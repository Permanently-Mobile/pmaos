/**
 * Memory system -- Phase 3: Tiered Memory.
 *
 * Save pipeline:   Venice extraction -> dedup -> save -> embed (fire-and-forget)
 * Retrieval:       Core (always) + Active (hybrid search) + Archive (fallback)
 * Fallback:        If Venice unavailable, degrades to regex classifier + FTS5-only
 */

import {
  CORE_MEMORY_LIMIT,
  countCoreMemories,
  decayMemories,
  getAllChatIds,
  getCoreMemories,
  getDatabase,
  getMemoryById,
  getRecentConversation,
  getRecentMemories,
  getSessionConversation,
  logConversationTurn,
  pruneConversationLog,
  pruneSpiceHistory,
  saveMemory,
  saveMemoryReturningId,
  saveEmbedding,
  searchArchiveMemories,
  searchMemories,
  setMemoryTier,
  touchMemory,
  vectorSearch,
  getEmbeddingForMemory,
  type Memory,
} from './db.js';
import { BOT_NAME } from './config.js';
import { veniceCapabilities, venicePrivateChat } from './venice.js';
import { extractAndSaveMemories, embedText, findDuplicate, cosineSimilarity } from './memory-extract.js';
import { runConsolidation } from './memory-consolidation.js';
import { runSpiceConsolidation } from './spice-consolidation.js';
import { logger } from './logger.js';

// ── Legacy fallback regex (used when Venice is not configured) ────────
const SEMANTIC_SIGNALS = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i;

/** Timeout for the query embedding call during retrieval (ms). */
const EMBED_QUERY_TIMEOUT_MS = 2000;

/** Max active/archive memories to include in search context. */
const TARGET_MEMORY_COUNT = 8;

/** Min active results before archive fallback triggers. */
const ARCHIVE_THRESHOLD = 3;

// ── MMR Reranking (Phase 5 Feature 4) ────────────────────────────────

/** Lambda controls relevance vs diversity tradeoff (higher = more relevance). */
const MMR_LAMBDA = 0.7;

/** Skip any candidate with cosine similarity > this to an already-selected item. */
const MMR_MAX_SIM = 0.85;

/** Over-fetch multiplier: fetch this many times TARGET_MEMORY_COUNT candidates. */
const MMR_OVERFETCH = 2;

interface RankedCandidate {
  memory: Memory;
  score: number;
}

/**
 * Maximal Marginal Relevance reranking.
 *
 * Greedy iterative selection: start with the highest-scoring candidate,
 * then for each remaining candidate compute:
 *   mmrScore = lambda * relevance - (1 - lambda) * max_similarity_to_selected
 *
 * Candidates with > MMR_MAX_SIM cosine similarity to any already-selected
 * item are skipped entirely (hard dedup filter).
 *
 * Uses cached embeddings from SQLite (sync reads, no API calls).
 * Falls back to Jaccard word overlap when embeddings are missing.
 */
function mmrRerank(
  candidates: RankedCandidate[],
  maxResults: number = TARGET_MEMORY_COUNT,
): RankedCandidate[] {
  if (candidates.length <= 1) return candidates;

  // Pre-fetch embeddings for all candidates (sync SQLite reads)
  const embeddings = new Map<number, number[] | null>();
  for (const c of candidates) {
    embeddings.set(c.memory.id, getEmbeddingForMemory(c.memory.id));
  }

  // Compute pairwise similarity between two candidates
  function candidateSimilarity(a: RankedCandidate, b: RankedCandidate): number {
    const vecA = embeddings.get(a.memory.id);
    const vecB = embeddings.get(b.memory.id);
    if (vecA && vecB && vecA.length === vecB.length) {
      return cosineSimilarity(vecA, vecB);
    }
    // Jaccard fallback when embeddings unavailable
    const wordsA = new Set(a.memory.content.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.memory.content.toLowerCase().split(/\s+/).filter(Boolean));
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // Normalize scores to [0, 1] for fair MMR comparison
  const maxScore = Math.max(...candidates.map((c) => c.score));
  const minScore = Math.min(...candidates.map((c) => c.score));
  const scoreRange = maxScore - minScore || 1;

  const selected: RankedCandidate[] = [];
  const remaining = new Set(candidates);

  // Seed with the highest-scoring candidate
  const best = candidates.reduce((a, b) => (a.score > b.score ? a : b));
  selected.push(best);
  remaining.delete(best);

  while (selected.length < maxResults && remaining.size > 0) {
    let bestMMR: RankedCandidate | null = null;
    let bestMMRScore = -Infinity;

    for (const candidate of remaining) {
      // Max similarity to any already-selected item
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const sim = candidateSimilarity(candidate, sel);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }

      // Hard filter: skip near-duplicates
      if (maxSimToSelected > MMR_MAX_SIM) continue;

      // MMR score
      const normRelevance = (candidate.score - minScore) / scoreRange;
      const mmrScore = MMR_LAMBDA * normRelevance - (1 - MMR_LAMBDA) * maxSimToSelected;

      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestMMR = candidate;
      }
    }

    if (!bestMMR) break; // All remaining are too similar
    selected.push(bestMMR);
    remaining.delete(bestMMR);
  }

  return selected;
}

