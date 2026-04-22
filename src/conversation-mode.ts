/**
 * Conversation Mode Detection + Sentence Chunker
 *
 * Classifies incoming messages as "conversation" (casual, short, check-in)
 * vs "task" (build, deploy, research, complex ops).
 *
 * When conversation mode is active, injects a brevity directive so Claude
 * responds in 1-3 sentences instead of reports.
 *
 * Also provides sentence chunking for progressive TTS delivery on the kiosk.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface ConversationModeResult {
  mode: 'conversation' | 'task';
  confidence: number;   // 0.0 - 1.0
  directive: string;    // Prompt injection string, empty for task mode
}

// ── Conversation Mode Directives ──────────────────────────────────────

/** Text-based conversation (kiosk text or Telegram). */
const CONVERSATION_DIRECTIVE = `[Bot mode: conversation]
This is casual talk, not a task. Keep response to 1-3 sentences max.
No lists, no bullets, no headers, no code blocks. Talk like you're in the same room.
If the answer genuinely needs more, say the key point first and offer to expand.
[End mode]`;

/**
 * Voice conversation (kiosk mic). Written for the ear, not the eye.
 * Slightly more room (1-4 sentences) because spoken answers need a bit
 * more framing than text to sound natural.
 */
const VOICE_CONVERSATION_DIRECTIVE = `[Bot mode: voice conversation]
This is a spoken conversation via kiosk voice. Write for the ear, not the eye.
Keep response to 1-4 sentences. Front-load the point -- setup, then payoff.
Use contractions always (don't, can't, it's, we'll, that's) -- never the formal form.
No parenthetical asides. No abbreviations that sound awkward spoken aloud (say "for example" not "e.g.").
No lists, bullets, headers, code blocks, or markdown of any kind.
Talk like you're across the desk. Quick, natural, direct.
[End mode]`;

// ── Detection Patterns ────────────────────────────────────────────────

const GREETING_RE = /^(hey|hi|yo|sup|what'?s up|good (morning|night|evening|afternoon)|how'?s it going|howdy)/i;

const CASUAL_RE = /\b(what do you think|thoughts on|how are you|what'?s new|anything going on|checking in|just wanted to|how'?s everything|what'?s the move|what are we|catch me up|where are we|status update|how'd it go|real quick)\b/i;

