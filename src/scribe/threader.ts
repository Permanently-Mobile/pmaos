/**
 * Scribe -- conversation threading.
 *
 * Groups flat conversation_log messages into topical threads
 * using time-gap segmentation and optional Venice topic splitting.
 */

import { randomBytes } from 'crypto';

import { logger } from '../logger.js';
import type { RawConversationTurn } from './db.js';
import type { ConversationThread, ThreadMessage } from './types.js';

// ── Configuration ───────────────────────────────────────────────────

/** Minutes of silence before we consider it a new conversation. */
export const GAP_THRESHOLD_S = 15 * 60;     // 15 minutes in seconds

/** Max messages in a single thread before we split. */
export const MAX_THREAD_MESSAGES = 40;

/** Drop threads shorter than this. */
export const MIN_THREAD_MESSAGES = 3;

// ── Message preprocessing ───────────────────────────────────────────

/** Patterns to strip from messages before classification. */
const STRIP_PATTERNS = [
  /\[Memory context\][\s\S]*?\[End memory context\]/gi,
  /\[Bot spice.*?\][\s\S]*?\[End spice\]/gi,
  /\[Respin context\][\s\S]*?\[End respin context\]/gi,
  /\[Voice transcribed\]:\s*/gi,
];

/** Patterns that indicate an assistant message contains a saved report.
 * These messages should NOT be truncated aggressively because the report
 * content is the valuable part Venice needs to classify properly. */
