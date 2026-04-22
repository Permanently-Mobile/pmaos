/**
 * Scribe Librarian -- Memory Writer
 *
 * Writes classified items to the memories DB alongside vault routing.
 * Replaces fire-and-forget per-turn extraction with batch processing
 * that has full conversation thread context.
 *
 * Handles:
 *   - Category-to-memory property mapping
 *   - Curated salience scoring from confidence + category type
 *   - FTS5 Jaccard dedup against existing memories
 *   - Vector dedup via sqlite-vec nearest neighbor
 *   - Embedding generation + storage (memory_embeddings + vec_memories)
 *   - Cross-indexing with vault paths (memory_vault_links in scribe.db)
 */

import { logger } from '../logger.js';
import { getOrComputeEmbedding } from './embedding-cache.js';
import {
  getMainWriteDb,
  hasMainWriteDb,
  isVecAvailable,
  saveMemoryVaultLink,
} from './db.js';
import type Database from 'better-sqlite3-multiple-ciphers';
import type {
  ClassifiedItem,
  RouteResult,
  MemoryWriteResult,
  ScribeCategory,
} from './types.js';

type DatabaseHandle = InstanceType<typeof Database>;

// ── Category -> Memory mapping ──────────────────────────────────────

interface MemoryMapping {
  sector: 'semantic' | 'episodic';
  topicKey: string;
  salienceBoost: number;
}

const CATEGORY_MAP: Record<ScribeCategory, MemoryMapping | null> = {
  task:      { sector: 'episodic',  topicKey: 'projects',    salienceBoost: 0 },
  decision:  { sector: 'semantic',  topicKey: 'projects',    salienceBoost: 0.5 },
  progress:  { sector: 'episodic',  topicKey: 'projects',    salienceBoost: 0 },
  research:  { sector: 'episodic',  topicKey: 'projects',    salienceBoost: -0.5 },
  note:      { sector: 'semantic',  topicKey: 'general',     salienceBoost: 0 },
  daily_log: { sector: 'episodic',  topicKey: 'general',     salienceBoost: -0.5 },
  personal:  { sector: 'semantic',  topicKey: 'personal',    salienceBoost: 0.5 },
  financial: { sector: 'episodic',  topicKey: 'crypto',      salienceBoost: 0 },
  skip:      null,
};

// ── Salience calculation ────────────────────────────────────────────

/**
 * Map confidence (0.6-1.0) + category boost to salience (0.5-5.0).
 * Decisions and personal facts get boosted (high-value semantic).
 * Daily logs and research get penalized (transient episodic).
 */
function calculateSalience(confidence: number, boost: number): number {
  // confidence 0.6-1.0 -> base salience 1.0-4.0
  const base = 1.0 + (confidence - 0.6) * (3.0 / 0.4);
  return Math.max(0.5, Math.min(5.0, base + boost));
}

// ── Topic key resolution ────────────────────────────────────────────

const VALID_TOPICS = new Set([
  'preferences', 'family', 'projects', 'crypto', 'tools', 'personal', 'general',
]);

/**
 * Map Scribe's freeform topic to memory topic_key.
 * Falls back to the category's default topic.
 */
function resolveTopicKey(item: ClassifiedItem, defaultTopic: string): string {
  if (item.topic) {
    const t = item.topic.toLowerCase();
    if (t.includes('crypto') || t.includes('trading') || t.includes('defi')) return 'crypto';
    if (t.includes('family') || t.includes('child') || t.includes('spouse') || t.includes('kid')) return 'family';
    if (t.includes('tool') || t.includes('api') || t.includes('script') || t.includes('cli')) return 'tools';
    if (t.includes('prefer') || t.includes('like') || t.includes('style') || t.includes('want')) return 'preferences';
  }
  if (item.project) return 'projects';
  return defaultTopic;
}

// ── Jaccard similarity ──────────────────────────────────────────────

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const JACCARD_THRESHOLD = 0.7;
const COSINE_THRESHOLD = 0.92;

// ── Memory row type (matching main db.ts) ───────────────────────────

interface MemoryRow {
  id: number;
  chat_id: string;
  topic_key: string | null;
  content: string;
  sector: string;
  salience: number;
  tier: string;
  created_at: number;
  accessed_at: number;
}

// ── Core: write memories from classified items ──────────────────────

/**
 * Write classified items to the memories DB.
 * Called after vault routing with route results for cross-indexing.
 *
 * For each qualifying item:
 *   1. Map category -> sector, topic_key, salience
 *   2. FTS5 Jaccard dedup against existing memories
 *   3. Vector dedup via sqlite-vec nearest neighbor
 *   4. Create new memory or refresh existing duplicate
 *   5. Generate + save embedding (memory_embeddings + vec_memories)
 *   6. Cross-link memory to vault path (if vault write succeeded)
 */
