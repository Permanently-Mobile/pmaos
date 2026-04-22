/**
 * Scribe -- database layer.
 *
 * Own SQLite database (store/scribe.db) to avoid WAL contention.
 * Reads conversation_log from main apex.db in read-only mode.
 * Write connection to main DB for Librarian memory operations.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { ScribeRunResult, ClassifiedItem } from './types.js';

// ── Module state ────────────────────────────────────────────────────

let scribeDb: Database.Database;
let mainDb: Database.Database;
let mainWriteDb: Database.Database;
let vecAvailable = false;

// ── Schema ──────────────────────────────────────────────────────────

function createScribeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scribe_state (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scribe_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at          INTEGER NOT NULL,
      completed_at        INTEGER,
      threads_processed   INTEGER NOT NULL DEFAULT 0,
      items_classified    INTEGER NOT NULL DEFAULT 0,
      items_written       INTEGER NOT NULL DEFAULT 0,
      items_skipped       INTEGER NOT NULL DEFAULT 0,
      items_deduplicated  INTEGER NOT NULL DEFAULT 0,
      errors              TEXT,
      trigger_type        TEXT NOT NULL,
      trigger_detail      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scribe_runs_started ON scribe_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS scribe_content_hashes (
      hash        TEXT PRIMARY KEY,
      vault_path  TEXT NOT NULL,
      category    TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scribe_hashes_path ON scribe_content_hashes(vault_path);

    CREATE TABLE IF NOT EXISTS scribe_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL,
      source_msg_ids  TEXT NOT NULL,
      category        TEXT NOT NULL,
      content         TEXT NOT NULL,
      project         TEXT,
      topic           TEXT,
      confidence      REAL NOT NULL,
      vault_path      TEXT,
      was_duplicate   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scribe_items_run ON scribe_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_scribe_items_category ON scribe_items(category);

    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash  TEXT PRIMARY KEY,
      embedding     BLOB NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_cache_created ON embedding_cache(created_at);

    CREATE TABLE IF NOT EXISTS dedup_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content     TEXT NOT NULL,
      matched_to  TEXT NOT NULL,
      similarity  REAL NOT NULL,
      method      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dedup_log_created ON dedup_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_vault_links (
      memory_id   INTEGER NOT NULL,
      vault_path  TEXT NOT NULL,
      category    TEXT NOT NULL,
      linked_at   INTEGER NOT NULL,
      PRIMARY KEY (memory_id, vault_path)
    );

    CREATE INDEX IF NOT EXISTS idx_mvl_vault ON memory_vault_links(vault_path);
  `);
}

// ── Init ────────────────────────────────────────────────────────────

/**
 * Initialize both databases:
 * - scribe.db (read/write) for Scribe's own state
 * - apex.db (read-only) for conversation_log access
 */
export function initScribeDb(mainRoot: string, scribeStoreDir: string): void {
  // Scribe's own database
  fs.mkdirSync(scribeStoreDir, { recursive: true });
  const scribeDbPath = path.join(scribeStoreDir, 'scribe.db');
  scribeDb = new Database(scribeDbPath);

  const env = readEnvFile(['DB_PASSPHRASE']);
  if (env.DB_PASSPHRASE) {
    // DBs use default cipher (not sqlcipher).
    scribeDb.pragma(`key='${env.DB_PASSPHRASE}'`);
  }
  scribeDb.pragma('journal_mode = WAL');
  scribeDb.pragma('busy_timeout = 5000');
  createScribeSchema(scribeDb);

  // Main database (read-only for conversation_log)
  const mainDbPath = path.join(mainRoot, 'store', 'apex.db');
  if (!fs.existsSync(mainDbPath)) {
    throw new Error(`Main database not found: ${mainDbPath}`);
  }
  mainDb = new Database(mainDbPath, { readonly: true });
  if (env.DB_PASSPHRASE) {
    // DBs use default cipher (not sqlcipher).
    mainDb.pragma(`key='${env.DB_PASSPHRASE}'`);
  }

  logger.info({ scribeDbPath, mainDbPath }, 'Scribe databases initialized');
}

