import Database from 'better-sqlite3-multiple-ciphers';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { readEnvFile, decryptAgeFile } from './env.js';
import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface BridgeMessage {
  id: string;
  from_agent: string;
  to_agent: string;
  msg_type: 'task' | 'result' | 'error' | 'heartbeat';
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'expired';
  payload: string;
  parent_id: string | null;
  priority: number;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
  error: string | null;
}

export interface TaskPayload {
  prompt: string;
  context?: string;
  reply_to_chat_id?: string;
  timeout_minutes?: number;
  session_id?: string;  // Links task to a shared context session
}

export interface ResultPayload {
  summary: string;
  report_path?: string;
  tokens_used?: number;
  cost_usd?: number;
  // Track 4: structured result fields
  status?: 'success' | 'partial' | 'failure';
  artifacts?: string[];
  tags?: string[];
  follow_up?: string;
  data?: Record<string, unknown>;
}

export interface HiveEntry {
  id: number;
  agent: string;
  action: string;
  detail: string | null;
  task_id: string | null;
  created_at: number;
}

export interface QueueStats {
  pending: number;
  claimed: number;
  completed: number;
  failed: number;
  expired: number;
}

// ── Security constants ────────────────────────────────────────────────

/** Allowlist of registered agents. Reject any from_agent/to_agent not in this list. */
export const REGISTERED_AGENTS: ReadonlyArray<string> = [
  'apex-bot',
  'researcher-1', 'coder-1', 'creative-1', 'processor-1',
  'paladin', 'content-board',
];

/** Maximum payload size in bytes (512KB). */
export const MAX_PAYLOAD_BYTES = 524288;

/** Valid priority range. Values outside are clamped. */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 10;

// ── Module state ──────────────────────────────────────────────────────

let db: Database.Database;

function createBridgeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bridge_messages (
      id           TEXT PRIMARY KEY,
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL,
      msg_type     TEXT NOT NULL DEFAULT 'task',
      status       TEXT NOT NULL DEFAULT 'pending',
      payload      TEXT NOT NULL,
      parent_id    TEXT,
      priority     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      claimed_at   INTEGER,
      completed_at INTEGER,
      expires_at   INTEGER,
      error        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bridge_to_status
      ON bridge_messages(to_agent, status, priority DESC, created_at);

    CREATE INDEX IF NOT EXISTS idx_bridge_parent
      ON bridge_messages(parent_id);

    CREATE INDEX IF NOT EXISTS idx_bridge_from_status
      ON bridge_messages(from_agent, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS hive_mind (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent       TEXT NOT NULL,
      action      TEXT NOT NULL,
      detail      TEXT,
      task_id     TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hive_agent_time
      ON hive_mind(agent, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_hive_time
      ON hive_mind(created_at DESC);
  `);
}

// ── Init ──────────────────────────────────────────────────────────────

/**
 * Open (or create) the shared bridge database.
 * The bridge DB lives at {projectRoot}/store/bridge.db -- separate from
 * per-bot apex.db to avoid WAL conflicts across processes.
 */
export function initBridge(projectRoot: string): void {
  const storeDir = path.join(projectRoot, 'store');
  fs.mkdirSync(storeDir, { recursive: true });

  const dbPath = process.env.BRIDGE_DB_PATH || path.join(storeDir, 'bridge.db');
  db = new Database(dbPath);

  // Read passphrase from the project root that OWNS the bridge DB,
  // not from the worker's cwd. Workers run from bots/<name>/ but the
  // bridge DB is encrypted with the main project's passphrase.
  // Checks .env.age (encrypted) first, then .env (plaintext fallback).
  let dbKey = '';
  const mainEnvBase = path.join(projectRoot, '.env');

  // Try encrypted .env.age at main project root (post-Phase 1 hardening)
  const decrypted = decryptAgeFile(mainEnvBase + '.age');
  if (decrypted) {
    const match = decrypted.match(/^DB_PASSPHRASE=(.+)$/m);
    dbKey = match?.[1]?.trim() || '';
  }

  // Fallback: plaintext .env at main project root (dev environments)
  if (!dbKey) {
    try {
      const envContent = fs.readFileSync(mainEnvBase, 'utf-8');
      const match = envContent.match(/^DB_PASSPHRASE=(.+)$/m);
      dbKey = match?.[1]?.trim() || '';
    } catch { /* no plaintext .env */ }
  }

  // Last resort: worker's own .env via standard readEnvFile
  if (!dbKey) dbKey = readEnvFile(['DB_PASSPHRASE']).DB_PASSPHRASE || '';

  if (dbKey) {
    // DBs use default cipher (not sqlcipher). Do NOT add cipher/legacy pragmas.
    db.pragma(`key='${dbKey}'`);
  } else {
    logger.warn('No DB_PASSPHRASE found for bridge DB -- database is NOT encrypted');
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  createBridgeSchema(db);
}

/** @internal - for tests only. */
export function _initTestBridge(): void {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createBridgeSchema(db);
}

// ── Send ──────────────────────────────────────────────────────────────

/**
 * Queue a task for another agent.
 * Returns the message ID (or existing ID if a duplicate is blocked).
 *
 * Dedup gate: rejects tasks with identical prompt text if the same prompt
 * is already pending/claimed OR was completed in the last 4 hours.
 * This prevents scheduled tasks from re-queueing work that already ran.
 */
export function sendTask(
  from: string,
  to: string,
  payload: TaskPayload,
  priority = 0,
  ttlMinutes = 60,
): string {
  // ── Agent identity verification ────────────────────────────────
  if (!REGISTERED_AGENTS.includes(from)) {
    const msg = `Bridge rejected sendTask: unregistered from_agent "${from}"`;
    logger.warn({ from, to }, msg);
    throw new Error(msg);
  }
  if (!REGISTERED_AGENTS.includes(to)) {
    const msg = `Bridge rejected sendTask: unregistered to_agent "${to}"`;
    logger.warn({ from, to }, msg);
    throw new Error(msg);
  }

  // ── Payload size limit ─────────────────────────────────────────
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > MAX_PAYLOAD_BYTES) {
    const msg = `Bridge rejected sendTask: payload size ${payloadStr.length} bytes exceeds limit of ${MAX_PAYLOAD_BYTES} bytes (512KB)`;
    logger.warn({ from, to, size: payloadStr.length }, msg);
    throw new Error(msg);
  }

  // ── Priority clamping ──────────────────────────────────────────
  if (priority < PRIORITY_MIN || priority > PRIORITY_MAX) {
    logger.warn(
      { from, to, originalPriority: priority },
      `Bridge clamping priority ${priority} to range ${PRIORITY_MIN}-${PRIORITY_MAX}`,
    );
    priority = Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, priority));
  }

  // ── Dedup gate ───────────────────────────────────────────────────
  // Normalize: lowercase, strip punctuation/extra whitespace for fuzzy match.
  // This catches prompts regenerated by Claude with minor wording variations
  // (e.g. possessives, curly quotes vs straight quotes).
  const normalizePrompt = (s: string): string =>
    s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

  const dedupCutoff = Math.floor(Date.now() / 1000) - 4 * 3600; // 4 hours
  const incomingNorm = normalizePrompt(payload.prompt);

  // Check pending/claimed (any age) + recently completed
  const recent = db.prepare(`
    SELECT id, payload FROM bridge_messages
    WHERE to_agent = ? AND msg_type = 'task'
      AND (
        status IN ('pending', 'claimed')
        OR (status = 'completed' AND created_at > ?)
      )
  `).all(to, dedupCutoff) as Array<{ id: string; payload: string }>;

  for (const row of recent) {
    try {
      const existing = JSON.parse(row.payload) as TaskPayload;
      const existingNorm = normalizePrompt(existing.prompt);
      // Exact normalized match
      if (existingNorm === incomingNorm) {
        logger.info(
          { to, existingId: row.id, promptPreview: payload.prompt.slice(0, 60) },
          'Bridge dedup: identical prompt already queued or completed recently',
        );
        return row.id;
      }
      // Fuzzy match: if first 300 normalized chars match, it's likely the same task
      // with minor regeneration differences. Using 300 instead of 100 so templated
      // prompts (e.g. YouTube video research) with different URLs aren't falsely deduped.
      if (incomingNorm.length > 80 && existingNorm.length > 80
        && incomingNorm.slice(0, 300) === existingNorm.slice(0, 300)) {
        logger.info(
          { to, existingId: row.id, promptPreview: payload.prompt.slice(0, 60) },
          'Bridge dedup: fuzzy match (same prompt prefix) -- blocking duplicate',
        );
        return row.id;
      }
    } catch { /* skip malformed payloads */ }
  }

  // ── Insert new task ──────────────────────────────────────────────
  const id = randomBytes(8).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;

  db.prepare(`
    INSERT INTO bridge_messages (id, from_agent, to_agent, msg_type, status, payload, priority, created_at, expires_at)
    VALUES (?, ?, ?, 'task', 'pending', ?, ?, ?, ?)
  `).run(id, from, to, payloadStr, priority, now, expiresAt);

  hiveLog(from, 'dispatch', `-> ${to}: ${payload.prompt.slice(0, 120)}`, id);
  return id;
}

// ── Claim ─────────────────────────────────────────────────────────────

/**
 * Atomically claim the next pending task for this agent.
 * Returns the message or null if the queue is empty.
 * Uses a transaction to prevent double-claims across processes.
 */
export function claimNextTask(agentName: string): BridgeMessage | null {
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM bridge_messages
      WHERE to_agent = ? AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY priority DESC, created_at
      LIMIT 1
    `).get(agentName, now) as BridgeMessage | undefined;

    if (!row) return null;

    db.prepare(`
      UPDATE bridge_messages SET status = 'claimed', claimed_at = ? WHERE id = ?
    `).run(now, row.id);

    return { ...row, status: 'claimed' as const, claimed_at: now };
  });

  const result = txn();
  if (result) {
    try {
      const p = JSON.parse(result.payload) as TaskPayload;
      hiveLog(agentName, 'claim', p.prompt?.slice(0, 120), result.id);
    } catch { hiveLog(agentName, 'claim', '', result.id); }
  }
  return result;
}