const REPORT_SAVE_PATTERNS = [
  /saved?\s+to\s+[`']?(?:workspace|store|vault)\/reports?\//i,
  /report\s+saved\s+to/i,
  /full\s+(?:comparison|analysis|research)\s+report/i,
];

/** Commands that are pure noise. */
const COMMAND_PATTERN = /^\/(?:newchat|start|help|chatid|respin|dashboard|wa|slack)\b/i;

/** Short acks that carry no information alone. */
const NOISE_PATTERN = /^(?:ok|got it|yep|yup|sure|k|👍|✅|done|nice|cool|bet|word|ty|thanks|thx)\.?$/i;

/** Transient operational messages that should never become tasks/notes. */
const TRANSIENT_PATTERNS = [
  /^(?:restart|restarting)\s+(?:apex-bot|researcher|processor|pm2)/i,
  /^(?:load|start|begin)\s+(?:new|fresh)\s+(?:session|chat)/i,
  /^(?:set|create|make)\s+(?:a\s+)?backup/i,
  /^checkpoint$/i,
  /^convolife$/i,
  /^(?:let's\s+)?(?:back\s+up|start\s+new\s+session)/i,
  /^Bot online and ready/i,
  /^I'm online and ready/i,
  /^Bot's here/i,
  /^I'm here and ready/i,
  /^I'm up\. Let's/i,
  /^Back online/i,
];

/**
 * Assistant-side noise patterns: agent delivery confirmations, status acks,
 * and other bot output that Scribe should never classify as vault content.
 */
const ASSISTANT_NOISE_PATTERNS = [
  // Agent delivery confirmations (the #1 cause of duplicate vault entries)
  /^done\.?\s+(?:full\s+)?report\s+saved/i,
  /^report\s+saved\s+to/i,
  /^here'?s?\s+(?:the\s+)?(?:short|quick)\s+(?:version|summary)/i,
  /^results?\s+(?:saved|delivered|posted)/i,
  /^research\s+(?:complete|done|saved)/i,
  /^(?:researcher|coder|processor|agent)\s+(?:is\s+)?on\s+it/i,
  /^queued\s+(?:for|to)\s+(?:researcher|coder|processor)/i,
  /^dispatched\s+to\s+(?:researcher|coder|processor)/i,
  // Bridge task confirmations
  /^task\s+(?:queued|dispatched|sent)\s+to/i,
  /^bridge\s+(?:task|dispatch)\s+confirmed/i,
  // Build/restart acks
  /^build\s+complete\.?\s+(?:ready|restarting)/i,
  /^restarting\s+now/i,
  // Systems check output (long diagnostic, no vault value)
  /^(?:🔴|🟢|🟡)\s+systems?\s+check/i,
  /^\d+\/\d+\s+pass/i,
  // Vault commit confirmations
  /^vault\s+committed/i,
  /^vault\s+commit/i,
];

function cleanMessage(content: string): string {
  let cleaned = content;
  for (const pattern of STRIP_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}

function isNoise(content: string): boolean {
  const trimmed = content.trim();
  if (COMMAND_PATTERN.test(trimmed)) return true;
  if (NOISE_PATTERN.test(trimmed)) return true;
  if (TRANSIENT_PATTERNS.some(p => p.test(trimmed))) return true;
  if (trimmed.length < 5) return true;
  return false;
}

/** Check if an assistant message is operational noise (delivery confirmations, etc.). */
function isAssistantNoise(content: string): boolean {
  const trimmed = content.trim();
  // Check first 200 chars only -- delivery confirmations are always at the start
  const head = trimmed.slice(0, 200);
  return ASSISTANT_NOISE_PATTERNS.some(p => p.test(head));
}

/** Truncate long assistant messages (code dumps, reports).
 * Raised from 1500 to 3500 so Venice sees enough of research responses
 * to classify them properly (payment comparisons, architecture writeups, etc.)
 *
 * Messages containing report save references get extra room (6000 chars)
 * because the report content IS the valuable data Venice needs to classify.
 */
function truncateAssistant(content: string, maxLen = 3500): string {
  // Detect saved reports -- give them double room
  const isReport = REPORT_SAVE_PATTERNS.some(p => p.test(content));
  const effectiveMax = isReport ? 6000 : maxLen;

  if (content.length <= effectiveMax) return content;

  // Smart truncation: try to preserve section headings and structure
  const cutContent = content.slice(0, effectiveMax);
  // Cut at the last complete paragraph/line break to avoid mid-sentence truncation
  const lastBreak = cutContent.lastIndexOf('\n\n');
  const cutPoint = lastBreak > effectiveMax * 0.7 ? lastBreak : effectiveMax;
  return content.slice(0, cutPoint) + '\n[...truncated]';
}

// ── Threading ───────────────────────────────────────────────────────

function generateThreadId(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

/**
 * Build conversation threads from flat message list.
 *
 * 1. Sort chronologically
 * 2. Split on time gaps > GAP_THRESHOLD_S
 * 3. Filter out noise-only threads
 * 4. Cap thread size at MAX_THREAD_MESSAGES
 */
export function buildThreads(turns: RawConversationTurn[]): ConversationThread[] {
  if (turns.length === 0) return [];

  // Sort ascending by timestamp
  const sorted = [...turns].sort((a, b) => a.created_at - b.created_at);

  const threads: ConversationThread[] = [];
  let currentMessages: ThreadMessage[] = [];
  let lastTimestamp = sorted[0].created_at;

  for (const turn of sorted) {
    const cleaned = cleanMessage(turn.content);

    // Skip pure noise messages (user commands, acks, transient ops)
    if (turn.role === 'user' && isNoise(cleaned)) continue;
    // Skip assistant operational noise (agent delivery confirmations, build acks, etc.)
    if (turn.role === 'assistant' && isAssistantNoise(cleaned)) continue;

    const gap = turn.created_at - lastTimestamp;

    // Start new thread on gap
    if (gap > GAP_THRESHOLD_S && currentMessages.length > 0) {
      threads.push(finalizeThread(currentMessages));
      currentMessages = [];
    }

    // Split oversized threads
    if (currentMessages.length >= MAX_THREAD_MESSAGES) {
      threads.push(finalizeThread(currentMessages));
      currentMessages = [];
    }

    const msgContent = turn.role === 'assistant'
      ? truncateAssistant(cleaned)
      : cleaned;

    if (msgContent.length > 0) {
      currentMessages.push({
        id: turn.id,
        role: turn.role as 'user' | 'assistant',
        content: msgContent,
        created_at: turn.created_at,
      });
    }

    lastTimestamp = turn.created_at;
  }

  // Don't forget the last thread
  if (currentMessages.length > 0) {
    threads.push(finalizeThread(currentMessages));
  }

  // Filter short threads
  const filtered = threads.filter(t => t.messages.length >= MIN_THREAD_MESSAGES);

  logger.info(
    { rawMessages: turns.length, threads: threads.length, afterFilter: filtered.length },
    'Built conversation threads',
  );

  return filtered;
}

function finalizeThread(messages: ThreadMessage[]): ConversationThread {
  // Generate topic summary from first user message
  const firstUserMsg = messages.find(m => m.role === 'user');
  const summary = firstUserMsg
    ? firstUserMsg.content.slice(0, 80).replace(/\n/g, ' ')
    : 'Conversation thread';

  return {
    id: generateThreadId(),
    messages,
    startTime: messages[0].created_at,
    endTime: messages[messages.length - 1].created_at,
    topicSummary: summary,
  };
}

/**
 * Format a thread's messages into a readable string for Venice classification.
 */
export function formatThreadForClassification(thread: ConversationThread): string {
  const lines: string[] = [];
  for (const msg of thread.messages) {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${msg.content}`);
  }
  return lines.join('\n');
}
