/**
 * Core Systems Check
 *
 * Fast diagnostic scan (~15-20s) across all core subsystems.
 * No Claude needed -- pure programmatic checks.
 *
 * Run:      node dist/systems-check.js
 * Trigger:  "systems check" / "status check" in chat
 * Auto:     Session start hook (bot.ts)
 *
 * Output:   Clean pass/warn/fail dashboard to stdout + optional Telegram notify.
 *           Full report saved to Obsidian vault.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const VAULT_PATH = process.env.VAULT_ROOT || '';
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');
const NOTIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');

// ── Types ─────────────────────────────────────────────────────────────

type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

interface CheckResult {
  name: string;
  tier: 1 | 2 | 3;
  status: CheckStatus;
  detail: string;
}

interface SystemsReport {
  timestamp: string;
  date: string;
  overall: CheckStatus;
  checks: CheckResult[];
  totalChecks: number;
  passed: number;
  warned: number;
  failed: number;
  skipped: number;
}

interface PM2Process {
  name: string;
  pm2_env: {
    status: string;
    pm_uptime: number;
    restart_time: number;
    pm_err_log_path?: string;
  };
  monit: {
    memory: number;
    cpu: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatUptime(pmUptime: number): string {
  const ms = Date.now() - pmUptime;
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function readEnvKey(key: string): string {
  // Try decrypted .env.age first, then plaintext .env
  const ageFile = path.join(PROJECT_ROOT, '.env.age');
  const plainFile = path.join(PROJECT_ROOT, '.env');
  let content = '';

  if (fs.existsSync(ageFile)) {
    try {
      // Find age binary
      let ageBin = '';
      try {
        execSync('age --version', { stdio: 'pipe', windowsHide: true });
        ageBin = 'age';
      } catch {
        const wingetBase = path.join(
          process.env.LOCALAPPDATA || '',
          'Microsoft', 'WinGet', 'Packages',
        );
        if (fs.existsSync(wingetBase)) {
          const dirs = fs.readdirSync(wingetBase).filter(d => d.startsWith('FiloSottile.age'));
          for (const d of dirs) {
            const p = path.join(wingetBase, d, 'age', 'age.exe');
            if (fs.existsSync(p)) { ageBin = p; break; }
          }
        }
      }

      if (ageBin) {
        const keyFile = process.env.SOPS_AGE_KEY_FILE
          || path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'sops', 'age', 'keys.txt');
        if (fs.existsSync(keyFile)) {
          content = execSync(
            `"${ageBin}" -d -i "${keyFile}" "${ageFile}"`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, windowsHide: true },
          );
        }
      }
    } catch { /* fall through to plaintext */ }
  }

  if (!content && fs.existsSync(plainFile)) {
    try { content = fs.readFileSync(plainFile, 'utf-8'); } catch { /* skip */ }
  }

  if (!content) return '';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    if (k !== key) continue;
    let v = trimmed.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return '';
}

function httpGet(url: string, headers: Record<string, string> = {}, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

async function httpsGet(url: string, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

// ── Tier 1: Critical Checks ───────────────────────────────────────────

function checkPM2Processes(): CheckResult[] {
  const results: CheckResult[] = [];
  let pm2List: PM2Process[] = [];

  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      pm2List = JSON.parse(raw.substring(start, end + 1)) as PM2Process[];
    }
  } catch {
    results.push({ name: 'PM2 Daemon', tier: 1, status: 'FAIL', detail: 'Cannot reach PM2 daemon' });
    return results;
  }

  if (pm2List.length === 0) {
    results.push({ name: 'PM2 Processes', tier: 1, status: 'FAIL', detail: 'No processes found' });
    return results;
  }

  // Critical processes that must be online
  const critical = (process.env.CRITICAL_AGENTS || process.env.BOT_NAME || 'apex-bot').split(',').map(s => s.trim());
  const expected = (process.env.EXPECTED_AGENTS || 'apex-bot').split(',').map(s => s.trim());

  const online: string[] = [];
  const stopped: string[] = [];
  const erroring: string[] = [];
  const highRestarts: string[] = [];
  let totalMemMB = 0;

  for (const p of pm2List) {
    const memMB = p.monit.memory / 1_048_576;
    totalMemMB += memMB;

    if (p.pm2_env.status === 'online') {
      online.push(p.name);
    } else if (p.pm2_env.status === 'stopped') {
      stopped.push(p.name);
    } else {
      erroring.push(`${p.name}(${p.pm2_env.status})`);
    }

    if (p.pm2_env.restart_time > 10) {
      highRestarts.push(`${p.name}(${p.pm2_env.restart_time}x)`);
    }
  }

  // Check critical processes
  for (const c of critical) {
    const proc = pm2List.find(p => p.name === c);
    if (!proc) {
      results.push({ name: `PM2: ${c}`, tier: 1, status: 'FAIL', detail: 'Process not found in PM2' });
    } else if (proc.pm2_env.status !== 'online') {
      results.push({ name: `PM2: ${c}`, tier: 1, status: 'FAIL', detail: `Status: ${proc.pm2_env.status}` });
    }
  }

  // Overall fleet status
  if (erroring.length > 0) {
    results.push({ name: 'PM2 Fleet', tier: 1, status: 'WARN', detail: `Erroring: ${erroring.join(', ')}` });
  } else if (stopped.length > 2) {
    results.push({ name: 'PM2 Fleet', tier: 1, status: 'WARN', detail: `${stopped.length} stopped: ${stopped.join(', ')}` });
  } else {
    results.push({ name: 'PM2 Fleet', tier: 1, status: 'PASS', detail: `${online.length}/${pm2List.length} online, ${totalMemMB.toFixed(0)}MB total` });
  }

  // High restart counts
  if (highRestarts.length > 0) {
    results.push({ name: 'PM2 Restarts', tier: 1, status: 'WARN', detail: `High restarts: ${highRestarts.join(', ')}` });
  }

  return results;
}

