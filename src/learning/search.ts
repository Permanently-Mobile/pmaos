/**
 * Learning search with BM25 ranking and temporal decay.
 *
 * Uses SQLite FTS5 for BM25-ranked full-text search, then applies
 * temporal decay (30-day half-life) to favor recent knowledge.
 *
 * Adapted from CashClaw's BM25 + temporal decay pattern.
 */

import { getLearningDb } from './index.js';
import type { KnowledgeEntry } from './knowledge.js';
import type { FeedbackEntry } from './feedback.js';

// Temporal decay: 30-day half-life
const DECAY_HALF_LIFE_SECONDS = 30 * 24 * 60 * 60;
const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_SECONDS;

export interface SearchHit {
  id: string;
  type: 'knowledge' | 'feedback';
  text: string;
  score: number;
  agent: string;
  created_at: number;
}

export interface SearchOptions {
  /** Filter to specific agent (omit for all agents) */
  agent?: string;
  /** Include shared/cross-agent knowledge (default: true) */
  includeShared?: boolean;
  /** Max results to return (default: 5) */
  limit?: number;
  /** Minimum BM25 score threshold (default: 0) */
  minScore?: number;
}

/**
 * Search both knowledge and feedback using BM25 with temporal decay.
 * Returns a unified, scored, and sorted result set.
 */
export function searchLearning(query: string, opts: SearchOptions = {}): SearchHit[] {
  if (!query.trim()) return [];

  const limit = opts.limit ?? 5;
  const includeShared = opts.includeShared ?? true;

  const knowledgeHits = searchKnowledge(query, opts);
  const feedbackHits = searchFeedback(query, opts);

  // Merge, sort by decayed score, limit
  return [...knowledgeHits, ...feedbackHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Search the knowledge base using FTS5 BM25 with temporal decay.
 */
export function searchKnowledge(query: string, opts: SearchOptions = {}): SearchHit[] {
  if (!query.trim()) return [];

  const db = getLearningDb();
  const limit = opts.limit ?? 10;
  const now = Math.floor(Date.now() / 1000);

  // Build agent filter
  let agentFilter = '';
  const params: unknown[] = [query];

  if (opts.agent) {
    if (opts.includeShared !== false) {
      agentFilter = "AND k.agent IN (?, 'shared')";
      params.push(opts.agent);
    } else {
      agentFilter = 'AND k.agent = ?';
      params.push(opts.agent);
    }
  }

  params.push(limit * 3); // fetch extra for post-decay reranking

  // FTS5 BM25 search with join back to main table
  const rows = db.prepare(`
    SELECT
      k.id,
      k.agent,
      k.topic,
      k.specialty,
      k.insight,
      k.quality,
      k.created_at,
      fts.rank as bm25_score
    FROM agent_knowledge_fts fts
    JOIN agent_knowledge k ON k.rowid = fts.rowid
    WHERE agent_knowledge_fts MATCH ?
    ${agentFilter}
    ORDER BY fts.rank
    LIMIT ?
  `).all(...params) as Array<KnowledgeEntry & { bm25_score: number }>;

  return rows.map(row => {
    // FTS5 rank is negative (lower = better match), invert it
    const bm25 = Math.abs(row.bm25_score);
    const age = now - row.created_at;
    const decay = Math.exp(-DECAY_LAMBDA * age);
    const finalScore = bm25 * decay * (row.quality ?? 1.0);

    return {
      id: row.id,
      type: 'knowledge' as const,
      text: `[${row.topic}/${row.specialty}] ${row.insight}`,
      score: finalScore,
      agent: row.agent,
      created_at: row.created_at,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Search feedback entries using FTS5 BM25 with temporal decay.
 */
export function searchFeedback(query: string, opts: SearchOptions = {}): SearchHit[] {
  if (!query.trim()) return [];

  const db = getLearningDb();
  const limit = opts.limit ?? 10;
  const now = Math.floor(Date.now() / 1000);

  let agentFilter = '';
  const params: unknown[] = [query];

  if (opts.agent) {
    agentFilter = 'AND f.agent = ?';
    params.push(opts.agent);
  }

  params.push(limit * 3);

  const rows = db.prepare(`
    SELECT
      f.id,
      f.agent,
      f.task_summary,
      f.score as task_score,
      f.comments,
      f.lessons_learned,
      f.created_at,
      fts.rank as bm25_score
    FROM agent_feedback_fts fts
    JOIN agent_feedback f ON f.rowid = fts.rowid
    WHERE agent_feedback_fts MATCH ?
    ${agentFilter}
    ORDER BY fts.rank
    LIMIT ?
  `).all(...params) as Array<FeedbackEntry & { bm25_score: number; task_score: number }>;

  return rows.map(row => {
    const bm25 = Math.abs(row.bm25_score);
    const age = now - row.created_at;
    const decay = Math.exp(-DECAY_LAMBDA * age);
    // Boost high-scoring tasks (lessons from success are more valuable)
    const scoreBoost = row.task_score >= 4 ? 1.2 : row.task_score <= 2 ? 0.8 : 1.0;
    const finalScore = bm25 * decay * scoreBoost;

    const lessonsText = row.lessons_learned ? ` Lesson: ${row.lessons_learned}` : '';
    return {
      id: row.id,
      type: 'feedback' as const,
      text: `[${row.task_score}/5] "${row.task_summary}" -- ${row.comments}${lessonsText}`,
      score: finalScore,
      agent: row.agent,
      created_at: row.created_at,
    };
  }).sort((a, b) => b.score - a.score);
}
