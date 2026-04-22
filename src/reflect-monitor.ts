/**
 * Reflect system health check for systems-check.ts (Tier 3).
 *
 * Checks:
 *   - Recent reflect runs (last 24h)
 *   - Staged proposal count
 *   - Hit rate (approved vs rejected over 30 days)
 */

import {
  getRecentReflectRuns,
  getAllStagedProposals,
  getProposalHitRate,
} from './db.js';

export interface ReflectHealthCheck {
  name: string;
  tier: 3;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

/**
 * Run reflect health check. Returns a systems-check compatible result.
 */
export function checkReflectHealth(): ReflectHealthCheck {
  try {
    const recentRuns = getRecentReflectRuns(process.env.BOT_NAME || 'apex-bot', 5);
    const allStaged = getAllStagedProposals(100);
    const hitRate = getProposalHitRate(process.env.BOT_NAME || 'apex-bot', 30);

    const parts: string[] = [];

    // Run count
    parts.push(`${recentRuns.length} runs (last 5)`);

    // Staged proposals across all agents
    parts.push(`${allStaged.length} staged`);

    // Hit rate
    if (hitRate.total > 0) {
      parts.push(`hit rate: ${(hitRate.rate * 100).toFixed(0)}% (${hitRate.correct}/${hitRate.total})`);
    } else {
      parts.push('hit rate: N/A');
    }

    // Check freshness -- WARN if no runs in 24h
    const lastRunAge = recentRuns.length > 0
      ? Math.round((Date.now() / 1000 - recentRuns[0].created_at) / 3600)
      : -1;

    if (lastRunAge === -1) {
      return {
        name: 'Reflect Engine',
        tier: 3,
        status: 'WARN',
        detail: `No runs yet | ${parts.join(', ')}`,
      };
    }

    if (lastRunAge > 24) {
      return {
        name: 'Reflect Engine',
        tier: 3,
        status: 'WARN',
        detail: `Last run ${lastRunAge}h ago | ${parts.join(', ')}`,
      };
    }

    return {
      name: 'Reflect Engine',
      tier: 3,
      status: 'PASS',
      detail: parts.join(', '),
    };
  } catch (err) {
    return {
      name: 'Reflect Engine',
      tier: 3,
      status: 'WARN',
      detail: `Check failed: ${String(err).slice(0, 60)}`,
    };
  }
}
