/**
 * Privacy Audit Logger -- Append-Only Audit Trail
 *
 * Logs every routing decision to SQLite for compliance and analytics.
 * Uses the existing apex.db (via better-sqlite3-multiple-ciphers).
 *
 * The audit log never stores message content -- only a SHA-256 hash.
 * This module is designed for standalone extraction (minimal Apex dependencies).
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3-multiple-ciphers';

import type { AuditEntry, AuditStats } from './types.js';
import { logger } from '../logger.js';

// ── Schema ─────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS privacy_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    message_hash TEXT NOT NULL,
    sensitivity_score REAL NOT NULL,
    categories TEXT NOT NULL,
    detection_count INTEGER NOT NULL,
    recommendation TEXT NOT NULL,
    actual_route TEXT NOT NULL,
    was_sanitized INTEGER NOT NULL DEFAULT 0,
    redaction_count INTEGER NOT NULL DEFAULT 0,
    overridden INTEGER NOT NULL DEFAULT 0,
    override_reason TEXT
  );
`;

const CREATE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_privacy_audit_chat ON privacy_audit(chat_id);
  CREATE INDEX IF NOT EXISTS idx_privacy_audit_ts ON privacy_audit(timestamp);
  CREATE INDEX IF NOT EXISTS idx_privacy_audit_score ON privacy_audit(sensitivity_score);
`;

// ── Logger class ───────────────────────────────────────────────────────

/**
 * Append-only privacy audit logger backed by SQLite.
 * All writes are synchronous (better-sqlite3). Errors are caught and
 * logged but never swallowed silently.
 */
export class PrivacyAuditLogger {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private initialized = false;

  /**
   * @param db - An already-opened better-sqlite3 Database instance (apex.db)
   */
  constructor(db: Database.Database) {
    this.db = db;
    this.ensureSchema();
    this.insertStmt = this.db.prepare(`
      INSERT INTO privacy_audit (
        timestamp, chat_id, message_hash, sensitivity_score,
        categories, detection_count, recommendation, actual_route,
        was_sanitized, redaction_count, overridden, override_reason
      ) VALUES (
        @timestamp, @chatId, @messageHash, @sensitivityScore,
        @categories, @detectionCount, @recommendation, @actualRoute,
        @wasSanitized, @redactionCount, @overridden, @overrideReason
      )
    `);
    this.initialized = true;
  }

  /** Create the privacy_audit table and indexes if they don't exist. */
  private ensureSchema(): void {
    try {
      this.db.exec(CREATE_TABLE_SQL);
      this.db.exec(CREATE_INDEXES_SQL);
    } catch (err) {
      logger.error({ err }, 'Failed to create privacy_audit schema');
      throw err;
    }
  }

  /**
   * Hash a message with SHA-256 for the audit log.
   * We never store raw message content in the audit trail.
   */
  static hashMessage(message: string): string {
    return createHash('sha256').update(message).digest('hex');
  }

  /**
   * Append an audit entry. Synchronous write.
   * Errors are logged but re-thrown -- callers should catch if needed.
   */
  log(entry: AuditEntry): void {
    if (!this.initialized) {
      logger.warn('PrivacyAuditLogger not initialized, skipping log');
      return;
    }

    try {
      this.insertStmt.run({
        timestamp: entry.timestamp,
        chatId: entry.chatId,
        messageHash: entry.messageHash,
        sensitivityScore: entry.sensitivityScore,
        categories: entry.categories,
        detectionCount: entry.detectionCount,
        recommendation: entry.recommendation,
        actualRoute: entry.actualRoute,
        wasSanitized: entry.wasSanitized ? 1 : 0,
        redactionCount: entry.redactionCount,
        overridden: entry.overridden ? 1 : 0,
        overrideReason: entry.overrideReason ?? null,
      });
    } catch (err) {
      logger.error({ err, chatId: entry.chatId }, 'Failed to write privacy audit entry');
      throw err;
    }
  }

