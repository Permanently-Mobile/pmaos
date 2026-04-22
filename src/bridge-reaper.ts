/**
 * Bridge Reaper
 *
 * Cleans up the bridge queue: retries retryable expired tasks, archives dead
 * records, prunes stale hive_mind entries, and alerts on high expiry rates.
 *
 * Run: node dist/bridge-reaper.js [quick|weekly]
 * Schedule: quick every 4h, weekly report Fridays 5am
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { decryptAgeFile } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const VAULT_PATH = process.env.VAULT_ROOT || '';
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');
const NOTIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');

// -- Config -----------------------------------------------------------------

const MAX_RETRIES_PER_RUN = 5;
const ARCHIVE_AFTER_DAYS = 7;
const RESULT_CLEANUP_DAYS = 7;
const HIVE_PRUNE_DAYS = 14;
const EXPIRY_ALERT_THRESHOLD = 0.25; // 25%

// -- Types ------------------------------------------------------------------

interface ReaperFinding {
  severity: 'info' | 'low' | 'medium' | 'high';
  title: string;
  detail: string;
}

interface BridgeRow {
  id: string;
  from_agent: string;
  to_agent: string;
  msg_type: string;
  status: string;
  payload: string;
  parent_id: string | null;
  priority: number;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
  error: string | null;
}

interface ExpiryByAgent {
  agent: string;
  total: number;
  expired: number;
  rate: number;
}

// -- DB helpers (standalone, no initBridge needed) ---------------------------

function openBridgeDb(): Database.Database {
  const dbPath = path.join(PROJECT_ROOT, 'store', 'bridge.db');
  const db = new Database(dbPath);

  // Read passphrase -- try .env.age first, then plaintext .env fallback
  let dbKey = '';
  const mainEnvBase = path.join(PROJECT_ROOT, '.env');

  const decrypted = decryptAgeFile(mainEnvBase + '.age');
  if (decrypted) {
    const match = decrypted.match(/^DB_PASSPHRASE=(.+)$/m);
    dbKey = match?.[1]?.trim() || '';
  }

  if (!dbKey) {
    try {
      const envContent = fs.readFileSync(mainEnvBase, 'utf-8');
      const match = envContent.match(/^DB_PASSPHRASE=(.+)$/m);
      dbKey = match?.[1]?.trim() || '';
    } catch { /* no plaintext .env */ }
  }

  if (dbKey) {
    // DBs use default cipher (not sqlcipher).
    db.pragma(`key='${dbKey}'`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function ensureArchiveTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_archive (
      id           TEXT PRIMARY KEY,
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL,
      msg_type     TEXT NOT NULL,
      status       TEXT NOT NULL,
      payload      TEXT NOT NULL,
      parent_id    TEXT,
      priority     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      claimed_at   INTEGER,
      completed_at INTEGER,
      expires_at   INTEGER,
      error        TEXT,
      archived_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_archive_time
      ON bridge_archive(archived_at DESC);
  `);
}

// -- PM2 check --------------------------------------------------------------

function getOnlineAgents(): Set<string> {
  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) return new Set();
    const list = JSON.parse(raw.substring(start, end + 1)) as Array<{ name: string; pm2_env: { status: string } }>;
    return new Set(list.filter(p => p.pm2_env.status === 'online').map(p => p.name));
  } catch {
    return new Set();
  }
}

// -- Core reaper functions --------------------------------------------------

function getExpiredTasks(db: Database.Database): { retryable: BridgeRow[]; dead: BridgeRow[] } {
  const now = Math.floor(Date.now() / 1000);
  const retryCutoff = now - 24 * 3600;

  const all = db.prepare(`SELECT * FROM bridge_messages WHERE status = 'expired'`).all() as BridgeRow[];
  const onlineAgents = getOnlineAgents();

  const retryable: BridgeRow[] = [];
  const dead: BridgeRow[] = [];

  for (const msg of all) {
    const completedAt = msg.completed_at ?? msg.created_at;
    if (msg.msg_type === 'task' && completedAt > retryCutoff && onlineAgents.has(msg.to_agent)) {
      retryable.push(msg);
    } else {
      dead.push(msg);
    }
  }

  return { retryable, dead };
}

function retryTasks(db: Database.Database, tasks: BridgeRow[]): Array<{ originalId: string; newId: string; agent: string }> {
  const retried: Array<{ originalId: string; newId: string; agent: string }> = [];
  const toRetry = tasks.slice(0, MAX_RETRIES_PER_RUN);

  for (const task of toRetry) {
    try {
      const id = randomBytes(8).toString('hex');
      const now = Math.floor(Date.now() / 1000);
      const ttlMinutes = 720; // 12h
      const expiresAt = now + ttlMinutes * 60;

      // Parse payload and add [RETRY] prefix
      let payloadStr: string;
      try {
        const payload = JSON.parse(task.payload);
        if (payload.prompt && !payload.prompt.startsWith('[RETRY]')) {
          payload.prompt = `[RETRY] ${payload.prompt}`;
        }
        payloadStr = JSON.stringify(payload);
      } catch {
        payloadStr = task.payload;
      }

      db.prepare(`
        INSERT INTO bridge_messages (id, from_agent, to_agent, msg_type, status, payload, priority, created_at, expires_at)
        VALUES (?, ?, ?, 'task', 'pending', ?, ?, ?, ?)
      `).run(id, task.from_agent, task.to_agent, payloadStr, task.priority, now, expiresAt);

      // Log retry in hive_mind
      db.prepare(`
        INSERT INTO hive_mind (agent, action, detail, task_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('reaper', 'retry', `Retried ${task.id} -> ${id} for ${task.to_agent}`, id, now);

      retried.push({ originalId: task.id, newId: id, agent: task.to_agent });
    } catch (err) {
      console.error(`Failed to retry task ${task.id}:`, err);
    }
  }

  return retried;
}

function archiveDeadTasks(db: Database.Database): number {
  ensureArchiveTable(db);
  const cutoff = Math.floor(Date.now() / 1000) - ARCHIVE_AFTER_DAYS * 86400;
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO bridge_archive
        (id, from_agent, to_agent, msg_type, status, payload, parent_id, priority,
         created_at, claimed_at, completed_at, expires_at, error, archived_at)
      SELECT id, from_agent, to_agent, msg_type, status, payload, parent_id, priority,
             created_at, claimed_at, completed_at, expires_at, error, ?
      FROM bridge_messages
      WHERE status IN ('completed', 'expired', 'failed')
        AND created_at < ?
    `).run(now, cutoff);

    const deleted = db.prepare(`
      DELETE FROM bridge_messages
      WHERE status IN ('completed', 'expired', 'failed')
        AND created_at < ?
    `).run(cutoff);

    return deleted.changes ?? 0;
  });

  return txn();
}

function cleanupResults(db: Database.Database): number {
  const cutoff = Math.floor(Date.now() / 1000) - RESULT_CLEANUP_DAYS * 86400;
  return db.prepare(`
    DELETE FROM bridge_messages
    WHERE msg_type IN ('result', 'error') AND created_at < ?
  `).run(cutoff).changes ?? 0;
}

function pruneHive(db: Database.Database): number {
  const cutoff = Math.floor(Date.now() / 1000) - HIVE_PRUNE_DAYS * 86400;
  return db.prepare(`DELETE FROM hive_mind WHERE created_at < ?`).run(cutoff).changes ?? 0;
}

function getQueueSnapshot(db: Database.Database): Record<string, number> {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM bridge_messages GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const snap: Record<string, number> = { pending: 0, claimed: 0, completed: 0, failed: 0, expired: 0 };
  for (const row of rows) snap[row.status] = row.count;
  return snap;
}

function getExpiryStats(db: Database.Database, days = 7): {
  total: number; expired: number; expiryRate: number; byAgent: ExpiryByAgent[];
} {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const overall = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
    FROM bridge_messages
    WHERE msg_type = 'task' AND created_at >= ?
  `).get(cutoff) as { total: number; expired: number };

  const byAgent = db.prepare(`
    SELECT
      to_agent as agent,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
    FROM bridge_messages
    WHERE msg_type = 'task' AND created_at >= ?
    GROUP BY to_agent
    ORDER BY expired DESC
  `).all(cutoff) as Array<{ agent: string; total: number; expired: number }>;

  return {
    total: overall.total,
    expired: overall.expired,
    expiryRate: overall.total > 0 ? overall.expired / overall.total : 0,
    byAgent: byAgent.map(a => ({ ...a, rate: a.total > 0 ? a.expired / a.total : 0 })),
  };
}