function checkDatabase(): CheckResult {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'apex.db');

  if (!fs.existsSync(dbPath)) {
    return { name: 'Main Database', tier: 1, status: 'FAIL', detail: 'apex.db not found' };
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Apply encryption key
    const passphrase = readEnvKey('DB_PASSPHRASE');
    if (passphrase) {
      // DBs use default cipher (not sqlcipher).
      db.pragma(`key='${passphrase}'`);
    }

    // Check key tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[];
    const tableNames = new Set(tables.map(t => t.name));

    const requiredTables = ['sessions', 'token_usage', 'memories', 'conversation_log', 'scheduled_tasks'];
    const missing = requiredTables.filter(t => !tableNames.has(t));

    if (missing.length > 0) {
      db.close();
      return { name: 'Main Database', tier: 1, status: 'FAIL', detail: `Missing tables: ${missing.join(', ')}` };
    }

    // Check memory count and vec availability
    const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number })?.c ?? 0;

    // Check if memory_embeddings virtual table exists (created by sqlite-vec)
    let vecAvailable = false;
    try {
      const vecTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'",
      ).get();
      vecAvailable = !!vecTable;
    } catch { /* not available */ }

    const stats = fs.statSync(dbPath);
    const sizeMB = (stats.size / 1_048_576).toFixed(1);

    db.close();
    return {
      name: 'Main Database',
      tier: 1,
      status: 'PASS',
      detail: `${sizeMB}MB, ${memCount} memories, ${tableNames.size} tables, vec: ${vecAvailable ? 'yes' : 'no'}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Main Database', tier: 1, status: 'FAIL', detail: `DB error: ${msg.slice(0, 80)}` };
  }
}

function checkBridgeQueue(): CheckResult {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'bridge.db');
  if (!fs.existsSync(dbPath)) {
    return { name: 'Bridge Queue', tier: 1, status: 'WARN', detail: 'bridge.db not found' };
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const passphrase = readEnvKey('DB_PASSPHRASE');
    if (passphrase) {
      // DBs use default cipher (not sqlcipher).
      db.pragma(`key='${passphrase}'`);
    }

    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_messages'",
    ).get();
    if (!tableCheck) {
      db.close();
      return { name: 'Bridge Queue', tier: 1, status: 'WARN', detail: 'bridge_messages table missing' };
    }

    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

    const pending = (db.prepare(
      "SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'pending'",
    ).get() as { c: number })?.c ?? 0;

    const stuck = (db.prepare(
      "SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'pending' AND created_at < ?",
    ).get(twoHoursAgo) as { c: number })?.c ?? 0;

    const failed7d = (db.prepare(
      "SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'failed' AND created_at >= ?",
    ).get(sevenDaysAgo) as { c: number })?.c ?? 0;

    // Check for duplicate pending tasks (same prompt)
    const dupes = (db.prepare(`
      SELECT COUNT(*) as c FROM (
        SELECT payload, COUNT(*) as cnt FROM bridge_messages
        WHERE status IN ('pending', 'claimed') GROUP BY payload HAVING cnt > 1
      )
    `).get() as { c: number })?.c ?? 0;

    db.close();

    if (stuck > 0) {
      return { name: 'Bridge Queue', tier: 1, status: 'FAIL', detail: `${stuck} stuck tasks (>2h), ${pending} pending, ${failed7d} failed (7d)` };
    }
    if (dupes > 0 || failed7d > 5) {
      return { name: 'Bridge Queue', tier: 1, status: 'WARN', detail: `${pending} pending, ${dupes} dupe groups, ${failed7d} failed (7d)` };
    }
    return { name: 'Bridge Queue', tier: 1, status: 'PASS', detail: `${pending} pending, 0 stuck, ${failed7d} failed (7d)` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Bridge Queue', tier: 1, status: 'FAIL', detail: `Bridge DB error: ${msg.slice(0, 80)}` };
  }
}

function checkBuild(): CheckResult {
  const distDir = path.join(PROJECT_ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    return { name: 'Build', tier: 1, status: 'FAIL', detail: 'dist/ directory missing' };
  }

  // Check dist freshness vs src
  try {
    const distFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
    if (distFiles.length === 0) {
      return { name: 'Build', tier: 1, status: 'FAIL', detail: 'No .js files in dist/' };
    }

    // Get newest dist file and newest src file
    let newestDist = 0;
    for (const f of distFiles) {
      const stat = fs.statSync(path.join(distDir, f));
      if (stat.mtimeMs > newestDist) newestDist = stat.mtimeMs;
    }

    const srcDir = path.join(PROJECT_ROOT, 'src');
    let newestSrc = 0;
    const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'));
    for (const f of srcFiles) {
      const stat = fs.statSync(path.join(srcDir, f));
      if (stat.mtimeMs > newestSrc) newestSrc = stat.mtimeMs;
    }

    const staleMinutes = Math.max(0, Math.floor((newestSrc - newestDist) / 60000));

    if (newestSrc > newestDist + 60000) {
      return { name: 'Build', tier: 1, status: 'WARN', detail: `dist/ is ${staleMinutes}min behind src/ -- rebuild needed` };
    }

    return { name: 'Build', tier: 1, status: 'PASS', detail: `${distFiles.length} files, build current` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Build', tier: 1, status: 'WARN', detail: `Build check error: ${msg.slice(0, 60)}` };
  }
}

function checkScheduledTasks(): CheckResult {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'apex.db');
  if (!fs.existsSync(dbPath)) {
    return { name: 'Scheduled Tasks', tier: 1, status: 'SKIP', detail: 'No database' };
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const passphrase = readEnvKey('DB_PASSPHRASE');
    if (passphrase) {
      // DBs use default cipher (not sqlcipher).
      db.pragma(`key='${passphrase}'`);
    }

    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'",
    ).get();
    if (!tableCheck) {
      db.close();
      return { name: 'Scheduled Tasks', tier: 1, status: 'SKIP', detail: 'Table not found' };
    }

    const total = (db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as { c: number })?.c ?? 0;
    const active = (db.prepare(
      "SELECT COUNT(*) as c FROM scheduled_tasks WHERE status = 'active'",
    ).get() as { c: number })?.c ?? 0;
    const paused = (db.prepare(
      "SELECT COUNT(*) as c FROM scheduled_tasks WHERE status = 'paused'",
    ).get() as { c: number })?.c ?? 0;

    db.close();
    return { name: 'Scheduled Tasks', tier: 1, status: 'PASS', detail: `${active} active, ${paused} paused, ${total} total` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Scheduled Tasks', tier: 1, status: 'WARN', detail: `Query error: ${msg.slice(0, 60)}` };
  }
}

// ── Tier 2: Service Checks ────────────────────────────────────────────

async function checkVenice(): Promise<CheckResult> {
  const key = readEnvKey('VENICE_API_KEY');
  if (!key) {
    return { name: 'Venice API', tier: 2, status: 'FAIL', detail: 'VENICE_API_KEY not found in .env' };
  }

  const status = await httpsGet('https://api.venice.ai/api/v1/models', {
    Authorization: `Bearer ${key}`,
  });

  if (status === 200) {
    return { name: 'Venice API', tier: 2, status: 'PASS', detail: 'Connected, key valid' };
  } else if (status === 401 || status === 403) {
    return { name: 'Venice API', tier: 2, status: 'FAIL', detail: `Auth failed (HTTP ${status})` };
  } else if (status === 0) {
    return { name: 'Venice API', tier: 2, status: 'FAIL', detail: 'Unreachable (timeout or DNS)' };
  }
  return { name: 'Venice API', tier: 2, status: 'WARN', detail: `Unexpected HTTP ${status}` };
}

async function checkElevenLabs(): Promise<CheckResult> {
  const key = readEnvKey('ELEVENLABS_API_KEY');
  const voiceId = readEnvKey('ELEVENLABS_VOICE_ID');

  if (!key) {
    return { name: 'Voice (ElevenLabs)', tier: 2, status: 'WARN', detail: 'ELEVENLABS_API_KEY not set' };
  }

  const status = await httpsGet('https://api.elevenlabs.io/v1/user', {
    'xi-api-key': key,
  });

  if (status === 200) {
    const voiceNote = voiceId ? `, voice ID: ${voiceId.slice(0, 8)}...` : ', no VOICE_ID set';
    return { name: 'Voice (ElevenLabs)', tier: 2, status: 'PASS', detail: `Key valid${voiceNote}` };
  } else if (status === 401) {
    return { name: 'Voice (ElevenLabs)', tier: 2, status: 'FAIL', detail: 'API key invalid/expired' };
  } else if (status === 0) {
    return { name: 'Voice (ElevenLabs)', tier: 2, status: 'WARN', detail: 'API unreachable' };
  }
  return { name: 'Voice (ElevenLabs)', tier: 2, status: 'WARN', detail: `HTTP ${status}` };
}

async function checkGroq(): Promise<CheckResult> {
  const key = readEnvKey('GROQ_API_KEY');
  if (!key) {
    return { name: 'STT (Groq)', tier: 2, status: 'WARN', detail: 'GROQ_API_KEY not set' };
  }

  const status = await httpsGet('https://api.groq.com/openai/v1/models', {
    Authorization: `Bearer ${key}`,
  });

  if (status === 200) {
    return { name: 'STT (Groq)', tier: 2, status: 'PASS', detail: 'Key valid, API reachable' };
  } else if (status === 401) {
    return { name: 'STT (Groq)', tier: 2, status: 'FAIL', detail: 'API key invalid' };
  }
  return { name: 'STT (Groq)', tier: 2, status: 'WARN', detail: `HTTP ${status}` };
}

async function checkAvatar(): Promise<CheckResult> {
  const avatarPort = readEnvKey('AVATAR_PORT') || '3142';
  const status = await httpGet(`http://localhost:${avatarPort}/`);

  if (status === 200) {
    return { name: 'Avatar Kiosk', tier: 2, status: 'PASS', detail: `Serving on port ${avatarPort}` };
  } else if (status === 0) {
    return { name: 'Avatar Kiosk', tier: 2, status: 'WARN', detail: `Not responding on port ${avatarPort}` };
  }
  return { name: 'Avatar Kiosk', tier: 2, status: 'WARN', detail: `HTTP ${status} on port ${avatarPort}` };
}

