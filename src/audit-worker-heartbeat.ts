/**
 * Worker Heartbeat Audit
 *
 * Verifies that scheduled automations and worker agents are producing
 * expected output -- not just running, but delivering results.
 *
 * Checks:
 *   1. Processor nightly run produced vault writes in last 24h
 *   2. Chat transcript exists for yesterday
 *   3. Kiosk log synced to vault for yesterday
 *   4. Daily note has meaningful content (>3 log entries)
 *   5. Processor Quality grade is C or better
 *   6. Bridge has no tasks stuck >4 hours
 *
 * Run: node dist/audit-worker-heartbeat.js
 * Schedule: Daily at 6:15 AM via audit scheduler
 */

import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const _VAULT_ROOT = process.env.VAULT_ROOT;
if (!_VAULT_ROOT) {
  console.error('[heartbeat-audit] VAULT_ROOT environment variable is required');
}
const VAULT_PATH = _VAULT_ROOT as string;
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');
const NOTIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');

// ── Types ─────────────────────────────────────────────────────────────

interface HeartbeatCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function notify(message: string): void {
  try {
    execSync(`bash "${NOTIFY_SCRIPT}" "${message.replace(/"/g, '\\"')}"`, {
      timeout: 10000, windowsHide: true, stdio: 'pipe',
    });
  } catch { /* non-fatal */ }
}

function openMainDb(): Database.Database | null {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'apex.db');
  if (!fs.existsSync(dbPath)) return null;

  try {
    const env = readEnvFile(['DB_PASSPHRASE']);
    const db = new Database(dbPath);
    if (env.DB_PASSPHRASE) {
      // DBs use default cipher (not sqlcipher).
      db.pragma(`key='${env.DB_PASSPHRASE}'`);
    }
    // Verify access
    db.prepare('SELECT 1').get();
    return db;
  } catch {
    return null;
  }
}

// ── Checks ────────────────────────────────────────────────────────────

/**
 * Check 1: Did the processor produce vault writes in the last 24 hours?
 * Uses vault git log to see commits with 'processor' in the message.
 */
