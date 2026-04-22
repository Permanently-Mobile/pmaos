import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';

import { STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';

let db: Database.Database;

/** Apply encryption key to a file-backed database. No-op for :memory: databases. */
function applyEncryptionKey(database: Database.Database, dbPath: string): void {
  if (dbPath === ':memory:') return;
  const env = readEnvFile(['DB_PASSPHRASE']);
  const key = env.DB_PASSPHRASE;
  if (key) {
    // DBs use default cipher (not sqlcipher). Do NOT add cipher/legacy pragmas.
    database.pragma(`key='${key}'`);
  } else {
    console.warn('[db] WARNING: No DB_PASSPHRASE found -- database is NOT encrypted');
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      prompt      TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      next_run    INTEGER NOT NULL,
      last_run    INTEGER,
      last_result TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS sessions (
      chat_id   TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      topic_key       TEXT,
      content         TEXT NOT NULL,
      sector          TEXT NOT NULL DEFAULT 'semantic',
      salience        REAL NOT NULL DEFAULT 1.0,
      tier            TEXT NOT NULL DEFAULT 'active',
      agent_id        TEXT NOT NULL DEFAULT 'apex-bot',
      namespace       TEXT NOT NULL DEFAULT 'private',
      access_count    INTEGER NOT NULL DEFAULT 1,
      half_life_hours REAL,
      created_at      INTEGER NOT NULL,
      accessed_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_sector ON memories(chat_id, sector);

    CREATE TABLE IF NOT EXISTS wa_message_map (
      telegram_msg_id INTEGER PRIMARY KEY,
      wa_chat_id      TEXT NOT NULL,
      contact_name    TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wa_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_chat_id  TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_wa_outbox_unsent ON wa_outbox(sent_at) WHERE sent_at IS NULL;

    CREATE TABLE IF NOT EXISTS wa_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON wa_messages(chat_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS conversation_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL,
      session_id  TEXT,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_convo_log_chat ON conversation_log(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      session_id      TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      context_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      did_compact     INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      provider        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_chat ON token_usage(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS slack_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      user_name    TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS discord_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      server_name  TEXT NOT NULL DEFAULT '',
      user_name    TEXT NOT NULL,
      body         TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discord_messages_channel ON discord_messages(channel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS spice_state (
      chat_id        TEXT PRIMARY KEY,
      active_spices  TEXT NOT NULL,
      message_count  INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spice_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      dimension       TEXT NOT NULL,
      directive       TEXT NOT NULL,
      character_id    TEXT,
      register        TEXT NOT NULL DEFAULT 'confident',
      hour_of_day     INTEGER NOT NULL,
      session_topic   TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_spice_history_chat ON spice_history(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_spice_history_dim ON spice_history(chat_id, dimension, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id   INTEGER PRIMARY KEY,
      embedding   BLOB NOT NULL,
      model       TEXT NOT NULL DEFAULT 'text-embedding-ada-002',
      created_at  INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    -- FTS5 index on conversation_log for session search / recall
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_log_fts USING fts5(
      content,
      content=conversation_log,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS convo_fts_insert AFTER INSERT ON conversation_log BEGIN
      INSERT INTO conversation_log_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS convo_fts_delete AFTER DELETE ON conversation_log BEGIN
      INSERT INTO conversation_log_fts(conversation_log_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    -- Skill suggestion system tables
    CREATE TABLE IF NOT EXISTS skill_candidates (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id          TEXT NOT NULL,
      chat_id             TEXT NOT NULL,
      workflow_summary    TEXT NOT NULL,
      skill_name_hint     TEXT,
      complexity_score    INTEGER NOT NULL,
      turn_count          INTEGER NOT NULL,
      total_output_tokens INTEGER NOT NULL,
      did_compact         INTEGER NOT NULL DEFAULT 0,
      duration_secs       INTEGER NOT NULL DEFAULT 0,
      pattern_hash        TEXT,
      suggested           INTEGER NOT NULL DEFAULT 0,
      dismissed           INTEGER NOT NULL DEFAULT 0,
      accepted            INTEGER NOT NULL DEFAULT 0,
      skill_draft         TEXT,
      installed           INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_candidates_session ON skill_candidates(session_id);
    CREATE INDEX IF NOT EXISTS idx_skill_candidates_hash ON skill_candidates(pattern_hash);

    CREATE TABLE IF NOT EXISTS skill_suggestion_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id  INTEGER NOT NULL,
      action        TEXT NOT NULL,
      user_response TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_suggestion_log_candidate ON skill_suggestion_log(candidate_id, created_at);

    -- Inbox: queued results from agents, prioritized for delivery
    CREATE TABLE IF NOT EXISTS bot_inbox (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 1,
      category        TEXT,
      title           TEXT,
      content         TEXT NOT NULL,
      report_path     TEXT,
      parent_task_id  TEXT,
      original_prompt TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      INTEGER NOT NULL,
      delivered_at    INTEGER,
      processed_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_priority
      ON bot_inbox(status, priority DESC, created_at);

    CREATE INDEX IF NOT EXISTS idx_inbox_source
      ON bot_inbox(source, status);

    -- Arbitrage scanner tables
    CREATE TABLE IF NOT EXISTS arb_listings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cl_post_id    TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      price_ask     REAL,
      url           TEXT NOT NULL,
      category      TEXT,
      city          TEXT,
      description   TEXT,
      posted_at     INTEGER,
      fetched_at    INTEGER NOT NULL,
      status        TEXT DEFAULT 'new'
    );

    CREATE INDEX IF NOT EXISTS idx_arb_listings_status ON arb_listings(status);
    CREATE INDEX IF NOT EXISTS idx_arb_listings_city ON arb_listings(city, category);

    CREATE TABLE IF NOT EXISTS arb_opportunities (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id      INTEGER NOT NULL REFERENCES arb_listings(id),
      estimated_resale REAL,
      margin_pct      REAL,
      profit_est      REAL,
      confidence      TEXT DEFAULT 'medium',
      research_notes  TEXT,
      sources         TEXT,
      scored_at       INTEGER NOT NULL,
      status          TEXT DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_arb_opps_listing ON arb_opportunities(listing_id);
    CREATE INDEX IF NOT EXISTS idx_arb_opps_margin ON arb_opportunities(margin_pct DESC);

    CREATE TABLE IF NOT EXISTS arb_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function initDatabase(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dbPath = path.join(STORE_DIR, 'apex.db');
  db = new Database(dbPath);
  applyEncryptionKey(db, dbPath);
  db.pragma('journal_mode = WAL');

  // Load sqlite-vec extension for native vector search
  sqliteVec.load(db);

  createSchema(db);
  runMigrations(db);
}

/** Expose the initialized database instance for sub-modules (e.g. arbitrage/storage). */
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized -- call initDatabase() first');
  return db;
}

/** Add columns that may not exist in older databases. */
function runMigrations(database: Database.Database): void {
  // Add context_tokens column to token_usage (introduced for accurate context tracking)
  const cols = database.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>;
  const hasContextTokens = cols.some((c) => c.name === 'context_tokens');
  if (!hasContextTokens) {
    database.exec(`ALTER TABLE token_usage ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0`);
  }

  // Add provider column to token_usage (provider abstraction layer)
  const hasProvider = cols.some((c) => c.name === 'provider');
  if (!hasProvider) {
    database.exec(`ALTER TABLE token_usage ADD COLUMN provider TEXT`);
  }

  // Add topic_key index for grouped memory queries (Phase 1 memory upgrade)
  const topicIdx = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_topic'`,
  ).get();
  if (!topicIdx) {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(chat_id, topic_key)`);
  }

  // Ensure memory_embeddings table exists for older databases (Phase 1.5 memory upgrade)
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id   INTEGER PRIMARY KEY,
      embedding   BLOB NOT NULL,
      model       TEXT NOT NULL DEFAULT 'text-embedding-ada-002',
      created_at  INTEGER NOT NULL
    )
  `);

  // Inbox table (for existing databases)
  database.exec(`
    CREATE TABLE IF NOT EXISTS bot_inbox (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 1,
      category        TEXT,
      title           TEXT,
      content         TEXT NOT NULL,
      report_path     TEXT,
      parent_task_id  TEXT,
      original_prompt TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      INTEGER NOT NULL,
      delivered_at    INTEGER,
      processed_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_priority
      ON bot_inbox(status, priority DESC, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_source
      ON bot_inbox(source, status);
  `);

  // sqlite-vec: create vec0 virtual table for native vector search (Phase 1 memory upgrade)
  // 1024 dimensions matches Venice BGE-M3 embeddings already stored
  // chat_id partition key scopes searches to the correct user
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        memory_id INTEGER PRIMARY KEY,
        chat_id TEXT partition key,
        embedding FLOAT[1024]
      )
    `);
  } catch {
    // vec0 table may already exist from a prior run -- non-fatal
  }

  // Migrate existing embeddings into vec_memories if empty
  const vecCount = database.prepare(
    `SELECT COUNT(*) as cnt FROM vec_memories`,
  ).get() as { cnt: number };

  if (vecCount.cnt === 0) {
    const existingEmbeddings = database.prepare(
      `SELECT e.memory_id, e.embedding, m.chat_id
       FROM memory_embeddings e
       JOIN memories m ON e.memory_id = m.id`,
    ).all() as Array<{ memory_id: number; embedding: Buffer; chat_id: string }>;

    if (existingEmbeddings.length > 0) {
      // vec0 inserts require db.exec() with hex encoding (parameter binding broken)
      let migrated = 0;
      for (const row of existingEmbeddings) {
        try {
          const hex = (row.embedding as Buffer).toString('hex');
          const safeChatId = String(row.chat_id).replace(/[^0-9\-]/g, '');
          if (!safeChatId) continue; // Skip rows with invalid chat_id
          const safeMemId = Number(row.memory_id);
          if (!Number.isInteger(safeMemId) || safeMemId <= 0) continue;
          database.exec(
            `INSERT INTO vec_memories (memory_id, chat_id, embedding) VALUES (${safeMemId}, '${safeChatId}', X'${hex}')`,
          );
          migrated++;
        } catch {
          // Skip any rows that fail (e.g. dimension mismatch)
        }
      }
      // Migration complete -- logged by caller if needed
    }
  }

  // Phase 3: Add tier column to memories (core/active/archive)
  const memCols = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  const hasTier = memCols.some((c) => c.name === 'tier');
  if (!hasTier) {
    database.exec(`ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'active'`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(chat_id, tier, salience DESC)`);
  }

  // Phase 5A: Agent memory namespaces
  const hasAgentId = memCols.some((c) => c.name === 'agent_id');
  if (!hasAgentId) {
    database.exec(`ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'apex-bot'`);
    database.exec(`ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT 'private'`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, namespace, salience DESC)`);
  }

  // Phase 5B: Ebbinghaus decay curves
  const hasAccessCount = memCols.some((c) => c.name === 'access_count');
  if (!hasAccessCount) {
    database.exec(`ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 1`);
    database.exec(`ALTER TABLE memories ADD COLUMN half_life_hours REAL`);
  }

  // Agent-scoped scheduling: add agent column to scheduled_tasks
  const taskCols = database.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as Array<{ name: string }>;
  const hasAgent = taskCols.some((c) => c.name === 'agent');
  if (!hasAgent) {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN agent TEXT DEFAULT NULL`);
  }

  // Multi-platform support: add source column to conversation_log
  const convoLogCols = database.prepare(`PRAGMA table_info(conversation_log)`).all() as Array<{ name: string }>;
  const hasSource = convoLogCols.some((c) => c.name === 'source');
  if (!hasSource) {
    database.exec(`ALTER TABLE conversation_log ADD COLUMN source TEXT DEFAULT 'telegram'`);
  }

  // FTS5 backfill: populate conversation_log_fts from existing conversation_log rows
  const convoFtsExists = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_log_fts'`,
  ).get();
  if (convoFtsExists) {
    const ftsCount = (database.prepare(`SELECT COUNT(*) as cnt FROM conversation_log_fts`).get() as { cnt: number }).cnt;
    const logCount = (database.prepare(`SELECT COUNT(*) as cnt FROM conversation_log`).get() as { cnt: number }).cnt;
    if (ftsCount === 0 && logCount > 0) {
      database.exec(`INSERT INTO conversation_log_fts(conversation_log_fts) VALUES('rebuild')`);
    }
  }

  // Arbitrage scanner tables (for existing databases)
  database.exec(`
    CREATE TABLE IF NOT EXISTS arb_listings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cl_post_id    TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      price_ask     REAL,
      url           TEXT NOT NULL,
      category      TEXT,
      city          TEXT,
      description   TEXT,
      posted_at     INTEGER,
      fetched_at    INTEGER NOT NULL,
      status        TEXT DEFAULT 'new'
    );
    CREATE INDEX IF NOT EXISTS idx_arb_listings_status ON arb_listings(status);
    CREATE INDEX IF NOT EXISTS idx_arb_listings_city ON arb_listings(city, category);

    CREATE TABLE IF NOT EXISTS arb_opportunities (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id      INTEGER NOT NULL REFERENCES arb_listings(id),
      estimated_resale REAL,
      margin_pct      REAL,
      profit_est      REAL,
      confidence      TEXT DEFAULT 'medium',
      research_notes  TEXT,
      sources         TEXT,
      scored_at       INTEGER NOT NULL,
      status          TEXT DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_arb_opps_listing ON arb_opportunities(listing_id);
    CREATE INDEX IF NOT EXISTS idx_arb_opps_margin ON arb_opportunities(margin_pct DESC);

    CREATE TABLE IF NOT EXISTS arb_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_enabled (
      chat_id TEXT PRIMARY KEY
    );

    -- BTW Queue: side items the user drops while the bot is mid-task
    CREATE TABLE IF NOT EXISTS btw_queue (
      id           TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL,
      content      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   INTEGER NOT NULL,
      processed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_btw_queue_status
      ON btw_queue(chat_id, status, created_at);

    -- Spice history (v2 upgrade: rotation tracking + pattern analysis)
    CREATE TABLE IF NOT EXISTS spice_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      dimension       TEXT NOT NULL,
      directive       TEXT NOT NULL,
      character_id    TEXT,
      register        TEXT NOT NULL DEFAULT 'confident',
      hour_of_day     INTEGER NOT NULL,
      session_topic   TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_spice_history_chat ON spice_history(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_spice_history_dim ON spice_history(chat_id, dimension, created_at DESC);

    -- Kiosk chat persistence (survives PM2 restarts)
    CREATE TABLE IF NOT EXISTS kiosk_chat (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      date   TEXT NOT NULL,
      sender TEXT NOT NULL,
      text   TEXT NOT NULL,
      ts     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kiosk_chat_date ON kiosk_chat(date, ts);

    -- Workflow DAG engine (Track 3)
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id           TEXT PRIMARY KEY,
      workflow_id  TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_data TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      started_at   INTEGER,
      completed_at INTEGER,
      error        TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wf_runs_status
      ON workflow_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_workflow
      ON workflow_runs(workflow_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      step_id      TEXT NOT NULL,
      action       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      input        TEXT,
      output       TEXT,
      error        TEXT,
      started_at   INTEGER,
      completed_at INTEGER,
      retry_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_wf_steps_run
      ON workflow_steps(run_id, step_id);

    CREATE TABLE IF NOT EXISTS webhooks (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      secret      TEXT,
      workflow_id TEXT NOT NULL,
      event_name  TEXT NOT NULL DEFAULT 'webhook_received',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );

    -- Browser session persistence (Track 5a)
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id               TEXT PRIMARY KEY,
      domain           TEXT NOT NULL,
      label            TEXT,
      storage_state    TEXT,
      user_agent       TEXT,
      viewport_width   INTEGER NOT NULL DEFAULT 1280,
      viewport_height  INTEGER NOT NULL DEFAULT 720,
      created_at       INTEGER NOT NULL,
      last_used        INTEGER NOT NULL,
      expires_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_browser_sessions_domain
      ON browser_sessions(domain);

    -- ReflectLoop self-improvement engine
    CREATE TABLE IF NOT EXISTS reflect_proposals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent         TEXT NOT NULL,
      category      TEXT NOT NULL,
      proposal      TEXT NOT NULL,
      evidence      TEXT NOT NULL DEFAULT '{}',
      confidence    REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'staged',
      outcome       TEXT,
      created_at    INTEGER NOT NULL,
      reviewed_at   INTEGER,
      applied_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_reflect_agent_status
      ON reflect_proposals(agent, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS reflect_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent         TEXT NOT NULL,
      run_type      TEXT NOT NULL,
      observations  INTEGER NOT NULL DEFAULT 0,
      proposals     INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reflect_runs_agent
      ON reflect_runs(agent, created_at DESC);

    CREATE TABLE IF NOT EXISTS spice_feedback (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      rotation_id   INTEGER,
      signal_type   TEXT NOT NULL,
      signal_source TEXT NOT NULL,
      confidence    REAL NOT NULL DEFAULT 0.5,
      dimensions    TEXT NOT NULL DEFAULT '[]',
      topic         TEXT,
      register      TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_spice_feedback_chat
      ON spice_feedback(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_spice_feedback_type
      ON spice_feedback(chat_id, signal_type);
  `);
}

/** @internal - for tests only. Creates a fresh in-memory database (unencrypted). */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

export function getSession(chatId: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined;
  // Return undefined for empty strings (cleared by /newchat) so the agent
  // starts a fresh session instead of trying to resume with ''
  return row?.session_id || undefined;
}

/** Return the first chat_id from sessions -- used by dashboard when no chatId is in the URL. */
export function getDefaultChatId(): string {
  const row = db
    .prepare('SELECT chat_id FROM sessions LIMIT 1')
    .get() as { chat_id: string } | undefined;
  return row?.chat_id || '';
}

export function setSession(chatId: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)',
  ).run(chatId, sessionId, new Date().toISOString());
}

export function clearSession(chatId: string): void {
  // Don't delete the row -- null out the session_id so getDefaultChatId() still
  // returns this chat_id for dashboard/kiosk endpoints (memory stats, etc.).
  // The next setSession() call will INSERT OR REPLACE with the new session_id.
  db.prepare(
    `UPDATE sessions SET session_id = '', updated_at = ? WHERE chat_id = ?`,
  ).run(new Date().toISOString(), chatId);
}

// ── Spice State ──────────────────────────────────────────────────────

export interface SpiceState {
  chat_id: string;
  active_spices: string; // JSON array of directive strings
  message_count: number;
  updated_at: number;
}

export function getSpiceState(chatId: string): SpiceState | undefined {
  return db
    .prepare('SELECT * FROM spice_state WHERE chat_id = ?')
    .get(chatId) as SpiceState | undefined;
}

export function setSpiceState(
  chatId: string,
  activeSpices: string[],
  messageCount: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO spice_state (chat_id, active_spices, message_count, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(chatId, JSON.stringify(activeSpices), messageCount, now);
}

// ── Spice History (v2) ───────────────────────────────────────────────

export interface SpiceHistoryRow {
  id: number;
  chat_id: string;
  dimension: string;
  directive: string;
  character_id: string | null;
  register: string;
  hour_of_day: number;
  session_topic: string | null;
  created_at: number;
}

/**
 * Save a batch of spice rotation results to history.
 * Called once per rotation (every ROTATION_INTERVAL messages).
 */
export function saveSpiceHistory(
  chatId: string,
  entries: Array<{
    dimension: string;
    directive: string;
    characterId?: string;
    register?: string;
    sessionTopic?: string;
  }>,
): void {
  const now = Math.floor(Date.now() / 1000);
  const hour = new Date().getHours();
  const stmt = db.prepare(
    `INSERT INTO spice_history (chat_id, dimension, directive, character_id, register, hour_of_day, session_topic, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of entries) {
    stmt.run(
      chatId,
      entry.dimension,
      entry.directive,
      entry.characterId ?? null,
      entry.register ?? 'confident',
      hour,
      entry.sessionTopic ?? null,
      now,
    );
  }
}

/**
 * Get recent spice history for a chat. Ordered newest first.
 */
export function getSpiceHistory(chatId: string, limit = 50): SpiceHistoryRow[] {
  return db.prepare(
    `SELECT * FROM spice_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(chatId, limit) as SpiceHistoryRow[];
}

/**
 * Get dimension frequency counts for a chat within a time window.
 * Returns dimensions ordered by usage count descending.
 */
export function getSpiceFrequency(
  chatId: string,
  sinceDays = 7,
): Array<{ dimension: string; count: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  return db.prepare(
    `SELECT dimension, COUNT(*) as count FROM spice_history
     WHERE chat_id = ? AND created_at >= ?
     GROUP BY dimension ORDER BY count DESC`,
  ).all(chatId, cutoff) as Array<{ dimension: string; count: number }>;
}

/**
 * Get character usage frequency for a chat within a time window.
 */
export function getSpiceCharacterFrequency(
  chatId: string,
  sinceDays = 7,
): Array<{ character_id: string; count: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  return db.prepare(
    `SELECT character_id, COUNT(*) as count FROM spice_history
     WHERE chat_id = ? AND created_at >= ? AND character_id IS NOT NULL
     GROUP BY character_id ORDER BY count DESC`,
  ).all(chatId, cutoff) as Array<{ character_id: string; count: number }>;
}

/**
 * Prune spice history older than N days. Called by nightly decay sweep.
 */
export function pruneSpiceHistory(keepDays = 30): number {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
  const result = db.prepare(
    `DELETE FROM spice_history WHERE created_at < ?`,
  ).run(cutoff);
  return result.changes;
}

/**
 * Count total spice history entries for a chat.
 */
export function countSpiceHistory(chatId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM spice_history WHERE chat_id = ?`,
  ).get(chatId) as { cnt: number };
  return row.cnt;
}

/**
 * Get the oldest spice history entry timestamp for a chat.
 * Returns unix timestamp or null if no history.
 */
export function getOldestSpiceHistory(chatId: string): number | null {
  const row = db.prepare(
    `SELECT MIN(created_at) as oldest FROM spice_history WHERE chat_id = ?`,
  ).get(chatId) as { oldest: number | null };
  return row.oldest;
}

/**
 * Count spice rotations (groups of entries with same created_at) in a time window.
 */
export function countSpiceRotations(chatId: string, sinceDays = 1): number {
  const cutoff = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  const row = db.prepare(
    `SELECT COUNT(DISTINCT created_at) as cnt FROM spice_history
     WHERE chat_id = ? AND created_at >= ?`,
  ).get(chatId, cutoff) as { cnt: number };
  return row.cnt;
}

// ── Memory ──────────────────────────────────────────────────────────

export interface Memory {
  id: number;
  chat_id: string;
  topic_key: string | null;
  content: string;
  sector: string;
  salience: number;
  tier: string; // 'core' | 'active' | 'archive'
  agent_id: string; // Phase 5A: which agent owns this memory
  namespace: string; // Phase 5A: 'private' | 'shared' | 'fleet'
  access_count: number; // Phase 5B: retrieval count for Ebbinghaus reinforcement
  half_life_hours: number | null; // Phase 5B: decay rate (null = sector default)
  created_at: number;
  accessed_at: number;
}

export function saveMemory(
  chatId: string,
  content: string,
  sector = 'semantic',
  topicKey?: string,
  agentId = 'apex-bot',
): void {
  const now = Math.floor(Date.now() / 1000);
  const halfLife = getDefaultHalfLife(sector);
  db.prepare(
    `INSERT INTO memories (chat_id, content, sector, topic_key, agent_id, namespace, half_life_hours, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?)`,
  ).run(chatId, content, sector, topicKey ?? null, agentId, halfLife, now, now);
}

export function searchMemories(
  chatId: string,
  query: string,
  limit = 3,
  excludeCore = false,
  agentId?: string,
): Memory[] {
  // Sanitize for FTS5: strip special chars, add * for prefix matching
  const sanitized = query
    .replace(/[""]/g, '"')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(' ');

  if (!sanitized) return [];

  const tierFilter = excludeCore ? ` AND memories.tier != 'core'` : '';
  // Phase 5A: namespace filtering. If agentId provided, only own + shared/fleet.
  // If not provided (primary bot/default), reads all memories.
  const agentFilter = agentId
    ? ` AND (memories.agent_id = '${agentId.replace(/'/g, "''")}' OR memories.namespace IN ('shared', 'fleet'))`
    : '';

  return db
    .prepare(
      `SELECT memories.* FROM memories
       JOIN memories_fts ON memories.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND memories.chat_id = ?${tierFilter}${agentFilter}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(sanitized, chatId, limit) as Memory[];
}

// ── Conversation FTS5 Search ──────────────────────────────────────────

export interface ConversationSearchResult {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
  rank: number;
}

/**
 * FTS5 keyword search across conversation_log.
 * Same sanitization as searchMemories -- strip special chars, prefix-match.
 */
export function searchConversations(
  chatId: string,
  query: string,
  limit = 10,
): ConversationSearchResult[] {
  const sanitized = query
    .replace(/[""]/g, '"')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(' ');

  if (!sanitized) return [];

  try {
    return db
      .prepare(
        `SELECT cl.id, cl.chat_id, cl.session_id, cl.role, cl.content, cl.created_at,
                conversation_log_fts.rank
         FROM conversation_log cl
         JOIN conversation_log_fts ON cl.id = conversation_log_fts.rowid
         WHERE conversation_log_fts MATCH ?
           AND cl.chat_id = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, chatId, limit) as ConversationSearchResult[];
  } catch (err) {
    // FTS5 table might not exist yet on first run
    return [];
  }
}

/**
 * Get surrounding conversation turns for context around a search hit.
 * Returns ±windowSize turns around the centerId row.
 */
export function getConversationWindow(
  chatId: string,
  centerId: number,
  windowSize = 2,
): Array<{ id: number; role: string; content: string; created_at: number }> {
  return db
    .prepare(
      `SELECT id, role, content, created_at FROM conversation_log
       WHERE chat_id = ? AND id BETWEEN ? AND ?
       ORDER BY id ASC`,
    )
    .all(chatId, centerId - windowSize, centerId + windowSize) as Array<{
      id: number;
      role: string;
      content: string;
      created_at: number;
    }>;
}

// ── Skill Suggestion DB Functions ─────────────────────────────────────

export function saveSkillCandidate(
  sessionId: string,
  chatId: string,
  workflowSummary: string,
  skillNameHint: string | null,
  complexityScore: number,
  turnCount: number,
  totalOutputTokens: number,
  didCompact: boolean,
  durationSecs: number,
  patternHash: string | null,
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO skill_candidates
     (session_id, chat_id, workflow_summary, skill_name_hint, complexity_score,
      turn_count, total_output_tokens, did_compact, duration_secs, pattern_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, chatId, workflowSummary, skillNameHint, complexityScore,
    turnCount, totalOutputTokens, didCompact ? 1 : 0, durationSecs, patternHash, now);
  return Number(result.lastInsertRowid);
}

export function getSkillCandidateBySession(sessionId: string): {
  id: number; session_id: string; chat_id: string; workflow_summary: string;
  skill_name_hint: string | null; complexity_score: number; suggested: number;
  dismissed: number; accepted: number; pattern_hash: string | null;
} | undefined {
  return db.prepare(
    `SELECT * FROM skill_candidates WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(sessionId) as any;
}

export function updateSkillCandidateStatus(
  id: number,
  field: 'suggested' | 'dismissed' | 'accepted' | 'installed',
  value: number,
  skillDraft?: string,
): void {
  if (skillDraft !== undefined) {
    db.prepare(`UPDATE skill_candidates SET ${field} = ?, skill_draft = ? WHERE id = ?`).run(value, skillDraft, id);
  } else {
    db.prepare(`UPDATE skill_candidates SET ${field} = ? WHERE id = ?`).run(value, id);
  }
}

export function isPatternDismissed(patternHash: string): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM skill_candidates WHERE pattern_hash = ? AND dismissed = 1`,
  ).get(patternHash) as { cnt: number };
  return row.cnt > 0;
}

export function getRecentDismissalCount(dayWindow = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - dayWindow * 86400;
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM skill_candidates WHERE dismissed = 1 AND created_at >= ?`,
  ).get(cutoff) as { cnt: number };
  return row.cnt;
}

export function logSkillSuggestion(candidateId: number, action: string, userResponse?: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO skill_suggestion_log (candidate_id, action, user_response, created_at) VALUES (?, ?, ?, ?)`,
  ).run(candidateId, action, userResponse ?? null, now);
}

export function getRecentMemories(chatId: string, limit = 5, excludeCore = false, agentId?: string): Memory[] {
  const tierFilter = excludeCore ? ` AND tier != 'core'` : '';
  // Phase 5A: namespace filtering
  const agentFilter = agentId
    ? ` AND (agent_id = '${agentId.replace(/'/g, "''")}' OR namespace IN ('shared', 'fleet'))`
    : '';
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ?${tierFilter}${agentFilter} ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  // Phase 5B: increment access_count for Ebbinghaus reinforcement instead of flat salience bump
  db.prepare(
    'UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
  ).run(now, id);
}

// ── Phase 5B: Ebbinghaus Decay ────────────────────────────────────────

/** Default half-lives by sector (hours). */
const HALF_LIFE_DEFAULTS: Record<string, number> = {
  semantic: 168, // 7 days
  episodic: 72,  // 3 days
};

/** Half-life for shared/fleet namespace memories. */
const SHARED_HALF_LIFE = 336; // 14 days

/** Get the default half-life for a memory based on sector and namespace. */
export function getDefaultHalfLife(sector: string, namespace?: string): number {
  if (namespace === 'shared' || namespace === 'fleet') return SHARED_HALF_LIFE;
  return HALF_LIFE_DEFAULTS[sector] ?? HALF_LIFE_DEFAULTS.semantic;
}

/**
 * Ebbinghaus-inspired decay. Replaces flat linear decay (Phase 1-4).
 *
 * Each memory's daily decay factor is calculated from its half-life
 * and access_count reinforcement:
 *   factor = e^(-ln(2) * 24 / (half_life * reinforcement))
 *   reinforcement = min(access_count, 20)^0.6
 *
 * Frequently accessed memories decay much slower than untouched ones.
 * Memories below 0.05 salience are deleted.
 */
export function decayMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

  // Only decay memories older than 24h (don't penalize brand-new saves)
  const memories = db.prepare(
    'SELECT id, salience, access_count, half_life_hours, sector, namespace FROM memories WHERE created_at < ?',
  ).all(oneDayAgo) as Array<{
    id: number; salience: number; access_count: number;
    half_life_hours: number | null; sector: string; namespace: string;
  }>;

  if (memories.length === 0) return;

  const updateStmt = db.prepare('UPDATE memories SET salience = ? WHERE id = ?');
  const deleteIds: number[] = [];

  const batchUpdate = db.transaction(() => {
    for (const mem of memories) {
      const halfLife = mem.half_life_hours || getDefaultHalfLife(mem.sector, mem.namespace);
      const accessCount = Math.max(mem.access_count || 1, 1);
      const reinforcement = Math.pow(Math.min(accessCount, 20), 0.6);
      const lambda = Math.LN2 / halfLife;

      // Daily decay factor with reinforcement slowing the effective rate
      const decayFactor = Math.exp(-lambda * 24 / reinforcement);
      const newSalience = mem.salience * decayFactor;

      if (newSalience < 0.05) {
        deleteIds.push(mem.id);
      } else {
        updateStmt.run(newSalience, mem.id);
      }
    }
  });

  batchUpdate();

  // Clean up memories that faded out (and their embeddings/vectors)
  for (const id of deleteIds) {
    deleteMemory(id);
  }
}

// ── Memory (Phase 1 + 1.5 upgrades) ─────────────────────────────────

/**
 * Insert a memory and return its row ID.
 * Needed so the extraction pipeline can immediately embed the saved memory.
 * @param salience  Initial salience (importance). Defaults to 1.0. Phase 1.5: Venice rates 1-10.
 * @param agentId   Phase 5A: owning agent ID. Defaults to 'apex-bot'.
 * @param namespace Phase 5A: 'private' | 'shared' | 'fleet'. Defaults to 'private'.
 */
export function saveMemoryReturningId(
  chatId: string,
  content: string,
  sector = 'semantic',
  topicKey?: string,
  salience = 1.0,
  agentId = 'apex-bot',
  namespace = 'private',
): number {
  const now = Math.floor(Date.now() / 1000);
  const halfLife = getDefaultHalfLife(sector, namespace);
  const result = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, topic_key, salience, agent_id, namespace, half_life_hours, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, content, sector, topicKey ?? null, salience, agentId, namespace, halfLife, now, now);
  return result.lastInsertRowid as number;
}

/**
 * Update an existing memory's content (for dedup-and-refresh).
 * Bumps salience and refreshes accessed_at.
 */
export function updateMemoryContent(
  id: number,
  content: string,
  salienceBump = 0.2,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE memories SET content = ?, accessed_at = ?, salience = MIN(salience + ?, 5.0) WHERE id = ?`,
  ).run(content, now, salienceBump, id);
}

/**
 * Get all memories for a chat, optionally filtered by topic.
 * Ordered by salience DESC for display.
 */
export function getMemoriesByTopic(
  chatId: string,
  topic?: string,
): Memory[] {
  if (topic) {
    return db.prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND topic_key = ? ORDER BY salience DESC`,
    ).all(chatId, topic) as Memory[];
  }
  return db.prepare(
    `SELECT * FROM memories WHERE chat_id = ? ORDER BY topic_key, salience DESC`,
  ).all(chatId) as Memory[];
}

/**
 * Delete memories matching a keyword via FTS5 search.
 * Returns the count of deleted memories.
 */
export function deleteMemoriesByKeyword(
  chatId: string,
  keyword: string,
): number {
  const matches = searchMemories(chatId, keyword, 50);
  if (matches.length === 0) return 0;

  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(
    `DELETE FROM memories WHERE id IN (${placeholders})`,
  ).run(...ids);
  return result.changes;
}

/**
 * Get a single memory by ID.
 */
export function getMemoryById(id: number): Memory | null {
  return (db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory) ?? null;
}

// ── Tiered Memory (Phase 3) ──────────────────────────────────────────

/** Max items allowed in core tier per chat. */
export const CORE_MEMORY_LIMIT = 30;

/**
 * Get all core-tier memories for a chat.
 * These are always prepended to context -- no search needed.
 * Phase 5A: agentId filtering. Primary bot (default/undefined) sees all core.
 * Named agents see own core + shared/fleet core.
 */
export function getCoreMemories(chatId: string, agentId?: string): Memory[] {
  const agentFilter = agentId
    ? ` AND (agent_id = '${agentId.replace(/'/g, "''")}' OR namespace IN ('shared', 'fleet'))`
    : '';
  return db.prepare(
    `SELECT * FROM memories WHERE chat_id = ? AND tier = 'core'${agentFilter} ORDER BY salience DESC`,
  ).all(chatId) as Memory[];
}

/**
 * Count core memories for a chat.
 */
export function countCoreMemories(chatId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ? AND tier = 'core'`,
  ).get(chatId) as { cnt: number };
  return row.cnt;
}

/**
 * Set a memory's tier. Used by /pin, /unpin, and promotion/demotion sweep.
 */
export function setMemoryTier(id: number, tier: 'core' | 'active' | 'archive'): void {
  db.prepare('UPDATE memories SET tier = ? WHERE id = ?').run(tier, id);
}

/**
 * Set a memory's salience directly. Used by /pin to set a floor.
 */
export function setMemorySalience(id: number, salience: number): void {
  db.prepare('UPDATE memories SET salience = ? WHERE id = ?').run(salience, id);
}

/**
 * Search archive-tier memories via FTS5. Triggered when active search
 * yields insufficient results.
 */
export function searchArchiveMemories(chatId: string, query: string, limit = 5): Memory[] {
  const sanitized = query
    .replace(/[""]/g, '"')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(' ');

  if (!sanitized) return [];

  return db.prepare(
    `SELECT memories.* FROM memories
     JOIN memories_fts ON memories.id = memories_fts.rowid
     WHERE memories_fts MATCH ? AND memories.chat_id = ? AND memories.tier = 'archive'
     ORDER BY rank
     LIMIT ?`,
  ).all(sanitized, chatId, limit) as Memory[];
}

// ── Phase 5A: Namespace Functions ─────────────────────────────────────

/**
 * Promote a memory to the shared namespace.
 * Used by the primary bot or agents when they have cross-fleet knowledge.
 */
export function promoteToShared(memoryId: number): void {
  const halfLife = SHARED_HALF_LIFE;
  db.prepare(
    'UPDATE memories SET namespace = ?, half_life_hours = ? WHERE id = ?',
  ).run('shared', halfLife, memoryId);
}

/**
 * Get memory counts per tier and namespace for a specific agent.
 * Used by dashboard stats.
 */
export function getAgentMemoryStats(agentId: string): Array<{ tier: string; namespace: string; count: number }> {
  return db.prepare(
    `SELECT tier, namespace, COUNT(*) as count FROM memories
     WHERE agent_id = ?
     GROUP BY tier, namespace
     ORDER BY tier, namespace`,
  ).all(agentId) as Array<{ tier: string; namespace: string; count: number }>;
}

/**
 * Get distinct agent_ids that have memories for a chat.
 * Used by namespace-aware consolidation sweep.
 */
export function getAgentIdsForChat(chatId: string): string[] {
  return (db.prepare(
    'SELECT DISTINCT agent_id FROM memories WHERE chat_id = ?',
  ).all(chatId) as Array<{ agent_id: string }>).map((r) => r.agent_id);
}

/**
 * Get memory IDs with embeddings for a specific agent.
 * Used by namespace-aware consolidation (Phase 5C).
 */
export function getMemoryIdsWithEmbeddingsForAgent(chatId: string, agentId: string): number[] {
  return (db.prepare(
    `SELECT m.id FROM memories m
     JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.chat_id = ? AND m.agent_id = ?
     ORDER BY m.id`,
  ).all(chatId, agentId) as Array<{ id: number }>).map((r) => r.id);
}

/**
 * Get shared namespace memory IDs with embeddings (cross-agent).
 * Used by fleet-level dedup in consolidation (Phase 5C).
 */
export function getSharedMemoryIdsWithEmbeddings(chatId: string): number[] {
  return (db.prepare(
    `SELECT m.id FROM memories m
     JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.chat_id = ? AND m.namespace = 'shared'
     ORDER BY m.id`,
  ).all(chatId) as Array<{ id: number }>).map((r) => r.id);
}

/**
 * Get all distinct chat_ids that have memories. Used by tier sweep.
 */
export function getAllChatIds(): string[] {
  return (db.prepare('SELECT DISTINCT chat_id FROM memories').all() as Array<{ chat_id: string }>)
    .map((r) => r.chat_id);
}

/**
 * Delete a single memory by ID. Also cleans up its embedding and vec entry.
 */
export function deleteMemory(id: number): void {
  const safeId = Number(id);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  db.prepare('DELETE FROM memories WHERE id = ?').run(safeId);
  db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(safeId);
  try {
    db.exec(`DELETE FROM vec_memories WHERE memory_id = ${safeId}`);
  } catch { /* vec table might not exist */ }
}

/**
 * Get all memory IDs for a chat that have embeddings.
 * Used by the consolidation sweep to find merge candidates.
 */
export function getMemoryIdsWithEmbeddings(chatId: string): number[] {
  return (db.prepare(
    `SELECT m.id FROM memories m
     JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.chat_id = ?
     ORDER BY m.id`,
  ).all(chatId) as Array<{ id: number }>).map((r) => r.id);
}

/**
 * Get the raw embedding for a specific memory.
 */
export function getEmbeddingForMemory(memoryId: number): number[] | null {
  const row = db.prepare(
    'SELECT embedding FROM memory_embeddings WHERE memory_id = ?',
  ).get(memoryId) as { embedding: Buffer } | undefined;
  if (!row) return null;
  return deserializeEmbedding(row.embedding);
}

// ── Embedding Storage ────────────────────────────────────────────────

/**
 * Serialize a float vector to a Buffer for BLOB storage.
 */
export function serializeEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * Deserialize a BLOB back to a float array.
 */
export function deserializeEmbedding(blob: Buffer): number[] {
  return Array.from(new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  ));
}

/**
 * Save an embedding vector for a memory.
 * Writes to both memory_embeddings (legacy) and vec_memories (sqlite-vec).
 *
 * Note: sqlite-vec vec0 inserts require db.exec() with hex-encoded blobs
 * due to a parameter binding incompatibility with better-sqlite3-multiple-ciphers.
 * Queries work fine with parameter binding.
 */
export function saveEmbedding(
  memoryId: number,
  embedding: number[],
  model = 'text-embedding-ada-002',
  chatId?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  const blob = serializeEmbedding(embedding);

  // Legacy table (keeps model + timestamp metadata)
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(memoryId, blob, model, now);

  // sqlite-vec virtual table (native vector search)
  // Uses db.exec() with hex encoding because vec0 parameter binding
  // is broken with better-sqlite3-multiple-ciphers for writes.
  // Security: chatId is validated to digits-only (Telegram numeric IDs).
  if (chatId) {
    try {
      const hex = blob.toString('hex');
      const safeChatId = chatId.replace(/[^0-9\-]/g, '');
      if (!safeChatId) throw new Error('Invalid chatId for vec_memories');
      const safeMemId = Number(memoryId);
      if (!Number.isInteger(safeMemId) || safeMemId <= 0) throw new Error('Invalid memoryId for vec_memories');
      // Delete existing row first (vec0 doesn't support OR REPLACE)
      db.exec(`DELETE FROM vec_memories WHERE memory_id = ${safeMemId}`);
      db.exec(
        `INSERT INTO vec_memories (memory_id, chat_id, embedding) VALUES (${safeMemId}, '${safeChatId}', X'${hex}')`,
      );
    } catch {
      // Non-fatal: vec table might not be ready
    }
  }
}

export interface EmbeddingRow {
  memory_id: number;
  embedding: Buffer;
  content: string;
  sector: string;
  salience: number;
  topic_key: string | null;
}

/**
 * Get all embeddings for a chat, joined with memory content.
 * Used by hybrid search to compute cosine similarity.
 */
export function getEmbeddingsForChat(chatId: string): EmbeddingRow[] {
  return db.prepare(
    `SELECT m.id as memory_id, e.embedding, m.content, m.sector, m.salience, m.topic_key
     FROM memories m
     JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.chat_id = ?`,
  ).all(chatId) as EmbeddingRow[];
}

/**
 * Native vector search via sqlite-vec.
 * Returns top-K nearest neighbors with cosine distance.
 * This replaces the old approach of loading ALL embeddings into JS.
 */
export interface VecSearchResult {
  memory_id: number;
  distance: number;
}

export function vectorSearch(
  chatId: string,
  queryEmbedding: number[],
  limit = 5,
): VecSearchResult[] {
  try {
    const blob = serializeEmbedding(queryEmbedding);
    return db.prepare(
      `SELECT memory_id, distance
       FROM vec_memories
       WHERE embedding MATCH ? AND k = ? AND chat_id = ?
       ORDER BY distance`,
    ).all(blob, limit, chatId) as VecSearchResult[];
  } catch {
    // Fallback: vec table not available or query failed
    return [];
  }
}

/**
 * Get all memory IDs that lack embeddings. Used by backfill script.
 */
export function getMemoriesWithoutEmbeddings(limit = 100): Memory[] {
  return db.prepare(
    `SELECT m.* FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE e.memory_id IS NULL
     LIMIT ?`,
  ).all(limit) as Memory[];
}

// ── Scheduled Tasks ──────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent: string | null;
}

export function createScheduledTask(
  id: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  agent?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, prompt, schedule, nextRun, now, agent ?? null);
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ? ORDER BY next_run`,
    )
    .all(now) as ScheduledTask[];
}

export function getAllScheduledTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function markTaskRunning(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'running' WHERE id = ?`).run(id);
}

export function markTaskActive(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'active' WHERE id = ?`).run(id);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ?, status = 'active' WHERE id = ?`,
  ).run(now, nextRun, result.slice(0, 500), id);
}

export function deleteScheduledTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function pauseScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?`).run(id);
}