async function checkDashboard(): Promise<CheckResult> {
  const dashPort = readEnvKey('DASHBOARD_PORT') || '3141';
  const status = await httpGet(`http://localhost:${dashPort}/`);

  if (status === 200 || status === 401) {
    // 401 = auth required = server is alive and responding
    return { name: 'Dashboard', tier: 2, status: 'PASS', detail: `Serving on port ${dashPort}` };
  } else if (status === 0) {
    return { name: 'Dashboard', tier: 2, status: 'WARN', detail: `Not responding on port ${dashPort}` };
  }
  return { name: 'Dashboard', tier: 2, status: 'WARN', detail: `HTTP ${status}` };
}

async function checkFirefly(): Promise<CheckResult> {
  // Check 1: Is the Docker container running?
  try {
    const ps = execSync('docker ps --filter name=firefly-app --format "{{.Status}}"', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (!ps) {
      return { name: 'Firefly III', tier: 2, status: 'WARN', detail: 'Container not running' };
    }

    // Check 2: Is the API responding?
    const token = readEnvKey('FIREFLY_API_TOKEN');
    const url = readEnvKey('FIREFLY_API_URL') || 'http://localhost:3143';

    if (!token) {
      return { name: 'Firefly III', tier: 2, status: 'WARN', detail: `Container: ${ps} | No API token configured` };
    }

    const status = await httpGet(`${url}/api/v1/about`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.api+json',
    });

    if (status >= 200 && status < 300) {
      return { name: 'Firefly III', tier: 2, status: 'PASS', detail: `Running on ${url} | ${ps}` };
    }
    return { name: 'Firefly III', tier: 2, status: 'WARN', detail: `Container: ${ps} | API HTTP ${status}` };
  } catch {
    return { name: 'Firefly III', tier: 2, status: 'WARN', detail: 'Docker check failed (Docker not running?)' };
  }
}

