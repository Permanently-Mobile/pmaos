/**
 * Skill Suggestion Trigger -- Detects complex multi-step workflows and
 * suggests extracting them as reusable skills.
 *
 * Three layers:
 *   1. Complexity Scorer (sync, per-turn, in-memory accumulator)
 *   2. Skill Candidate Evaluator (async, Venice-based, fire-and-forget)
 *   3. Suggestion Presenter (next-message injection, accept/dismiss)
 *
 * Human-in-the-loop at every step. No auto-install. Security scanner required.
 */

import { createHash } from 'crypto';
import {
  saveSkillCandidate,
  getSkillCandidateBySession,
  updateSkillCandidateStatus,
  isPatternDismissed,
  getRecentDismissalCount,
  logSkillSuggestion,
} from './db.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

interface SessionScore {
  score: number;
  turns: number;
  totalOutputTokens: number;
  didCompact: boolean;
  startedAt: number;
  evaluated: boolean;
}

interface PendingSuggestion {
  candidateId: number;
  message: string;
  messagesIgnored: number;  // count toward 3-message expiry
}

// ── Usage type (matches agent.ts UsageInfo shape) ────────────────────

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  didCompact: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

/** Session complexity threshold to trigger skill evaluation. */
const COMPLEXITY_THRESHOLD = 12;

/** Max messages without response before suggestion expires. */
const SUGGESTION_EXPIRY_MESSAGES = 3;

/** Cooldown after N dismissals in a week (ms). */
const DISMISSAL_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Max dismissals in 7 days before cooldown kicks in. */
const DISMISSAL_COOLDOWN_THRESHOLD = 3;

// ── In-memory state ──────────────────────────────────────────────────

const sessionScores = new Map<string, SessionScore>();
const pendingSuggestions = new Map<string, PendingSuggestion>();

// Cooldown tracking (resets on restart, which is acceptable)
let lastCooldownCheck = 0;
let inCooldown = false;

// ── Complexity Scoring ───────────────────────────────────────────────

/**
 * Score a turn's complexity. Called synchronously after every response.
 * Never throws -- wrapped in try/catch to protect the hot path.
 */
export function scoreTurnComplexity(
  chatId: string,
  sessionId: string | undefined,
  usage: UsageInfo,
  response: string,
  _userMessage: string,
): void {
  if (!sessionId) return;

  try {
    let session = sessionScores.get(sessionId);
    if (!session) {
      session = {
        score: 0,
        turns: 0,
        totalOutputTokens: 0,
        didCompact: false,
        startedAt: Date.now(),
        evaluated: false,
      };
      sessionScores.set(sessionId, session);
    }

    session.turns++;
    session.totalOutputTokens += usage.outputTokens;

    // ── Scoring signals ──────────────────────────────────────────

    // High single-turn output (+2)
    if (usage.outputTokens > 4000) {
      session.score += 2;
    }

    // Sustained output across session (+3)
    if (session.totalOutputTokens > 15000 && !session.didCompact) {
      session.score += 3;
    }

    // Context compaction (+5, one-time)
    if (usage.didCompact && !session.didCompact) {
      session.didCompact = true;
      session.score += 5;
    }

    // Turn count bonus (+1 per 3 turns, capped at +5)
    const turnBonus = Math.min(Math.floor(session.turns / 3), 5);
    // Only add if turn count just crossed a threshold
    if (session.turns % 3 === 0 && turnBonus <= 5) {
      session.score += 1;
    }

    // Session duration > 10 min (+2, one-time at threshold)
    const durationMs = Date.now() - session.startedAt;
    if (durationMs > 10 * 60 * 1000 && session.turns === Math.ceil(session.turns)) {
      // Approximate: add +2 once around the 10-min mark
      if (durationMs < 11 * 60 * 1000) {
        session.score += 2;
      }
    }

    // File creation/build markers (+2)
    const lower = response.slice(0, 500).toLowerCase();
    if (/(?:file written|created|wrote to|saved to)/.test(lower)) {
      session.score += 2;
    }
    if (/(?:build complete|compiled|tests? pass|npm run build)/.test(lower)) {
      session.score += 2;
    }

    logger.debug(
      { sessionId, score: session.score, turns: session.turns, outputTokens: session.totalOutputTokens },
      'Skill suggest: session complexity score',
    );

    // ── Threshold check ──────────────────────────────────────────
    if (session.score >= COMPLEXITY_THRESHOLD && !session.evaluated) {
      session.evaluated = true;

      // Check cooldown
      if (isInCooldown()) {
        logger.info({ sessionId, score: session.score }, 'Skill suggest: above threshold but in cooldown');
        return;
      }

      // Fire-and-forget: evaluate and store candidate
      evaluateSession(chatId, sessionId, session).catch((err) => {
        logger.warn({ err }, 'Skill suggest: evaluation failed (non-fatal)');
      });
    }
  } catch (err) {
    // Never crash the hot path
    logger.debug({ err }, 'Skill suggest: scoring error (ignored)');
  }
}

// ── Evaluation (async, Venice-based) ─────────────────────────────────

