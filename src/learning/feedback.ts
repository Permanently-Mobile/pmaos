/**
 * Task feedback storage and retrieval.
 *
 * Tracks scored results from completed work across all agents.
 * Feeds into the search system for context-aware task execution
 * and into study sessions for self-improvement.
 */

import { randomBytes } from 'crypto';
import { getLearningDb } from './index.js';

export interface FeedbackEntry {
  id: string;
  agent: string;
  task_id: string;
  task_summary: string;
  score: number;
  comments: string;
  lessons_learned: string | null;
  created_at: number;
}

export interface FeedbackStats {
  totalTasks: number;
  avgScore: number;
  byAgent: Record<string, { count: number; avgScore: number }>;
  recentTrend: 'improving' | 'declining' | 'stable' | 'insufficient_data';
}

const MAX_ENTRIES_PER_AGENT = 200;

/**
 * Store feedback for a completed task.
 */
export function storeFeedback(entry: Omit<FeedbackEntry, 'id' | 'created_at'> & { id?: string; created_at?: number }): string {
  const db = getLearningDb();
  const id = entry.id || randomBytes(8).toString('hex');
  const now = entry.created_at || Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO agent_feedback (id, agent, task_id, task_summary, score, comments, lessons_learned, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.agent, entry.task_id, entry.task_summary, entry.score, entry.comments, entry.lessons_learned ?? null, now);

  // Trim old entries
  db.prepare(`
    DELETE FROM agent_feedback
    WHERE agent = ? AND id NOT IN (
      SELECT id FROM agent_feedback
      WHERE agent = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(entry.agent, entry.agent, MAX_ENTRIES_PER_AGENT);

  return id;
}

/**
 * Get feedback entries, optionally filtered.
 */
export function getFeedback(opts: {
  agent?: string;
  minScore?: number;
  maxScore?: number;
  limit?: number;
} = {}): FeedbackEntry[] {
  const db = getLearningDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.agent) {
    conditions.push('agent = ?');
    params.push(opts.agent);
  }
  if (opts.minScore !== undefined) {
    conditions.push('score >= ?');
    params.push(opts.minScore);
  }
  if (opts.maxScore !== undefined) {
    conditions.push('score <= ?');
    params.push(opts.maxScore);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 50;

  return db.prepare(`
    SELECT * FROM agent_feedback ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as FeedbackEntry[];
}

/**
 * Get aggregate feedback statistics.
 */
export function getFeedbackStats(agent?: string): FeedbackStats {
  const db = getLearningDb();

  const agentFilter = agent ? 'WHERE agent = ?' : '';
  const agentParams = agent ? [agent] : [];

  const total = db.prepare(
    `SELECT COUNT(*) as count, AVG(score) as avg FROM agent_feedback ${agentFilter}`
  ).get(...agentParams) as { count: number; avg: number | null };

  const agentRows = db.prepare(
    'SELECT agent, COUNT(*) as count, AVG(score) as avg FROM agent_feedback GROUP BY agent'
  ).all() as Array<{ agent: string; count: number; avg: number }>;

  const byAgent: Record<string, { count: number; avgScore: number }> = {};
  for (const row of agentRows) {
    byAgent[row.agent] = {
      count: row.count,
      avgScore: Math.round(row.avg * 10) / 10,
    };
  }

  // Calculate trend from last 20 vs previous 20 tasks
  let recentTrend: FeedbackStats['recentTrend'] = 'insufficient_data';
  const recentFilter = agent ? 'WHERE agent = ?' : '';
  const recentRows = db.prepare(
    `SELECT score FROM agent_feedback ${recentFilter} ORDER BY created_at DESC LIMIT 40`
  ).all(...agentParams) as Array<{ score: number }>;

  if (recentRows.length >= 10) {
    const half = Math.floor(recentRows.length / 2);
    const recent = recentRows.slice(0, half);
    const older = recentRows.slice(half);
    const recentAvg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
    const olderAvg = older.reduce((s, r) => s + r.score, 0) / older.length;
    const diff = recentAvg - olderAvg;
    if (diff > 0.3) recentTrend = 'improving';
    else if (diff < -0.3) recentTrend = 'declining';
    else recentTrend = 'stable';
  }

  return {
    totalTasks: total.count,
    avgScore: total.avg ? Math.round(total.avg * 10) / 10 : 0,
    byAgent,
    recentTrend,
  };
}