export function resumeScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET status = 'active' WHERE id = ?`).run(id);
}

// ── Browser Sessions (Track 5a) ───────────────────────────────────────

export interface BrowserSession {
  id: string;
  domain: string;
  label: string | null;
  storage_state: string | null;
  user_agent: string | null;
  viewport_width: number;
  viewport_height: number;
  created_at: number;
  last_used: number;
  expires_at: number | null;
}

export function saveBrowserSession(
  id: string,
  domain: string,
  storageState: string,
  label?: string,
  userAgent?: string,
  viewportWidth = 1280,
  viewportHeight = 720,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO browser_sessions
     (id, domain, label, storage_state, user_agent, viewport_width, viewport_height, created_at, last_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, domain, label ?? null, storageState, userAgent ?? null, viewportWidth, viewportHeight, now, now);
}

export function getBrowserSession(id: string): BrowserSession | undefined {
  return db
    .prepare('SELECT * FROM browser_sessions WHERE id = ?')
    .get(id) as BrowserSession | undefined;
}

export function getBrowserSessionByDomain(domain: string): BrowserSession | undefined {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM browser_sessions
       WHERE domain = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY last_used DESC LIMIT 1`,
    )
    .get(domain, now) as BrowserSession | undefined;
}

export function listBrowserSessions(): BrowserSession[] {
  return db
    .prepare('SELECT * FROM browser_sessions ORDER BY last_used DESC')
    .all() as BrowserSession[];
}