// ── Complete / Fail ───────────────────────────────────────────────────

/**
 * Mark a task as completed and store the result payload.
 * Also inserts a 'result' message addressed back to the original sender.
 *
 * @param callerAgent - Optional: the agent calling this function. If provided,
 *   must match the task's to_agent (ownership check). If omitted, allowed for
 *   backward compatibility but logs a warning for future enforcement.
 */
export function completeTask(messageId: string, resultPayload: ResultPayload, callerAgent?: string): void {
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    // Get original message first for ownership check
    const original = db.prepare(`SELECT * FROM bridge_messages WHERE id = ?`).get(messageId) as BridgeMessage | undefined;
    if (!original) return;

    // ── Ownership verification ───────────────────────────────────
    if (callerAgent) {
      if (callerAgent !== original.to_agent) {
        const msg = `Bridge rejected completeTask: caller "${callerAgent}" is not the assigned agent "${original.to_agent}" for task ${messageId}`;
        logger.warn({ messageId, callerAgent, to_agent: original.to_agent }, msg);
        throw new Error(msg);
      }
    } else {
      logger.warn(
        { messageId, to_agent: original.to_agent },
        'completeTask called without callerAgent -- ownership not verified (backward compat)',
      );
    }

    // Update original task
    db.prepare(`
      UPDATE bridge_messages SET status = 'completed', completed_at = ? WHERE id = ?
    `).run(now, messageId);

    // Insert result message going back to the sender
    const resultId = randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO bridge_messages (id, from_agent, to_agent, msg_type, status, payload, parent_id, priority, created_at)
      VALUES (?, ?, ?, 'result', 'completed', ?, ?, 0, ?)
    `).run(resultId, original.to_agent, original.from_agent, JSON.stringify(resultPayload), messageId, now);

    hiveLog(original.to_agent, 'complete', resultPayload.summary?.slice(0, 120), messageId);
  });

  txn();
}

/**
 * Mark a task as failed with an error message.
 * Inserts an error message back to the sender.
 *
 * @param callerAgent - Optional: the agent calling this function. If provided,
 *   must match the task's to_agent (ownership check). If omitted, allowed for
 *   backward compatibility but logs a warning for future enforcement.
 */
export function failTask(messageId: string, errorMessage: string, callerAgent?: string): void {
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    // Get original message first for ownership check
    const original = db.prepare(`SELECT * FROM bridge_messages WHERE id = ?`).get(messageId) as BridgeMessage | undefined;
    if (!original) return;

    // ── Ownership verification ───────────────────────────────────
    if (callerAgent) {
      if (callerAgent !== original.to_agent) {
        const msg = `Bridge rejected failTask: caller "${callerAgent}" is not the assigned agent "${original.to_agent}" for task ${messageId}`;
        logger.warn({ messageId, callerAgent, to_agent: original.to_agent }, msg);
        throw new Error(msg);
      }
    } else {
      logger.warn(
        { messageId, to_agent: original.to_agent },
        'failTask called without callerAgent -- ownership not verified (backward compat)',
      );
    }

    db.prepare(`
      UPDATE bridge_messages SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
    `).run(now, errorMessage, messageId);

    const errorId = randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO bridge_messages (id, from_agent, to_agent, msg_type, status, payload, parent_id, priority, created_at, error)
      VALUES (?, ?, ?, 'error', 'completed', ?, ?, 0, ?, ?)
    `).run(errorId, original.to_agent, original.from_agent, JSON.stringify({ error_message: errorMessage, original_prompt: JSON.parse(original.payload).prompt?.slice(0, 200) }), messageId, now, errorMessage);

    hiveLog(original.to_agent, 'fail', errorMessage.slice(0, 120), messageId);
  });

  txn();
}