async function checkFireflyBiz(): Promise<CheckResult> {
  try {
    const ps = execSync('docker ps --filter name=firefly-biz-app --format "{{.Status}}"', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (!ps) {
      return { name: 'Firefly III (Business)', tier: 2, status: 'WARN', detail: 'Container not running' };
    }

    const token = readEnvKey('FIREFLY_BIZ_API_TOKEN');
    const url = readEnvKey('FIREFLY_BIZ_API_URL') || 'http://localhost:3144';

    if (!token) {
      return { name: 'Firefly III (Business)', tier: 2, status: 'WARN', detail: `Container: ${ps} | No API token configured` };
    }

    const status = await httpGet(`${url}/api/v1/about`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.api+json',
    });

    if (status >= 200 && status < 300) {
      return { name: 'Firefly III (Business)', tier: 2, status: 'PASS', detail: `Running on ${url} | ${ps}` };
    }
    return { name: 'Firefly III (Business)', tier: 2, status: 'WARN', detail: `Container: ${ps} | API HTTP ${status}` };
  } catch {
    return { name: 'Firefly III (Business)', tier: 2, status: 'WARN', detail: 'Docker check failed (Docker not running?)' };
  }
}

async function checkSignal(): Promise<CheckResult> {
  try {
    const ps = execSync('docker ps --filter name=signal-api --format "{{.Status}}"', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (!ps) {
      return { name: 'Signal', tier: 2, status: 'WARN', detail: 'Container not running' };
    }

    const url = readEnvKey('SIGNAL_API_URL') || 'http://localhost:3145';
    const phone = readEnvKey('SIGNAL_PHONE_NUMBER');

    if (!phone) {
      return { name: 'Signal', tier: 2, status: 'WARN', detail: `Container: ${ps} | No phone number configured` };
    }

    const status = await httpGet(`${url}/v1/about`, {
      Accept: 'application/json',
    });

    if (status >= 200 && status < 300) {
      return { name: 'Signal', tier: 2, status: 'PASS', detail: `Running on ${url} | ${ps}` };
    }
    return { name: 'Signal', tier: 2, status: 'WARN', detail: `Container: ${ps} | API HTTP ${status}` };
  } catch {
    return { name: 'Signal', tier: 2, status: 'WARN', detail: 'Docker check failed (Docker not running?)' };
  }
}

async function checkInternet(): Promise<CheckResult> {
  const status = await httpsGet('https://www.google.com', {}, 5000);
  if (status >= 200 && status < 400) {
    return { name: 'Internet', tier: 2, status: 'PASS', detail: 'Connected' };
  } else if (status === 0) {
    return { name: 'Internet', tier: 2, status: 'FAIL', detail: 'No internet connectivity' };
  }
  return { name: 'Internet', tier: 2, status: 'WARN', detail: `HTTP ${status}` };
}

// ── Tier 2: Spice System Check ────────────────────────────────────────

function checkSpiceSystem(): CheckResult {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'apex.db');
  if (!fs.existsSync(dbPath)) {
    return { name: 'Spice System', tier: 2, status: 'SKIP', detail: 'DB not found' };
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const passphrase = readEnvKey('DB_PASSPHRASE');
    if (passphrase) {
      // DBs use default cipher (not sqlcipher).
      db.pragma(`key='${passphrase}'`);
    }

    // Check if spice_history table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='spice_history'",
    ).get();

    if (!tableCheck) {
      db.close();
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: 'spice_history table not found (run migration)' };
    }

    // Get chat_id from sessions
    const session = db.prepare('SELECT chat_id FROM sessions LIMIT 1').get() as { chat_id: string } | undefined;
    const chatId = session?.chat_id || '';

    if (!chatId) {
      db.close();
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: 'No chat ID found' };
    }

    // History count
    const histRow = db.prepare('SELECT COUNT(*) as cnt FROM spice_history WHERE chat_id = ?').get(chatId) as { cnt: number };
    const historyCount = histRow.cnt;

    // Rotations in 24h
    const cutoff24h = Math.floor(Date.now() / 1000) - 86400;
    const rot24hRow = db.prepare(
      'SELECT COUNT(DISTINCT created_at) as cnt FROM spice_history WHERE chat_id = ? AND created_at >= ?',
    ).get(chatId, cutoff24h) as { cnt: number };
    const rotations24h = rot24hRow.cnt;

    // Rotations in 7d
    const cutoff7d = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rot7dRow = db.prepare(
      'SELECT COUNT(DISTINCT created_at) as cnt FROM spice_history WHERE chat_id = ? AND created_at >= ?',
    ).get(chatId, cutoff7d) as { cnt: number };
    const rotations7d = rot7dRow.cnt;

    // Active spices
    const stateRow = db.prepare('SELECT active_spices FROM spice_state WHERE chat_id = ?').get(chatId) as { active_spices: string } | undefined;
    let activeCount = 0;
    if (stateRow) {
      try { activeCount = JSON.parse(stateRow.active_spices).length; } catch { /* */ }
    }

    db.close();

    const parts = [
      `${activeCount}/3 active`,
      `${rotations24h} rot/24h`,
      `${rotations7d} rot/7d`,
      `${historyCount} history`,
    ];

    // WARN if zero rotations in 24h but had some in 7d
    if (rotations24h === 0 && rotations7d > 0) {
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: `No rotations in 24h | ${parts.join(', ')}` };
    }

    // WARN if no history at all
    if (historyCount === 0) {
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: 'No history data yet' };
    }

    return { name: 'Spice System', tier: 2, status: 'PASS', detail: parts.join(', ') };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Spice System', tier: 2, status: 'FAIL', detail: `Check error: ${msg.slice(0, 80)}` };
  }
}