export function touchBrowserSession(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE browser_sessions SET last_used = ? WHERE id = ?').run(now, id);
}

export function deleteBrowserSession(id: string): void {
  db.prepare('DELETE FROM browser_sessions WHERE id = ?').run(id);
}

// ── WhatsApp message map ──────────────────────────────────────────────

export function saveWaMessageMap(telegramMsgId: number, waChatId: string, contactName: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO wa_message_map (telegram_msg_id, wa_chat_id, contact_name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(telegramMsgId, waChatId, contactName, now);
}

export function lookupWaChatId(telegramMsgId: number): { waChatId: string; contactName: string } | null {
  const row = db
    .prepare('SELECT wa_chat_id, contact_name FROM wa_message_map WHERE telegram_msg_id = ?')
    .get(telegramMsgId) as { wa_chat_id: string; contact_name: string } | undefined;
  if (!row) return null;
  return { waChatId: row.wa_chat_id, contactName: row.contact_name };
}

export function getRecentWaContacts(limit = 20): Array<{ waChatId: string; contactName: string; lastSeen: number }> {
  const rows = db.prepare(
    `SELECT wa_chat_id, contact_name, MAX(created_at) as lastSeen
     FROM wa_message_map
     GROUP BY wa_chat_id
     ORDER BY lastSeen DESC
     LIMIT ?`,
  ).all(limit) as Array<{ wa_chat_id: string; contact_name: string; lastSeen: number }>;
  return rows.map((r) => ({ waChatId: r.wa_chat_id, contactName: r.contact_name, lastSeen: r.lastSeen }));
}

// ── WhatsApp outbox ──────────────────────────────────────────────────

export interface WaOutboxItem {
  id: number;
  to_chat_id: string;
  body: string;
  created_at: number;
}

export function enqueueWaMessage(toChatId: string, body: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO wa_outbox (to_chat_id, body, created_at) VALUES (?, ?, ?)`,
  ).run(toChatId, body, now);
  return result.lastInsertRowid as number;
}

export function getPendingWaMessages(): WaOutboxItem[] {
  return db.prepare(
    `SELECT id, to_chat_id, body, created_at FROM wa_outbox WHERE sent_at IS NULL ORDER BY created_at`,
  ).all() as WaOutboxItem[];
}

export function markWaMessageSent(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE wa_outbox SET sent_at = ? WHERE id = ?`).run(now, id);
}