// ── Retrieval (Phase 3: Tiered) ──────────────────────────────────────

/**
 * Build a compact memory context string to prepend to the user's message.
 *
 * Phase 3 tiered retrieval:
 *   Tier 1 - Core: Always prepended (no search). Max 30 items.
 *   Tier 2 - Active: Hybrid 3-signal search (FTS5 + vec + recency).
 *   Tier 3 - Archive: FTS5-only fallback when active results < 3.
 *
 * Scoring formula per active candidate:
 *   score = 0.35 * ftsRank + 0.40 * cosineSim + 0.15 * salienceNorm + 0.10 * recencyBonus
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  agentId?: string,
): Promise<string> {
  const parts: string[] = [];

  // ── Tier 1: Core Memory (always present) ────────────────────────
  // Phase 5A: agentId filters core memories (primary bot sees all, named agents see own + shared/fleet)
  const coreMemories = getCoreMemories(chatId, agentId);
  if (coreMemories.length > 0) {
    const coreLines = coreMemories.map((m) => {
      const topic = m.topic_key ? `${m.topic_key}/` : '';
      return `- ${m.content} (${topic}core)`;
    });
    parts.push(`[Core memory]\n${coreLines.join('\n')}\n[End core memory]`);
  }

  // Collect core IDs to exclude from search results (avoid double-showing)
  const coreIds = new Set(coreMemories.map((m) => m.id));

  // ── Tier 2: Active Memory (hybrid search) ───────────────────────
  const candidates = new Map<number, { memory: Memory; score: number }>();

  // Signal 1: FTS5 keyword search (excludes core tier)
  // Phase 5A: pass agentId for namespace filtering
  const ftsResults = searchMemories(chatId, userMessage, 5, true, agentId);
  for (let i = 0; i < ftsResults.length; i++) {
    const mem = ftsResults[i];
    if (coreIds.has(mem.id)) continue;
    const ftsScore = 1 - (i / Math.max(ftsResults.length, 1));
    const salienceNorm = mem.salience / 5.0;
    candidates.set(mem.id, {
      memory: mem,
      score: 0.35 * ftsScore + 0.15 * salienceNorm,
    });
  }

  // Signal 2: Embedding vector search (sqlite-vec)
  const embeddingScores = new Map<number, number>();

  try {
    const queryVec = await Promise.race([
      embedText(userMessage),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), EMBED_QUERY_TIMEOUT_MS)),
    ]);

    if (queryVec) {
      const vecResults = vectorSearch(chatId, queryVec, 8);

      for (const { memory_id: memId, distance } of vecResults) {
        if (coreIds.has(memId)) continue; // skip core (already shown)
        const sim = 1 / (1 + distance);
        embeddingScores.set(memId, sim);

        if (candidates.has(memId)) {
          const existing = candidates.get(memId)!;
          existing.score += 0.40 * sim;
        } else {
          const mem = getMemoryById(memId);
          if (mem) {
            const salienceNorm = mem.salience / 5.0;
            candidates.set(memId, {
              memory: mem,
              score: 0.40 * sim + 0.15 * salienceNorm,
            });
          }
        }
      }
    }
  } catch {
    logger.debug('Embedding query skipped (timeout or error)');
  }

  // Signal 3: Recency (excludes core tier)
  // Phase 5A: pass agentId for namespace filtering
  const recentResults = getRecentMemories(chatId, 5, true, agentId);
  for (const mem of recentResults) {
    if (coreIds.has(mem.id)) continue;
    const embScore = embeddingScores.get(mem.id) ?? 0;
    if (candidates.has(mem.id)) {
      candidates.get(mem.id)!.score += 0.10;
    } else {
      const salienceNorm = mem.salience / 5.0;
      candidates.set(mem.id, {
        memory: mem,
        score: 0.10 + 0.40 * embScore + 0.15 * salienceNorm,
      });
    }
  }

  // Rank active results with MMR diversity reranking (Phase 5 Feature 4)
  // Over-fetch 2x candidates, then MMR selects the final set balancing relevance + diversity
  const sortedCandidates = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, TARGET_MEMORY_COUNT * MMR_OVERFETCH);
  const ranked = mmrRerank(sortedCandidates, TARGET_MEMORY_COUNT);

  // ── Tier 3: Archive (fallback when active is thin) ──────────────
  let archiveResults: Memory[] = [];
  if (ranked.length < ARCHIVE_THRESHOLD) {
    archiveResults = searchArchiveMemories(chatId, userMessage, 5)
      .filter((m) => !coreIds.has(m.id));
  }

  // ── Format search results ───────────────────────────────────────
  const allSearched = [
    ...ranked.map((r) => r.memory),
    ...archiveResults,
  ];

  if (allSearched.length > 0) {
    // Touch all retrieved memories (boost salience)
    for (const mem of allSearched) {
      touchMemory(mem.id);
    }

    const lines = allSearched.map((mem) => {
      const topic = mem.topic_key ? `${mem.topic_key}/` : '';
      const tierLabel = mem.tier === 'archive' ? 'archive' : mem.sector;
      return `- ${mem.content} (${topic}${tierLabel})`;
    });
    parts.push(`[Memory context]\n${lines.join('\n')}\n[End memory context]`);
  }

  return parts.join('\n\n');
}

// ── Save Pipeline ────────────────────────────────────────────────────

/**
 * Save conversation turn to log and extract memories.
 *
 * When Venice is configured: fire-and-forget extraction via Venice.
 * When Venice is not configured: fallback to regex-based classification.
 *
 * The extraction runs AFTER this function returns, so it never blocks
 * the message pipeline. Errors are caught and logged, never thrown.
 */
