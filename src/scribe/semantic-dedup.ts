/**
 * Scribe -- semantic deduplication engine.
 *
 * Uses Venice embeddings + cosine similarity to detect near-duplicate
 * content that stem-matching might miss. Designed as a second-tier check
 * for the ambiguous range (0.4 - 0.9) of stem similarity scores.
 *
 * Phase 2 additions:
 *   - findBestVaultMatch: cross-vault semantic check for notes
 *   - findDuplicateInList: per-item semantic check for tasks
 */

import { getOrComputeEmbedding, getOrComputeEmbeddingBatch } from './embedding-cache.js';
import { logger } from '../logger.js';
import type { VaultIndex } from './types.js';

// ── Constants ────────────────────────────────────────────────────────

/** Default cosine similarity threshold for declaring a duplicate. */
const DEFAULT_THRESHOLD = 0.80;

/** Lower threshold for task dedup (paraphrases are common). */
const TASK_THRESHOLD = 0.75;

/** Threshold for cross-vault note matching against project files. */
const VAULT_MATCH_THRESHOLD = 0.75;

/** Lines shorter than this are skipped (not meaningful enough to embed). */
const MIN_LINE_LENGTH = 15;

/** Cap on how many vault lines to compare against per file (cost control). */
const MAX_COMPARISON_LINES = 200;

/** Max files to scan for cross-vault matching (cost control). */
const MAX_VAULT_FILES = 50;

/** Max lines per file for cross-vault matching (cost control). */
const MAX_LINES_PER_FILE = 100;

// ── Cosine similarity ────────────────────────────────────────────────

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns value in [-1, 1], where 1 = identical direction.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Public API ───────────────────────────────────────────────────────

export interface SemanticDedupResult {
  isDupe: boolean;
  bestMatch: string;
  similarity: number;
}

export interface VaultMatchResult {
  filePath: string;
  relativePath: string;
  similarity: number;
  matchedLine: string;
}

/**
 * Check if a new item is semantically duplicated by any existing content.
 *
 * Embeds the new item and all significant existing lines via Venice,
 * then returns the best cosine similarity match. Embeddings are cached
 * aggressively so repeated vault lines cost zero API calls.
 *
 * @param newItem  The incoming content to check
 * @param existingContent  Array of existing vault lines to compare against
 * @param threshold  Cosine similarity threshold (default 0.80)
 */
export async function isSemanticallyDuplicate(
  newItem: string,
  existingContent: string[],
  threshold = DEFAULT_THRESHOLD,
): Promise<SemanticDedupResult> {
  // Filter to lines worth embedding (skip short/empty lines)
  const significant = existingContent
    .filter(line => line.trim().length >= MIN_LINE_LENGTH)
    .slice(-MAX_COMPARISON_LINES); // keep the most recent lines

  if (significant.length === 0) {
    return { isDupe: false, bestMatch: '', similarity: 0 };
  }

  // Embed the new item
  const newEmbedding = await getOrComputeEmbedding(newItem);

  // Batch embed existing content (cache handles repeat lines for free)
  const existingEmbeddings = await getOrComputeEmbeddingBatch(significant);

  // Find best cosine similarity match
  let bestSimilarity = 0;
  let bestMatch = '';

  for (let i = 0; i < existingEmbeddings.length; i++) {
    const sim = cosineSimilarity(newEmbedding, existingEmbeddings[i]);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = significant[i];
    }
  }

  const isDupe = bestSimilarity >= threshold;

  if (isDupe) {
    logger.debug(
      {
        similarity: bestSimilarity.toFixed(3),
        threshold,
        newItem: newItem.slice(0, 60),
        matchedTo: bestMatch.slice(0, 60),
      },
      'Semantic duplicate detected',
    );
  }

  return { isDupe, bestMatch, similarity: bestSimilarity };
}

/**
 * Phase 2: Cross-vault semantic check for notes.
 *
 * Before creating a new note file, embed the content and compare against
 * ALL project files and existing notes in the vault. If the content
 * is already covered by an existing file, return the match so the
 * router can skip or redirect.
 *
 * Cost-controlled: caps at MAX_VAULT_FILES files, MAX_LINES_PER_FILE per file.
 * Embedding cache makes repeated lines free.
 */