// ── Tier 2: Report Routing Check ──────────────────────────────────────

function checkReportRouting(): CheckResult {
  const vaultResearcherDir = path.join(VAULT_PATH, 'Agent Workspace', 'Researcher');
  const vaultResearchDir = path.join(VAULT_PATH, 'Research Results');
  const staleThresholdMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();

  // Directories to scan for stranded reports
  const localDirs = [
    path.join(PROJECT_ROOT, 'store', 'reports'),
  ];

  // Also check bots/*/store/reports/ directories
  const botsDir = path.join(PROJECT_ROOT, 'bots');
  if (fs.existsSync(botsDir)) {
    try {
      const botDirs = fs.readdirSync(botsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const d of botDirs) {
        const reportsPath = path.join(botsDir, d.name, 'store', 'reports');
        if (fs.existsSync(reportsPath)) {
          localDirs.push(reportsPath);
        }
      }
    } catch { /* non-fatal */ }
  }

  // Collect vault filenames for matching (Agent Workspace/Researcher + Research Results)
  const vaultFiles = new Set<string>();
  for (const vDir of [vaultResearcherDir, vaultResearchDir]) {
    if (!fs.existsSync(vDir)) continue;
    try {
      const files = fs.readdirSync(vDir).filter(f => f.endsWith('.md'));
      for (const f of files) vaultFiles.add(f.toLowerCase());
    } catch { /* non-fatal */ }
  }
  // Also check Research Results subdirectories (Reference/, project folders)
  if (fs.existsSync(vaultResearchDir)) {
    try {
      const subDirs = fs.readdirSync(vaultResearchDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const sub of subDirs) {
        try {
          const files = fs.readdirSync(path.join(vaultResearchDir, sub.name))
            .filter(f => f.endsWith('.md'));
          for (const f of files) vaultFiles.add(f.toLowerCase());
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }
  }

  let totalLocal = 0;
  let staleUnrouted = 0;
  const staleFiles: string[] = [];

  for (const dir of localDirs) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch { continue; }

    for (const file of files) {
      totalLocal++;
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        const ageMs = now - stat.mtimeMs;

        // Only flag files older than 7 days with no vault match
        if (ageMs > staleThresholdMs && !vaultFiles.has(file.toLowerCase())) {
          staleUnrouted++;
          if (staleFiles.length < 3) {
            const relDir = path.relative(PROJECT_ROOT, dir);
            staleFiles.push(`${relDir}/${file}`);
          }
        }
      } catch { /* skip */ }
    }
  }

  if (staleUnrouted > 0) {
    const examples = staleFiles.length > 0 ? ` (e.g. ${staleFiles.join(', ')})` : '';
    return {
      name: 'Report Routing',
      tier: 2,
      status: 'WARN',
      detail: `${staleUnrouted} reports stuck locally >7d, ${totalLocal} total in fallback dirs${examples}`,
    };
  }

  if (totalLocal > 0) {
    return {
      name: 'Report Routing',
      tier: 2,
      status: 'PASS',
      detail: `${totalLocal} local reports, all have vault matches or are <7d old`,
    };
  }

  return { name: 'Report Routing', tier: 2, status: 'PASS', detail: 'No local fallback reports' };
}