export async function writeMemoriesFromClassified(
  chatId: string,
  items: ClassifiedItem[],
  routeResults: RouteResult[],
): Promise<MemoryWriteResult> {
  const result: MemoryWriteResult = {
    created: 0,
    updated: 0,
    deduplicated: 0,
    embedded: 0,
    errors: [],
  };

  if (!hasMainWriteDb()) {
    logger.warn('Main write DB not available -- skipping memory writes');
    return result;
  }

  const db = getMainWriteDb();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const route = routeResults[i];

    const mapping = CATEGORY_MAP[item.category];
    if (!mapping) continue;

    try {
      const topicKey = resolveTopicKey(item, mapping.topicKey);
      const salience = calculateSalience(item.confidence, mapping.salienceBoost);

      // ── Layer 1: FTS5 keyword dedup ───────────────────────────
      const ftsDup = findFtsDuplicate(db, chatId, item.content);

      if (ftsDup) {
        // Refresh existing memory with updated wording
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
          `UPDATE memories SET content = ?, accessed_at = ?, salience = MIN(salience + 0.2, 5.0) WHERE id = ?`,
        ).run(item.content, now, ftsDup.id);

        result.updated++;

        // Re-embed
        try {
          const emb = await getOrComputeEmbedding(item.content);
          saveEmbeddingToMain(db, ftsDup.id, emb, chatId);
          result.embedded++;
        } catch { /* non-fatal */ }

        // Cross-link if vault write succeeded
        if (route.written && route.path) {
          saveMemoryVaultLink(ftsDup.id, route.path, item.category);
        }

        result.deduplicated++;
        continue;
      }

      // ── Layer 2: Vector dedup ─────────────────────────────────
      let embedding: Float32Array | null = null;
      try {
        embedding = await getOrComputeEmbedding(item.content);
      } catch {
        // Can't embed -- proceed without vector dedup
      }

      if (embedding) {
        const vecDup = findVectorDuplicate(db, chatId, embedding);
        if (vecDup) {
          const now = Math.floor(Date.now() / 1000);
          db.prepare(
            `UPDATE memories SET content = ?, accessed_at = ?, salience = MIN(salience + 0.2, 5.0) WHERE id = ?`,
          ).run(item.content, now, vecDup.memoryId);

          result.updated++;
          saveEmbeddingToMain(db, vecDup.memoryId, embedding, chatId);
          result.embedded++;

          if (route.written && route.path) {
            saveMemoryVaultLink(vecDup.memoryId, route.path, item.category);
          }

          result.deduplicated++;
          continue;
        }
      }

      // ── No duplicate: create new memory ───────────────────────
      const now = Math.floor(Date.now() / 1000);
      const insertResult = db.prepare(
        `INSERT INTO memories (chat_id, content, sector, topic_key, salience, created_at, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(chatId, item.content, mapping.sector, topicKey, salience, now, now);

      const memId = insertResult.lastInsertRowid as number;
      result.created++;

      // Save embedding
      if (embedding) {
        saveEmbeddingToMain(db, memId, embedding, chatId);
        result.embedded++;
      }

      // Cross-link
      if (route.written && route.path) {
        saveMemoryVaultLink(memId, route.path, item.category);
      }

      logger.debug(
        { memId, category: item.category, topic: topicKey, salience: salience.toFixed(2) },
        'Scribe wrote memory',
      );

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${item.category}: ${errMsg}`);
      logger.error({ err: errMsg, content: item.content.slice(0, 50) }, 'Memory write failed');
    }
  }

  if (result.created > 0 || result.updated > 0) {
    logger.info(
      { created: result.created, updated: result.updated, deduped: result.deduplicated, embedded: result.embedded },
      'Scribe memory writes complete',
    );
  }

  return result;
}

// ── FTS5 duplicate finder ───────────────────────────────────────────

function findFtsDuplicate(
  db: DatabaseHandle,
  chatId: string,
  content: string,
): MemoryRow | null {
  const sanitized = content
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w: string) => `"${w}"*`)
    .join(' ');

  if (!sanitized) return null;

  try {
    const matches = db.prepare(
      `SELECT memories.* FROM memories
       JOIN memories_fts ON memories.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND memories.chat_id = ?
       ORDER BY rank
       LIMIT 5`,
    ).all(sanitized, chatId) as MemoryRow[];

    for (const mem of matches) {
      if (jaccardSimilarity(content, mem.content) > JACCARD_THRESHOLD) {
        return mem;
      }
    }
  } catch (err) {
    logger.debug({ err }, 'FTS5 dedup check failed (non-fatal)');
  }

  return null;
}

// ── Vector duplicate finder ─────────────────────────────────────────

function findVectorDuplicate(
  db: DatabaseHandle,
  chatId: string,
  embedding: Float32Array,
): { memoryId: number; distance: number } | null {
  if (!isVecAvailable()) return null;

  try {
    const blob = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );
    const results = db.prepare(
      `SELECT memory_id, distance
       FROM vec_memories
       WHERE embedding MATCH ? AND k = ? AND chat_id = ?
       ORDER BY distance`,
    ).all(blob, 3, chatId) as Array<{ memory_id: number; distance: number }>;

    for (const { memory_id, distance } of results) {
      const sim = 1 / (1 + distance);
      if (sim > COSINE_THRESHOLD) {
        return { memoryId: memory_id, distance };
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Vector dedup check failed (non-fatal)');
  }

  return null;
}

// ── Embedding writer (main DB) ──────────────────────────────────────

/**
 * Save an embedding to both memory_embeddings (legacy) and vec_memories (sqlite-vec).
 * Mirrors the logic in src/db.ts saveEmbedding() but uses the Scribe write connection.
 */
function saveEmbeddingToMain(
  db: DatabaseHandle,
  memoryId: number,
  embedding: Float32Array,
  chatId: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  const blob = Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );

  // Legacy table
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(memoryId, blob, 'text-embedding-bge-m3', now);

  // sqlite-vec virtual table (hex encoding workaround for better-sqlite3-multiple-ciphers)
  if (isVecAvailable()) {
    try {
      const hex = blob.toString('hex');
      const safeChatId = chatId.replace(/[^0-9\-]/g, '');
      if (!safeChatId) return;
      const safeMemId = Number(memoryId);
      if (!Number.isInteger(safeMemId) || safeMemId <= 0) return;
      db.exec(`DELETE FROM vec_memories WHERE memory_id = ${safeMemId}`);
      db.exec(
        `INSERT INTO vec_memories (memory_id, chat_id, embedding) VALUES (${safeMemId}, '${safeChatId}', X'${hex}')`,
      );
    } catch {
      // Non-fatal: vec table write failure
    }
  }
}