const PLANNING_CHAT_RE = /\b(should we|what if|idea for|thinking about|planning|sounds good|let'?s do|yea|yeah|yes|nah|nope|cool|nice|perfect|got it|makes sense|love it|that works|agreed)\b/i;

const QUESTION_WORDS_RE = /^(what|how|when|where|who|why|which|is|are|do|does|did|can|could|would|will)\b/i;

const TASK_VERBS_RE = /\b(build|deploy|create|implement|fix|debug|refactor|install|configure|write code|push|commit|restart|set up|scaffold|migrate|update|add .{3,} to|remove|delete|wire|dispatch|spin up|kick off|run .{3,} (script|command|test|audit)|have (coder-1|researcher-1|creative-1|security-1))\b/i;

const CODE_FENCE_RE = /```|`[^`]+`/;
const FILE_PATH_RE = /[\/\\][\w.-]+\.\w{1,5}\b/;
const URL_RE = /https?:\/\/\S+/;
const COMMAND_RE = /^\//;
const SCHEDULE_RE = /\b(schedule|cron|every \d|at \d+[ap]m)\b/i;
const BRIDGE_RE = /\b(have (researcher-1|coder-1|creative-1|scribe|security-1)|dispatch|send.*to (coder-1|researcher-1|creative-1))\b/i;

// ── Classification ────────────────────────────────────────────────────

/**
 * Classify a message as conversation or task mode.
 * Uses heuristic scoring -- no API calls, fast regex matching only.
 */
export function classifyMessage(message: string): ConversationModeResult {
  // Strip context prefixes used internally
  const raw = message
    .replace(/^\[Voice transcribed via kiosk\]:\s*/i, '')
    .replace(/^\[Kiosk text\]:\s*/i, '')
    .trim();

  const words = raw.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  let convScore = 0;
  let taskScore = 0;

  // ── Conversation signals ──

  if (wordCount <= 20) convScore += 3;
  if (wordCount <= 8) convScore += 2;

  if (GREETING_RE.test(raw)) convScore += 4;
  if (CASUAL_RE.test(raw)) convScore += 3;
  if (PLANNING_CHAT_RE.test(raw)) convScore += 2;

  // Question without task verbs
  if (QUESTION_WORDS_RE.test(raw) && !TASK_VERBS_RE.test(raw)) convScore += 2;

  // Voice input biases toward conversation
  if (message.includes('[Voice transcribed via kiosk]')) convScore += 2;

  // No code, no paths, no URLs = more conversational
  if (!CODE_FENCE_RE.test(raw) && !FILE_PATH_RE.test(raw) && !URL_RE.test(raw)) convScore += 1;

  // Ends with question mark
  if (raw.endsWith('?')) convScore += 1;

  // ── Task signals ──

  if (TASK_VERBS_RE.test(raw)) taskScore += 5;
  if (CODE_FENCE_RE.test(raw)) taskScore += 4;
  if (FILE_PATH_RE.test(raw)) taskScore += 3;
  if (wordCount > 50) taskScore += 3;
  if (COMMAND_RE.test(raw)) taskScore += 5;
  if (SCHEDULE_RE.test(raw)) taskScore += 3;
  if (BRIDGE_RE.test(raw)) taskScore += 3;

  // ── Decision ──

  const mode: 'conversation' | 'task' = convScore > taskScore ? 'conversation' : 'task';
  const total = convScore + taskScore;
  const confidence = total > 0 ? Math.abs(convScore - taskScore) / total : 0.5;

  // Voice input gets the voice-optimized directive (write for the ear)
  const isVoice = message.includes('[Voice transcribed via kiosk]');
  let directive = '';
  if (mode === 'conversation') {
    directive = isVoice ? VOICE_CONVERSATION_DIRECTIVE : CONVERSATION_DIRECTIVE;
  }

  return {
    mode,
    confidence,
    directive,
  };
}

/** Convenience shortcut. */
export function isConversationMode(message: string): boolean {
  return classifyMessage(message).mode === 'conversation';
}

// ── Sentence Chunking ─────────────────────────────────────────────────

/**
 * Abbreviation tokens that should not trigger a sentence split.
 * We replace these with placeholders before splitting, then restore.
 */
const ABBREVIATIONS = [
  'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Sr.', 'Jr.',
  'St.', 'Ave.', 'Blvd.', 'Dept.', 'Est.', 'Fig.',
  'vs.', 'etc.', 'e.g.', 'i.e.', 'a.m.', 'p.m.',
  'U.S.', 'U.K.', 'E.U.',
];

const ABBR_PLACEHOLDER_PREFIX = '\x00ABBR';

/**
 * Split response text into speakable sentence chunks.
 * Designed for progressive TTS delivery -- each chunk is independently synthesizable.
 *
 * @param text - The full response text (pre-sanitized for speech or raw)
 * @returns Array of sentence strings, each suitable for TTS
 */
export function chunkIntoSentences(text: string): string[] {
  if (!text || !text.trim()) return [];

  let working = text.trim();

  // 1. Replace abbreviations with placeholders
  const abbrMap = new Map<string, string>();
  for (let i = 0; i < ABBREVIATIONS.length; i++) {
    const abbr = ABBREVIATIONS[i];
    const placeholder = `${ABBR_PLACEHOLDER_PREFIX}${i}\x00`;
    if (working.includes(abbr)) {
      abbrMap.set(placeholder, abbr);
      working = working.split(abbr).join(placeholder);
    }
  }

  // 2. Split on sentence boundaries: period/exclamation/question followed by whitespace
  const chunks = working.split(/(?<=[.!?])\s+/);

  // 3. Restore abbreviations and clean up
  const restored = chunks
    .map(chunk => {
      let c = chunk.trim();
      for (const [placeholder, abbr] of abbrMap) {
        c = c.split(placeholder).join(abbr);
      }
      return c;
    })
    .filter(c => c.length > 0);

  // 4. Merge very short chunks (< 3 words) into previous chunk
  const merged: string[] = [];
  for (const chunk of restored) {
    const wordCount = chunk.split(/\s+/).length;
    if (wordCount < 3 && merged.length > 0) {
      merged[merged.length - 1] += ' ' + chunk;
    } else {
      merged.push(chunk);
    }
  }

  return merged.length > 0 ? merged : [text.trim()];
}