export async function findBestVaultMatch(
  content: string,
  vaultIndex: VaultIndex,
  excludePath?: string,
): Promise<VaultMatchResult | null> {
  // Prioritize project files and existing notes (most likely match targets)
  const candidates = vaultIndex.files
    .filter(f => {
      // Only check Project files and Notes (skip daily notes, templates, etc.)
      const rp = f.relativePath;
      if (excludePath && f.path === excludePath) return false;
      if (rp.startsWith('Projects/') || rp.startsWith('Notes/')) return true;
      // Also check Deepdives & Ongoing and Tasks.md
      if (rp === 'Deepdives & Ongoing.md' || rp === 'Tasks.md') return true;
      return false;
    })
    // Sort by modification time (recent files more likely to match recent conversation)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, MAX_VAULT_FILES);

  if (candidates.length === 0) {
    return null;
  }

  // Embed the incoming content once
  let newEmbedding: Float32Array;
  try {
    newEmbedding = await getOrComputeEmbedding(content);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cross-vault embed failed');
    return null;
  }

  let bestResult: VaultMatchResult | null = null;
  let bestSimilarity = 0;

  // Collect all lines from all candidate files with file tracking
  const allLines: string[] = [];
  const lineFileMap: Array<{ fileIdx: number; line: string }> = [];

  for (let fi = 0; fi < candidates.length; fi++) {
    const file = candidates[fi];
    const lines = file.contentLines
      .filter(l => l.trim().length >= MIN_LINE_LENGTH)
      .slice(-MAX_LINES_PER_FILE);

    for (const line of lines) {
      allLines.push(line);
      lineFileMap.push({ fileIdx: fi, line });
    }
  }

  if (allLines.length === 0) {
    return null;
  }

  // Batch embed all vault lines (cache makes this cheap for repeat content)
  let allEmbeddings: Float32Array[];
  try {
    allEmbeddings = await getOrComputeEmbeddingBatch(allLines);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cross-vault batch embed failed');
    return null;
  }

  // Find the best match across all files
  for (let i = 0; i < allEmbeddings.length; i++) {
    const sim = cosineSimilarity(newEmbedding, allEmbeddings[i]);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      const fileEntry = candidates[lineFileMap[i].fileIdx];
      bestResult = {
        filePath: fileEntry.path,
        relativePath: fileEntry.relativePath,
        similarity: sim,
        matchedLine: lineFileMap[i].line,
      };
    }
  }

  if (bestResult && bestSimilarity >= VAULT_MATCH_THRESHOLD) {
    logger.debug(
      {
        similarity: bestSimilarity.toFixed(3),
        matchedFile: bestResult.relativePath,
        matchedLine: bestResult.matchedLine.slice(0, 60),
        content: content.slice(0, 60),
      },
      'Cross-vault match found',
    );
    return bestResult;
  }

  return null;
}

/**
 * Phase 2: Per-item semantic dedup against a flat list.
 *
 * Used for comparing incoming tasks against all open tasks in the vault.
 * Lower threshold (0.75) than general dedup to catch paraphrases like
 * "Build Scout agent" vs "Develop Scout agent for crypto pipeline".
 */
export async function findDuplicateInList(
  content: string,
  existingItems: string[],
  threshold = TASK_THRESHOLD,
): Promise<SemanticDedupResult> {
  // Filter to significant items
  const significant = existingItems.filter(item => item.trim().length >= MIN_LINE_LENGTH);

  if (significant.length === 0) {
    return { isDupe: false, bestMatch: '', similarity: 0 };
  }

  // Embed the new item
  let newEmbedding: Float32Array;
  try {
    newEmbedding = await getOrComputeEmbedding(content);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Task embed failed');
    return { isDupe: false, bestMatch: '', similarity: 0 };
  }

  // Batch embed existing items (cached)
  let existingEmbeddings: Float32Array[];
  try {
    existingEmbeddings = await getOrComputeEmbeddingBatch(significant);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Task list batch embed failed');
    return { isDupe: false, bestMatch: '', similarity: 0 };
  }

  // Find best match
  let bestSimilarity = 0;
  let bestMatch = '';

  for (let i = 0; i < existingEmbeddings.length; i++) {
    const sim = cosineSimilarity(newEmbedding, existingEmbeddings[i]);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = significant[i];
    }
  }

  const isDupe = bestSimilarity >= threshold;

  if (isDupe) {
    logger.debug(
      {
        similarity: bestSimilarity.toFixed(3),
        threshold,
        newItem: content.slice(0, 60),
        matchedTo: bestMatch.slice(0, 60),
      },
      'Task list semantic duplicate detected',
    );
  }

  return { isDupe, bestMatch, similarity: bestSimilarity };
}
