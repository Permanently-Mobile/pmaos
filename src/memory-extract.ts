/**
 * Memory extraction pipeline -- Phase 1 + 1.5.
 *
 * Uses Venice (zero data retention) to:
 *   1. Extract discrete facts from conversation turns
 *   2. Classify them by topic and sector
 *   3. Deduplicate against existing memories
 *   4. Generate embeddings for semantic search
 *
 * All functions are designed to be non-fatal: they catch errors and
 * return safe defaults so the main conversation pipeline never blocks.
 */

import {
  saveMemoryReturningId,
  updateMemoryContent,
  searchMemories,
  saveEmbedding,
  vectorSearch,
} from './db.js';
import { venicePrivateChat, veniceEmbed, veniceCapabilities } from './venice.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export type TopicKey =
  | 'preferences'
  | 'family'
  | 'projects'
  | 'crypto'
  | 'tools'
  | 'personal'
  | 'general';

const VALID_TOPICS = new Set<string>([
  'preferences', 'family', 'projects', 'crypto', 'tools', 'personal', 'general',
]);

const VALID_SECTORS = new Set<string>(['semantic', 'episodic']);

export interface ExtractedFact {
  fact: string;
  topic: TopicKey;
  sector: 'semantic' | 'episodic';
  /** Importance rating 1-10. Used as initial salience. */
  importance: number;
}

// ── Config ───────────────────────────────────────────────────────────

/** Skip extraction for very short messages. */
const MIN_EXTRACT_LENGTH = 25;

/** Max facts Venice should return per turn. */
const MAX_FACTS_PER_TURN = 5;

/** Jaccard word overlap threshold for FTS5-based dedup. */
const JACCARD_DEDUP_THRESHOLD = 0.7;

/** Cosine similarity threshold for embedding-based dedup. */
const COSINE_DEDUP_THRESHOLD = 0.92;

/** Per-chat debounce to avoid rapid extraction calls. */
const EXTRACT_DEBOUNCE_MS = 3000;
const lastExtractTime = new Map<string, number>();

// ── Venice Extraction Prompt ─────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system for a personal AI assistant. Given a conversation between a user and an assistant, extract any facts, preferences, decisions, or personally meaningful information worth remembering long-term.

Rules:
- Extract discrete, standalone facts. Each fact should make sense on its own without context.
- Write facts as concise third-person statements about the user (e.g. "Prefers dark mode", "Has a young son").
- Skip greetings, small talk, commands like "do X", questions with no personal info, and transient requests.
- Skip technical discussion about code changes, build steps, or debugging unless it reveals a personal preference.
- If the user corrects or updates a previous preference, extract the NEW value only.
- Classify each fact into exactly one topic: preferences, family, projects, crypto, tools, personal, general.
- Classify as "semantic" (long-lived fact, preference, or identity) or "episodic" (event, decision, task that may fade).
- Rate importance from 1-10: 1=trivial/transient, 5=moderately useful, 10=core identity/critical fact. Family facts, strong preferences, and identity statements should be 7-10. Routine decisions or minor context should be 1-4.
- Return valid JSON array only. No explanation, no markdown fencing, no code blocks.
- If nothing is worth remembering, return exactly: []
- Maximum ${MAX_FACTS_PER_TURN} facts per response.

