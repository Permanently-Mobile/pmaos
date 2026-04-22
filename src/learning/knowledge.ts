/**
 * Knowledge storage and retrieval.
 *
 * Stores insights learned from study sessions, task analysis, and
 * cross-agent shared discoveries. Each entry is tagged with agent,
 * topic, and specialty for targeted retrieval.
 */

import { randomBytes } from 'crypto';
import { getLearningDb } from './index.js';

export interface KnowledgeEntry {
  id: string;
  agent: string;
  topic: string;
  specialty: string;
  insight: string;
  source: string;
  quality: number;
  created_at: number;
}

export interface KnowledgeStats {
  totalEntries: number;
  byAgent: Record<string, number>;
  byTopic: Record<string, number>;
  avgQuality: number;
}

const MAX_ENTRIES_PER_AGENT = 100;

/**
 * Store a new knowledge entry.
 * Auto-trims old entries per agent to prevent unbounded growth.
 */
export function storeKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'created_at'> & { id?: string; created_at?: number }): string {
  const db = getLearningDb();
  const id = entry.id || randomBytes(8).toString('hex');
  const now = entry.created_at || Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO agent_knowledge (id, agent, topic, specialty, insight, source, quality, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.agent, entry.topic, entry.specialty, entry.insight, entry.source, entry.quality ?? 1.0, now);

  // Trim old entries for this agent (keep most recent MAX_ENTRIES_PER_AGENT)
  db.prepare(`
    DELETE FROM agent_knowledge
    WHERE agent = ? AND id NOT IN (
      SELECT id FROM agent_knowledge
      WHERE agent = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(entry.agent, entry.agent, MAX_ENTRIES_PER_AGENT);

  return id;
}

/**
 * Get knowledge entries, optionally filtered by agent and/or specialty.
 */
export function getKnowledge(opts: {
  agent?: string;
  specialty?: string;
  topic?: string;
  limit?: number;
} = {}): KnowledgeEntry[] {
  const db = getLearningDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.agent) {
    conditions.push('agent = ?');
    params.push(opts.agent);
  }
  if (opts.specialty) {
    conditions.push('specialty = ?');
    params.push(opts.specialty);
  }
  if (opts.topic) {
    conditions.push('topic = ?');
    params.push(opts.topic);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 50;

  return db.prepare(`
    SELECT * FROM agent_knowledge ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as KnowledgeEntry[];
}

/**
 * Get knowledge for a specific agent, including shared "general" entries.
 */
export function getKnowledgeByAgent(agent: string, limit = 20): KnowledgeEntry[] {
  const db = getLearningDb();
  return db.prepare(`
    SELECT * FROM agent_knowledge
    WHERE agent = ? OR agent = 'shared'
    ORDER BY quality DESC, created_at DESC
    LIMIT ?
  `).all(agent, limit) as KnowledgeEntry[];
}

/**
 * Delete a knowledge entry by ID.
 * Also removes any referencing study_log entries (FK constraint).
 */
export function deleteKnowledge(id: string): boolean {
  const db = getLearningDb();
  // Remove FK references from study log first
  db.prepare('DELETE FROM agent_study_log WHERE knowledge_id = ?').run(id);
  const result = db.prepare('DELETE FROM agent_knowledge WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get aggregate stats about the knowledge base.
 */
export function getKnowledgeStats(): KnowledgeStats {
  const db = getLearningDb();

  const total = db.prepare('SELECT COUNT(*) as count FROM agent_knowledge').get() as { count: number };
  const avgQ = db.prepare('SELECT AVG(quality) as avg FROM agent_knowledge').get() as { avg: number | null };

  const agentRows = db.prepare(
    'SELECT agent, COUNT(*) as count FROM agent_knowledge GROUP BY agent'
  ).all() as Array<{ agent: string; count: number }>;

  const topicRows = db.prepare(
    'SELECT topic, COUNT(*) as count FROM agent_knowledge GROUP BY topic'
  ).all() as Array<{ topic: string; count: number }>;

  const byAgent: Record<string, number> = {};
  for (const row of agentRows) byAgent[row.agent] = row.count;

  const byTopic: Record<string, number> = {};
  for (const row of topicRows) byTopic[row.topic] = row.count;

  return {
    totalEntries: total.count,
    byAgent,
    byTopic,
    avgQuality: avgQ.avg ? Math.round(avgQ.avg * 100) / 100 : 0,
  };
}