// ── WhatsApp messages ────────────────────────────────────────────────

// ── Conversation Log ──────────────────────────────────────────────────

export interface ConversationTurn {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
  source?: string;
}

export function logConversationTurn(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  sessionId?: string,
  source: string = 'telegram',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO conversation_log (chat_id, session_id, role, content, created_at, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, role, content, now, source);
}

/**
 * Get conversation history filtered by source platform.
 */
export function getConversationBySource(
  chatId: string,
  source: string,
  limit = 20,
): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ? AND source = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, source, limit) as ConversationTurn[];
}

export function getRecentConversation(
  chatId: string,
  limit = 20,
): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Get ALL conversation turns for a specific session (chronological order).
 * Used by pre-compaction flush to extract facts from the entire session,
 * not just the last N turns.
 *
 * Falls back to getRecentConversation(chatId, 200) if sessionId is missing
 * or returns no results.
 */
export function getSessionConversation(
  chatId: string,
  sessionId?: string,
): ConversationTurn[] {
  if (sessionId) {
    const results = db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(chatId, sessionId) as ConversationTurn[];
    if (results.length > 0) return results;
  }
  // Fallback: pull last 200 turns chronologically
  const fallback = db
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT 200`,
    )
    .all(chatId) as ConversationTurn[];
  return fallback.reverse(); // chronological order
}

/**
 * Prune old conversation_log entries, keeping only the most recent N rows per chat.
 * Called alongside memory decay to prevent unbounded disk growth.
 */
export function pruneConversationLog(keepPerChat = 500): void {
  // Get distinct chat IDs
  const chats = db
    .prepare('SELECT DISTINCT chat_id FROM conversation_log')
    .all() as Array<{ chat_id: string }>;

  const deleteStmt = db.prepare(`
    DELETE FROM conversation_log
    WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM conversation_log
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `);

  for (const chat of chats) {
    deleteStmt.run(chat.chat_id, chat.chat_id, keepPerChat);
  }
}

// ── WhatsApp messages ────────────────────────────────────────────────

export function saveWaMessage(
  chatId: string,
  contactName: string,
  body: string,
  timestamp: number,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO wa_messages (chat_id, contact_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, contactName, body, timestamp, isFromMe ? 1 : 0, now);
}

// ── Slack messages ────────────────────────────────────────────────

export function saveSlackMessage(
  channelId: string,
  channelName: string,
  userName: string,
  body: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO slack_messages (channel_id, channel_name, user_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(channelId, channelName, userName, body, timestamp, isFromMe ? 1 : 0, now);
}

export interface SlackMessageRow {
  id: number;
  channel_id: string;
  channel_name: string;
  user_name: string;
  body: string;
  timestamp: string;
  is_from_me: number;
  created_at: number;
}

export function getRecentSlackMessages(channelId: string, limit = 20): SlackMessageRow[] {
  return db
    .prepare(
      `SELECT * FROM slack_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as SlackMessageRow[];
}