function getArchiveCount(db: Database.Database): number {
  try {
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_archive'",
    ).get();
    if (!tableCheck) return 0;
    return (db.prepare('SELECT COUNT(*) as count FROM bridge_archive').get() as { count: number }).count;
  } catch {
    return 0;
  }
}

// -- Notify -----------------------------------------------------------------

function notify(message: string): void {
  try {
    execSync(`bash "${NOTIFY_SCRIPT}" "${message.replace(/"/g, '\\"')}"`, {
      timeout: 10000,
      windowsHide: true,
      stdio: 'pipe',
    });
  } catch {
    console.error('Notify failed (non-fatal)');
  }
}

// -- Run modes --------------------------------------------------------------

function runQuick(): void {
  console.log('Reaper: quick cleanup...');

  const db = openBridgeDb();

  try {
    // 1. Identify retryable expired tasks
    const { retryable, dead } = getExpiredTasks(db);
    console.log(`  Expired: ${retryable.length} retryable, ${dead.length} dead`);

    // 2. Retry eligible tasks
    const retried = retryTasks(db, retryable);
    if (retried.length > 0) {
      console.log(`  Retried: ${retried.length} tasks`);
      for (const r of retried) {
        console.log(`    ${r.originalId} -> ${r.newId} (${r.agent})`);
      }
    }

    // 3. Archive old records
    const archived = archiveDeadTasks(db);
    console.log(`  Archived: ${archived} old records`);

    // 4. Clean old results
    const cleaned = cleanupResults(db);
    console.log(`  Results cleaned: ${cleaned}`);

    // 5. Prune hive mind
    const pruned = pruneHive(db);
    console.log(`  Hive pruned: ${pruned} entries`);

    // 6. Check expiry rate and alert if needed
    const stats = getExpiryStats(db);
    if (stats.expiryRate > EXPIRY_ALERT_THRESHOLD && stats.total >= 5) {
      const pct = (stats.expiryRate * 100).toFixed(0);
      const msg = `Reaper alert: ${pct}% expiry rate (${stats.expired}/${stats.total} tasks in 7d)`;
      console.log(`  ALERT: ${msg}`);
      notify(msg);
    }

    console.log('Reaper: quick cleanup done.');
  } finally {
    db.close();
  }
}