// ── Read results ──────────────────────────────────────────────────────

/**
 * Get completed result/error messages addressed to this agent.
 */
export function getCompletedResults(agentName: string, limit = 10): BridgeMessage[] {
  return db.prepare(`
    SELECT * FROM bridge_messages
    WHERE to_agent = ? AND status = 'completed' AND msg_type IN ('result', 'error')
    ORDER BY created_at
    LIMIT ?
  `).all(agentName, limit) as BridgeMessage[];
}

/**
 * Remove a result message after it has been delivered.
 */
export function acknowledgeResult(messageId: string): void {
  db.prepare(`DELETE FROM bridge_messages WHERE id = ?`).run(messageId);
}

// ── Maintenance ───────────────────────────────────────────────────────

/**
 * Expire stale messages:
 * - Pending tasks past their expires_at -> 'expired'
 * - Claimed tasks running longer than maxClaimedMinutes -> 'failed'
 * Returns count of affected messages.
 */
export function expireStale(maxClaimedMinutes = 60): number {
  const now = Math.floor(Date.now() / 1000);
  const claimedCutoff = now - maxClaimedMinutes * 60;

  const txn = db.transaction(() => {
    // Expire unclaimed tasks past TTL
    const expired = db.prepare(`
      UPDATE bridge_messages SET status = 'expired', completed_at = ?
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, now);

    // Fail long-running claimed tasks (worker probably crashed)
    const timedOut = db.prepare(`
      UPDATE bridge_messages SET status = 'failed', completed_at = ?, error = 'Timed out (worker may have crashed)'
      WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?
    `).run(now, claimedCutoff);

    return (expired.changes ?? 0) + (timedOut.changes ?? 0);
  });

  return txn();
}

// ── Stats ─────────────────────────────────────────────────────────────

/**
 * Get queue statistics.
 */
export function getQueueStats(): QueueStats {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM bridge_messages GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const stats: QueueStats = { pending: 0, claimed: 0, completed: 0, failed: 0, expired: 0 };
  for (const row of rows) {
    if (row.status in stats) {
      stats[row.status as keyof QueueStats] = row.count;
    }
  }
  return stats;
}

/**
 * Get the original task message by ID (for looking up context).
 */
export function getTaskById(messageId: string): BridgeMessage | null {
  return (db.prepare(`SELECT * FROM bridge_messages WHERE id = ?`).get(messageId) as BridgeMessage) ?? null;
}

// ── Hive Mind (cross-agent activity ledger) ──────────────────────────

/**
 * Log an activity entry to the hive mind.
 * Called automatically by bridge operations + manually by workers.
 */
export function hiveLog(agent: string, action: string, detail?: string, taskId?: string): void {
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO hive_mind (agent, action, detail, task_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(agent, action, detail ?? null, taskId ?? null, now);
  } catch {
    // Swallow -- hive logging should never break bridge operations
  }
}

/** Get the most recent N activity entries across all agents. */
export function hiveRecent(limit = 50): HiveEntry[] {
  return db.prepare(`
    SELECT * FROM hive_mind ORDER BY created_at DESC LIMIT ?
  `).all(limit) as HiveEntry[];
}

/** Get the most recent N activity entries for a single agent. */
export function hiveByAgent(agent: string, limit = 20): HiveEntry[] {
  return db.prepare(`
    SELECT * FROM hive_mind WHERE agent = ? ORDER BY created_at DESC LIMIT ?
  `).all(agent, limit) as HiveEntry[];
}

/** Get the last-seen timestamp for every agent that has logged activity. */
export function hiveLastSeen(): Record<string, number> {
  const rows = db.prepare(`
    SELECT agent, MAX(created_at) as last_seen FROM hive_mind GROUP BY agent
  `).all() as Array<{ agent: string; last_seen: number }>;
  const result: Record<string, number> = {};
  for (const r of rows) result[r.agent] = r.last_seen;
  return result;
}

/** Delete hive entries older than maxAgeDays. Returns count deleted. */
export function hivePrune(maxAgeDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  return db.prepare(`DELETE FROM hive_mind WHERE created_at < ?`).run(cutoff).changes ?? 0;
}

// ── Reaper (bridge cleanup) ────────────────────────────────────────────

/**
 * Ensure the bridge_archive table exists.
 * Called by the reaper on first run -- additive, no existing tables touched.
 */
export function ensureArchiveSchema(): void {
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

/**
 * Get expired tasks bucketed by retryability.
 * Retryable: expired <24h ago, msg_type = 'task'.
 * Dead: everything else that's expired.
 */
export function getExpiredTasks(): { retryable: BridgeMessage[]; dead: BridgeMessage[] } {
  const now = Math.floor(Date.now() / 1000);
  const retryCutoff = now - 24 * 3600; // 24h ago

  const all = db.prepare(`
    SELECT * FROM bridge_messages WHERE status = 'expired'
  `).all() as BridgeMessage[];

  const retryable: BridgeMessage[] = [];
  const dead: BridgeMessage[] = [];

  for (const msg of all) {
    const completedAt = msg.completed_at ?? msg.created_at;
    if (msg.msg_type === 'task' && completedAt > retryCutoff) {
      retryable.push(msg);
    } else {
      dead.push(msg);
    }
  }

  return { retryable, dead };
}

/**
 * Re-queue an expired task as a new pending message.
 * Creates a fresh message with new ID and TTL. Original stays as-is.
 * Returns the new message ID.
 */
export function retryExpiredTask(original: BridgeMessage, ttlMinutes = 720): string {
  const id = randomBytes(8).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;

  // Prefix the payload prompt with [RETRY] marker
  let payload: TaskPayload;
  try {
    payload = JSON.parse(original.payload) as TaskPayload;
    if (!payload.prompt.startsWith('[RETRY]')) {
      payload.prompt = `[RETRY] ${payload.prompt}`;
    }
  } catch {
    payload = { prompt: `[RETRY] ${original.payload}` };
  }

  db.prepare(`
    INSERT INTO bridge_messages (id, from_agent, to_agent, msg_type, status, payload, priority, created_at, expires_at)
    VALUES (?, ?, ?, 'task', 'pending', ?, ?, ?, ?)
  `).run(id, original.from_agent, original.to_agent, JSON.stringify(payload), original.priority, now, expiresAt);

  hiveLog('reaper', 'retry', `Retried ${original.id} -> ${id} for ${original.to_agent}`, id);
  return id;
}

/**
 * Move old completed/expired/failed tasks to bridge_archive.
 * Returns count of archived records.
 */
export function archiveOldTasks(olderThanDays = 7): number {
  ensureArchiveSchema();
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    // Copy to archive
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO bridge_archive
        (id, from_agent, to_agent, msg_type, status, payload, parent_id, priority,
         created_at, claimed_at, completed_at, expires_at, error, archived_at)
      SELECT id, from_agent, to_agent, msg_type, status, payload, parent_id, priority,
             created_at, claimed_at, completed_at, expires_at, error, ?
      FROM bridge_messages
      WHERE status IN ('completed', 'expired', 'failed')
        AND created_at < ?
    `).run(now, cutoff);

    // Delete from main table
    const deleted = db.prepare(`
      DELETE FROM bridge_messages
      WHERE status IN ('completed', 'expired', 'failed')
        AND created_at < ?
    `).run(cutoff);

    return deleted.changes ?? 0;
  });

  return txn();
}

/**
 * Delete old result/error messages that have been delivered.
 * Returns count of cleaned records.
 */
export function cleanupOldResults(olderThanDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  return db.prepare(`
    DELETE FROM bridge_messages
    WHERE msg_type IN ('result', 'error') AND created_at < ?
  `).run(cutoff).changes ?? 0;
}

/**
 * Get expiry statistics for the past N days.
 * Returns overall rate and per-agent breakdown.
 */
export function getExpiryStats(days = 7): {
  total: number;
  expired: number;
  expiryRate: number;
  byAgent: Array<{ agent: string; expired: number; total: number; rate: number }>;
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
    byAgent: byAgent.map(a => ({
      ...a,
      rate: a.total > 0 ? a.expired / a.total : 0,
    })),
  };
}
