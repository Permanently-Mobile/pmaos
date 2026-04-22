/**
 * Service Health Audit
 *
 * Checks pm2 process status, error logs, bridge queue health, and database sizes.
 * Generates a markdown report saved to the Obsidian vault.
 *
 * Run: node dist/audit-service-health.js
 * Schedule: Every Monday at 9:30am (0 30 9 * * 1)
 */

import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const VAULT_PATH = process.env.VAULT_ROOT || '';
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');
const NOTIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');

function notify(message: string): void {
  try {
    execSync(`bash "${NOTIFY_SCRIPT}" "${message.replace(/"/g, '\\"')}"`, {
      timeout: 10000, windowsHide: true, stdio: 'pipe',
    });
  } catch { /* non-fatal */ }
}

// -- Types ------------------------------------------------------------------

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

interface ProcessStatus {
  name: string;
  status: string;
  uptime: string;
  restarts: number;
  memory: string;
  memoryMB: number;
  cpu: number;
  flags: string[];
  errLogPath?: string;
}

interface ErrorRate {
  name: string;
  errors: number;
  trend: string;
}

interface BridgeHealth {
  pending: number;
  failed: number;
  expired: number;
  pendingOld: number;
}

interface DbSize {
  name: string;
  size: string;
  sizeBytes: number;
  flagged: boolean;
}

// -- Bot definitions --------------------------------------------------------

interface BotDef {
  name: string;
  displayName: string;
  dir: string;
}

// Rename to your agent names and directories
const BOTS: BotDef[] = [
  { name: process.env.BOT_NAME || 'apex-bot', displayName: 'Primary Bot', dir: PROJECT_ROOT },
  { name: 'worker-1', displayName: 'Worker 1', dir: path.join(PROJECT_ROOT, 'bots', 'worker-1') },
  { name: 'research', displayName: 'Research', dir: path.join(PROJECT_ROOT, 'bots', 'research') },
  { name: 'code', displayName: 'Code', dir: path.join(PROJECT_ROOT, 'bots', 'code') },
  { name: 'processor-1', displayName: 'Processor', dir: path.join(PROJECT_ROOT, 'bots', 'processor-1') },
];

// -- Helpers ----------------------------------------------------------------

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

// -- Data gathering ---------------------------------------------------------

function getPM2Processes(): PM2Process[] {
  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    // pm2 sometimes outputs warnings before the JSON array
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    return JSON.parse(raw.substring(start, end + 1)) as PM2Process[];
  } catch (err) {
    console.error('Failed to get pm2 process list:', err);
    return [];
  }
}

function getProcessStatuses(pm2List: PM2Process[]): ProcessStatus[] {
  return pm2List.map(p => {
    const flags: string[] = [];
    const memMB = p.monit.memory / 1_048_576;

    if (p.pm2_env.status !== 'online') flags.push(`Status: ${p.pm2_env.status}`);
    if (p.pm2_env.restart_time > 10) flags.push(`High restart count: ${p.pm2_env.restart_time}`);
    if (memMB > 500) flags.push(`Memory: ${memMB.toFixed(0)}MB (>500MB)`);

    return {
      name: p.name,
      status: p.pm2_env.status,
      uptime: formatUptime(p.pm2_env.pm_uptime),
      restarts: p.pm2_env.restart_time,
      memory: formatBytes(p.monit.memory),
      memoryMB: memMB,
      cpu: p.monit.cpu,
      flags,
      errLogPath: p.pm2_env.pm_err_log_path,
    };
  });
}

function getErrorRates(processes: ProcessStatus[]): ErrorRate[] {
  const results: ErrorRate[] = [];

  for (const proc of processes) {
    let errorCount = 0;

    if (proc.errLogPath) {
      try {
        if (fs.existsSync(proc.errLogPath)) {
          const content = fs.readFileSync(proc.errLogPath, 'utf-8');
          errorCount = content.split('\n').filter(l => l.trim().length > 0).length;
        }
      } catch {
        errorCount = -1;
      }
    }

    results.push({
      name: proc.name,
      errors: errorCount,
      trend: errorCount > 50 ? 'HIGH' : errorCount > 0 ? 'Normal' : 'Clean',
    });
  }

  return results;
}

function getBridgeHealth(): BridgeHealth {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'bridge.db');
  if (!fs.existsSync(dbPath)) {
    return { pending: 0, failed: 0, expired: 0, pendingOld: 0 };
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    // Bridge DB is encrypted -- read passphrase from project root .env
    const mainEnvPath = path.join(PROJECT_ROOT, '.env');
    try {
      const envContent = fs.readFileSync(mainEnvPath, 'utf-8');
      const match = envContent.match(/^DB_PASSPHRASE=(.+)$/m);
      const dbKey = match?.[1]?.trim();
      if (dbKey) {
        // DBs use default cipher (not sqlcipher).
        db.pragma(`key='${dbKey}'`);
      }
    } catch { /* passphrase not found, try without */ }

    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_messages'",
    ).get();
    if (!tableCheck) {
      db.close();
      return { pending: 0, failed: 0, expired: 0, pendingOld: 0 };
    }

    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 3600;

    const pending = (db.prepare(
      "SELECT COUNT(*) as count FROM bridge_messages WHERE status = 'pending'",
    ).get() as { count: number })?.count ?? 0;

    const failed = (db.prepare(
      "SELECT COUNT(*) as count FROM bridge_messages WHERE status = 'failed' AND created_at >= ?",
    ).get(sevenDaysAgo) as { count: number })?.count ?? 0;

    const expired = (db.prepare(
      "SELECT COUNT(*) as count FROM bridge_messages WHERE status = 'expired' AND created_at >= ?",
    ).get(sevenDaysAgo) as { count: number })?.count ?? 0;

    const pendingOld = (db.prepare(
      "SELECT COUNT(*) as count FROM bridge_messages WHERE status = 'pending' AND created_at < ?",
    ).get(twoHoursAgo) as { count: number })?.count ?? 0;

    db.close();
    return { pending, failed, expired, pendingOld };
  } catch (err) {
    console.error('Failed to query bridge DB:', err);
    return { pending: 0, failed: 0, expired: 0, pendingOld: 0 };
  }
}

