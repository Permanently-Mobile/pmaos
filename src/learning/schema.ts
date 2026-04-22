/**
 * Learning system database schema.
 *
 * Tables live in bridge.db (shared across all agents).
 * Uses FTS5 for BM25-ranked full-text search with temporal decay.
 */

import Database from 'better-sqlite3-multiple-ciphers';

export function createLearningSchema(db: Database.Database): void {
  db.exec(`
    -- Agent knowledge: insights learned from study sessions and task analysis
    CREATE TABLE IF NOT EXISTS agent_knowledge (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      topic       TEXT NOT NULL,
      specialty   TEXT NOT NULL DEFAULT 'general',
      insight     TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'study',
      quality     REAL NOT NULL DEFAULT 1.0,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_agent
      ON agent_knowledge(agent, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_knowledge_specialty
      ON agent_knowledge(specialty, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_knowledge_topic
      ON agent_knowledge(topic, agent);

    -- FTS5 index on knowledge insights for BM25 search
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_knowledge_fts USING fts5(
      insight,
      topic,
      specialty,
      content=agent_knowledge,
      content_rowid=rowid
    );

    -- Sync triggers for FTS5
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON agent_knowledge BEGIN
      INSERT INTO agent_knowledge_fts(rowid, insight, topic, specialty)
        VALUES (new.rowid, new.insight, new.topic, new.specialty);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON agent_knowledge BEGIN
      INSERT INTO agent_knowledge_fts(agent_knowledge_fts, rowid, insight, topic, specialty)
        VALUES ('delete', old.rowid, old.insight, old.topic, old.specialty);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON agent_knowledge BEGIN
      INSERT INTO agent_knowledge_fts(agent_knowledge_fts, rowid, insight, topic, specialty)
        VALUES ('delete', old.rowid, old.insight, old.topic, old.specialty);
      INSERT INTO agent_knowledge_fts(rowid, insight, topic, specialty)
        VALUES (new.rowid, new.insight, new.topic, new.specialty);
    END;

    -- Task feedback: scored results from completed work
    CREATE TABLE IF NOT EXISTS agent_feedback (
      id              TEXT PRIMARY KEY,
      agent           TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      task_summary    TEXT NOT NULL,
      score           REAL NOT NULL DEFAULT 0,
      comments        TEXT NOT NULL DEFAULT '',
      lessons_learned TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_agent
      ON agent_feedback(agent, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_feedback_score
      ON agent_feedback(agent, score);

    -- FTS5 index on feedback for search
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_feedback_fts USING fts5(
      task_summary,
      comments,
      lessons_learned,
      content=agent_feedback,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS feedback_fts_insert AFTER INSERT ON agent_feedback BEGIN
      INSERT INTO agent_feedback_fts(rowid, task_summary, comments, lessons_learned)
        VALUES (new.rowid, new.task_summary, new.comments, COALESCE(new.lessons_learned, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS feedback_fts_delete AFTER DELETE ON agent_feedback BEGIN
      INSERT INTO agent_feedback_fts(agent_feedback_fts, rowid, task_summary, comments, lessons_learned)
        VALUES ('delete', old.rowid, old.task_summary, old.comments, COALESCE(old.lessons_learned, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS feedback_fts_update AFTER UPDATE ON agent_feedback BEGIN
      INSERT INTO agent_feedback_fts(agent_feedback_fts, rowid, task_summary, comments, lessons_learned)
        VALUES ('delete', old.rowid, old.task_summary, old.comments, COALESCE(old.lessons_learned, ''));
      INSERT INTO agent_feedback_fts(rowid, task_summary, comments, lessons_learned)
        VALUES (new.rowid, new.task_summary, new.comments, COALESCE(new.lessons_learned, ''));
    END;

    -- Study session log: tracks when agents studied and what they learned
    CREATE TABLE IF NOT EXISTS agent_study_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent           TEXT NOT NULL,
      topic           TEXT NOT NULL,
      specialty       TEXT NOT NULL DEFAULT 'general',
      tokens_used     INTEGER NOT NULL DEFAULT 0,
      knowledge_id    TEXT,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY (knowledge_id) REFERENCES agent_knowledge(id)
    );

    CREATE INDEX IF NOT EXISTS idx_study_agent
      ON agent_study_log(agent, created_at DESC);
  `);
}