// ── Tier 3: Environment Checks ────────────────────────────────────────

function checkDiskSpace(): CheckResult {
  try {
    // Windows: use wmic or PowerShell
    const raw = execSync(
      'powershell -Command "Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json"',
      { encoding: 'utf-8', timeout: 10000, windowsHide: true },
    );
    const data = JSON.parse(raw);
    const usedGB = data.Used / 1_073_741_824;
    const freeGB = data.Free / 1_073_741_824;
    const totalGB = usedGB + freeGB;
    const pctUsed = Math.round((usedGB / totalGB) * 100);

    if (freeGB < 5) {
      return { name: 'Disk Space (C:)', tier: 3, status: 'FAIL', detail: `${freeGB.toFixed(1)}GB free (${pctUsed}% used)` };
    }
    if (freeGB < 20) {
      return { name: 'Disk Space (C:)', tier: 3, status: 'WARN', detail: `${freeGB.toFixed(1)}GB free (${pctUsed}% used)` };
    }
    return { name: 'Disk Space (C:)', tier: 3, status: 'PASS', detail: `${freeGB.toFixed(1)}GB free (${pctUsed}% used)` };
  } catch {
    return { name: 'Disk Space (C:)', tier: 3, status: 'SKIP', detail: 'Could not query disk' };
  }
}

function checkRAM(): CheckResult {
  try {
    const raw = execSync(
      'powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json"',
      { encoding: 'utf-8', timeout: 10000, windowsHide: true },
    );
    const data = JSON.parse(raw);
    const totalGB = data.TotalVisibleMemorySize / 1_048_576;
    const freeGB = data.FreePhysicalMemory / 1_048_576;
    const pctUsed = Math.round(((totalGB - freeGB) / totalGB) * 100);

    if (pctUsed > 90) {
      return { name: 'RAM', tier: 3, status: 'FAIL', detail: `${pctUsed}% used, ${freeGB.toFixed(1)}GB free of ${totalGB.toFixed(0)}GB` };
    }
    if (pctUsed > 80) {
      return { name: 'RAM', tier: 3, status: 'WARN', detail: `${pctUsed}% used, ${freeGB.toFixed(1)}GB free of ${totalGB.toFixed(0)}GB` };
    }
    return { name: 'RAM', tier: 3, status: 'PASS', detail: `${pctUsed}% used, ${freeGB.toFixed(1)}GB free of ${totalGB.toFixed(0)}GB` };
  } catch {
    return { name: 'RAM', tier: 3, status: 'SKIP', detail: 'Could not query RAM' };
  }
}

function checkVaultGit(): CheckResult {
  if (!fs.existsSync(VAULT_PATH)) {
    return { name: 'Vault Git', tier: 3, status: 'FAIL', detail: 'Vault path not found' };
  }

  try {
    const status = execSync('git status --porcelain', {
      cwd: VAULT_PATH,
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });
    const uncommitted = status.trim().split('\n').filter(l => l.trim()).length;
    if (uncommitted > 20) {
      return { name: 'Vault Git', tier: 3, status: 'WARN', detail: `${uncommitted} uncommitted changes` };
    }
    if (uncommitted > 0) {
      return { name: 'Vault Git', tier: 3, status: 'PASS', detail: `${uncommitted} uncommitted changes` };
    }
    return { name: 'Vault Git', tier: 3, status: 'PASS', detail: 'Clean' };
  } catch {
    return { name: 'Vault Git', tier: 3, status: 'WARN', detail: 'Git check failed' };
  }
}

function checkLogSizes(): CheckResult {
  const logDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pm2', 'logs');
  if (!fs.existsSync(logDir)) {
    return { name: 'Log Sizes', tier: 3, status: 'SKIP', detail: 'PM2 log dir not found' };
  }

  try {
    const files = fs.readdirSync(logDir);
    let totalBytes = 0;
    let largestFile = '';
    let largestSize = 0;

    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(logDir, f));
        totalBytes += stat.size;
        if (stat.size > largestSize) {
          largestSize = stat.size;
          largestFile = f;
        }
      } catch { /* skip */ }
    }

    const totalMB = totalBytes / 1_048_576;
    const largestMB = largestSize / 1_048_576;

    if (totalMB > 500) {
      return { name: 'Log Sizes', tier: 3, status: 'FAIL', detail: `${totalMB.toFixed(0)}MB total, largest: ${largestFile} (${largestMB.toFixed(0)}MB)` };
    }
    if (totalMB > 100) {
      return { name: 'Log Sizes', tier: 3, status: 'WARN', detail: `${totalMB.toFixed(0)}MB total, largest: ${largestFile} (${largestMB.toFixed(0)}MB)` };
    }
    return { name: 'Log Sizes', tier: 3, status: 'PASS', detail: `${totalMB.toFixed(1)}MB total across ${files.length} files` };
  } catch {
    return { name: 'Log Sizes', tier: 3, status: 'SKIP', detail: 'Could not scan logs' };
  }
}