// ── Discord messages ──────────────────────────────────────────────

export function saveDiscordMessage(
  channelId: string,
  channelName: string,
  serverName: string,
  userName: string,
  body: string,
  messageId: string,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO discord_messages (channel_id, channel_name, server_name, user_name, body, message_id, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(channelId, channelName, serverName, userName, body, messageId, isFromMe ? 1 : 0, now);
}

export interface DiscordMessageRow {
  id: number;
  channel_id: string;
  channel_name: string;
  server_name: string;
  user_name: string;
  body: string;
  message_id: string;
  is_from_me: number;
  created_at: number;
}

export function getRecentDiscordMessages(channelId: string, limit = 20): DiscordMessageRow[] {
  return db
    .prepare(
      `SELECT * FROM discord_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as DiscordMessageRow[];
}

// ── Token Usage ──────────────────────────────────────────────────────

export function saveTokenUsage(
  chatId: string,
  sessionId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  contextTokens: number,
  costUsd: number,
  didCompact: boolean,
  provider?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO token_usage (chat_id, session_id, input_tokens, output_tokens, cache_read, context_tokens, cost_usd, did_compact, created_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, inputTokens, outputTokens, cacheRead, contextTokens, costUsd, didCompact ? 1 : 0, now, provider ?? null);
}

export interface SessionTokenSummary {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastCacheRead: number;
  lastContextTokens: number;
  totalCostUsd: number;
  compactions: number;
  firstTurnAt: number;
  lastTurnAt: number;
}

// ── Dashboard Queries ──────────────────────────────────────────────────

export interface DashboardMemoryStats {
  total: number;
  semantic: number;
  episodic: number;
  core: number;
  active: number;
  archive: number;
  avgSalience: number;
  salienceDistribution: { bucket: string; count: number }[];
}

export function getDashboardMemoryStats(chatId: string): DashboardMemoryStats {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN sector = 'semantic' THEN 1 ELSE 0 END) as semantic,
         SUM(CASE WHEN sector = 'episodic' THEN 1 ELSE 0 END) as episodic,
         SUM(CASE WHEN tier = 'core' THEN 1 ELSE 0 END) as core,
         SUM(CASE WHEN tier = 'active' THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN tier = 'archive' THEN 1 ELSE 0 END) as archive,
         AVG(salience) as avgSalience
       FROM memories WHERE chat_id = ?`,
    )
    .get(chatId) as { total: number; semantic: number; episodic: number; core: number; active: number; archive: number; avgSalience: number | null };

  const buckets = db
    .prepare(
      `SELECT
         CASE
           WHEN salience < 0.5 THEN '0-0.5'
           WHEN salience < 1.0 THEN '0.5-1'
           WHEN salience < 2.0 THEN '1-2'
           WHEN salience < 3.0 THEN '2-3'
           WHEN salience < 4.0 THEN '3-4'
           ELSE '4-5'
         END as bucket,
         COUNT(*) as count
       FROM memories WHERE chat_id = ?
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all(chatId) as { bucket: string; count: number }[];

  return {
    total: counts.total,
    semantic: counts.semantic,
    episodic: counts.episodic,
    core: counts.core,
    active: counts.active,
    archive: counts.archive,
    avgSalience: counts.avgSalience ?? 0,
    salienceDistribution: buckets,
  };
}

export function getDashboardLowSalienceMemories(chatId: string, limit = 10): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND salience < 0.5
       ORDER BY salience ASC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardTopAccessedMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ?
       ORDER BY salience DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardMemoryTimeline(chatId: string, days = 30): { date: string; semantic: number; episodic: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         SUM(CASE WHEN sector = 'semantic' THEN 1 ELSE 0 END) as semantic,
         SUM(CASE WHEN sector = 'episodic' THEN 1 ELSE 0 END) as episodic
       FROM memories
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; semantic: number; episodic: number }[];
}

export interface DashboardWeeklyTokenStats {
  weekInput: number;
  weekOutput: number;
  weekCost: number;
  weekTurns: number;
}

export function getDashboardWeeklyTokenStats(chatId: string): DashboardWeeklyTokenStats {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as weekInput,
         COALESCE(SUM(output_tokens), 0) as weekOutput,
         COALESCE(SUM(cost_usd), 0) as weekCost,
         COUNT(*) as weekTurns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', 'weekday 0', '-6 days', 'start of day')`,
    )
    .get(chatId) as { weekInput: number; weekOutput: number; weekCost: number; weekTurns: number };

  return row;
}

export interface DashboardTokenStats {
  todayInput: number;
  todayOutput: number;
  todayCost: number;
  todayTurns: number;
  allTimeCost: number;
  allTimeTurns: number;
}

export function getDashboardTokenStats(chatId: string): DashboardTokenStats {
  const today = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as todayInput,
         COALESCE(SUM(output_tokens), 0) as todayOutput,
         COALESCE(SUM(cost_usd), 0) as todayCost,
         COUNT(*) as todayTurns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', 'start of day')`,
    )
    .get(chatId) as { todayInput: number; todayOutput: number; todayCost: number; todayTurns: number };

  const allTime = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) as allTimeCost,
         COUNT(*) as allTimeTurns
       FROM token_usage WHERE chat_id = ?`,
    )
    .get(chatId) as { allTimeCost: number; allTimeTurns: number };

  return { ...today, ...allTime };
}

// Monthly spend aggregated across ALL bots (no chatId filter).
export interface DashboardMonthlySpend {
  monthCost: number;
  monthTurns: number;
}

export function getDashboardMonthlySpend(): DashboardMonthlySpend {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) as monthCost,
         COUNT(*) as monthTurns
       FROM token_usage
       WHERE created_at >= unixepoch('now', 'start of month')`,
    )
    .get() as { monthCost: number; monthTurns: number };
  return row;
}

