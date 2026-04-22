/**
 * ReflectLoop -- Generic self-improvement pattern.
 *
 * Six-step cycle:
 *   1. Observe  -- Collect raw data from the work period
 *   2. Measure  -- Score outcomes against benchmarks
 *   3. Reflect  -- LLM extracts patterns from scored data
 *   4. Propose  -- Generate change recommendations with confidence
 *   5. Stage    -- Write proposals to DB for review (NOT auto-apply)
 *   6. Promote  -- Manual review via /reflect. Auto-promote gate exists
 *                  but disabled until 98%+ hit rate over 20+ proposals.
 *
 * Fail-open: if any step fails, the loop logs the error and returns 0.
 * Never blocks the main message pipeline.
 */

import {
  saveReflectProposal,
  saveReflectRun,
  getProposalHitRate,
} from './db.js';
import { logger } from './logger.js';

// ── Interfaces ──────────────────────────────────────────────────────

export interface Observation {
  /** Raw data point with metadata */
  data: Record<string, unknown>;
  timestamp: number;
}

export interface MeasuredOutcome {
  observation: Observation;
  /** -1.0 (bad) to +1.0 (good) */
  score: number;
  /** Human-readable signal description */
  signal: string;
  /** 0.0 to 1.0 */
  confidence: number;
}

export interface ReflectProposal {
  category: string;
  proposal: string;
  /** JSON stringified supporting data */
  evidence: string;
  /** 0.0 to 1.0 */
  confidence: number;
}

export interface ReflectLoopConfig {
  /** Agent name (primary, scout, alpha) */
  agent: string;
  /** Minimum confidence to stage a proposal. Default 0.6 */
  minConfidence?: number;
  /** Max proposals per run. Default 5 */
  maxProposals?: number;
  /** Hit rate threshold for auto-promote. Default 0.98 */
  autoPromoteThreshold?: number;
  /** Whether auto-promote is enabled. Default false */
  autoPromoteEnabled?: boolean;
}

/**
 * Each agent implements this interface with domain-specific logic.
 */
export interface ReflectLoopInstance {
  observe(): Promise<Observation[]>;
  measure(observations: Observation[]): Promise<MeasuredOutcome[]>;
  reflect(outcomes: MeasuredOutcome[]): Promise<ReflectProposal[]>;
  applyProposal?(proposal: ReflectProposal): Promise<boolean>;
}

// ── Executor ────────────────────────────────────────────────────────

/**
 * Execute a full reflect loop cycle.
 * Returns the number of proposals staged.
 */
export async function runReflectLoop(
  instance: ReflectLoopInstance,
  config: ReflectLoopConfig,
): Promise<number> {
  const startMs = Date.now();
  const minConf = config.minConfidence ?? 0.6;
  const maxProposals = config.maxProposals ?? 5;

  try {
    // Step 1: Observe
    const observations = await instance.observe();
    if (observations.length === 0) {
      saveReflectRun(config.agent, 'scheduled', 0, 0, Date.now() - startMs);
      logger.debug({ agent: config.agent }, 'Reflect: no observations, skipping');
      return 0;
    }

    // Step 2: Measure
    const outcomes = await instance.measure(observations);
    if (outcomes.length === 0) {
      saveReflectRun(config.agent, 'scheduled', observations.length, 0, Date.now() - startMs);
      logger.debug({ agent: config.agent, obs: observations.length }, 'Reflect: no measurable outcomes');
      return 0;
    }

    // Step 3: Reflect (LLM analysis)
    const rawProposals = await instance.reflect(outcomes);

    // Step 4: Filter by confidence, cap at maxProposals
    const qualified = rawProposals
      .filter(p => p.confidence >= minConf)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxProposals);

    // Step 5: Stage -- write to DB
    let staged = 0;
    for (const proposal of qualified) {
      saveReflectProposal(
        config.agent,
        proposal.category,
        proposal.proposal,
        proposal.evidence,
        proposal.confidence,
      );
      staged++;
      logger.info(
        { agent: config.agent, category: proposal.category, confidence: proposal.confidence },
        `Reflect proposal staged: ${proposal.proposal.slice(0, 80)}`,
      );
    }

    // Step 6: Auto-promote check (disabled by default)
    if (config.autoPromoteEnabled && instance.applyProposal) {
      const hitRate = getProposalHitRate(config.agent, 30);
      if (hitRate.total >= 20 && hitRate.rate >= (config.autoPromoteThreshold ?? 0.98)) {
        logger.info(
          { agent: config.agent, hitRate: hitRate.rate, total: hitRate.total },
          'Auto-promote conditions met (not yet active)',
        );
      }
    }

    saveReflectRun(config.agent, 'scheduled', observations.length, staged, Date.now() - startMs);
    return staged;
  } catch (err) {
    logger.error({ err, agent: config.agent }, 'ReflectLoop failed (non-fatal)');
    saveReflectRun(config.agent, 'scheduled', 0, 0, Date.now() - startMs, String(err));
    return 0;
  }
}
