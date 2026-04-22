/**
 * Memory Consolidation (Phase 4 + Phase 5C upgrade)
 *
 * Nightly sweep that runs alongside decay:
 *   1. Finds highly similar memories (>0.9) and merges them
 *   2. Detects contradictions (0.7-0.9 similarity with conflicting content)
 *   3. Clusters episodic memories and generates consolidated summaries
 *
 * Phase 5C additions:
 *   - Namespace-aware: never merges across different agent_ids
 *   - Danger-zone priority: processes memories scoring 0.25-1.5 first (spaced repetition)
 *   - Fleet dedup: cross-agent dedup for shared namespace memories
 *
 * Uses sqlite-vec for similarity lookup and Venice for merge/contradiction analysis.
 * Runs as part of runDecaySweep() in memory.ts.
 */

import {
  deleteMemory,
  getAgentIdsForChat,
  getEmbeddingForMemory,
  getMemoryById,
  getMemoryIdsWithEmbeddingsForAgent,
  getSharedMemoryIdsWithEmbeddings,
  saveEmbedding,
  saveMemoryReturningId,
  updateMemoryContent,
  vectorSearch,
  type Memory,
} from './db.js';
import { veniceCapabilities, venicePrivateChat } from './venice.js';
import { embedText } from './memory-extract.js';
import { logger } from './logger.js';

// ── Thresholds ──────────────────────────────────────────────────────

/** Similarity above this = merge candidates. */
const MERGE_THRESHOLD = 0.90;

/** Similarity in this range = potential contradiction. */
const CONTRADICTION_HIGH = 0.90;
const CONTRADICTION_LOW = 0.70;

/** Max memories to process per sweep (rate limit protection). */
const MAX_CONSOLIDATION_PER_SWEEP = 50;

/** Max merges per sweep to avoid runaway consolidation. */
const MAX_MERGES_PER_SWEEP = 10;

/** Min episodic cluster size to trigger summary. */
const MIN_CLUSTER_SIZE = 3;

// ── Venice prompts ──────────────────────────────────────────────────

const MERGE_PROMPT = `You are a memory consolidation system. Given two similar memory facts about the same user, merge them into a single, more complete fact.

Rules:
- Keep all unique information from both facts
- Write as a concise third-person statement
- If one fact is more recent or specific, prefer that detail
- Return ONLY the merged fact text. No explanation, no quotes.`;

const CONTRADICTION_PROMPT = `You are a memory analysis system. Given two memory facts about the same user, determine if they contradict each other.

Rules:
- Return "CONTRADICTION" if the facts directly conflict (e.g. "prefers dark mode" vs "prefers light mode")
- Return "COMPATIBLE" if they can both be true (e.g. "likes coffee" and "drinks coffee every morning")
- Return "SUPERSEDED" if one fact updates or replaces the other (e.g. "uses React" vs "switched from React to Vue")
- Return ONLY one of these three words. No explanation.`;

const EPISODIC_SUMMARY_PROMPT = `You are a memory consolidation system. Given a cluster of related episodic memories (events, decisions, tasks), generate a single consolidated summary that captures the key information.

Rules:
- Write as a concise third-person statement
- Capture the overall narrative or decision arc
- Keep dates and specific outcomes if mentioned
- Maximum 2 sentences
- Return ONLY the summary text. No explanation, no quotes.`;

// ── Core consolidation ──────────────────────────────────────────────

interface ConsolidationResult {
  merged: number;
  contradictions: number;
  episodicSummaries: number;
}

/** Salience range for danger-zone prioritization (Phase 5C). */
const DANGER_ZONE_LOW = 0.25;
const DANGER_ZONE_HIGH = 1.5;

/**
 * Run the full consolidation sweep for a single chat.
 * Called from runDecaySweep() in memory.ts.
 *
 * Phase 5C upgrades:
 *   - Namespace-aware: never merge across different agent_ids
 *   - Danger-zone priority: process fading memories (0.25-1.5) first
 *   - Fleet dedup: cross-agent duplicate removal in shared namespace
 */