export interface DashboardOpenRouterSpend {
  monthCost: number;
  monthTurns: number;
  todayCost: number;
  todayTurns: number;
}

export function getDashboardOpenRouterSpend(): DashboardOpenRouterSpend {
  const month = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) as monthCost,
         COUNT(*) as monthTurns
       FROM token_usage
       WHERE provider = 'openrouter' AND created_at >= unixepoch('now', 'start of month')`,
    )
    .get() as { monthCost: number; monthTurns: number };
  const today = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) as todayCost,
         COUNT(*) as todayTurns
       FROM token_usage
       WHERE provider = 'openrouter' AND created_at >= unixepoch('now', 'start of day')`,
    )
    .get() as { todayCost: number; todayTurns: number };
  return { ...month, ...today };
}

export function getDashboardCostTimeline(chatId: string, days = 30): { date: string; cost: number; turns: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         SUM(cost_usd) as cost,
         COUNT(*) as turns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; cost: number; turns: number }[];
}

export function getDashboardCostTimelineHourly(chatId: string, hours = 24): { hour: string; cost: number; turns: number }[] {
  return db
    .prepare(
      `SELECT
         strftime('%Y-%m-%dT%H:00', created_at, 'unixepoch') as hour,
         SUM(cost_usd) as cost,
         COUNT(*) as turns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY hour
       ORDER BY hour`,
    )
    .all(chatId, `-${hours} hours`) as { hour: string; cost: number; turns: number }[];
}

