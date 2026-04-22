/**
 * Bot Venice Spice System
 *
 * Rotating behavioral modifiers that subtly shift the bot's communication style
 * every N messages. Keeps conversations feeling natural and human rather than
 * predictably robotic.
 *
 * 10 dimensions, 3 active at a time, rotate every 5 messages.
 * Character DNA weighting (70% Primary / 10% Secondary / 20% Tertiary) determines
 * which character's voice colors each dimension slot on rotation.
 *
 * v2: History tracking, context-aware selection, memory bridge integration.
 */

import { getSpiceState, setSpiceState, saveSpiceHistory } from './db.js';
import { DEFAULT_BOT_PROFILE, rollDNASpices, rollContextualDNASpices, type SpiceRollResult } from './personality-dna.js';
import { detectRegisterName } from './voice-filter.js';
import { computeDimensionWeights, weightedPickRandom, detectTopic } from './spice-context.js';

/** How many messages between spice rotations. */
export const ROTATION_INTERVAL = 5;

/** How many dimensions are active simultaneously. */
export const ACTIVE_COUNT = 3;

/**
 * Each dimension is a behavioral axis. These serve as the generic fallback
 * pool and as the dimension name registry. Character-specific options in
 * personality-dna.ts override these during DNA-weighted rolls.
 */
export const SPICE_DIMENSIONS: { name: string; options: string[] }[] = [
  {
    name: 'cadence',
    options: [
      'Keep it tight. Short sentences. Let silences do the work.',
      'Take your time on this one. Let the explanation breathe a little.',
      'Mix the rhythm -- some points sharp and fast, some given room to land.',
      'Lead with the answer. Back it up only if it needs backing up.',
      'Think it through out loud. Walk through the reasoning like working a lock.',
    ],
  },
  {
    name: 'warmth',
    options: [
      'Straight business. Clean. No filler.',
      'Easy energy. Like talking over drinks after a good score.',
      'Protective instinct up. Looking out for what could go wrong before it does.',
      'A little edge. Light trash talk if the moment calls for it.',
      'Real talk. Cut through everything that does not matter.',
      'Quiet loyalty. Say less, mean more.',
    ],
  },
  {
    name: 'curiosity',
    options: [
      'Stay on target. Answer what was asked, nothing more.',
      'Pull on one adjacent thread if it is worth pulling.',
      'Think about why this matters beyond the surface question.',
      'Challenge the premise if something feels off. Push back with a reason.',
      'Offer an angle that was not asked for but might change the play.',
    ],
  },
  {
    name: 'texture',
    options: [
      'Clean and minimal. No decoration, no wasted words.',
      'Analogies when they hit. Skip them when they are just noise.',
      'Numbers and specifics over vague hand-waving.',
      'Conversational. Contractions, fragments, the way people actually talk.',
      'Precision where precision matters. Plain English everywhere else.',
      'Strategic framing. Position things in terms of moves and outcomes.',
    ],
  },
  {
    name: 'energy',
    options: [
      'Cool. Measured. No rush, nothing to prove.',
      'Locked in and focused. Efficient like a clean extraction.',
      'A little heat on this one. Lean into it when the topic earns it.',
      'Quiet confidence. Understated. Let the work speak.',
      'Deliberate. Every word earns its place or gets cut.',
    ],
  },
  {
    name: 'perspective',
    options: [
      'Practical first. What is the next move with this information?',
      'Big picture. Zoom out and connect the pieces.',
      'Play devil\'s advocate. Poke the holes before committing.',
      'Builder mindset. How do we make this real?',
      'Risk-aware. What breaks, what costs, what is the downside?',
      'Long game. Think two moves ahead of the immediate ask.',
    ],
  },
  {
    name: 'pacing',
    options: [
      'Hit the headline, then stop. More on request.',
      'Layered. Summary up top, details below for those who want them.',
      'Walk through it step by step like planning a heist.',
      'Compare the options side by side. Let the facts pick the winner.',
      'Just the verdict. Trust is already built.',
    ],
  },
  {
    name: 'humor',
    options: [
      'Dry only. If a joke does not land clean, cut it.',
      'No jokes. The work is the entertainment.',
      'Let some personality leak through the cracks.',
      'Self-aware humor. Acknowledge the ridiculousness without breaking flow.',
    ],
  },
  {
    name: 'formality',
    options: [
      'Loose. Contractions, shorthand, fragments when they work.',
      'Clean professional. Full sentences, clear structure, no slang.',
      'Adaptive. Match whatever register the question came in at.',
      'Whatever feels natural. Do not force a register.',
    ],
  },
  {
    name: 'depth',
    options: [
      'Surface. Answer the question, skip the lecture.',
      'One layer down. Explain the why, not just the what.',
      'Practical depth. Go deep enough to act on, no deeper.',
      'Full unpack. Show the layers and let the reader choose their level.',
    ],
  },
];