export async function runConsolidation(chatId: string): Promise<ConsolidationResult> {
  const result: ConsolidationResult = { merged: 0, contradictions: 0, episodicSummaries: 0 };

  const { configured } = veniceCapabilities();
  if (!configured) {
    logger.debug('Consolidation skipped (Venice not configured)');
    return result;
  }

  const alreadyMerged = new Set<number>(); // track deleted IDs to skip

  // Phase 5C: Process per-agent to enforce namespace boundaries
  const agentIds = getAgentIdsForChat(chatId);

  for (const agentId of agentIds) {
    const memoryIds = getMemoryIdsWithEmbeddingsForAgent(chatId, agentId);
    if (memoryIds.length < 2) continue;

    // Phase 5C: Danger-zone prioritization -- sort fading memories first
    // Memories scoring 0.25-1.5 are reviewed before healthier ones
    const sortedIds = sortByDangerZonePriority(memoryIds);
    const toProcess = sortedIds.slice(0, MAX_CONSOLIDATION_PER_SWEEP);

    // ── Pass 1: Merge highly similar memories (within same agent) ──
    for (const memId of toProcess) {
      if (alreadyMerged.has(memId)) continue;
      if (result.merged >= MAX_MERGES_PER_SWEEP) break;

      const embedding = getEmbeddingForMemory(memId);
      if (!embedding) continue;

      const memory = getMemoryById(memId);
      if (!memory) continue;

      // Find nearest neighbors (scoped to same chat_id via vectorSearch)
      const neighbors = vectorSearch(chatId, embedding, 5);

      for (const { memory_id: neighborId, distance } of neighbors) {
        if (neighborId === memId) continue;
        if (alreadyMerged.has(neighborId)) continue;

        // Phase 5C: Skip neighbors from different agents
        const neighbor = getMemoryById(neighborId);
        if (!neighbor) continue;
        if (neighbor.agent_id !== agentId) continue;

        const sim = 1 / (1 + distance);

        if (sim >= MERGE_THRESHOLD) {
          try {
            const merged = await mergeMemories(memory, neighbor);
            if (merged) {
              const keeper = memory.salience >= neighbor.salience ? memory : neighbor;
              const discard = keeper.id === memory.id ? neighbor : memory;

              updateMemoryContent(keeper.id, merged, 0.3);
              deleteMemory(discard.id);
              alreadyMerged.add(discard.id);

              const newVec = await embedText(merged);
              if (newVec) {
                saveEmbedding(keeper.id, newVec, 'text-embedding-bge-m3', chatId);
              }

              result.merged++;
              logger.debug({ keepId: keeper.id, discardId: discard.id, agentId }, 'Memories merged');
            }
          } catch (err) {
            logger.error({ err, memId, neighborId }, 'Merge failed (non-fatal)');
          }
        } else if (sim >= CONTRADICTION_LOW && sim < CONTRADICTION_HIGH) {
          try {
            const verdict = await checkContradiction(memory, neighbor);
            if (verdict === 'CONTRADICTION') {
              result.contradictions++;
              logger.warn(
                { mem1: memory.content.slice(0, 60), mem2: neighbor.content.slice(0, 60), agentId },
                'Contradiction detected between memories',
              );
              if (memory.accessed_at >= neighbor.accessed_at) {
                updateMemoryContent(memory.id, memory.content, 0.1);
                deleteMemory(neighbor.id);
                alreadyMerged.add(neighbor.id);
              } else {
                updateMemoryContent(neighbor.id, neighbor.content, 0.1);
                deleteMemory(memory.id);
                alreadyMerged.add(memory.id);
              }
            } else if (verdict === 'SUPERSEDED') {
              const newer = memory.created_at >= neighbor.created_at ? memory : neighbor;
              const older = newer.id === memory.id ? neighbor : memory;
              deleteMemory(older.id);
              alreadyMerged.add(older.id);
              result.merged++;
              logger.debug({ keepId: newer.id, discardId: older.id, agentId }, 'Superseded memory removed');
            }
          } catch (err) {
            logger.error({ err, memId, neighborId }, 'Contradiction check failed (non-fatal)');
          }
        }
      }
    }

    // ── Pass 2: Episodic clustering & summary (per agent) ─────────
    const episodicIds = toProcess.filter((id) => {
      if (alreadyMerged.has(id)) return false;
      const mem = getMemoryById(id);
      return mem?.sector === 'episodic';
    });

    if (episodicIds.length >= MIN_CLUSTER_SIZE) {
      try {
        const summaries = await clusterAndSummarizeEpisodic(chatId, episodicIds, agentId);
        result.episodicSummaries += summaries;
      } catch (err) {
        logger.error({ err, agentId }, 'Episodic clustering failed (non-fatal)');
      }
    }
  }

  // ── Pass 3: Fleet-level dedup (Phase 5C) ──────────────────────
  // Check for duplicates across agents in the shared namespace
  try {
    const fleetMerges = await fleetDedup(chatId, alreadyMerged);
    result.merged += fleetMerges;
  } catch (err) {
    logger.error({ err }, 'Fleet dedup failed (non-fatal)');
  }

  if (result.merged > 0 || result.contradictions > 0 || result.episodicSummaries > 0) {
    logger.info(
      { chatId, ...result },
      'Memory consolidation complete',
    );
  }

  return result;
}