export interface RecentTokenUsageRow {
  id: number;
  chat_id: string;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  context_tokens: number;
  cost_usd: number;
  did_compact: number;
  created_at: number;
}

export function getDashboardRecentTokenUsage(chatId: string, limit = 20): RecentTokenUsageRow[] {
  return db
    .prepare(
      `SELECT * FROM token_usage WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as RecentTokenUsageRow[];
}

export function getDashboardMemoriesBySector(chatId: string, sector: string, limit = 50, offset = 0): { memories: Memory[]; total: number } {
  const total = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ? AND sector = ?')
    .get(chatId, sector) as { cnt: number };
  const memories = db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND sector = ?
       ORDER BY salience DESC, created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(chatId, sector, limit, offset) as Memory[];
  return { memories, total: total.cnt };
}

export function getSessionTokenUsage(sessionId: string): SessionTokenSummary | null {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)           as turns,
         SUM(input_tokens)  as totalInputTokens,
         SUM(output_tokens) as totalOutputTokens,
         SUM(cost_usd)      as totalCostUsd,
         SUM(did_compact)   as compactions,
         MIN(created_at)    as firstTurnAt,
         MAX(created_at)    as lastTurnAt
       FROM token_usage WHERE session_id = ?`,
    )
    .get(sessionId) as {
      turns: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      compactions: number;
      firstTurnAt: number;
      lastTurnAt: number;
    } | undefined;

  if (!row || row.turns === 0) return null;

  // Get the most recent turn's context_tokens (actual context window size from last API call)
  // Falls back to cache_read for backward compat with rows before the migration
  const lastRow = db
    .prepare(
      `SELECT cache_read, context_tokens FROM token_usage
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { cache_read: number; context_tokens: number } | undefined;

  return {
    turns: row.turns,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    lastCacheRead: lastRow?.cache_read ?? 0,
    lastContextTokens: lastRow?.context_tokens ?? lastRow?.cache_read ?? 0,
    totalCostUsd: row.totalCostUsd,
    compactions: row.compactions,
    firstTurnAt: row.firstTurnAt,
    lastTurnAt: row.lastTurnAt,
  };
}

/**
 * Fallback: get the most recent token usage for a chat_id regardless of session.
 * Used when the session row has been cleared (e.g. after /newchat) but we still
 * want to show context stats on the kiosk until the new session starts.
 */
export function getLatestTokenUsageByChatId(chatId: string): SessionTokenSummary | null {
  // Find the most recent session_id for this chat_id from token_usage itself
  const latest = db
    .prepare(
      `SELECT session_id FROM token_usage
       WHERE chat_id = ? AND session_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId) as { session_id: string } | undefined;

  if (!latest?.session_id) return null;
  return getSessionTokenUsage(latest.session_id);
}

// ── Inbox ───────────────────────────────────────────────────────────

export interface InboxItem {
  id: string;
  source: string;
  priority: number;       // 1=low, 2=medium, 3=high
  category: string | null;
  title: string | null;
  content: string;
  report_path: string | null;
  parent_task_id: string | null;
  original_prompt: string | null;
  status: 'pending' | 'delivered' | 'processed';
  created_at: number;
  delivered_at: number | null;
  processed_at: number | null;
}

/**
 * Insert a new item into the bot's inbox.
 */
export function addInboxItem(item: {
  id: string;
  source: string;
  priority?: number;
  category?: string;
  title?: string;
  content: string;
  report_path?: string;
  parent_task_id?: string;
  original_prompt?: string;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO bot_inbox (id, source, priority, category, title, content, report_path, parent_task_id, original_prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    item.id,
    item.source,
    item.priority ?? 1,
    item.category ?? null,
    item.title ?? null,
    item.content,
    item.report_path ?? null,
    item.parent_task_id ?? null,
    item.original_prompt ?? null,
    now,
  );
}

/**
 * Get pending inbox items by priority tier.
 */
export function getInboxByPriority(priority: number, limit = 10): InboxItem[] {
  return db.prepare(`
    SELECT * FROM bot_inbox
    WHERE status = 'pending' AND priority = ?
    ORDER BY created_at
    LIMIT ?
  `).all(priority, limit) as InboxItem[];
}

/**
 * Get all pending inbox items, ordered by priority DESC then created_at.
 */
export function getPendingInbox(limit = 20): InboxItem[] {
  return db.prepare(`
    SELECT * FROM bot_inbox
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at
    LIMIT ?
  `).all(limit) as InboxItem[];
}

/**
 * Mark an inbox item as delivered (sent to Telegram).
 */
export function markInboxDelivered(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE bot_inbox SET status = 'delivered', delivered_at = ? WHERE id = ?
  `).run(now, id);
}

/**
 * Mark an inbox item as fully processed (routed, archived, etc.).
 */
export function markInboxProcessed(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE bot_inbox SET status = 'processed', processed_at = ? WHERE id = ?
  `).run(now, id);
}

