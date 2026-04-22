/**
 * Shared Learning System
 *
 * Self-improving knowledge base shared across all agents.
 * Uses SQLite FTS5 for BM25-ranked search with temporal decay.
 * Storage in bridge.db for cross-agent access.
 *
 * Extracted from CashClaw's BM25 + temporal decay pattern,
 * adapted for our SQLite-based multi-agent architecture.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';

import { readEnvFile, decryptAgeFile } from '../env.js';
import { logger } from '../logger.js';
import { createLearningSchema } from './schema.js';

// Re-export everything
export { storeKnowledge, getKnowledge, getKnowledgeByAgent, deleteKnowledge, getKnowledgeStats } from './knowledge.js';
export { storeFeedback, getFeedback, getFeedbackStats } from './feedback.js';
export { searchLearning, searchKnowledge, searchFeedback } from './search.js';
export type { KnowledgeEntry, KnowledgeStats } from './knowledge.js';
export type { FeedbackEntry, FeedbackStats } from './feedback.js';
export type { SearchHit, SearchOptions } from './search.js';

// ── Module state ──────────────────────────────────────────────────────

let db: Database.Database | null = null;

/**
 * Initialize the learning system.
 * Opens a connection to bridge.db and ensures the learning tables exist.
 *
 * @param projectRoot - The main project-apex root (where store/bridge.db lives)
 */
export function initLearning(projectRoot: string): void {
  if (db) return; // already initialized

  const storeDir = path.join(projectRoot, 'store');
  const dbPath = process.env.BRIDGE_DB_PATH || path.join(storeDir, 'bridge.db');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Bridge database not found at ${dbPath}. Initialize the bridge first.`);
  }

  db = new Database(dbPath);

  // Read encryption key (same logic as bridge.ts)
  let dbKey = '';
  const mainEnvBase = path.join(projectRoot, '.env');

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

  if (!dbKey) dbKey = readEnvFile(['DB_PASSPHRASE']).DB_PASSPHRASE || '';

  if (dbKey) {
    // DBs use default cipher (not sqlcipher).
    db.pragma(`key='${dbKey}'`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  createLearningSchema(db);
  logger.info('Learning system initialized');
}

/**
 * Get the database reference. Throws if not initialized.
 */
export function getLearningDb(): Database.Database {
  if (!db) {
    throw new Error('Learning system not initialized. Call initLearning() first.');
  }
  return db;
}

/**
 * Initialize for testing with an in-memory database.
 */
export function _initTestLearning(): void {
  db = new Database(':memory:');
  createLearningSchema(db);
}