// ── Helper functions ────────────────────────────────────────────────

/**
 * Merge two similar memories using Venice LLM.
 * Returns the merged text, or null if merge isn't appropriate.
 */
async function mergeMemories(a: Memory, b: Memory): Promise<string | null> {
  const prompt = `Memory A: ${a.content}\nMemory B: ${b.content}`;
  const merged = await venicePrivateChat(prompt, MERGE_PROMPT);
  if (!merged || merged.trim().length < 5) return null;
  return merged.trim();
}

/**
 * Check if two memories contradict each other.
 * Returns 'CONTRADICTION', 'COMPATIBLE', or 'SUPERSEDED'.
 */
async function checkContradiction(a: Memory, b: Memory): Promise<string> {
  const prompt = `Memory A: ${a.content}\nMemory B: ${b.content}`;
  const verdict = await venicePrivateChat(prompt, CONTRADICTION_PROMPT);
  const normalized = (verdict ?? '').trim().toUpperCase();
  if (['CONTRADICTION', 'COMPATIBLE', 'SUPERSEDED'].includes(normalized)) {
    return normalized;
  }
  return 'COMPATIBLE'; // default safe
}

/**
 * Phase 5C: Sort memory IDs so danger-zone (salience 0.25-1.5) are processed first.
 * These are the memories most likely to be lost if not reinforced or merged.
 */
function sortByDangerZonePriority(memoryIds: number[]): number[] {
  const withSalience = memoryIds.map((id) => {
    const mem = getMemoryById(id);
    return { id, salience: mem?.salience ?? 0 };
  });

  return withSalience
    .sort((a, b) => {
      const aInDanger = a.salience >= DANGER_ZONE_LOW && a.salience <= DANGER_ZONE_HIGH;
      const bInDanger = b.salience >= DANGER_ZONE_LOW && b.salience <= DANGER_ZONE_HIGH;
      // Danger-zone memories first, then by salience ascending (most at-risk first)
      if (aInDanger && !bInDanger) return -1;
      if (!aInDanger && bInDanger) return 1;
      return a.salience - b.salience;
    })
    .map((x) => x.id);
}

/**
 * Phase 5C: Fleet-level dedup across agents in the shared namespace.
 * If multiple agents promoted the same fact to shared, merge them.
 */