export function saveConversationTurn(
  chatId: string,
  userMessage: string,
  claudeResponse: string,
  sessionId?: string,
  source: string = 'telegram',
): void {
  // Always log full conversation to conversation_log (for /respin)
  logConversationTurn(chatId, 'user', userMessage, sessionId, source);
  logConversationTurn(chatId, 'assistant', claudeResponse, sessionId, source);

  // Skip commands and very short messages
  if (userMessage.length <= 20 || userMessage.startsWith('/')) return;

  // Implicit feedback signal collection for spice learning.
  // Runs sync, per-message, no LLM. Classifies this user message
  // as feedback about the previous assistant response.
  if (claudeResponse.length > 20) {
    try {
      // Dynamic import is async but we fire-and-forget -- classify is sync once loaded
      import('./reflect-primary.js').then(({ classifyImplicitFeedback }) => {
        classifyImplicitFeedback(userMessage, claudeResponse, chatId);
      }).catch(() => { /* non-fatal */ });
    } catch {
      // Non-fatal: reflect module may not be loaded
    }
  }

  // Bridge feedback into the shared learning system (cross-agent knowledge base).
  // Fire-and-forget: store a lightweight feedback entry for the primary bot's conversation turns.
  try {
    import('./learning/feedback.js').then(({ storeFeedback }) => {
      storeFeedback({
        agent: BOT_NAME,
        task_id: `conv-${Date.now()}`,
        task_summary: userMessage.slice(0, 500),
        score: 3, // neutral baseline; spice system handles fine-grained scoring
        comments: 'auto-logged conversation turn',
        lessons_learned: null,
      });
    }).catch(() => { /* non-fatal: learning system may not be initialized */ });
  } catch { /* non-fatal */ }

  // When Scribe Librarian is active, skip per-turn extraction.
  // Scribe handles memory writes in batch with full thread context.
  if (process.env.SCRIBE_LIBRARIAN === '1') return;

  // Fire-and-forget extraction via Venice
  const { configured } = veniceCapabilities();
  if (configured) {
    extractAndSaveMemories(chatId, userMessage, claudeResponse).catch((err) => {
      logger.error({ err }, 'Memory extraction failed (non-fatal)');
    });
  } else {
    // Legacy fallback: regex-based classification
    if (SEMANTIC_SIGNALS.test(userMessage)) {
      saveMemory(chatId, userMessage, 'semantic');
    } else {
      saveMemory(chatId, userMessage, 'episodic');
    }
  }
}

