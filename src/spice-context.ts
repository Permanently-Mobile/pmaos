/**
 * Spice Context-Aware Selection (Layer 2b)
 *
 * Gathers three contextual signals and produces weighted dimension preferences
 * so spice rotation can favor appropriate behavioral dimensions:
 *
 *   1. Time of day  (sync, new Date().getHours())
 *   2. Topic detection  (sync, regex-based, no LLM call)
 *   3. Register influence  (from voice-filter detectRegisterName)
 *
 * All three are optional and fail-open. If context detection fails,
 * the system falls back to uniform random (pure pickRandom).
 *
 * Output: WeightedDimension[] with relative weights per dimension name.
 * Higher weight = more likely to be selected for this rotation.
 */

import { detectRegisterName, type RegisterName } from './voice-filter.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface WeightedDimension {
  name: string;
  weight: number;
}

export type TimeSlot = 'overnight' | 'morning' | 'afternoon' | 'evening';
export type TopicCategory = 'crypto' | 'family' | 'technical' | 'planning' | 'general';

// ── Time of Day ──────────────────────────────────────────────────────

/**
 * Determine the current time slot. EST-based (server time).
 */
export function getTimeSlot(hour?: number): TimeSlot {
  const h = hour ?? new Date().getHours();
  if (h >= 0 && h < 6) return 'overnight';
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  return 'evening';
}

/**
 * Time-of-day dimension weight biases.
 * Values > 1.0 = boost, < 1.0 = suppress, 1.0 = neutral.
 */
const TIME_WEIGHTS: Record<TimeSlot, Record<string, number>> = {
  overnight: {
    energy: 0.5,        // calm energy overnight
    pacing: 1.4,        // efficient, get to the point
    warmth: 1.2,        // slight warmth for late night
    humor: 0.6,         // dial back humor
    depth: 0.8,         // keep it surface level unless asked
  },
  morning: {
    energy: 1.3,        // focused energy
    depth: 0.7,         // stay surface, quick answers
    perspective: 1.2,   // practical/builder mindset
    cadence: 1.2,       // crisp cadence
    formality: 1.1,     // slightly more structured
  },
  afternoon: {
    // Balanced -- no strong biases
  },
  evening: {
    warmth: 1.3,        // relaxed warmth
    humor: 1.3,         // lighter humor OK
    formality: 0.8,     // more casual
    energy: 0.7,        // chill energy
    depth: 1.2,         // OK to go deeper in the evening
  },
};

// ── Topic Detection ──────────────────────────────────────────────────

/**
 * Regex-based topic detection. No LLM call.
 * Returns 'general' if nothing matches (neutral, no bias).
 */
export function detectTopic(message: string): TopicCategory {
  const lower = message.toLowerCase();

  // Crypto/trading
  if (/\b(crypto|bitcoin|btc|eth|defi|nft|trade|trading|portfolio|swap|token|solana|sol|memecoin|chart|candle|rsi|macd|leverage|short|long position|exchange|arbitrage|arb)\b/.test(lower)) {
    return 'crypto';
  }

  // Family/personal
  if (/\b(alex|alice|family|kid|son|wife|child|school|daycare|home|house|birthday|vacation|doctor|appointment)\b/.test(lower)) {
    return 'family';
  }

  // Technical/code
  if (/\b(code|function|class|typescript|javascript|python|api|endpoint|database|sql|deploy|docker|git|build|refactor|debug|error|stack trace|npm|node|test|lint)\b/.test(lower)) {
    return 'technical';
  }

  // Planning/strategy
  if (/\b(plan|strategy|roadmap|phase|decision|compare|evaluate|weigh|option|tradeoff|trade.?off|budget|timeline|goal|objective|priorit|agenda)\b/.test(lower)) {
    return 'planning';
  }

  return 'general';
}

/**
 * Topic-based dimension weight biases.
 */
const TOPIC_WEIGHTS: Record<TopicCategory, Record<string, number>> = {
  crypto: {
    perspective: 1.5,   // strategic thinking for trades
    texture: 1.3,       // numbers and specifics
    energy: 1.2,        // locked in focus
    depth: 1.2,         // go deeper on analysis
    humor: 0.6,         // less humor with money
  },
  family: {
    warmth: 1.6,        // protective warmth
    humor: 0.5,         // suppress edgy humor
    energy: 0.7,        // calm energy
    perspective: 1.2,   // practical perspective
    formality: 0.8,     // casual/warm tone
  },
  technical: {
    depth: 1.5,         // deep dives on code
    texture: 1.3,       // precision matters
    cadence: 1.2,       // methodical cadence
    perspective: 1.2,   // builder mindset
    humor: 0.7,         // less humor, more focus
  },
  planning: {
    perspective: 1.5,   // long game thinking
    pacing: 1.3,        // layered presentation
    depth: 1.3,         // thorough analysis
    curiosity: 1.2,     // challenge assumptions
    energy: 1.1,        // focused energy
  },
  general: {
    // Neutral -- no biases
  },
};