function checkEncryptedEnv(): CheckResult {
  const ageFile = path.join(PROJECT_ROOT, '.env.age');
  const plainFile = path.join(PROJECT_ROOT, '.env');

  if (fs.existsSync(plainFile) && !fs.existsSync(ageFile)) {
    return { name: 'Env Encryption', tier: 3, status: 'WARN', detail: 'Plaintext .env found, no .env.age' };
  }

  if (!fs.existsSync(ageFile)) {
    return { name: 'Env Encryption', tier: 3, status: 'FAIL', detail: 'No .env or .env.age found' };
  }

  // Verify we can decrypt
  const testKey = readEnvKey('TELEGRAM_BOT_TOKEN');
  if (testKey) {
    if (fs.existsSync(plainFile)) {
      return { name: 'Env Encryption', tier: 3, status: 'WARN', detail: 'Encrypted OK but plaintext .env still exists' };
    }
    return { name: 'Env Encryption', tier: 3, status: 'PASS', detail: 'Encrypted, decryptable' };
  }
  return { name: 'Env Encryption', tier: 3, status: 'FAIL', detail: '.env.age exists but cannot decrypt' };
}

function checkProcessLocks(): CheckResult {
  const lockDir = path.join(PROJECT_ROOT, 'store', 'locks');
  if (!fs.existsSync(lockDir)) {
    return { name: 'Process Locks', tier: 3, status: 'PASS', detail: 'No active locks' };
  }

  try {
    const lockFiles = fs.readdirSync(lockDir).filter(f => f.endsWith('.lock'));
    if (lockFiles.length === 0) {
      return { name: 'Process Locks', tier: 3, status: 'PASS', detail: 'No active locks' };
    }

    // Check for stale locks
    const stale: string[] = [];
    for (const f of lockFiles) {
      const content = fs.readFileSync(path.join(lockDir, f), 'utf-8').trim();
      const pid = parseInt(content, 10);
      if (pid) {
        try {
          process.kill(pid, 0); // Check if PID exists
        } catch {
          stale.push(f);
        }
      }
    }

    if (stale.length > 0) {
      return { name: 'Process Locks', tier: 3, status: 'WARN', detail: `${stale.length} stale locks: ${stale.join(', ')}` };
    }
    return { name: 'Process Locks', tier: 3, status: 'PASS', detail: `${lockFiles.length} active locks` };
  } catch {
    return { name: 'Process Locks', tier: 3, status: 'SKIP', detail: 'Could not check locks' };
  }
}

// ── Report Generation ─────────────────────────────────────────────────

function generateTelegramSummary(report: SystemsReport): string {
  const icon = report.overall === 'PASS' ? '🟢'
    : report.overall === 'WARN' ? '🟡'
    : '🔴';

  const statusIcons: Record<CheckStatus, string> = {
    PASS: '✅', WARN: '⚠️', FAIL: '❌', SKIP: '⏭️',
  };

  let msg = `${icon} Systems Check - ${report.overall}\n`;
  msg += `${report.passed}/${report.totalChecks} pass`;
  if (report.warned > 0) msg += `, ${report.warned} warn`;
  if (report.failed > 0) msg += `, ${report.failed} fail`;
  msg += '\n\n';

  // Group by tier
  const tiers: Record<number, CheckResult[]> = { 1: [], 2: [], 3: [] };
  for (const c of report.checks) {
    tiers[c.tier].push(c);
  }

  const tierNames: Record<number, string> = { 1: 'Critical', 2: 'Services', 3: 'Environment' };

  for (const tier of [1, 2, 3]) {
    const items = tiers[tier];
    if (items.length === 0) continue;

    // Only show tier header if there are non-PASS items, or always for tier 1
    const hasIssues = items.some(i => i.status !== 'PASS');
    if (!hasIssues && tier > 1) {
      msg += `${tierNames[tier]}: all clear\n`;
      continue;
    }

    msg += `-- ${tierNames[tier]} --\n`;
    for (const c of items) {
      msg += `${statusIcons[c.status]} ${c.name}: ${c.detail}\n`;
    }
    msg += '\n';
  }

  return msg.trim();
}