function checkScribeOutput(): HeartbeatCheck {
  try {
    const output = execSync(
      `git log --since="24 hours ago" --oneline --all`,
      { cwd: VAULT_PATH, encoding: 'utf8', timeout: 5000, windowsHide: true },
    ).trim();

    const scribeCommits = output.split('\n')
      .filter(line => /processor|nightly/i.test(line));

    if (scribeCommits.length > 0) {
      return {
        name: 'Processor Output',
        status: 'PASS',
        detail: `${scribeCommits.length} Processor-related commit(s) in last 24h`,
      };
    }

    // Check if Scribe's auto-sort produced anything (different commit messages)
    const allCommits = output.split('\n').filter(l => l.trim().length > 0);
    if (allCommits.length > 0) {
      return {
        name: 'Processor Output',
        status: 'WARN',
        detail: `${allCommits.length} vault commits found but none from the processor specifically. Processor nightly may not have run.`,
      };
    }

    return {
      name: 'Processor Output',
      status: 'FAIL',
      detail: 'No vault commits in last 24 hours. Processor is not producing output.',
    };
  } catch (err) {
    return {
      name: 'Processor Output',
      status: 'FAIL',
      detail: `Git check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 2: Does yesterday's chat transcript exist?
 */
function checkChatTranscript(): HeartbeatCheck {
  const yest = yesterday();
  const chatFile = path.join(VAULT_PATH, 'Chats', `${yest}.md`);

  if (fs.existsSync(chatFile)) {
    const stat = fs.statSync(chatFile);
    if (stat.size > 100) {
      return {
        name: 'Chat Transcript',
        status: 'PASS',
        detail: `${yest}.md exists (${Math.round(stat.size / 1024)}KB)`,
      };
    }
    return {
      name: 'Chat Transcript',
      status: 'WARN',
      detail: `${yest}.md exists but is very small (${stat.size} bytes). May be empty.`,
    };
  }

  return {
    name: 'Chat Transcript',
    status: 'FAIL',
    detail: `Missing: Chats/${yest}.md. Nightly chat export did not run.`,
  };
}

/**
 * Check 3: Is yesterday's kiosk log in the vault?
 */
function checkKioskLog(): HeartbeatCheck {
  const yest = yesterday();
  const kioskFile = path.join(VAULT_PATH, 'Kiosk Logs', `${yest}.md`);

  if (fs.existsSync(kioskFile)) {
    const stat = fs.statSync(kioskFile);
    return {
      name: 'Kiosk Log',
      status: 'PASS',
      detail: `${yest}.md synced (${Math.round(stat.size / 1024)}KB)`,
    };
  }

  // Check if a kiosk log exists in the project-apex Kiosk Logs (source)
  const sourceFile = path.join(PROJECT_ROOT, 'Kiosk Logs', `${yest}.md`);
  if (fs.existsSync(sourceFile)) {
    return {
      name: 'Kiosk Log',
      status: 'WARN',
      detail: `${yest}.md exists in project-apex but NOT synced to vault.`,
    };
  }

  return {
    name: 'Kiosk Log',
    status: 'WARN',
    detail: `No kiosk log for ${yest} (no kiosk activity, or sync missed).`,
  };
}

/**
 * Check 4: Does today's daily note have meaningful log entries?
 * Checks today AND yesterday to handle early morning runs.
 */
function checkDailyNote(): HeartbeatCheck {
  const yest = yesterday();
  const todayStr = today();

  // Check yesterday's note first (more important -- should be complete)
  const yesterdayFile = path.join(VAULT_PATH, 'Daily Notes', `${yest}.md`);
  let yestLogCount = 0;

  if (fs.existsSync(yesterdayFile)) {
    const content = fs.readFileSync(yesterdayFile, 'utf-8');
    const lines = content.split('\n');
    let inLog = false;
    for (const line of lines) {
      if (line.trim().startsWith('## Log')) { inLog = true; continue; }
      if (inLog && line.trim().startsWith('## ')) { inLog = false; }
      if (inLog && line.trim().startsWith('- ')) { yestLogCount++; }
    }
  }

  // Check today's note
  const todayFile = path.join(VAULT_PATH, 'Daily Notes', `${todayStr}.md`);
  let todayLogCount = 0;

  if (fs.existsSync(todayFile)) {
    const content = fs.readFileSync(todayFile, 'utf-8');
    const lines = content.split('\n');
    let inLog = false;
    for (const line of lines) {
      if (line.trim().startsWith('## Log')) { inLog = true; continue; }
      if (inLog && line.trim().startsWith('## ')) { inLog = false; }
      if (inLog && line.trim().startsWith('- ')) { todayLogCount++; }
    }
  }

  if (yestLogCount >= 3) {
    return {
      name: 'Daily Note',
      status: 'PASS',
      detail: `Yesterday (${yest}): ${yestLogCount} log entries. Today: ${todayLogCount}.`,
    };
  }

  if (yestLogCount > 0) {
    return {
      name: 'Daily Note',
      status: 'WARN',
      detail: `Yesterday (${yest}): only ${yestLogCount} log entries (expected 3+). Today: ${todayLogCount}.`,
    };
  }

  if (!fs.existsSync(yesterdayFile)) {
    return {
      name: 'Daily Note',
      status: 'FAIL',
      detail: `No daily note for ${yest}. Processor or session logging not running.`,
    };
  }

  return {
    name: 'Daily Note',
    status: 'FAIL',
    detail: `${yest} daily note exists but has 0 log entries. Nothing was logged.`,
  };
}

/**
 * Check 5: What's the latest Processor Quality grade?
 */
function checkScribeQuality(): HeartbeatCheck {
  const qualityDir = path.join(VAULT_PATH, 'Audits', 'Processor Quality');
  if (!fs.existsSync(qualityDir)) {
    return {
      name: 'Processor Quality',
      status: 'WARN',
      detail: 'No Processor Quality audit folder found. Audit may not be configured.',
    };
  }

  try {
    const files = fs.readdirSync(qualityDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    if (files.length === 0) {
      return {
        name: 'Processor Quality',
        status: 'WARN',
        detail: 'No Processor Quality audit reports found.',
      };
    }

    const latest = files[0];
    const content = fs.readFileSync(path.join(qualityDir, latest), 'utf-8');

    // Extract grade from report
    const gradeMatch = content.match(/Grade[:\s]*([A-D][+-]?)/i);
    const grade = gradeMatch ? gradeMatch[1].toUpperCase() : 'UNKNOWN';

    if (grade.startsWith('A') || grade.startsWith('B')) {
      return {
        name: 'Processor Quality',
        status: 'PASS',
        detail: `Latest grade: ${grade} (${latest})`,
      };
    }

    if (grade.startsWith('C')) {
      return {
        name: 'Processor Quality',
        status: 'WARN',
        detail: `Latest grade: ${grade} (${latest}). Acceptable but needs attention.`,
      };
    }

    return {
      name: 'Processor Quality',
      status: 'FAIL',
      detail: `Latest grade: ${grade} (${latest}). Below acceptable threshold.`,
    };
  } catch (err) {
    return {
      name: 'Processor Quality',
      status: 'WARN',
      detail: `Failed to read quality reports: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 6: Are any bridge tasks stuck (pending >4 hours)?
 * Bridge has its own DB at store/bridge.db (separate from apex.db).
 */
function checkBridgeStuck(): HeartbeatCheck {
  const bridgeDbPath = path.join(PROJECT_ROOT, 'store', 'bridge.db');
  if (!fs.existsSync(bridgeDbPath)) {
    return {
      name: 'Bridge Health',
      status: 'WARN',
      detail: 'Bridge database not found at store/bridge.db.',
    };
  }

  let db: Database.Database;
  try {
    const env = readEnvFile(['DB_PASSPHRASE']);
    db = new Database(bridgeDbPath);
    if (env.DB_PASSPHRASE) {
      // DBs use default cipher (not sqlcipher).
      db.pragma(`key='${env.DB_PASSPHRASE}'`);
    }
    db.prepare('SELECT 1').get();
  } catch {
    return {
      name: 'Bridge Health',
      status: 'WARN',
      detail: 'Could not open bridge database.',
    };
  }

  try {
    const fourHoursAgo = Math.floor(Date.now() / 1000) - (4 * 3600);

    const stuck = db.prepare(
      `SELECT COUNT(*) as c FROM bridge_messages
       WHERE status = 'pending' AND created_at < ?`,
    ).get(fourHoursAgo) as { c: number };

    const failed7d = db.prepare(
      `SELECT COUNT(*) as c FROM bridge_messages
       WHERE status = 'failed' AND created_at > ?`,
    ).get(Math.floor(Date.now() / 1000) - (7 * 86400)) as { c: number };

    db.close();

    if (stuck.c > 0) {
      return {
        name: 'Bridge Health',
        status: 'FAIL',
        detail: `${stuck.c} task(s) pending >4 hours. Workers may not be processing. ${failed7d.c} failures in 7d.`,
      };
    }

    if (failed7d.c > 5) {
      return {
        name: 'Bridge Health',
        status: 'WARN',
        detail: `No stuck tasks, but ${failed7d.c} failures in last 7 days (elevated).`,
      };
    }

    return {
      name: 'Bridge Health',
      status: 'PASS',
      detail: `Queue clear. ${failed7d.c} failure(s) in 7d.`,
    };
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    return {
      name: 'Bridge Health',
      status: 'WARN',
      detail: `Bridge check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────

export function runHeartbeatAudit(): HeartbeatCheck[] {
  return [
    checkScribeOutput(),
    checkChatTranscript(),
    checkKioskLog(),
    checkDailyNote(),
    checkScribeQuality(),
    checkBridgeStuck(),
  ];
}

function generateReport(checks: HeartbeatCheck[]): string {
  const dateStr = today();
  const passCount = checks.filter(c => c.status === 'PASS').length;
  const warnCount = checks.filter(c => c.status === 'WARN').length;
  const failCount = checks.filter(c => c.status === 'FAIL').length;

  let overallStatus: string;
  if (failCount > 0) overallStatus = 'FAIL';
  else if (warnCount > 0) overallStatus = 'WARN';
  else overallStatus = 'PASS';

  const statusIcon = { PASS: '\u2705', WARN: '\u26A0\uFE0F', FAIL: '\u274C' };

  const lines = [
    `# Worker Heartbeat Audit - ${dateStr}`,
    '',
    `**Overall**: ${statusIcon[overallStatus as keyof typeof statusIcon]} ${overallStatus} (${passCount} pass, ${warnCount} warn, ${failCount} fail)`,
    '',
    '## Checks',
    '',
    '| Status | Check | Detail |',
    '|--------|-------|--------|',
  ];

  for (const check of checks) {
    const icon = statusIcon[check.status];
    lines.push(`| ${icon} ${check.status} | ${check.name} | ${check.detail} |`);
  }

  // Flags section for audit integration
  lines.push('');
  lines.push('## Flags');
  lines.push('');

  const flags = checks.filter(c => c.status !== 'PASS');
  if (flags.length === 0) {
    lines.push('No flags. All clear.');
  } else {
    for (const f of flags) {
      lines.push(`- [${f.status}] ${f.name}: ${f.detail}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ── CLI entry point ───────────────────────────────────────────────────

if (process.argv[1]?.endsWith('audit-worker-heartbeat.js') || process.argv[1]?.endsWith('audit-worker-heartbeat.ts')) {
  const checks = runHeartbeatAudit();
  const report = generateReport(checks);

  // Save to vault
  const reportDir = path.join(VAULT_PATH, 'Audits', 'Worker Heartbeat');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${today()} - Worker Heartbeat.md`);
  fs.writeFileSync(reportPath, report, 'utf-8');

  // Vault commit
  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "worker heartbeat audit ${today()}"`, {
      timeout: 10000, windowsHide: true, stdio: 'pipe',
    });
  } catch { /* non-fatal */ }

  // Summary to console
  const passCount = checks.filter(c => c.status === 'PASS').length;
  const failCount = checks.filter(c => c.status === 'FAIL').length;
  const warnCount = checks.filter(c => c.status === 'WARN').length;

  console.log(`Worker Heartbeat: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);

  // Alert on failures
  if (failCount > 0) {
    const failNames = checks.filter(c => c.status === 'FAIL').map(c => c.name).join(', ');
    notify(`Worker Heartbeat ALERT: ${failCount} failure(s) -- ${failNames}`);
  }

  console.log(`Report: ${reportPath}`);
}