async function fleetDedup(chatId: string, alreadyMerged: Set<number>): Promise<number> {
  const sharedIds = getSharedMemoryIdsWithEmbeddings(chatId);
  if (sharedIds.length < 2) return 0;

  let merges = 0;

  for (const memId of sharedIds) {
    if (alreadyMerged.has(memId)) continue;
    if (merges >= MAX_MERGES_PER_SWEEP) break;

    const embedding = getEmbeddingForMemory(memId);
    if (!embedding) continue;

    const memory = getMemoryById(memId);
    if (!memory) continue;

    const neighbors = vectorSearch(chatId, embedding, 5);

    for (const { memory_id: neighborId, distance } of neighbors) {
      if (neighborId === memId) continue;
      if (alreadyMerged.has(neighborId)) continue;

      const neighbor = getMemoryById(neighborId);
      if (!neighbor) continue;
      // Only dedup within shared namespace (cross-agent)
      if (neighbor.namespace !== 'shared') continue;

      const sim = 1 / (1 + distance);
      if (sim >= MERGE_THRESHOLD) {
        // Keep the higher-salience version
        const keeper = memory.salience >= neighbor.salience ? memory : neighbor;
        const discard = keeper.id === memory.id ? neighbor : memory;

        deleteMemory(discard.id);
        alreadyMerged.add(discard.id);
        merges++;

        logger.debug(
          { keepId: keeper.id, discardId: discard.id, keepAgent: keeper.agent_id, discardAgent: discard.agent_id },
          'Fleet dedup: cross-agent shared memory merged',
        );
      }
    }
  }

  return merges;
}

/**
 * Cluster episodic memories by similarity and generate summaries
 * for clusters of 3+ related memories.
 * Phase 5C: agent-aware -- only clusters within same agent.
 */
async function clusterAndSummarizeEpisodic(
  chatId: string,
  episodicIds: number[],
  agentId?: string,
): Promise<number> {
  let summariesCreated = 0;
  const clustered = new Set<number>();

  for (const memId of episodicIds) {
    if (clustered.has(memId)) continue;

    const embedding = getEmbeddingForMemory(memId);
    if (!embedding) continue;

    const memory = getMemoryById(memId);
    if (!memory) continue;

    // Find nearby episodic memories
    const neighbors = vectorSearch(chatId, embedding, 8);
    const cluster: Memory[] = [memory];

    for (const { memory_id: nId, distance } of neighbors) {
      if (nId === memId || clustered.has(nId)) continue;
      const sim = 1 / (1 + distance);
      if (sim < 0.75) continue; // not similar enough for clustering

      const neighbor = getMemoryById(nId);
      if (!neighbor || neighbor.sector !== 'episodic') continue;
      // Phase 5C: only cluster within same agent
      if (agentId && neighbor.agent_id !== agentId) continue;
      cluster.push(neighbor);
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      // Generate summary
      const clusterText = cluster.map((m) => `- ${m.content}`).join('\n');
      const summary = await venicePrivateChat(clusterText, EPISODIC_SUMMARY_PROMPT);

      if (summary && summary.trim().length >= 10) {
        // Save consolidated summary as semantic memory (it's now a fact)
        // Phase 5A: tag with agent_id to maintain namespace ownership
        const memId2 = saveMemoryReturningId(
          chatId,
          `[Consolidated] ${summary.trim()}`,
          'semantic',
          'general',
          3.0, // moderate-high salience
          agentId || 'apex-bot',
        );

        // Embed the summary
        const vec = await embedText(summary.trim());
        if (vec) {
          saveEmbedding(memId2, vec, 'text-embedding-bge-m3', chatId);
        }

        // Delete the original episodic memories (they're now captured in the summary)
        for (const m of cluster) {
          deleteMemory(m.id);
          clustered.add(m.id);
        }

        summariesCreated++;
        logger.debug(
          { clusterSize: cluster.length, summaryId: memId2 },
          'Episodic cluster summarized',
        );
      }
    }
  }

  return summariesCreated;
}
