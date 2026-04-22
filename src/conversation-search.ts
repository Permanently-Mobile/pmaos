/**
 * Conversation Search -- Smart recall for past conversations.
 *
 * Detects when the user references past conversations ("remember when we talked about X")
 * and injects relevant FTS5 search results into the context assembly pipeline.
 *
 * Zero-cost on normal messages: trigger check is a sync regex scan (<0.1ms).
 * Only fires FTS5 queries when recall-intent is detected.
 */

import { searchConversations, getConversationWindow } from './db.js';
import { logger } from './logger.js';

// ── Recall trigger patterns ──────────────────────────────────────────
// Natural ways the user might reference past conversations.

const RECALL_PATTERNS = [
  /\bremember when\b/i,
  /\bwe (talked|discussed|spoke|chatted) about\b/i,
  /\blast time.*(?:said|discussed|mentioned|talked)\b/i,
  /\bwhat did (you|i|we) say about\b/i,
  /\bthat conversation about\b/i,
  /\bwhen did (we|i|you)\b/i,
  /\bfind.*(conversation|chat|discussion).*about\b/i,
  /\bsearch.*(conversation|chat|history)\b/i,
  /\byou (said|mentioned|told me)\b/i,
  /\bearlier (you|we|i)\b/i,
  /\bpreviously (you|we|i)\b/i,
  /\bgo back to\b/i,
  /\bbring up.*again\b/i,
];

// Phrases to strip when extracting search terms from recall messages
const RECALL_STRIP = /remember when|we (talked|discussed|spoke|chatted) about|last time|what did (you|i|we) say about|that conversation about|when did (we|i|you)|find.*(conversation|chat|discussion).*about|search.*(conversation|chat|history)|you (said|mentioned|told me)|earlier (you|we|i)|previously (you|we|i)|go back to|bring up.*again/gi;

/** Max tokens worth of recall context to inject (~6000 chars). */
const TOKEN_BUDGET_CHARS = 6000;

/** Max number of FTS hits to process. */
const MAX_HITS = 5;

/** Window size: how many surrounding turns to include per hit. */
const WINDOW_SIZE = 2;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Fast sync check: does this message look like it references a past conversation?
 */
export function shouldSearchConversations(message: string): boolean {
  return RECALL_PATTERNS.some((p) => p.test(message));
}

/**
 * Build conversation recall context for injection into the message pipeline.
 * Returns formatted recall string or empty string (no match / no results).
 */
export async function buildConversationRecallContext(
  chatId: string,
  message: string,
): Promise<string> {
  if (!shouldSearchConversations(message)) return '';

  // Extract search terms by stripping recall phrasing
  const cleaned = message.replace(RECALL_STRIP, '').trim();
  if (cleaned.length < 3) return '';

  const hits = searchConversations(chatId, cleaned, MAX_HITS * 3);
  if (hits.length === 0) {
    logger.debug({ query: cleaned }, 'Conversation recall: no FTS5 hits');
    return '';
  }

  logger.info(
    { query: cleaned, hitCount: hits.length },
    'Conversation recall: FTS5 search returned results',
  );

  // Deduplicate by picking the best hit per session
  const seenSessions = new Set<string>();
  const bestHits = hits.filter((h) => {
    const sid = h.session_id || 'none';
    if (seenSessions.has(sid)) return false;
    seenSessions.add(sid);
    return true;
  }).slice(0, MAX_HITS);

  // Build context snippets with surrounding turns
  const snippets: string[] = [];
  let charCount = 0;

  for (const hit of bestHits) {
    if (charCount >= TOKEN_BUDGET_CHARS) break;

    const window = getConversationWindow(chatId, hit.id, WINDOW_SIZE);
    const date = new Date(hit.created_at * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });

    const lines: string[] = [`[${date}]`];
    for (const turn of window) {
      const role = turn.role === 'user' ? 'User' : 'Assistant';
      const content = turn.content.length > 300
        ? turn.content.slice(0, 300) + '...'
        : turn.content;
      lines.push(`${role}: ${content}`);
    }

    const snippet = lines.join('\n');
    charCount += snippet.length;
    snippets.push(snippet);
  }

  if (snippets.length === 0) return '';

  return `[Past conversation recall]\n${snippets.join('\n---\n')}\n[End recall]`;
}