/** For tests only. */
export function _initTestScribeDb(): void {
  scribeDb = new Database(':memory:');
  createScribeSchema(scribeDb);
  mainDb = new Database(':memory:');
}

// ── Watermark ───────────────────────────────────────────────────────

export function getLastProcessedId(): number {
  const row = scribeDb
    .prepare('SELECT value FROM scribe_state WHERE key = ?')
    .get('last_processed_id') as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function setLastProcessedId(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `INSERT OR REPLACE INTO scribe_state (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run('last_processed_id', String(id), now);
}

// ── Conversation log access ─────────────────────────────────────────

export interface RawConversationTurn {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

/**
 * Get unprocessed messages from main DB's conversation_log.
 * Orders ascending so we process oldest-first.
 */
export function getUnprocessedMessages(afterId: number, limit = 500): RawConversationTurn[] {
  return mainDb
    .prepare(
      `SELECT id, chat_id, session_id, role, content, created_at
       FROM conversation_log
       WHERE id > ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(afterId, limit) as RawConversationTurn[];
}

/**
 * Get messages within a time window (for lookback-days mode).
 */
export function getMessagesSince(sinceTimestamp: number, limit = 2000): RawConversationTurn[] {
  return mainDb
    .prepare(
      `SELECT id, chat_id, session_id, role, content, created_at
       FROM conversation_log
       WHERE created_at >= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(sinceTimestamp, limit) as RawConversationTurn[];
}

// ── Run logging ─────────────────────────────────────────────────────

export function startScribeRun(triggerType: string, triggerDetail?: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = scribeDb.prepare(
    `INSERT INTO scribe_runs (started_at, trigger_type, trigger_detail) VALUES (?, ?, ?)`,
  ).run(now, triggerType, triggerDetail ?? null);
  return result.lastInsertRowid as number;
}

export function completeScribeRun(runId: number, result: ScribeRunResult): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `UPDATE scribe_runs SET
       completed_at = ?,
       threads_processed = ?,
       items_classified = ?,
       items_written = ?,
       items_skipped = ?,
       items_deduplicated = ?,
       errors = ?
     WHERE id = ?`,
  ).run(
    now,
    result.threadsProcessed,
    result.itemsClassified,
    result.itemsWritten,
    result.itemsSkipped,
    result.itemsDeduplicated,
    result.errors.length > 0 ? JSON.stringify(result.errors) : null,
    runId,
  );
}

// ── Item audit trail ────────────────────────────────────────────────

export function logScribeItem(
  runId: number,
  item: ClassifiedItem,
  vaultPath: string | null,
  wasDuplicate: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `INSERT INTO scribe_items (run_id, source_msg_ids, category, content, project, topic, confidence, vault_path, was_duplicate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    JSON.stringify(item.sourceMessageIds),
    item.category,
    item.content,
    item.project ?? null,
    item.topic ?? null,
    item.confidence,
    vaultPath,
    wasDuplicate ? 1 : 0,
    now,
  );
}

// ── Content hash dedup ──────────────────────────────────────────────

export function computeContentHash(content: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function hasContentHash(hash: string): boolean {
  const row = scribeDb
    .prepare('SELECT 1 FROM scribe_content_hashes WHERE hash = ?')
    .get(hash);
  return !!row;
}

export function saveContentHash(hash: string, vaultPath: string, category: string): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `INSERT OR IGNORE INTO scribe_content_hashes (hash, vault_path, category, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hash, vaultPath, category, now);
}

// ── DB handle access ────────────────────────────────────────────────

/**
 * Get the scribe DB handle for use by embedding-cache and other modules.
 * Throws if DB hasn't been initialized via initScribeDb().
 */
export function getScribeDb(): Database.Database {
  if (!scribeDb) throw new Error('Scribe DB not initialized -- call initScribeDb() first');
  return scribeDb;
}

// ── Dedup audit log ─────────────────────────────────────────────────

/**
 * Log a dedup decision to the audit trail.
 * Records what was skipped, what it matched against, similarity score, and method used.
 */
export function logDedupDecision(
  content: string,
  matchedTo: string,
  similarity: number,
  method: 'stem' | 'semantic' | 'cross-vault' | 'task-list' | 'substance-gate',
): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `INSERT INTO dedup_log (content, matched_to, similarity, method, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(content, matchedTo, similarity, method, now);
}

/**
 * Phase 2: Log items that passed dedup (were NOT duplicates) with their best scores.
 * Enables post-run audit: "these items had scores near the threshold."
 */
export function logDedupPass(
  content: string,
  bestMatch: string,
  bestScore: number,
  method: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `INSERT INTO dedup_log (content, matched_to, similarity, method, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(content, bestMatch || '(no match)', bestScore, `pass:${method}`, now);
}

// ── Main DB write connection (Librarian) ────────────────────────────

/**
 * Initialize a write connection to apex.db for memory operations.
 * Loads sqlite-vec for vec_memories access. Separate from the read-only
 * connection to keep conversation_log reads contention-free.
 */
export function initMainWriteDb(mainRoot: string): void {
  const mainDbPath = path.join(mainRoot, 'store', 'apex.db');
  if (!fs.existsSync(mainDbPath)) {
    logger.warn({ mainDbPath }, 'Main DB not found -- Librarian memory writes disabled');
    return;
  }

  mainWriteDb = new Database(mainDbPath);
  const env = readEnvFile(['DB_PASSPHRASE']);
  if (env.DB_PASSPHRASE) {
    // DBs use default cipher (not sqlcipher).
    mainWriteDb.pragma(`key='${env.DB_PASSPHRASE}'`);
  }
  mainWriteDb.pragma('journal_mode = WAL');
  mainWriteDb.pragma('busy_timeout = 10000');

  // Load sqlite-vec for native vector search on vec_memories
  try {
    sqliteVec.load(mainWriteDb);
    vecAvailable = true;
  } catch (err) {
    logger.warn({ err }, 'sqlite-vec failed to load on write connection -- vector writes disabled');
    vecAvailable = false;
  }

  logger.info({ mainDbPath, vecAvailable }, 'Scribe main write DB initialized (Librarian)');
}

/**
 * Get the write-enabled main DB handle.
 * Throws if not initialized.
 */
export function getMainWriteDb(): Database.Database {
  if (!mainWriteDb) throw new Error('Main write DB not initialized -- call initMainWriteDb() first');
  return mainWriteDb;
}

/** Whether sqlite-vec is available on the write connection. */
export function isVecAvailable(): boolean {
  return vecAvailable;
}

/** Check if the main write DB has been initialized. */
export function hasMainWriteDb(): boolean {
  return !!mainWriteDb;
}

// ── Memory-vault cross-index ────────────────────────────────────────

/**
 * Link a memory ID to a vault file path.
 * Stored in scribe.db for Librarian cross-reference queries.
 */
export function saveMemoryVaultLink(
  memoryId: number,
  vaultPath: string,
  category: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  scribeDb.prepare(
    `INSERT OR REPLACE INTO memory_vault_links (memory_id, vault_path, category, linked_at)
     VALUES (?, ?, ?, ?)`,
  ).run(memoryId, vaultPath, category, now);
}

/**
 * Get all vault paths linked to a memory.
 */
export function getLinksForMemory(
  memoryId: number,
): Array<{ vault_path: string; category: string }> {
  return scribeDb.prepare(
    `SELECT vault_path, category FROM memory_vault_links WHERE memory_id = ?`,
  ).all(memoryId) as Array<{ vault_path: string; category: string }>;
}

/**
 * Get all memory IDs linked to a vault path.
 */
export function getLinksForVaultPath(
  vaultPath: string,
): Array<{ memory_id: number; category: string }> {
  return scribeDb.prepare(
    `SELECT memory_id, category FROM memory_vault_links WHERE vault_path = ?`,
  ).all(vaultPath) as Array<{ memory_id: number; category: string }>;
}
