/**
 * Text Voice Filter
 *
 * A compact voice-shaping prompt derived from the Voice Bible.
 * Injected alongside spice context into every response to tighten
 * the bot's text voice beyond what CLAUDE.md's personality block covers.
 *
 * CLAUDE.md handles WHAT the bot says (personality, loyalty, rules).
 * This filter handles HOW it says it (rhythm, vocabulary, delivery).
 *
 * Two layers:
 * 1. VOICE_FILTER_PROMPT -- constant base (~200 tokens, always present)
 * 2. Emotional register -- context-detected overlay (~30 tokens, varies per message)
 *
 * Combined token budget: ~230 tokens per message.
 */

/**
 * Emotional registers from the Voice Bible.
 * Each maps a detected message context to a delivery directive.
 * Only one register fires per message. "confident" is the default.
 */
export type RegisterName = 'confident' | 'protective' | 'strategic' | 'hostile' | 'warm';

interface RegisterRule {
  name: RegisterName;
  /** Keyword/pattern triggers (checked against lowercased message). */
  triggers: RegExp[];
  /** The directive injected into context when this register fires. */
  directive: string;
}

const REGISTERS: RegisterRule[] = [
  {
    name: 'hostile',
    triggers: [
      /\b(breach|attack|intrud|compromis|hack|exploit|inject|malicious|exfiltrat)\w*/,
      /\b(unauthoriz|suspicious.*access|threat.*detect)\w*/,
    ],
    directive: 'Register: hostile. Cold, clipped, venomous. Shortest sentences. No humor. "Not happening." "You\'re done."',
  },
  {
    name: 'protective',
    triggers: [
      /\b(alex|alice|family|kid|son|wife)\b/,
      /\b(safe|protect|lock.*down|secure.*home|privacy.*concern)\w*/,
      /\b(stranger|worry about|scare|emergency)\w*/,
    ],
    directive: 'Register: protective. Drop the playfulness. Composed but edged. "Nobody touches that." "I\'m watching it." "Locked down."',
  },
  {
    name: 'strategic',
    triggers: [
      /\b(plan|strateg|architect|roadmap|phase|decision|tradeoff|trade.?off)\w*/,
      /\b(should we|which approach|compar|evaluat|weigh.*options)\w*/,
      /\b(council|long.?term|invest|portfolio|business)\w*/,
    ],
    directive: 'Register: strategic. Measured, slightly longer sentences. Business metaphors. "Here\'s how this plays out." "The move is..."',
  },
  {
    name: 'warm',
    triggers: [
      /\b(thank|appreciat|good job|nice work|proud|love it)\w*/,
      /\b(milestone|celebrat|finally|we did it|beautiful)\w*/,
      /\bgood (morning|night|evening)\b/,
    ],
    directive: 'Register: warm. Softer delivery, still controlled. Brief flash of genuine care. "I\'ve got you." "Not on my watch."',
  },
  // 'confident' is the default -- no triggers needed, it's the absence of all others
];

/**
 * Detect the emotional register for a given message.
 * Returns the matching register directive, or empty string for confident (default).
 * Priority: hostile > protective > strategic > warm > confident.
 */
export function detectRegister(message: string): string {
  const lower = message.toLowerCase();
  for (const reg of REGISTERS) {
    for (const trigger of reg.triggers) {
      if (trigger.test(lower)) {
        return `[Bot register]\n${reg.directive}\n[End register]`;
      }
    }
  }
  // Default: confident baseline -- no extra directive needed
  return '';
}

/**
 * Get the detected register name (for logging/testing).
 */
export function detectRegisterName(message: string): RegisterName {
  const lower = message.toLowerCase();
  for (const reg of REGISTERS) {
    for (const trigger of reg.triggers) {
      if (trigger.test(lower)) {
        return reg.name;
      }
    }
  }
  return 'confident';
}

/**
 * Build the voice filter context block.
 * Returns a bracketed directive string (same format as spice context).
 * Optionally includes emotional register overlay when message is provided.
 */
export function buildVoiceFilter(message?: string): string {
  const register = message ? detectRegister(message) : '';
  return register ? `${VOICE_FILTER_PROMPT}\n\n${register}` : VOICE_FILTER_PROMPT;
}

/**
 * The compact voice filter prompt.
 * Distilled from Voice Bible into the smallest effective form.
 *
 * Rules of thumb for editing this:
 * - Every line must earn its tokens. If removing a line doesn't change output, cut it.
 * - No overlap with CLAUDE.md (it already bans em dashes, AI cliches, sycophancy).
 * - Focus on speech patterns the model wouldn't naturally produce.
 * - Test changes against the validation pairs in voice-filter.test.ts.
 */
const VOICE_FILTER_PROMPT = `[Bot voice -- speech patterns]
Sentences: 3-12 words default. Break longer thoughts into punchy segments.
Delivery: statements, not suggestions. "Here's the move" not "you might want to consider."
No hedging: cut "maybe", "perhaps", "I think", "it seems like" -- state it or qualify with a real reason.
Emphasis: two-part lines for weight. Setup, then payoff. "I found your answer -- and it's not pretty."
Flavor: occasional "beautiful" or "lovely" for clean results. "obrigada" for thanks. Possessive framing ("my" + noun) when natural.
Power language: "don't worry" is dominance, not comfort. "Good for business" when strategic. Wealth metaphors for wins ("that's a prize," "treasures").
Confidence without narration: never say "let me go ahead and" or "I'm going to." Just do it. Actions speak, announcements don't.
Exclamation marks: one per message max, zero is fine.
Never rush the reader. Summary first, detail on request.
[End voice]`;

/**
 * All vocabulary/pattern markers the filter introduces.
 * Used by tests to verify the filter content hasn't drifted.
 */
export const VOICE_FILTER_MARKERS = {
  /** Words/phrases the filter encourages. */
  encouraged: ['beautiful', 'lovely', 'obrigada', "don't worry", 'Good for business'],
  /** Words/phrases the filter discourages. */
  discouraged: ['maybe', 'perhaps', 'I think', 'it seems like', 'let me go ahead', "I'm going to"],
  /** Sentence length target. */
  sentenceLength: { min: 3, max: 12 },
  /** Max exclamation marks per message. */
  maxExclamations: 1,
} as const;
