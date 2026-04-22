/**
 * Spice Consolidation (Layer 3: Memory Bridge)
 *
 * Nightly job that reads spice_history patterns via SQL aggregation
 * and promotes insights to the memory system as low-salience episodic memories.
 *
 * Pattern detection is pure SQL (no LLM). Insight generation uses one Venice call
 * per detected pattern to produce natural language.
 *
 * Self-balancing lifecycle:
 *   spice_history -> pattern detection -> Venice insight -> episodic memory (salience 1.5)
 *   episodic memory -> natural decay (0.95/day) -> only persistent patterns survive
 *   persistent patterns -> consolidation clusters -> semantic -> tier sweep -> core
 *
 * Hard caps:
 *   - Max 3 insights per nightly run (prevents bloat)
 *   - Dedup via findDuplicate() before saving (prevents repeats)
 *   - Min 3 occurrences before a pattern qualifies
 *
 * Runs inside runDecaySweep() in memory.ts. Fail-open, non-fatal.
 */

import {
  getDefaultChatId,
  getSpiceFrequency,
  getSpiceCharacterFrequency,
  saveMemoryReturningId,
} from './db.js';
import { findDuplicate } from './memory-extract.js';
import { venicePrivateChat, veniceCapabilities } from './venice.js';
import { logger } from './logger.js';
import { getDatabase } from './db.js';

/** Max insights to generate per nightly run. */
const MAX_INSIGHTS_PER_RUN = 3;

/** Minimum occurrences before a pattern qualifies. */
const MIN_PATTERN_COUNT = 3;

/** Salience for spice-derived episodic memories. Low = natural decay. */
const INSIGHT_SALIENCE = 1.5;

// ── Pattern Detection (Pure SQL) ─────────────────────────────────────

export interface SpicePattern {
  type: 'dimension-topic' | 'register-dimension' | 'time-dimension';
  /** Human-readable description for Venice to polish. */
  rawDescription: string;
  /** Supporting data for the pattern. */
  data: Record<string, unknown>;
}

/**
 * Detect dimension-topic affinities: which dimensions appear most with certain topics.
 * 7-day window, min 3 occurrences.
 */
export function detectDimensionTopicPatterns(): SpicePattern[] {
  try {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;

    const rows = db.prepare(`
      SELECT dimension, session_topic, COUNT(*) as cnt
      FROM spice_history
      WHERE created_at >= ? AND session_topic IS NOT NULL AND session_topic != ''
      GROUP BY dimension, session_topic
      HAVING cnt >= ?
      ORDER BY cnt DESC
      LIMIT 5
    `).all(cutoff, MIN_PATTERN_COUNT) as Array<{ dimension: string; session_topic: string; cnt: number }>;

    return rows.map((r) => ({
      type: 'dimension-topic' as const,
      rawDescription: `The "${r.dimension}" dimension appears ${r.cnt} times with "${r.session_topic}" topics in the last 7 days`,
      data: { dimension: r.dimension, topic: r.session_topic, count: r.cnt },
    }));
  } catch (err) {
    logger.warn({ err }, 'detectDimensionTopicPatterns failed');
    return [];
  }
}

/**
 * Detect register-dimension correlations: which dimensions co-occur with non-default registers.
 * 14-day window, min 3 occurrences.
 */
export function detectRegisterDimensionPatterns(): SpicePattern[] {
  try {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;

    const rows = db.prepare(`
      SELECT register, dimension, COUNT(*) as cnt
      FROM spice_history
      WHERE created_at >= ? AND register != 'confident'
      GROUP BY register, dimension
      HAVING cnt >= ?
      ORDER BY cnt DESC
      LIMIT 5
    `).all(cutoff, MIN_PATTERN_COUNT) as Array<{ register: string; dimension: string; cnt: number }>;

    return rows.map((r) => ({
      type: 'register-dimension' as const,
      rawDescription: `The "${r.dimension}" dimension appears ${r.cnt} times during "${r.register}" register in the last 14 days`,
      data: { register: r.register, dimension: r.dimension, count: r.cnt },
    }));
  } catch (err) {
    logger.warn({ err }, 'detectRegisterDimensionPatterns failed');
    return [];
  }
}

/**
 * Detect time-of-day dimension preferences: consistent dimension choices at certain hours.
 * 14-day window, min 3 occurrences.
 */
