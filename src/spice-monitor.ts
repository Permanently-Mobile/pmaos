/**
 * Spice Monitor (Layer 4: Monitoring)
 *
 * Status reporting and health checks for the spice system.
 * Two entry points:
 *   1. getSpiceStatus()     - gather metrics for the "spice status" command
 *   2. formatSpiceStatus()  - format metrics for Telegram output
 *   3. checkSpiceHealth()   - systems-check integration (Tier 2 check)
 */

import {
  getSpiceState,
  getSpiceFrequency,
  getSpiceCharacterFrequency,
  countSpiceHistory,
  getOldestSpiceHistory,
  countSpiceRotations,
  getDefaultChatId,
} from './db.js';
import { ROTATION_INTERVAL, ACTIVE_COUNT, SPICE_DIMENSIONS } from './spice.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface SpiceStatus {
  /** Currently active directive strings. */
  activeSpices: string[];
  /** Messages until next rotation. */
  messagesUntilRotation: number;
  /** Total message count in current cycle. */
  currentMessageCount: number;
  /** Rotations in the last 24 hours. */
  rotations24h: number;
  /** Rotations in the last 7 days. */
  rotations7d: number;
  /** Total history entries. */
  historyCount: number;
  /** Age of oldest history entry in days (null if no history). */
  oldestEntryDays: number | null;
  /** Top dimensions by usage (7-day window). */
  topDimensions: Array<{ dimension: string; count: number; pct: number }>;
  /** Character split (7-day window). */
  characterSplit: Array<{ character_id: string; count: number; pct: number }>;
}

// ── Status Gathering ─────────────────────────────────────────────────

/**
 * Gather full spice system metrics. Returns null if no chat ID found.
 */
export function getSpiceStatus(): SpiceStatus | null {
  try {
    const chatId = getDefaultChatId();
    if (!chatId) return null;

    // Current state
    const state = getSpiceState(chatId);
    const activeSpices = state ? JSON.parse(state.active_spices) as string[] : [];
    const currentMessageCount = state?.message_count ?? 0;
    const messagesUntilRotation = state
      ? Math.max(0, ROTATION_INTERVAL - currentMessageCount)
      : ROTATION_INTERVAL;

    // Rotation counts
    const rotations24h = countSpiceRotations(chatId, 1);
    const rotations7d = countSpiceRotations(chatId, 7);

    // History stats
    const historyCount = countSpiceHistory(chatId);
    const oldestTs = getOldestSpiceHistory(chatId);
    const oldestEntryDays = oldestTs
      ? Math.round((Date.now() / 1000 - oldestTs) / 86400)
      : null;

    // Dimension frequency (7d)
    const dimFreq = getSpiceFrequency(chatId, 7);
    const totalDimCount = dimFreq.reduce((s, d) => s + d.count, 0);
    const topDimensions = dimFreq.slice(0, 5).map((d) => ({
      dimension: d.dimension,
      count: d.count,
      pct: totalDimCount > 0 ? Math.round((d.count / totalDimCount) * 100) : 0,
    }));

    // Character frequency (7d)
    const charFreq = getSpiceCharacterFrequency(chatId, 7);
    const totalCharCount = charFreq.reduce((s, c) => s + c.count, 0);
    const characterSplit = charFreq.map((c) => ({
      character_id: c.character_id,
      count: c.count,
      pct: totalCharCount > 0 ? Math.round((c.count / totalCharCount) * 100) : 0,
    }));

    return {
      activeSpices,
      messagesUntilRotation,
      currentMessageCount,
      rotations24h,
      rotations7d,
      historyCount,
      oldestEntryDays,
      topDimensions,
      characterSplit,
    };
  } catch (err) {
    logger.error({ err }, 'getSpiceStatus failed');
    return null;
  }
}

// ── Telegram Formatting ──────────────────────────────────────────────

/**
 * Format spice status for Telegram display.
 * Clean plain text, no heavy markdown.
 */
export function formatSpiceStatus(status: SpiceStatus): string {
  const lines: string[] = [];

  lines.push('Spice System v2');
  lines.push('');

  // Active spices (truncated for readability)
  if (status.activeSpices.length > 0) {
    const truncated = status.activeSpices.map((s) =>
      s.length > 60 ? s.slice(0, 57) + '...' : s,
    );
    lines.push(`Active: ${truncated.join(' | ')}`);
  } else {
    lines.push('Active: none (will roll on next message)');
  }

  lines.push(`Next rotation: ${status.messagesUntilRotation} message${status.messagesUntilRotation !== 1 ? 's' : ''}`);
  lines.push(`Rotations (24h): ${status.rotations24h} | (7d): ${status.rotations7d}`);
  lines.push(`History: ${status.historyCount} entries${status.oldestEntryDays !== null ? ` (oldest: ${status.oldestEntryDays}d)` : ''}`);

  // Top dimensions
  if (status.topDimensions.length > 0) {
    const dimStr = status.topDimensions
      .map((d) => `${d.dimension} (${d.pct}%)`)
      .join(', ');
    lines.push(`Top dimensions: ${dimStr}`);
  }

  // Character split
  if (status.characterSplit.length > 0) {
    const charNames: Record<string, string> = {
      primary: 'Primary',
      secondary: 'Secondary',
      tertiary: 'Tertiary',
    };
    const charStr = status.characterSplit
      .map((c) => `${charNames[c.character_id] || c.character_id} ${c.pct}%`)
      .join(' | ');
    lines.push(`Character split: ${charStr}`);
  }

  return lines.join('\n');
}

// ── Systems Check Integration ────────────────────────────────────────

/**
 * Health check for systems-check.ts (Tier 2).
 * Returns a check result object compatible with the systems check framework.
 */
export function checkSpiceHealth(): {
  name: string;
  tier: 2;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
} {
  try {
    const chatId = getDefaultChatId();
    if (!chatId) {
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: 'No chat ID found' };
    }

    const rotations24h = countSpiceRotations(chatId, 1);
    const rotations7d = countSpiceRotations(chatId, 7);
    const historyCount = countSpiceHistory(chatId);
    const state = getSpiceState(chatId);
    const activeCount = state ? (JSON.parse(state.active_spices) as string[]).length : 0;

    const parts: string[] = [];
    parts.push(`${activeCount}/${ACTIVE_COUNT} active`);
    parts.push(`${rotations24h} rot/24h`);
    parts.push(`${rotations7d} rot/7d`);
    parts.push(`${historyCount} history rows`);
    parts.push(`${SPICE_DIMENSIONS.length} dimensions`);

    // WARN if zero rotations in 24h (might indicate bot not running or spice broken)
    if (rotations24h === 0 && rotations7d > 0) {
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: `No rotations in 24h | ${parts.join(', ')}` };
    }

    // WARN if no history at all (fresh install or data loss)
    if (historyCount === 0) {
      return { name: 'Spice System', tier: 2, status: 'WARN', detail: 'No history data yet' };
    }

    return { name: 'Spice System', tier: 2, status: 'PASS', detail: parts.join(', ') };
  } catch (err) {
    return { name: 'Spice System', tier: 2, status: 'FAIL', detail: `Check error: ${err}` };
  }
}
