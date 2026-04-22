/**
 * Scribe -- embedding cache layer.
 *
 * Caches Venice AI embeddings in scribe.db to avoid redundant API calls.
 * Embeddings are stored as binary blobs (Float32Array serialized to Buffer).
 * TTL: 30 days -- embeddings don't go stale for dedup purposes.
 */

import crypto from 'crypto';

import { getScribeDb } from './db.js';
import { veniceEmbed } from '../venice.js';
import { logger } from '../logger.js';

// ── Constants ────────────────────────────────────────────────────────

const EMBEDDING_TTL_DAYS = 30;

/** Max texts per Venice API call to stay within rate limits. */
const BATCH_CHUNK_SIZE = 50;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize and SHA-256 hash text for cache key.
 * Same normalization as contentHash in db.ts so identical content matches.
 */
function hashContent(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Serialize a number[] embedding to a Buffer for SQLite BLOB storage. */
function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/** Deserialize a SQLite BLOB Buffer back to Float32Array. */
function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy into a fresh ArrayBuffer to guarantee correct alignment
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get an embedding for a text string, using cache when available.
 * Computes via Venice on cache miss and stores the result.
 */
export async function getOrComputeEmbedding(text: string): Promise<Float32Array> {
  const hash = hashContent(text);
  const db = getScribeDb();

  // Cache hit?
  const row = db.prepare(
    'SELECT embedding FROM embedding_cache WHERE content_hash = ?',
  ).get(hash) as { embedding: Buffer } | undefined;

  if (row) {
    return bufferToFloat32(row.embedding);
  }

  // Cache miss -- call Venice
  const result = await veniceEmbed({ input: text });
  if (!result.embeddings || result.embeddings.length === 0) {
    throw new Error('Venice returned no embeddings');
  }

  const embedding = result.embeddings[0];
  const buf = embeddingToBuffer(embedding);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    'INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, created_at) VALUES (?, ?, ?)',
  ).run(hash, buf, now);

  logger.debug({ hash: hash.slice(0, 12), dims: embedding.length }, 'Cached new embedding');
  return new Float32Array(embedding);
}

/**
 * Batch-get embeddings, leveraging cache for already-seen content.
 * Only calls Venice for uncached texts, in chunks of BATCH_CHUNK_SIZE.
 */
export async function getOrComputeEmbeddingBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const db = getScribeDb();
  const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];

  // Check cache for each text
  const selectStmt = db.prepare(
    'SELECT embedding FROM embedding_cache WHERE content_hash = ?',
  );

  for (let i = 0; i < texts.length; i++) {
    const hash = hashContent(texts[i]);
    const row = selectStmt.get(hash) as { embedding: Buffer } | undefined;
    if (row) {
      results[i] = bufferToFloat32(row.embedding);
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]);
    }
  }

  if (uncachedTexts.length === 0) {
    logger.debug({ total: texts.length, cached: texts.length }, 'All embeddings served from cache');
    return results as Float32Array[];
  }

  // Embed uncached texts in chunks via Venice batch API
  const now = Math.floor(Date.now() / 1000);
  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, created_at) VALUES (?, ?, ?)',
  );

  let embeddedCount = 0;

  for (let chunkStart = 0; chunkStart < uncachedTexts.length; chunkStart += BATCH_CHUNK_SIZE) {
    const batchTexts = uncachedTexts.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE);
    const batchIndices = uncachedIndices.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE);

    const embedResult = await veniceEmbed({ input: batchTexts });

    for (let j = 0; j < batchTexts.length; j++) {
      const embedding = embedResult.embeddings[j];
      if (!embedding) continue;

      const hash = hashContent(batchTexts[j]);
      const buf = embeddingToBuffer(embedding);
      insertStmt.run(hash, buf, now);

      results[batchIndices[j]] = new Float32Array(embedding);
      embeddedCount++;
    }
  }

  logger.debug(
    { total: texts.length, cached: texts.length - uncachedTexts.length, computed: embeddedCount },
    'Batch embedding complete',
  );

  return results as Float32Array[];
}

/**
 * Remove expired embeddings from the cache.
 * Returns the number of entries pruned.
 */
export function pruneExpiredEmbeddings(ttlDays = EMBEDDING_TTL_DAYS): number {
  const cutoff = Math.floor(Date.now() / 1000) - (ttlDays * 86400);
  const db = getScribeDb();
  const result = db.prepare('DELETE FROM embedding_cache WHERE created_at < ?').run(cutoff);
  const pruned = result.changes;

  if (pruned > 0) {
    logger.info({ pruned, ttlDays }, 'Pruned expired embeddings');
  }

  return pruned;
}