export function detectTimeDimensionPatterns(): SpicePattern[] {
  try {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;

    // Group into time slots: overnight (0-5), morning (6-11), afternoon (12-17), evening (18-23)
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN hour_of_day BETWEEN 0 AND 5 THEN 'overnight'
          WHEN hour_of_day BETWEEN 6 AND 11 THEN 'morning'
          WHEN hour_of_day BETWEEN 12 AND 17 THEN 'afternoon'
          ELSE 'evening'
        END as time_slot,
        dimension,
        COUNT(*) as cnt
      FROM spice_history
      WHERE created_at >= ?
      GROUP BY time_slot, dimension
      HAVING cnt >= ?
      ORDER BY cnt DESC
      LIMIT 5
    `).all(cutoff, MIN_PATTERN_COUNT) as Array<{ time_slot: string; dimension: string; cnt: number }>;

    return rows.map((r) => ({
      type: 'time-dimension' as const,
      rawDescription: `The "${r.dimension}" dimension appears ${r.cnt} times during ${r.time_slot} hours in the last 14 days`,
      data: { timeSlot: r.time_slot, dimension: r.dimension, count: r.cnt },
    }));
  } catch (err) {
    logger.warn({ err }, 'detectTimeDimensionPatterns failed');
    return [];
  }
}

// ── Insight Generation ───────────────────────────────────────────────

/**
 * Use Venice to polish a raw pattern description into natural language.
 * Returns null on failure (fail-open).
 */
async function generateInsight(pattern: SpicePattern): Promise<string | null> {
  try {
    const caps = veniceCapabilities();
    if (!caps.configured) {
      // No Venice -- return raw description as-is
      return pattern.rawDescription;
    }

    const prompt = `You are summarizing a behavioral preference pattern for a personal AI assistant. Convert this raw pattern into a single, natural sentence that describes a communication preference. Keep it concise (under 20 words). No quotes, no meta-commentary, just the insight.

Raw pattern: ${pattern.rawDescription}

Write the insight:`;

    const result = await venicePrivateChat(prompt);
    const trimmed = result?.trim();
    if (!trimmed || trimmed.length < 10) return pattern.rawDescription;
    return trimmed;
  } catch (err) {
    logger.warn({ err }, 'Venice insight generation failed, using raw description');
    return pattern.rawDescription;
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────

/**
 * Run spice consolidation: detect patterns, generate insights, save to memory.
 * Called by runDecaySweep() in memory.ts. Async, fail-open, non-fatal.
 *
 * Max 3 insights per run. Deduplicates against existing memories.
 */
export async function runSpiceConsolidation(): Promise<number> {
  const chatId = getDefaultChatId();
  if (!chatId) {
    logger.debug('Spice consolidation skipped: no default chat ID');
    return 0;
  }

  try {
    // Detect all patterns
    const allPatterns: SpicePattern[] = [
      ...detectDimensionTopicPatterns(),
      ...detectRegisterDimensionPatterns(),
      ...detectTimeDimensionPatterns(),
    ];

    if (allPatterns.length === 0) {
      logger.debug('Spice consolidation: no patterns detected');
      return 0;
    }

    // Take top patterns (sorted by count, capped at MAX_INSIGHTS_PER_RUN)
    const topPatterns = allPatterns
      .sort((a, b) => ((b.data.count as number) || 0) - ((a.data.count as number) || 0))
      .slice(0, MAX_INSIGHTS_PER_RUN);

    let saved = 0;

    for (const pattern of topPatterns) {
      try {
        // Generate natural language insight
        const insight = await generateInsight(pattern);
        if (!insight) continue;

        // Dedup against existing memories
        const dupId = await findDuplicate(chatId, insight);
        if (dupId !== null) {
          logger.debug({ insight, dupId }, 'Spice insight already exists, skipping');
          continue;
        }

        // Save as low-salience episodic memory
        const memId = saveMemoryReturningId(
          chatId,
          insight,
          'episodic',
          'preferences',
          INSIGHT_SALIENCE,
        );

        saved++;
        logger.info({ memId, insight, pattern: pattern.type }, 'Spice insight saved to memory');
      } catch (err) {
        logger.warn({ err, pattern: pattern.type }, 'Failed to process spice pattern');
      }
    }

    if (saved > 0) {
      logger.info({ saved, detected: allPatterns.length }, 'Spice consolidation complete');
    }

    return saved;
  } catch (err) {
    logger.error({ err }, 'Spice consolidation failed (non-fatal)');
    return 0;
  }
}