// ── Session Summary (Phase 1.5) ──────────────────────────────────────

const SESSION_SUMMARY_PROMPT = `You are a memory consolidation system. Given a conversation log between a user and an AI assistant, write a concise session summary (3-5 bullet points) capturing the key decisions, facts learned, tasks completed, and any important context that should persist across sessions.

Rules:
- Write in third person about the user (e.g. "The user decided to...", "Completed Phase 1 of...")
- Focus on decisions, outcomes, and new information -- not the back-and-forth
- Skip greetings, small talk, and transient requests
- Each bullet should be a standalone fact or decision
- If the conversation is too short or trivial to summarize, return exactly: SKIP
- Return plain text bullets only. No JSON, no markdown fencing.`;

/**
 * Generate a session summary from recent conversation and save as a
 * high-salience semantic memory. Called on /newchat and on compaction.
 *
 * Fire-and-forget: never throws, logs errors internally.
 * Returns the memory ID if saved, null otherwise.
 */
export async function saveSessionSummary(chatId: string): Promise<number | null> {
  try {
    const { configured } = veniceCapabilities();
    if (!configured) {
      logger.debug('Session summary skipped (Venice not configured)');
      return null;
    }

    // Pull last 30 turns (~15 exchanges) for summarization
    const turns = getRecentConversation(chatId, 30);
    if (turns.length < 4) {
      // Too short to summarize
      logger.debug({ turnCount: turns.length }, 'Session summary skipped (too few turns)');
      return null;
    }

    // Build conversation text (chronological)
    const reversed = [...turns].reverse();
    const convoText = reversed
      .map((t) => {
        const role = t.role === 'user' ? 'User' : 'Assistant';
        const content = t.content.length > 400 ? t.content.slice(0, 400) + '...' : t.content;
        return `${role}: ${content}`;
      })
      .join('\n');

    // Generate summary via Venice (zero data retention)
    const summary = await venicePrivateChat(convoText, SESSION_SUMMARY_PROMPT);

    if (!summary || summary.trim() === 'SKIP' || summary.trim().length < 20) {
      logger.debug('Session summary skipped (nothing worth remembering)');
      return null;
    }

    // Save as high-salience semantic memory
    const memId = saveMemoryReturningId(
      chatId,
      `[Session Summary] ${summary.trim()}`,
      'semantic',
      'general',
      4.5, // High salience -- session summaries are important
    );

    // Embed for vector search (fire-and-forget)
    embedText(summary.trim())
      .then((vec) => {
        if (vec) saveEmbedding(memId, vec, 'text-embedding-bge-m3', chatId);
      })
      .catch(() => {}); // non-fatal

    logger.info({ chatId, memId }, 'Session summary saved');
    return memId;
  } catch (err) {
    logger.error({ err }, 'Session summary failed (non-fatal)');
    return null;
  }
}

// ── Pre-Compaction Flush (Phase 5) ───────────────────────────────────

/** Max facts per chunk during batch extraction (higher than per-turn limit). */
const MAX_BATCH_FACTS = 15;

/** Max chars per chunk sent to Venice for batch extraction. */
const BATCH_CHUNK_SIZE = 2000;

const BATCH_EXTRACTION_PROMPT = `You are a memory extraction system performing a FULL SESSION SCAN before context window compaction. Extract ALL facts, preferences, decisions, project states, and personally meaningful information from this conversation segment.

This is a batch extraction -- be thorough. Many of these facts may not have been captured by per-turn extraction.

Rules:
- Extract discrete, standalone facts. Each fact should make sense without context.
- Write as concise third-person statements (e.g. "The user decided to...", "Prefers X over Y").
- Focus especially on: decisions made, preferences stated, project status changes, relationships, technical choices.
- Skip greetings, small talk, and acknowledgements.
- Classify each fact: topic (preferences, family, projects, crypto, tools, personal, general), sector (semantic or episodic).
- Rate importance 1-10: 1=trivial, 5=useful, 10=core identity.
- Return valid JSON array only. No explanation, no markdown fencing.
- If nothing worth remembering, return: []
- Maximum ${MAX_BATCH_FACTS} facts.

Format: [{"fact": "...", "topic": "...", "sector": "semantic|episodic", "importance": 1-10}]`;