function getDatabaseSizes(): DbSize[] {
  const results: DbSize[] = [];

  for (const bot of BOTS) {
    const dbPath = path.join(bot.dir, 'store', 'apex.db');

    try {
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        const sizeMB = stats.size / 1_048_576;
        results.push({
          name: bot.displayName,
          size: formatBytes(stats.size),
          sizeBytes: stats.size,
          flagged: sizeMB > 500,
        });
      } else {
        results.push({ name: bot.displayName, size: 'N/A', sizeBytes: 0, flagged: false });
      }
    } catch {
      results.push({ name: bot.displayName, size: 'Error', sizeBytes: 0, flagged: false });
    }
  }

  return results;
}

// -- Main -------------------------------------------------------------------

function run(): void {
  const now = new Date();
  const reportDate = now.toISOString().split('T')[0];

  console.log(`Running service health audit for ${reportDate}...`);

  // Gather data
  const pm2List = getPM2Processes();
  const processes = getProcessStatuses(pm2List);
  const errorRates = getErrorRates(processes);
  const bridge = getBridgeHealth();
  const dbSizes = getDatabaseSizes();

  // Collect flags
  const allFlags: string[] = [];

  for (const p of processes) {
    for (const flag of p.flags) {
      allFlags.push(`[Process ${p.name}] ${flag}`);
    }
  }

  for (const e of errorRates) {
    if (e.errors > 50) {
      allFlags.push(`[Error Rate] ${e.name}: ${e.errors} errors in log`);
    }
  }

  if (bridge.failed > 0) allFlags.push(`[Bridge] ${bridge.failed} failed tasks in past 7 days`);
  if (bridge.pendingOld > 0) allFlags.push(`[Bridge] ${bridge.pendingOld} tasks pending > 2 hours`);

  for (const d of dbSizes) {
    if (d.flagged) allFlags.push(`[Database] ${d.name} DB over 500MB: ${d.size}`);
  }

  const status = allFlags.length > 0 ? 'flagged' : 'clean';

  // -- Generate markdown ----------------------------------------------------

  let md = `---
type: audit
tags: [audit, service-health]
created: ${reportDate}
status: ${status}
---

# Service Health Audit - ${reportDate}

## Process Status
| Process | Status | Uptime | Restarts | Memory | CPU |
|---------|--------|--------|----------|--------|-----|
`;

  if (processes.length === 0) {
    md += `| (pm2 unavailable) | - | - | - | - | - |\n`;
  } else {
    for (const p of processes) {
      md += `| ${p.name} | ${p.status} | ${p.uptime} | ${p.restarts} | ${p.memory} | ${p.cpu}% |\n`;
    }
  }

  md += `
## Error Rates (log totals)
| Bot | Errors | Trend |
|-----|--------|-------|
`;

  for (const e of errorRates) {
    const errDisplay = e.errors === -1 ? 'Unreadable' : String(e.errors);
    md += `| ${e.name} | ${errDisplay} | ${e.trend} |\n`;
  }

  md += `
## Bridge Queue
| Metric | Count | Status |
|--------|-------|--------|
| Pending | ${bridge.pending} | ${bridge.pendingOld > 0 ? 'FLAG' : 'OK'} |
| Failed (7d) | ${bridge.failed} | ${bridge.failed > 0 ? 'FLAG' : 'OK'} |
| Expired (7d) | ${bridge.expired} | ${bridge.expired > 0 ? 'FLAG' : 'OK'} |
`;

  md += `
## Database Sizes
| Bot | DB Size | Status |
|-----|---------|--------|
`;

  for (const d of dbSizes) {
    md += `| ${d.name} | ${d.size} | ${d.flagged ? 'FLAG' : 'OK'} |\n`;
  }

  md += `
## Flags
`;

  if (allFlags.length === 0) {
    md += `No flags - all clear.\n`;
  } else {
    for (const flag of allFlags) {
      md += `- ${flag}\n`;
    }
  }

  // -- Write to vault -------------------------------------------------------

  const outputPath = path.join(VAULT_PATH, 'Audits', 'Service Health', `${reportDate} - Service Health.md`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md, 'utf-8');

  console.log(`Service health audit written to: ${outputPath}`);

  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "service health audit - ${reportDate}"`, {
      cwd: VAULT_PATH,
      stdio: 'pipe',
      windowsHide: true,
    });
    console.log('Vault commit done.');
  } catch (err) {
    console.error('Vault commit failed (non-fatal):', err);
  }

  console.log('Service health audit complete.');

  if (process.argv.includes('--notify')) {
    if (allFlags.length > 0) {
      notify(`Service Health: ${allFlags.length} flags found. ${allFlags.slice(0, 3).join(' | ')}`);
    } else {
      notify('Service Health: all clear.');
    }
  }
}

run();