/**
 * Count pending inbox items, optionally filtered by priority.
 */
export function countPendingInbox(priority?: number): number {
  if (priority !== undefined) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM bot_inbox WHERE status = 'pending' AND priority = ?
    `).get(priority) as { cnt: number };
    return row.cnt;
  }
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM bot_inbox WHERE status = 'pending'
  `).get() as { cnt: number };
  return row.cnt;
}

/**
 * Prune old delivered/processed inbox items (keep last N days).
 */
export function pruneInbox(keepDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
  const result = db.prepare(`
    DELETE FROM bot_inbox WHERE status IN ('delivered', 'processed') AND created_at < ?
  `).run(cutoff);
  return result.changes;
}

// ── Voice toggle persistence ──────────────────────────────────────────

export function getVoiceEnabledChats(): Set<string> {
  const rows = db.prepare('SELECT chat_id FROM voice_enabled').all() as { chat_id: string }[];
  return new Set(rows.map(r => r.chat_id));
}

export function setVoiceEnabled(chatId: string, enabled: boolean): void {
  if (enabled) {
    db.prepare('INSERT OR IGNORE INTO voice_enabled (chat_id) VALUES (?)').run(chatId);
  } else {
    db.prepare('DELETE FROM voice_enabled WHERE chat_id = ?').run(chatId);
  }
}

// ── BTW Queue ──────────────────────────────────────────────────────

export interface BtwItem {
  id: string;
  chat_id: string;
  content: string;
  status: 'pending' | 'processed';
  created_at: number;
  processed_at: number | null;
}

/**
 * Add an item to the BTW queue.
 */
export function enqueueBtw(id: string, chatId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO btw_queue (id, chat_id, content, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, chatId, content, now);
}

/**
 * Get pending BTW items for a chat, oldest first.
 */
export function getPendingBtw(chatId: string, limit = 10): BtwItem[] {
  return db.prepare(
    `SELECT * FROM btw_queue WHERE chat_id = ? AND status = 'pending' ORDER BY created_at LIMIT ?`,
  ).all(chatId, limit) as BtwItem[];
}

/**
 * Mark a BTW item as processed.
 */
export function markBtwProcessed(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE btw_queue SET status = 'processed', processed_at = ? WHERE id = ?`,
  ).run(now, id);
}

/**
 * Clear all pending BTW items for a chat. Returns count deleted.
 */
export function clearBtwQueue(chatId: string): number {
  const result = db.prepare(
    `DELETE FROM btw_queue WHERE chat_id = ? AND status = 'pending'`,
  ).run(chatId);
  return result.changes;
}

/**
 * Count pending BTW items for a chat.
 */
export function countPendingBtw(chatId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM btw_queue WHERE chat_id = ? AND status = 'pending'`,
  ).get(chatId) as { cnt: number };
  return row.cnt;
}

/**
 * Prune old processed BTW items (keep last N days).
 */
export function pruneBtwQueue(keepDays = 3): number {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
  const result = db.prepare(
    `DELETE FROM btw_queue WHERE status = 'processed' AND created_at < ?`,
  ).run(cutoff);
  return result.changes;
}

// ── Kiosk Chat Persistence (SQLite-backed, survives restarts) ──────────────

export function saveKioskChatMsg(date: string, sender: string, text: string, ts: number): void {
  db.prepare(
    `INSERT INTO kiosk_chat (date, sender, text, ts) VALUES (?, ?, ?, ?)`,
  ).run(date, sender, text, ts);
}

export function getKioskChatMsgs(date: string): Array<{ sender: string; text: string; ts: number }> {
  return db.prepare(
    `SELECT sender, text, ts FROM kiosk_chat WHERE date = ? ORDER BY ts ASC`,
  ).all(date) as Array<{ sender: string; text: string; ts: number }>;
}

export function clearKioskChatDate(date: string): void {
  db.prepare(`DELETE FROM kiosk_chat WHERE date = ?`).run(date);
}

export function pruneKioskChat(keepDays = 2): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  db.prepare(`DELETE FROM kiosk_chat WHERE date < ?`).run(cutoffStr);
}

// ── ReflectLoop (Self-Improvement Engine) ─────────────────────────────

export interface ReflectProposalRow {
  id: number;
  agent: string;
  category: string;
  proposal: string;
  evidence: string;
  confidence: number;
  status: string;
  outcome: string | null;
  created_at: number;
  reviewed_at: number | null;
  applied_at: number | null;
}

export interface ReflectRunRow {
  id: number;
  agent: string;
  run_type: string;
  observations: number;
  proposals: number;
  duration_ms: number;
  error: string | null;
  created_at: number;
}

export interface SpiceFeedbackRow {
  id: number;
  chat_id: string;
  rotation_id: number | null;
  signal_type: string;
  signal_source: string;
  confidence: number;
  dimensions: string;
  topic: string | null;
  register: string | null;
  created_at: number;
}

export function saveReflectProposal(
  agent: string,
  category: string,
  proposal: string,
  evidence: string,
  confidence: number,
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO reflect_proposals (agent, category, proposal, evidence, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'staged', ?)`,
  ).run(agent, category, proposal, evidence, confidence, now);
  return result.lastInsertRowid as number;
}

export function getReflectProposals(
  agent: string,
  status?: string,
  limit = 20,
): ReflectProposalRow[] {
  if (status) {
    return db.prepare(
      `SELECT * FROM reflect_proposals WHERE agent = ? AND status = ?
       ORDER BY confidence DESC, created_at DESC LIMIT ?`,
    ).all(agent, status, limit) as ReflectProposalRow[];
  }
  return db.prepare(
    `SELECT * FROM reflect_proposals WHERE agent = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(agent, limit) as ReflectProposalRow[];
}

export function getAllStagedProposals(limit = 30): ReflectProposalRow[] {
  return db.prepare(
    `SELECT * FROM reflect_proposals WHERE status = 'staged'
     ORDER BY confidence DESC, created_at DESC LIMIT ?`,
  ).all(limit) as ReflectProposalRow[];
}

export function updateProposalStatus(
  id: number,
  status: 'approved' | 'rejected' | 'applied' | 'expired',
  outcome?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  if (status === 'applied') {
    db.prepare(
      `UPDATE reflect_proposals SET status = ?, outcome = ?, applied_at = ?, reviewed_at = COALESCE(reviewed_at, ?) WHERE id = ?`,
    ).run(status, outcome ?? null, now, now, id);
  } else {
    db.prepare(
      `UPDATE reflect_proposals SET status = ?, outcome = ?, reviewed_at = ? WHERE id = ?`,
    ).run(status, outcome ?? null, now, id);
  }
}

export function getProposalHitRate(
  agent: string,
  windowDays = 30,
): { total: number; correct: number; rate: number } {
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const row = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'approved' OR status = 'applied' THEN 1 ELSE 0 END) as correct
     FROM reflect_proposals
     WHERE agent = ? AND status IN ('approved', 'rejected', 'applied') AND reviewed_at >= ?`,
  ).get(agent, cutoff) as { total: number; correct: number };
  return {
    total: row.total,
    correct: row.correct,
    rate: row.total > 0 ? row.correct / row.total : 0,
  };
}

export function saveReflectRun(
  agent: string,
  runType: string,
  observations: number,
  proposals: number,
  durationMs: number,
  error?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO reflect_runs (agent, run_type, observations, proposals, duration_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(agent, runType, observations, proposals, durationMs, error ?? null, now);
}

export function getRecentReflectRuns(agent: string, limit = 10): ReflectRunRow[] {
  return db.prepare(
    `SELECT * FROM reflect_runs WHERE agent = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(agent, limit) as ReflectRunRow[];
}

export function saveSpiceFeedback(
  chatId: string,
  rotationId: number | null,
  signalType: string,
  signalSource: string,
  confidence: number,
  dimensions: string,
  topic?: string,
  register?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO spice_feedback (chat_id, rotation_id, signal_type, signal_source, confidence, dimensions, topic, register, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, rotationId, signalType, signalSource, confidence, dimensions, topic ?? null, register ?? null, now);
}

export function getSpiceFeedbackSummary(
  chatId: string,
  sinceDays = 1,
): SpiceFeedbackRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  return db.prepare(
    `SELECT * FROM spice_feedback WHERE chat_id = ? AND created_at >= ?
     ORDER BY created_at DESC`,
  ).all(chatId, cutoff) as SpiceFeedbackRow[];
}

export function getConversationTurnsSince(
  chatId: string,
  sinceTimestamp: number,
): ConversationTurn[] {
  return db.prepare(
    `SELECT * FROM conversation_log WHERE chat_id = ? AND created_at >= ?
     ORDER BY created_at ASC`,
  ).all(chatId, sinceTimestamp) as ConversationTurn[];
}