Format: [{"fact": "...", "topic": "...", "sector": "semantic|episodic", "importance": 1-10}]`;

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Extract memorable facts from a conversation turn using Venice.
 * Returns an array of discrete facts, or empty array on failure.
 * Never throws.
 */
export async function extractFacts(
  userMessage: string,
  assistantResponse: string,
): Promise<ExtractedFact[]> {
  if (userMessage.length < MIN_EXTRACT_LENGTH) return [];

  try {
    const prompt = `User said: ${userMessage}\n\nAssistant replied: ${assistantResponse.slice(0, 1000)}`;
    const raw = await venicePrivateChat(prompt, EXTRACTION_SYSTEM_PROMPT);

    // Parse the JSON response
    const cleaned = raw.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    // Validate and filter
    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (
        typeof item.fact === 'string' &&
        item.fact.length > 3 &&
        VALID_TOPICS.has(item.topic) &&
        VALID_SECTORS.has(item.sector)
      ) {
        // Clamp importance to 1-10 range, default to 5 if missing/invalid
        const rawImportance = typeof item.importance === 'number' ? item.importance : 5;
        const importance = Math.max(1, Math.min(10, Math.round(rawImportance)));
        facts.push({
          fact: item.fact.slice(0, 500), // cap length
          topic: item.topic as TopicKey,
          sector: item.sector as 'semantic' | 'episodic',
          importance,
        });
      }
    }

    return facts.slice(0, MAX_FACTS_PER_TURN);
  } catch (err) {
    logger.warn({ err }, 'Memory extraction failed (non-fatal)');
    return [];
  }
}

// ── Deduplication ────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two strings (word-level).
 */
export function jaccardSimilarity(a: string, b: string): number {
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

/**
 * Compute cosine similarity between two vectors.
 * Returns value between -1 and 1 (1 = identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check if a fact already exists in memory.
 * Returns the memory ID if a duplicate is found, null otherwise.
 * Uses FTS5 Jaccard check + sqlite-vec nearest neighbor check.
 */
export async function findDuplicate(
  chatId: string,
  fact: string,
  factEmbedding?: number[] | null,
): Promise<number | null> {
  // Layer 1: FTS5 keyword check with Jaccard threshold
  const ftsMatches = searchMemories(chatId, fact, 5);
  for (const mem of ftsMatches) {
    if (jaccardSimilarity(fact, mem.content) > JACCARD_DEDUP_THRESHOLD) {
      return mem.id;
    }
  }

  // Layer 2: sqlite-vec nearest neighbor check
  if (factEmbedding) {
    const vecResults = vectorSearch(chatId, factEmbedding, 3);
    for (const { memory_id, distance } of vecResults) {
      // Convert L2 distance to similarity: sim = 1 / (1 + distance)
      const sim = 1 / (1 + distance);
      if (sim > COSINE_DEDUP_THRESHOLD) {
        return memory_id;
      }
    }
  }

  return null;
}

// ── Embedding ────────────────────────────────────────────────────────

/**
 * Embed text via Venice. Returns vector or null on failure.
 * Never throws.
 */
export async function embedText(text: string): Promise<number[] | null> {
  try {
    const result = await veniceEmbed({ input: text });
    return result.embeddings[0] ?? null;
  } catch (err) {
    logger.warn({ err }, 'Venice embedding failed (non-fatal)');
    return null;
  }
}

// ── Full Pipeline ────────────────────────────────────────────────────

/**
 * Full extraction pipeline: extract facts from conversation, dedup, save, embed.
 * Called fire-and-forget after response is sent to user.
 * Returns number of new facts saved.
 * Never throws.
 * @param agentId Phase 5A: owning agent ID for namespace tagging. Defaults to 'apex-bot'.
 */
export async function extractAndSaveMemories(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  agentId = 'apex-bot',
): Promise<number> {
  try {
    // Debounce: skip if we just extracted for this chat
    const now = Date.now();
    const lastTime = lastExtractTime.get(chatId) ?? 0;
    if (now - lastTime < EXTRACT_DEBOUNCE_MS) {
      return 0;
    }
    lastExtractTime.set(chatId, now);

    // Step 1: Extract facts via Venice
    const facts = await extractFacts(userMessage, assistantResponse);
    if (facts.length === 0) return 0;

    let saved = 0;

    for (const fact of facts) {
      // Step 2: Generate embedding for dedup + future search
      const embedding = await embedText(fact.fact);

      // Step 3: Check for duplicates
      const dupId = await findDuplicate(chatId, fact.fact, embedding);

      if (dupId) {
        // Refresh existing memory with updated wording
        updateMemoryContent(dupId, fact.fact);
        // Update embedding if we have a new one
        if (embedding) {
          saveEmbedding(dupId, embedding, 'text-embedding-bge-m3', chatId);
        }
        logger.debug({ dupId, fact: fact.fact }, 'Memory deduped and refreshed');
      } else {
        // Step 4: Save new memory (importance 1-10 mapped to salience 0.5-5.0)
        // Phase 5A: tag with agent_id for namespace isolation
        const initialSalience = fact.importance / 2;
        const memId = saveMemoryReturningId(chatId, fact.fact, fact.sector, fact.topic, initialSalience, agentId);
        saved++;

        // Step 5: Save embedding (writes to both legacy table + vec_memories)
        if (embedding) {
          saveEmbedding(memId, embedding, 'text-embedding-bge-m3', chatId);
        }

        logger.debug({ memId, fact: fact.fact, topic: fact.topic }, 'New memory saved');
      }
    }

    if (saved > 0) {
      logger.info({ chatId, extracted: facts.length, saved }, 'Memory extraction complete');
    }

    return saved;
  } catch (err) {
    logger.error({ err }, 'extractAndSaveMemories failed (non-fatal)');
    return 0;
  }
}