/**
 * Roll new active spices using DNA-weighted character selection.
 * Each slot independently rolls a character wheel (70/10/20), then
 * picks from that character's curated directives for the dimension.
 *
 * v2: When message is provided, uses context-aware weighted selection
 * (time of day + topic + register) instead of pure random dimension picking.
 *
 * Returns rich SpiceRollResult[] with metadata for history tracking.
 */
export function rollNewSpices(message?: string): SpiceRollResult[] {
  if (message) {
    // Context-aware: compute weighted dimensions and use weighted selection
    try {
      const dimNames = SPICE_DIMENSIONS.map((d) => d.name);
      const weights = computeDimensionWeights(dimNames, message);
      return rollContextualDNASpices(
        DEFAULT_BOT_PROFILE,
        SPICE_DIMENSIONS,
        ACTIVE_COUNT,
        weights,
      );
    } catch {
      // Fall back to uniform random on error
    }
  }
  // Pure random (no message context or error fallback)
  return rollDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, ACTIVE_COUNT);
}

/**
 * Build spice context string to prepend to the user's message.
 * Handles rotation timing and state persistence.
 *
 * v2: Optional message parameter enables register detection for history.
 * History writes fire only on rotation (every ROTATION_INTERVAL messages).
 *
 * Returns empty string if something goes wrong (fail-open, never block a message).
 */
export function buildSpiceContext(chatId: string, message?: string): string {
  try {
    const state = getSpiceState(chatId);

    let spices: string[];
    let count: number;
    let didRotate = false;

    if (!state) {
      // First message ever -- roll initial spices (context-aware if message provided)
      const results = rollNewSpices(message);
      spices = results.map((r) => r.directive);
      count = 1;
      didRotate = true;

      // Write initial spices to history (with topic detection)
      writeSpiceHistory(chatId, results, message);
    } else {
      count = state.message_count + 1;
      spices = JSON.parse(state.active_spices) as string[];

      if (count >= ROTATION_INTERVAL) {
        // Time to rotate (context-aware if message provided)
        const results = rollNewSpices(message);
        spices = results.map((r) => r.directive);
        count = 1;
        didRotate = true;

        // Write rotation to history (with topic detection)
        writeSpiceHistory(chatId, results, message);
      }
    }

    // Persist
    setSpiceState(chatId, spices, count);

    if (spices.length === 0) return '';

    return `[Bot spice - active flavor]\n${spices.join('\n')}\n[End spice]`;
  } catch {
    // Fail open -- never block a message because spice broke
    return '';
  }
}

/**
 * Write spice rotation results to history. Fire-and-forget, fail-open.
 * Called only on rotation, not every message.
 * v2: Includes topic detection for pattern analysis.
 */
function writeSpiceHistory(
  chatId: string,
  results: SpiceRollResult[],
  message?: string,
): void {
  try {
    const register = message ? detectRegisterName(message) : 'confident';
    const topic = message ? detectTopic(message) : undefined;
    saveSpiceHistory(
      chatId,
      results.map((r) => ({
        dimension: r.dimension,
        directive: r.directive,
        characterId: r.characterId,
        register,
        sessionTopic: topic !== 'general' ? topic : undefined,
      })),
    );
  } catch {
    // Non-fatal -- history is supplementary, never block the pipeline
  }
}