  /**
   * Get aggregate stats from the audit log.
   *
   * @param chatId - Filter by chat ID (optional, all chats if omitted)
   * @param since - Only include entries after this epoch timestamp (optional)
   */
  getStats(chatId?: string, since?: number): AuditStats {
    try {
      const whereClause: string[] = [];
      const params: Record<string, unknown> = {};

      if (chatId) {
        whereClause.push('chat_id = @chatId');
        params.chatId = chatId;
      }
      if (since !== undefined) {
        whereClause.push('timestamp >= @since');
        params.since = since;
      }

      const where = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';

      // Main aggregates
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN actual_route IN ('venice', 'ollama') THEN 1 ELSE 0 END) as privacy_routed,
          SUM(CASE WHEN actual_route NOT IN ('venice', 'ollama', 'blocked') THEN 1 ELSE 0 END) as standard_routed,
          SUM(CASE WHEN recommendation = 'block' THEN 1 ELSE 0 END) as blocked,
          AVG(sensitivity_score) as avg_score
        FROM privacy_audit ${where}
      `).get(params) as {
        total: number;
        privacy_routed: number;
        standard_routed: number;
        blocked: number;
        avg_score: number | null;
      };

      // Top categories (parse JSON arrays and count occurrences)
      const catRows = this.db.prepare(`
        SELECT categories FROM privacy_audit ${where}
      `).all(params) as Array<{ categories: string }>;

      const catCounts = new Map<string, number>();
      for (const r of catRows) {
        try {
          const cats = JSON.parse(r.categories) as string[];
          for (const c of cats) {
            catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
          }
        } catch {
          // Skip malformed entries
        }
      }

      const topCategories = Array.from(catCounts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return {
        totalRequests: row.total,
        privacyRouted: row.privacy_routed,
        standardRouted: row.standard_routed,
        blocked: row.blocked,
        topCategories,
        averageSensitivityScore: row.avg_score ?? 0,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get privacy audit stats');
      return {
        totalRequests: 0,
        privacyRouted: 0,
        standardRouted: 0,
        blocked: 0,
        topCategories: [],
        averageSensitivityScore: 0,
      };
    }
  }

  /**
   * Retrieve recent audit entries for a chat.
   *
   * @param chatId - The chat to query
   * @param limit - Max entries to return (default 50)
   */
  getEntries(chatId: string, limit = 50): AuditEntry[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM privacy_audit
        WHERE chat_id = @chatId
        ORDER BY timestamp DESC
        LIMIT @limit
      `).all({ chatId, limit }) as Array<{
        id: number;
        timestamp: number;
        chat_id: string;
        message_hash: string;
        sensitivity_score: number;
        categories: string;
        detection_count: number;
        recommendation: string;
        actual_route: string;
        was_sanitized: number;
        redaction_count: number;
        overridden: number;
        override_reason: string | null;
      }>;

      return rows.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        chatId: r.chat_id,
        messageHash: r.message_hash,
        sensitivityScore: r.sensitivity_score,
        categories: r.categories,
        detectionCount: r.detection_count,
        recommendation: r.recommendation,
        actualRoute: r.actual_route,
        wasSanitized: r.was_sanitized === 1,
        redactionCount: r.redaction_count,
        overridden: r.overridden === 1,
        overrideReason: r.override_reason ?? undefined,
      }));
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to get privacy audit entries');
      return [];
    }
  }

  /**
   * Export audit entries as CSV for compliance reporting.
   *
   * @param since - Only include entries after this epoch timestamp
   */
  exportCSV(since: number): string {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM privacy_audit
        WHERE timestamp >= @since
        ORDER BY timestamp ASC
      `).all({ since }) as Array<{
        id: number;
        timestamp: number;
        chat_id: string;
        message_hash: string;
        sensitivity_score: number;
        categories: string;
        detection_count: number;
        recommendation: string;
        actual_route: string;
        was_sanitized: number;
        redaction_count: number;
        overridden: number;
        override_reason: string | null;
      }>;

      const header = 'id,timestamp,chat_id,message_hash,sensitivity_score,categories,detection_count,recommendation,actual_route,was_sanitized,redaction_count,overridden,override_reason';
      const lines = rows.map(r =>
        [
          r.id,
          r.timestamp,
          csvEscape(r.chat_id),
          r.message_hash,
          r.sensitivity_score.toFixed(2),
          csvEscape(r.categories),
          r.detection_count,
          r.recommendation,
          r.actual_route,
          r.was_sanitized,
          r.redaction_count,
          r.overridden,
          csvEscape(r.override_reason ?? ''),
        ].join(',')
      );

      return [header, ...lines].join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to export privacy audit CSV');
      return '';
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Escape a string for CSV (wrap in quotes if it contains comma, quote, or newline). */
function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