/**
 * Pre-compaction memory flush -- Phase 5 Feature 1.
 *
 * Triggered ONCE when context window reaches 75%. Extracts ALL facts
 * from the current session BEFORE compaction can wipe them.
 *
 * Flow:
 *   1. Pull all conversation turns for the session
 *   2. Chunk into segments (~2000 chars each)
 *   3. Venice batch extraction per chunk (up to 15 facts each)
 *   4. Dedup against existing memories
 *   5. Save new facts at salience 4.0
 *   6. Generate proactive session summary at salience 4.5
 *
 * Fire-and-forget: never throws, logs errors internally.
 * Returns count of new memories saved, or null on failure.
 */
export async function flushPreCompaction(
  chatId: string,
  sessionId?: string,
): Promise<number | null> {
  try {
    const { configured } = veniceCapabilities();
    if (!configured) {
      logger.debug('Pre-compaction flush skipped (Venice not configured)');
      return null;
    }

    // Step 1: Pull ALL session turns (chronological)
    const turns = getSessionConversation(chatId, sessionId);
    if (turns.length < 4) {
      logger.debug({ turnCount: turns.length }, 'Pre-compaction flush skipped (too few turns)');
      return null;
    }

    logger.info({ chatId, turns: turns.length }, 'Pre-compaction flush starting');

    // Step 2: Build full conversation text and chunk it
    const fullConvo = turns
      .map((t) => {
        const role = t.role === 'user' ? 'User' : 'Assistant';
        const content = t.content.length > 500 ? t.content.slice(0, 500) + '...' : t.content;
        return `${role}: ${content}`;
      })
      .join('\n');

    const chunks: string[] = [];
    let current = '';
    for (const line of fullConvo.split('\n')) {
      if (current.length + line.length + 1 > BATCH_CHUNK_SIZE && current.length > 0) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current.length > 0) chunks.push(current);

    // Step 3: Extract facts from each chunk (sequential to avoid Venice rate limits)
    let totalSaved = 0;

    for (let i = 0; i < chunks.length; i++) {
      try {
        const raw = await venicePrivateChat(chunks[i], BATCH_EXTRACTION_PROMPT);
        const cleaned = raw.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '');
        let parsed: unknown[];
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          logger.debug({ chunk: i }, 'Pre-compaction chunk parse failed (skipping)');
          continue;
        }

        if (!Array.isArray(parsed)) continue;

        for (const item of parsed.slice(0, MAX_BATCH_FACTS)) {
          const rec = item as Record<string, unknown>;
          if (typeof rec.fact !== 'string' || rec.fact.length < 4) continue;

          const fact = (rec.fact as string).slice(0, 500);
          const topic = typeof rec.topic === 'string' &&
            ['preferences', 'family', 'projects', 'crypto', 'tools', 'personal', 'general'].includes(rec.topic)
            ? rec.topic : 'general';
          const sector = rec.sector === 'episodic' ? 'episodic' : 'semantic';
          const importance = typeof rec.importance === 'number'
            ? Math.max(1, Math.min(10, Math.round(rec.importance))) : 5;

          // Step 4: Generate embedding and dedup
          const embedding = await embedText(fact);
          const dupId = await findDuplicate(chatId, fact, embedding);

          if (!dupId) {
            // Step 5: Save with elevated salience (4.0 base, importance gives additional boost)
            const salience = Math.min(5.0, 3.5 + importance / 10);
            const memId = saveMemoryReturningId(chatId, fact, sector, topic, salience);
            totalSaved++;

            if (embedding) {
              saveEmbedding(memId, embedding, 'text-embedding-bge-m3', chatId);
            }

            logger.debug({ memId, fact: fact.slice(0, 60) }, 'Pre-compaction fact saved');
          }
        }
      } catch (chunkErr) {
        logger.warn({ err: chunkErr, chunk: i }, 'Pre-compaction chunk failed (continuing)');
      }
    }

    // Step 6: Proactive session summary (same as saveSessionSummary but earlier)
    const summaryId = await saveSessionSummary(chatId);

    logger.info(
      { chatId, totalSaved, summaryId, chunks: chunks.length },
      'Pre-compaction flush complete',
    );

    return totalSaved;
  } catch (err) {
    logger.error({ err }, 'Pre-compaction flush failed (non-fatal)');
    return null;
  }
}