// ── Register Influence ───────────────────────────────────────────────

/**
 * Register-based dimension weight adjustments.
 * Applied on top of time + topic weights.
 */
const REGISTER_WEIGHTS: Record<RegisterName, Record<string, number>> = {
  hostile: {
    energy: 1.5,        // intensity up
    warmth: 0.5,        // cold
    humor: 0.1,         // no humor
    perspective: 1.3,   // strategic/risk-aware
    formality: 1.2,     // tight and precise
  },
  protective: {
    warmth: 1.5,        // protective warmth
    energy: 1.2,        // alert energy
    humor: 0.3,         // suppress humor
    perspective: 1.3,   // risk-aware
    depth: 0.8,         // surface, act fast
  },
  strategic: {
    perspective: 1.5,   // big picture thinking
    depth: 1.4,         // deep analysis
    pacing: 1.3,        // layered presentation
    texture: 1.2,       // precise framing
    humor: 0.7,         // dial back
  },
  warm: {
    warmth: 1.4,        // lean into warmth
    humor: 1.3,         // humor OK
    formality: 0.7,     // casual
    energy: 0.8,        // relaxed
    depth: 0.9,         // don't overdo depth
  },
  confident: {
    // Default -- no adjustments
  },
};

// ── Core Logic ───────────────────────────────────────────────────────

/**
 * Compute weighted dimension preferences from all context signals.
 *
 * @param dimensionNames  - Names of all available dimensions
 * @param message         - User's message (optional, for topic + register detection)
 * @param hour            - Override hour for testing (defaults to current hour)
 * @returns WeightedDimension[] with combined weights. Higher = more likely to be picked.
 */
export function computeDimensionWeights(
  dimensionNames: string[],
  message?: string,
  hour?: number,
): WeightedDimension[] {
  // Start with uniform weight = 1.0 for all dimensions
  const weights: Record<string, number> = {};
  for (const name of dimensionNames) {
    weights[name] = 1.0;
  }

  // Layer 1: Time of day
  const timeSlot = getTimeSlot(hour);
  const timeBoosts = TIME_WEIGHTS[timeSlot];
  for (const [dim, mult] of Object.entries(timeBoosts)) {
    if (weights[dim] !== undefined) {
      weights[dim] *= mult;
    }
  }

  // Layer 2: Topic detection (only if message provided)
  if (message) {
    const topic = detectTopic(message);
    const topicBoosts = TOPIC_WEIGHTS[topic];
    for (const [dim, mult] of Object.entries(topicBoosts)) {
      if (weights[dim] !== undefined) {
        weights[dim] *= mult;
      }
    }
  }

  // Layer 3: Register influence (only if message provided)
  if (message) {
    const register = detectRegisterName(message);
    const registerBoosts = REGISTER_WEIGHTS[register];
    for (const [dim, mult] of Object.entries(registerBoosts)) {
      if (weights[dim] !== undefined) {
        weights[dim] *= mult;
      }
    }
  }

  return dimensionNames.map((name) => ({ name, weight: weights[name] }));
}

/**
 * Weighted random selection of N unique dimension indices.
 * Higher-weighted dimensions are more likely to be selected.
 *
 * Falls back to uniform random if all weights are equal or on error.
 */
export function weightedPickRandom(
  dimensionWeights: WeightedDimension[],
  count: number,
): number[] {
  try {
    const n = Math.min(count, dimensionWeights.length);
    const indices: number[] = [];

    // Build pool with remaining candidates
    const pool = dimensionWeights.map((dw, i) => ({ index: i, weight: dw.weight }));

    for (let pick = 0; pick < n; pick++) {
      const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
      if (totalWeight <= 0) break;

      // Weighted random selection
      let roll = Math.random() * totalWeight;
      let selected = pool.length - 1; // fallback
      for (let i = 0; i < pool.length; i++) {
        roll -= pool[i].weight;
        if (roll <= 0) {
          selected = i;
          break;
        }
      }

      indices.push(pool[selected].index);
      pool.splice(selected, 1); // remove selected to prevent duplicates
    }

    return indices;
  } catch (err) {
    // Fail-open: fall back to sequential indices
    logger.warn({ err }, 'weightedPickRandom failed, falling back to sequential');
    return Array.from({ length: Math.min(count, dimensionWeights.length) }, (_, i) => i);
  }
}