async function evaluateSession(
  chatId: string,
  sessionId: string,
  session: SessionScore,
): Promise<void> {
  const durationSecs = Math.round((Date.now() - session.startedAt) / 1000);

  // Build a pattern hash for dedup (coarse: score + turns + compact flag)
  const hashInput = `${session.score}:${session.turns}:${session.didCompact}:${session.totalOutputTokens > 20000}`;
  const patternHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  // Check if this pattern was already dismissed
  if (isPatternDismissed(patternHash)) {
    logger.info({ patternHash }, 'Skill suggest: pattern was previously dismissed, skipping');
    return;
  }

  // For v1, we skip the Venice classification step and just record the candidate.
  // The workflow summary is a template -- the bot fills in details when presenting.
  const summary = `Complex session: ${session.turns} turns, ${Math.round(session.totalOutputTokens / 1000)}k output tokens, ${Math.round(durationSecs / 60)} min${session.didCompact ? ', context compacted' : ''}`;

  const candidateId = saveSkillCandidate(
    sessionId, chatId, summary, null,
    session.score, session.turns, session.totalOutputTokens,
    session.didCompact, durationSecs, patternHash,
  );

  // Queue suggestion for next message
  pendingSuggestions.set(chatId, {
    candidateId,
    message: `That was a ${session.turns}-turn session (${Math.round(session.totalOutputTokens / 1000)}k output tokens${session.didCompact ? ', hit context limit' : ''}). If this is a workflow you repeat, I can extract it as a reusable skill. Say "make it a skill" or just ignore this.`,
    messagesIgnored: 0,
  });

  logSkillSuggestion(candidateId, 'queued');
  logger.info(
    { candidateId, sessionId, score: session.score, turns: session.turns },
    'Skill suggest: candidate queued for suggestion',
  );
}

// ── Suggestion delivery ──────────────────────────────────────────────

/**
 * Check for a pending skill suggestion for this chat.
 * Returns the suggestion text or null. Consumed once (cleared after return).
 */
export function getPendingSkillSuggestion(chatId: string): string | null {
  const pending = pendingSuggestions.get(chatId);
  if (!pending) return null;

  // Mark as suggested in DB
  updateSkillCandidateStatus(pending.candidateId, 'suggested', 1);
  logSkillSuggestion(pending.candidateId, 'suggested');

  // Don't delete from map yet -- need to track accept/dismiss
  return pending.message;
}

/**
 * Check if there's a pending suggestion (without consuming it).
 */
export function hasSkillSuggestionPending(chatId: string): boolean {
  return pendingSuggestions.has(chatId);
}

/**
 * Track a message that ignored the suggestion. After SUGGESTION_EXPIRY_MESSAGES,
 * auto-dismiss. Call this when a message arrives and doesn't match accept/dismiss.
 */
export function tickSuggestionExpiry(chatId: string): void {
  const pending = pendingSuggestions.get(chatId);
  if (!pending) return;

  pending.messagesIgnored++;
  if (pending.messagesIgnored >= SUGGESTION_EXPIRY_MESSAGES) {
    dismissSkillSuggestion(chatId, 'expired');
  }
}

// ── Accept / Dismiss ─────────────────────────────────────────────────

/** Regex patterns for accepting a skill suggestion. */
export const SKILL_ACCEPT_PATTERN = /\b(make (?:it|that) a skill|extract (?:it|that) as a skill|yes.*skill|skill it)\b/i;

/** Regex patterns for dismissing a skill suggestion. */
export const SKILL_DISMISS_PATTERN = /\b(no|nah|skip|pass|not now|ignore)\b/i;

/**
 * Handle acceptance of a skill suggestion.
 * Returns a message acknowledging -- actual draft generation happens later
 * when the bot has context to analyze the conversation.
 */
export function acceptSkillSuggestion(chatId: string): string | null {
  const pending = pendingSuggestions.get(chatId);
  if (!pending) return null;

  updateSkillCandidateStatus(pending.candidateId, 'accepted', 1);
  logSkillSuggestion(pending.candidateId, 'accepted');
  pendingSuggestions.delete(chatId);

  logger.info({ candidateId: pending.candidateId }, 'Skill suggest: accepted by user');

  return 'Noted. I\'ll draft a SKILL.md from that session and show it to you for review before installing.';
}

/**
 * Handle dismissal of a skill suggestion.
 */
export function dismissSkillSuggestion(chatId: string, reason: string): void {
  const pending = pendingSuggestions.get(chatId);
  if (!pending) return;

  updateSkillCandidateStatus(pending.candidateId, 'dismissed', 1);
  logSkillSuggestion(pending.candidateId, 'dismissed', reason);
  pendingSuggestions.delete(chatId);

  logger.info({ candidateId: pending.candidateId, reason }, 'Skill suggest: dismissed');
}

// ── Cooldown check ───────────────────────────────────────────────────

function isInCooldown(): boolean {
  const now = Date.now();
  // Only recheck every 5 minutes
  if (now - lastCooldownCheck < 5 * 60 * 1000) return inCooldown;

  lastCooldownCheck = now;
  const recentDismissals = getRecentDismissalCount(7);
  inCooldown = recentDismissals >= DISMISSAL_COOLDOWN_THRESHOLD;

  if (inCooldown) {
    logger.info({ recentDismissals }, 'Skill suggest: in cooldown (too many dismissals)');
  }

  return inCooldown;
}

// ── Cleanup ──────────────────────────────────────────────────────────

/**
 * Clear session score (e.g. on /newchat). Prevents stale data.
 */
export function clearSessionScore(sessionId: string): void {
  sessionScores.delete(sessionId);
}