// ── Tier Sweep (Phase 3) ─────────────────────────────────────────────

/**
 * Promotion/demotion sweep for a single chat.
 *
 * Phase 5B thresholds (calibrated for Ebbinghaus decay in 0-5 salience range):
 *   Active -> Core:    salience >= 3.0 AND semantic AND core has room
 *   Core -> Active:    salience < 1.5
 *   Active -> Archive: salience < 0.25
 *   Archive -> Delete: salience < 0.05 (handled by Ebbinghaus decay)
 *
 * Danger zone (0.25-1.5): memories prioritized for consolidation review (Phase 5C).
 */
export function runTierSweep(chatId: string): void {
  const db = getDatabase();

  // Demote: Core -> Active (salience dropped below threshold)
  const coreMemories = getCoreMemories(chatId);
  let demoted = 0;
  for (const mem of coreMemories) {
    if (mem.salience < 1.5) {
      setMemoryTier(mem.id, 'active');
      demoted++;
    }
  }

  // Demote: Active -> Archive (low salience -- Ebbinghaus handles time-based decay)
  const archiveResult = db.prepare(
    `UPDATE memories SET tier = 'archive'
     WHERE chat_id = ? AND tier = 'active'
     AND salience < 0.25`,
  ).run(chatId);

  // Promote: Active -> Core (high salience semantic memories)
  const coreCount = countCoreMemories(chatId);
  if (coreCount < CORE_MEMORY_LIMIT) {
    const slotsAvailable = CORE_MEMORY_LIMIT - coreCount;
    const promoteCandidates = db.prepare(
      `SELECT id FROM memories
       WHERE chat_id = ? AND tier = 'active'
       AND sector = 'semantic' AND salience >= 3.0
       ORDER BY salience DESC
       LIMIT ?`,
    ).all(chatId, slotsAvailable) as Array<{ id: number }>;

    for (const c of promoteCandidates) {
      setMemoryTier(c.id, 'core');
    }

    if (promoteCandidates.length > 0) {
      logger.info(
        { chatId, promoted: promoteCandidates.length },
        'Tier sweep: promoted memories to core',
      );
    }
  }

  if (demoted > 0 || (archiveResult.changes > 0)) {
    logger.info(
      { chatId, demotedFromCore: demoted, archivedFromActive: archiveResult.changes },
      'Tier sweep: demoted memories',
    );
  }
}

// ── Decay ────────────────────────────────────────────────────────────

/**
 * Run the daily decay sweep. Call once on startup and every 24h.
 * Also prunes old conversation_log entries to prevent unbounded growth.
 * Phase 3: Runs tier promotion/demotion sweep.
 * Phase 4: Runs memory consolidation (merge, contradiction, episodic clustering).
 */
export function runDecaySweep(): void {
  decayMemories();
  pruneConversationLog(500);

  // Spice v2: prune history older than 30 days
  try {
    pruneSpiceHistory(30);
  } catch (err) {
    logger.error({ err }, 'Spice history prune failed (non-fatal)');
  }

  // Phase 3: Tier sweep after decay
  const chatIds = getAllChatIds();
  for (const chatId of chatIds) {
    try {
      runTierSweep(chatId);
    } catch (err) {
      logger.error({ err, chatId }, 'Tier sweep failed for chat (non-fatal)');
    }
  }

  // Phase 4: Memory consolidation (async, fire-and-forget)
  for (const chatId of chatIds) {
    runConsolidation(chatId).catch((err) => {
      logger.error({ err, chatId }, 'Memory consolidation failed for chat (non-fatal)');
    });
  }

  // Spice v2: Nightly pattern promotion to memory (async, fire-and-forget)
  runSpiceConsolidation().catch((err) => {
    logger.error({ err }, 'Spice consolidation failed (non-fatal)');
  });
}