function runWeekly(): void {
  const reportDate = new Date().toISOString().split('T')[0];
  console.log(`Reaper: weekly report for ${reportDate}...`);

  const db = openBridgeDb();

  try {
    // Gather all data
    const { retryable, dead } = getExpiredTasks(db);
    const retried = retryTasks(db, retryable);
    const archived = archiveDeadTasks(db);
    const cleaned = cleanupResults(db);
    const pruned = pruneHive(db);
    const stats = getExpiryStats(db);
    const snapshot = getQueueSnapshot(db);
    const archiveCount = getArchiveCount(db);
    const alertTriggered = stats.expiryRate > EXPIRY_ALERT_THRESHOLD && stats.total >= 5;

    // Collect findings
    const findings: ReaperFinding[] = [];

    if (alertTriggered) {
      findings.push({
        severity: 'high',
        title: 'High expiry rate',
        detail: `${(stats.expiryRate * 100).toFixed(0)}% of tasks expired in the last 7 days (${stats.expired}/${stats.total})`,
      });
    }

    for (const agent of stats.byAgent) {
      if (agent.expired > 3 && agent.rate > 0.5) {
        findings.push({
          severity: 'medium',
          title: `${agent.agent} has high expiry`,
          detail: `${agent.expired}/${agent.total} tasks expired (${(agent.rate * 100).toFixed(0)}%)`,
        });
      }
    }

    if (snapshot.pending > 10) {
      findings.push({
        severity: 'low',
        title: 'Large pending queue',
        detail: `${snapshot.pending} tasks pending -- agents may be offline or overloaded`,
      });
    }

    if (archived > 50) {
      findings.push({
        severity: 'info',
        title: 'Heavy archive cycle',
        detail: `${archived} records archived this run -- normal after a busy week`,
      });
    }

    const status = findings.some(f => f.severity === 'high') ? 'flagged' : 'clean';

    // Generate markdown
    let md = `---
type: audit
tags: [audit, bridge-health, infrastructure]
created: ${reportDate}
status: ${status}
---

# Bridge Health Report - ${reportDate}

## Summary
| Metric | Value |
|--------|-------|
| Expired found | ${retryable.length + dead.length} |
| Retried | ${retried.length} |
| Archived | ${archived} |
| Results cleaned | ${cleaned} |
| Hive pruned | ${pruned} |
| Archive total | ${archiveCount} |
| Expiry rate (7d) | ${(stats.expiryRate * 100).toFixed(1)}% |
| Alert triggered | ${alertTriggered ? 'YES' : 'No'} |

## Queue Snapshot
| Status | Count |
|--------|-------|
`;

    for (const [s, count] of Object.entries(snapshot)) {
      md += `| ${s} | ${count} |\n`;
    }

    md += `
## Expiry Rate by Agent (7 days)
| Agent | Total | Expired | Rate | Status |
|-------|-------|---------|------|--------|
`;

    if (stats.byAgent.length === 0) {
      md += `| (no tasks in period) | - | - | - | - |\n`;
    } else {
      for (const a of stats.byAgent) {
        const pct = (a.rate * 100).toFixed(0);
        const flag = a.rate > 0.5 && a.expired > 3 ? 'FLAG' : 'OK';
        md += `| ${a.agent} | ${a.total} | ${a.expired} | ${pct}% | ${flag} |\n`;
      }
    }

    if (retried.length > 0) {
      md += `
## Retry Log
| Original ID | New ID | Agent |
|-------------|--------|-------|
`;
      for (const r of retried) {
        md += `| ${r.originalId.slice(0, 12)}... | ${r.newId.slice(0, 12)}... | ${r.agent} |\n`;
      }
    }

    md += `
## Flags
`;

    if (findings.length === 0) {
      md += `No flags - all clear.\n`;
    } else {
      for (const f of findings) {
        md += `- [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}\n`;
      }
    }

    // Write to vault
    const outputDir = path.join(VAULT_PATH, 'Audits', 'Bridge Health');
    const outputPath = path.join(outputDir, `${reportDate} - Bridge Health.md`);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, md, 'utf-8');
    console.log(`Report written to: ${outputPath}`);

    // Vault commit
    try {
      execSync(`bash "${VAULT_COMMIT_SCRIPT}" "bridge health audit - ${reportDate}"`, {
        cwd: VAULT_PATH,
        stdio: 'pipe',
        windowsHide: true,
      });
      console.log('Vault commit done.');
    } catch (err) {
      console.error('Vault commit failed (non-fatal):', err);
    }

    // Alert if needed
    if (alertTriggered) {
      notify(`Reaper weekly: ${(stats.expiryRate * 100).toFixed(0)}% expiry rate -- report in vault`);
    }

    console.log('Reaper: weekly report done.');
  } finally {
    db.close();
  }
}

// -- CLI entry point --------------------------------------------------------

const mode = process.argv[2] || 'quick';

if (mode === 'weekly') {
  runWeekly();
} else {
  runQuick();
}
