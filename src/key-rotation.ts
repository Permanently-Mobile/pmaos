/**
 * API Key Rotation Tracker
 *
 * Tracks when each API key was last rotated and alerts when
 * a key is approaching or past its rotation deadline (90 days default).
 *
 * Does NOT auto-rotate keys (that requires provider-specific APIs and
 * human verification). Instead, it:
 * 1. Tracks rotation dates in a local JSON file
 * 2. Alerts when keys are due for rotation
 * 3. Provides a checklist for the rotation process
 * 4. Logs rotation events for audit trail
 *
 * Usage:
 *   node dist/key-rotation.js status   -- show all keys and their rotation status
 *   node dist/key-rotation.js rotated <KEY_NAME>  -- mark a key as freshly rotated
 *   node dist/key-rotation.js check    -- check for overdue keys, alert if found
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.env.APEX_ROOT || process.cwd();
const VAULT_ROOT = process.env.VAULT_ROOT || '';
const ROTATION_DB = path.join(PROJECT_ROOT, 'store', 'key-rotation.json');

// ── Configuration ────────────────────────────────────────────────────

const DEFAULT_ROTATION_DAYS = 90;

interface KeyConfig {
  name: string;
  envVar: string;
  provider: string;
  rotationDays: number;
  rotationUrl: string;   // where to go to rotate
  notes: string;
}

const TRACKED_KEYS: KeyConfig[] = [
  {
    name: 'Telegram Bot Token (Primary)',
    envVar: 'TELEGRAM_BOT_TOKEN',
    provider: 'Telegram BotFather',
    rotationDays: 90,
    rotationUrl: 'https://t.me/BotFather -> /revoke then /newtoken',
    notes: 'Rotate via BotFather. Update .env.age, restart the primary bot.',
  },
  {
    name: 'Venice API Key',
    envVar: 'VENICE_API_KEY',
    provider: 'Venice AI',
    rotationDays: 90,
    rotationUrl: 'https://venice.ai/settings/api',
    notes: 'Generate new key, update .env.age for all bots that use it.',
  },
  {
    name: 'ElevenLabs API Key',
    envVar: 'ELEVENLABS_API_KEY',
    provider: 'ElevenLabs',
    rotationDays: 90,
    rotationUrl: 'https://elevenlabs.io/app/settings/api-keys',
    notes: 'Generate new key in settings. Update .env.age.',
  },
  {
    name: 'Groq API Key',
    envVar: 'GROQ_API_KEY',
    provider: 'Groq',
    rotationDays: 90,
    rotationUrl: 'https://console.groq.com/keys',
    notes: 'Create new key, delete old one. Update .env.age.',
  },
  {
    name: 'Google API Key (Gemini)',
    envVar: 'GOOGLE_API_KEY',
    provider: 'Google AI Studio',
    rotationDays: 90,
    rotationUrl: 'https://aistudio.google.com/app/apikey',
    notes: 'Generate new key. Update .env.age.',
  },
  {
    name: 'OpenRouter API Key',
    envVar: 'OPENROUTER_API_KEY',
    provider: 'OpenRouter',
    rotationDays: 90,
    rotationUrl: 'https://openrouter.ai/keys',
    notes: 'Generate new key. Update .env.age.',
  },
  {
    name: 'Slack User Token',
    envVar: 'SLACK_USER_TOKEN',
    provider: 'Slack',
    rotationDays: 90,
    rotationUrl: 'https://api.slack.com/apps -> OAuth & Permissions',
    notes: 'Reinstall app to workspace for new token. Update .env.age.',
  },
  {
    name: 'Grafana Service Account Token',
    envVar: 'GRAFANA_TOKEN',
    provider: 'Grafana (local)',
    rotationDays: 180,
    rotationUrl: 'http://127.0.0.1:3000 -> Administration -> Service Accounts',
    notes: 'Create new token, delete old one. Update .env.age.',
  },
  {
    name: 'DB Passphrase',
    envVar: 'DB_PASSPHRASE',
    provider: 'Self-managed',
    rotationDays: 180,
    rotationUrl: 'Manual process: re-encrypt all SQLite DBs with new passphrase',
    notes: 'HIGH RISK rotation. Requires re-encrypting all 3 DBs. Schedule during S1.',
  },
];

// ── State ────────────────────────────────────────────────────────────

interface RotationRecord {
  envVar: string;
  lastRotated: string;     // ISO date
  rotatedBy: string;       // who did it
  history: { date: string; by: string }[];
}

interface RotationDB {
  version: 1;
  keys: Record<string, RotationRecord>;
}

function loadDB(): RotationDB {
  try {
    return JSON.parse(fs.readFileSync(ROTATION_DB, 'utf-8'));
  } catch {
    return { version: 1, keys: {} };
  }
}

function saveDB(db: RotationDB): void {
  const dir = path.dirname(ROTATION_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROTATION_DB, JSON.stringify(db, null, 2));
}

// ── Core Functions ───────────────────────────────────────────────────

interface KeyStatus {
  config: KeyConfig;
  lastRotated: string | null;
  daysSinceRotation: number | null;
  daysUntilDue: number | null;
  status: 'ok' | 'warning' | 'overdue' | 'unknown';
}

function getKeyStatus(): KeyStatus[] {
  const db = loadDB();
  const now = Date.now();

  return TRACKED_KEYS.map((config) => {
    const record = db.keys[config.envVar];
    if (!record) {
      return {
        config,
        lastRotated: null,
        daysSinceRotation: null,
        daysUntilDue: null,
        status: 'unknown' as const,
      };
    }

    const lastRotatedMs = new Date(record.lastRotated).getTime();
    const daysSince = Math.floor((now - lastRotatedMs) / (1000 * 60 * 60 * 24));
    const daysUntil = config.rotationDays - daysSince;

    let status: 'ok' | 'warning' | 'overdue';
    if (daysUntil <= 0) {
      status = 'overdue';
    } else if (daysUntil <= 14) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      config,
      lastRotated: record.lastRotated,
      daysSinceRotation: daysSince,
      daysUntilDue: daysUntil,
      status,
    };
  });
}

export function markRotated(envVar: string, by: string = 'assistant'): boolean {
  const config = TRACKED_KEYS.find(k => k.envVar === envVar);
  if (!config) return false;

  const db = loadDB();
  const now = new Date().toISOString().slice(0, 10);
  const existing = db.keys[envVar];

  db.keys[envVar] = {
    envVar,
    lastRotated: now,
    rotatedBy: by,
    history: [
      ...(existing?.history || []),
      { date: now, by },
    ],
  };

  saveDB(db);
  return true;
}

export function initializeAllKeys(): void {
  const db = loadDB();
  const now = new Date().toISOString().slice(0, 10);

  for (const config of TRACKED_KEYS) {
    if (!db.keys[config.envVar]) {
      db.keys[config.envVar] = {
        envVar: config.envVar,
        lastRotated: now,
        rotatedBy: 'initial baseline',
        history: [{ date: now, by: 'initial baseline' }],
      };
    }
  }

  saveDB(db);
}

// ── Report ───────────────────────────────────────────────────────────

export function generateRotationReport(): { vaultReport: string; telegramSummary: string } {
  const statuses = getKeyStatus();
  const date = new Date().toISOString().slice(0, 10);

  const overdue = statuses.filter(s => s.status === 'overdue');
  const warning = statuses.filter(s => s.status === 'warning');
  const ok = statuses.filter(s => s.status === 'ok');
  const unknown = statuses.filter(s => s.status === 'unknown');

  const lines: string[] = [];
  lines.push(`# API Key Rotation Status - ${date}`);
  lines.push('');
  lines.push('| Key | Provider | Last Rotated | Days Since | Due In | Status |');
  lines.push('|-----|----------|-------------|-----------|--------|--------|');

  for (const s of statuses) {
    const lastRotated = s.lastRotated || 'Never';
    const daysSince = s.daysSinceRotation !== null ? `${s.daysSinceRotation}d` : '-';
    const daysUntil = s.daysUntilDue !== null ? `${s.daysUntilDue}d` : '-';
    const statusEmoji = { ok: 'OK', warning: 'WARNING', overdue: 'OVERDUE', unknown: '?' }[s.status];
    lines.push(`| ${s.config.name} | ${s.config.provider} | ${lastRotated} | ${daysSince} | ${daysUntil} | ${statusEmoji} |`);
  }

  lines.push('');

  if (overdue.length > 0) {
    lines.push('## Overdue Keys');
    for (const s of overdue) {
      lines.push(`- **${s.config.name}**: ${Math.abs(s.daysUntilDue || 0)} days overdue`);
      lines.push(`  - Rotate at: ${s.config.rotationUrl}`);
      lines.push(`  - Notes: ${s.config.notes}`);
    }
    lines.push('');
  }

  if (warning.length > 0) {
    lines.push('## Due Soon');
    for (const s of warning) {
      lines.push(`- **${s.config.name}**: ${s.daysUntilDue} days remaining`);
    }
    lines.push('');
  }

  // Telegram summary
  const tgLines: string[] = [];
  tgLines.push(`Key Rotation Check - ${date}`);

  if (overdue.length > 0) {
    tgLines.push(`!! ${overdue.length} key(s) OVERDUE:`);
    for (const s of overdue) {
      tgLines.push(`  ${s.config.name} (${Math.abs(s.daysUntilDue || 0)}d overdue)`);
    }
  }
  if (warning.length > 0) {
    tgLines.push(`${warning.length} key(s) due within 14 days`);
  }
  if (unknown.length > 0) {
    tgLines.push(`${unknown.length} key(s) never baselined`);
  }
  tgLines.push(`${ok.length}/${statuses.length} keys OK`);

  return { vaultReport: lines.join('\n'), telegramSummary: tgLines.join('\n') };
}

// ── Standalone ───────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('key-rotation.js')) {
  const cmd = process.argv[2];

  if (cmd === 'status' || cmd === 'check') {
    const { vaultReport, telegramSummary } = generateRotationReport();

    if (cmd === 'check') {
      // Save to vault
      const date = new Date().toISOString().slice(0, 10);
      const reportDir = path.join(VAULT_ROOT, 'Audits', 'Security');
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(path.join(reportDir, `${date} - Key Rotation Status.md`), vaultReport);

      try {
        execSync(
          `bash "${path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh')}" "key rotation check ${date}"`,
          { stdio: 'pipe', windowsHide: true },
        );
      } catch { /* non-fatal */ }

      // Alert if overdue
      if (telegramSummary.includes('OVERDUE')) {
        try {
          execSync(
            `bash "${path.join(PROJECT_ROOT, 'scripts', 'notify.sh')}" "${telegramSummary.replace(/"/g, '\\"')}"`,
            { stdio: 'pipe', windowsHide: true },
          );
        } catch { /* non-fatal */ }
      }
    }

    console.log(telegramSummary);
    if (cmd === 'status') {
      console.log('\n' + vaultReport);
    }

  } else if (cmd === 'rotated') {
    const keyName = process.argv[3];
    if (!keyName) {
      console.log('Usage: node dist/key-rotation.js rotated <ENV_VAR_NAME>');
      console.log('Available keys:');
      TRACKED_KEYS.forEach(k => console.log(`  ${k.envVar} -- ${k.name}`));
      process.exit(1);
    }
    if (markRotated(keyName, 'owner')) {
      console.log(`Marked ${keyName} as rotated today`);
    } else {
      console.log(`Unknown key: ${keyName}`);
      process.exit(1);
    }

  } else if (cmd === 'init') {
    initializeAllKeys();
    console.log('All keys baselined to today');

  } else {
    console.log('Usage: node dist/key-rotation.js <status|check|rotated|init>');
  }
}