function generateVaultReport(report: SystemsReport): string {
  const statusIcons: Record<CheckStatus, string> = {
    PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', SKIP: 'SKIP',
  };

  let md = `---
type: audit
tags: [audit, systems-check]
created: ${report.date}
status: ${report.overall.toLowerCase()}
---

# Systems Check - ${report.date} ${report.timestamp.split('T')[1]?.slice(0, 5) || ''}

## Summary
- **Overall**: ${report.overall}
- **Checks**: ${report.totalChecks} total
- **Passed**: ${report.passed}
- **Warnings**: ${report.warned}
- **Failed**: ${report.failed}
- **Skipped**: ${report.skipped}

## Tier 1: Critical
| Check | Status | Detail |
|-------|--------|--------|
`;

  for (const c of report.checks.filter(c => c.tier === 1)) {
    md += `| ${c.name} | ${statusIcons[c.status]} | ${c.detail} |\n`;
  }

  md += `\n## Tier 2: Services\n| Check | Status | Detail |\n|-------|--------|--------|\n`;
  for (const c of report.checks.filter(c => c.tier === 2)) {
    md += `| ${c.name} | ${statusIcons[c.status]} | ${c.detail} |\n`;
  }

  md += `\n## Tier 3: Environment\n| Check | Status | Detail |\n|-------|--------|--------|\n`;
  for (const c of report.checks.filter(c => c.tier === 3)) {
    md += `| ${c.name} | ${statusIcons[c.status]} | ${c.detail} |\n`;
  }

  // Add findings section for non-PASS items
  const issues = report.checks.filter(c => c.status === 'FAIL' || c.status === 'WARN');
  if (issues.length > 0) {
    md += `\n## Findings\n`;
    for (const c of issues) {
      md += `- **${c.status}** [${c.name}]: ${c.detail}\n`;
    }
  } else {
    md += `\n## Findings\nAll clear. No issues detected.\n`;
  }

  return md;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function runSystemsCheck(options?: {
  notify?: boolean;
  saveToVault?: boolean;
  quiet?: boolean;
}): Promise<SystemsReport> {
  const { notify = false, saveToVault = true, quiet = false } = options || {};

  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const timestamp = now.toISOString();

  if (!quiet) console.log(`Running systems check...`);

  // Run all checks
  const checks: CheckResult[] = [];

  // Tier 1: Critical (synchronous)
  checks.push(...checkPM2Processes());
  checks.push(checkDatabase());
  checks.push(checkBridgeQueue());
  checks.push(checkBuild());
  checks.push(checkScheduledTasks());

  // Tier 2: Services (async)
  const [internet, venice, elevenlabs, groq, avatar, dashboard, firefly, fireflyBiz, signal] = await Promise.all([
    checkInternet(),
    checkVenice(),
    checkElevenLabs(),
    checkGroq(),
    checkAvatar(),
    checkDashboard(),
    checkFirefly(),
    checkFireflyBiz(),
    checkSignal(),
  ]);
  checks.push(internet);
  checks.push(venice);
  checks.push(elevenlabs);
  checks.push(groq);
  checks.push(avatar);
  checks.push(dashboard);
  checks.push(firefly);
  checks.push(fireflyBiz);
  checks.push(signal);
  checks.push(checkSpiceSystem());
  checks.push(checkReportRouting());

  // Tier 3: Environment (synchronous)
  checks.push(checkDiskSpace());
  checks.push(checkRAM());
  checks.push(checkVaultGit());
  checks.push(checkLogSizes());
  checks.push(checkEncryptedEnv());
  checks.push(checkProcessLocks());

  // Reflect engine health check
  try {
    const { checkReflectHealth } = await import('./reflect-monitor.js');
    checks.push(checkReflectHealth());
  } catch {
    // Reflect module not available -- skip
  }

  // Calculate totals
  const passed = checks.filter(c => c.status === 'PASS').length;
  const warned = checks.filter(c => c.status === 'WARN').length;
  const failed = checks.filter(c => c.status === 'FAIL').length;
  const skipped = checks.filter(c => c.status === 'SKIP').length;

  // Tier 1 fail = overall FAIL, any warn = overall WARN
  const tier1Fail = checks.some(c => c.tier === 1 && c.status === 'FAIL');
  const overall: CheckStatus = tier1Fail ? 'FAIL' : (failed > 0 || warned > 0) ? 'WARN' : 'PASS';

  const report: SystemsReport = {
    timestamp,
    date,
    overall,
    checks,
    totalChecks: checks.length,
    passed,
    warned,
    failed,
    skipped,
  };

  // Output
  if (!quiet) {
    const summary = generateTelegramSummary(report);
    console.log('\n' + summary);
  }

  // Save to vault
  if (saveToVault) {
    try {
      const outputDir = path.join(VAULT_PATH, 'Audits', 'Systems Health');
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${date} - Systems Health.md`);
      const vaultReport = generateVaultReport(report);
      fs.writeFileSync(outputPath, vaultReport, 'utf-8');
      if (!quiet) console.log(`\nReport saved: ${outputPath}`);

      try {
        execSync(`bash "${VAULT_COMMIT_SCRIPT}" "systems health check - ${date}"`, {
          cwd: VAULT_PATH,
          stdio: 'pipe',
          windowsHide: true,
        });
      } catch { /* vault commit non-fatal */ }
    } catch (err) {
      if (!quiet) console.error('Failed to save vault report:', err);
    }
  }

  // Telegram notification (optional)
  if (notify) {
    try {
      const summary = generateTelegramSummary(report);
      execSync(`bash "${NOTIFY_SCRIPT}" "${summary.replace(/"/g, '\\"')}"`, {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch { /* notify non-fatal */ }
  }

  return report;
}

// CLI entry point
const isDirectRun = process.argv[1]?.endsWith('systems-check.js')
  || process.argv[1]?.endsWith('systems-check.ts');

if (isDirectRun) {
  const notify = process.argv.includes('--notify');
  const noVault = process.argv.includes('--no-vault');
  runSystemsCheck({ notify, saveToVault: !noVault }).catch(console.error);
}
