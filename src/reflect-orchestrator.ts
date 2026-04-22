/**
 * Reflect Orchestrator
 *
 * Creates and manages all ReflectLoop instances.
 * Registers session boundary hooks for primary bot reflect.
 * Provides entry points for scheduled tasks and manual invocation.
 */

import { runReflectLoop, type ReflectLoopConfig } from './reflect-loop.js';
import { createPrimaryReflectInstance } from './reflect-primary.js';
import { createScoutReflectInstance } from './reflect-scout.js';
import { createAlphaReflectInstance } from './reflect-alpha.js';
import { onSessionBoundary } from './session-boundary.js';
import { BOT_NAME } from './config.js';
import { logger } from './logger.js';

// ── Config ──────────────────────────────────────────────────────────

const PRIMARY_CONFIG: ReflectLoopConfig = {
  agent: BOT_NAME,
  minConfidence: 0.6,
  maxProposals: 5,
  autoPromoteEnabled: false,
};

const STRATEGY_CONFIG: ReflectLoopConfig = {
  agent: 'strategy-1',
  minConfidence: 0.7, // Higher bar -- source changes have real cost
  maxProposals: 3,
  autoPromoteEnabled: false,
};

const OPTIMIZER_CONFIG: ReflectLoopConfig = {
  agent: 'optimizer-1',
  minConfidence: 0.6,
  maxProposals: 3,
  autoPromoteEnabled: false,
};

// ── Initialization ──────────────────────────────────────────────────

/**
 * Initialize the reflection system. Call once from index.ts on startup.
 * Registers session boundary callback for primary bot reflect.
 */
export function initReflectSystem(): void {
  // Fire primary reflect at every session boundary (8am, 4pm, 12am)
  onSessionBoundary(async (from, to) => {
    logger.info({ from, to }, 'Session boundary: running primary reflect');
    try {
      const instance = createPrimaryReflectInstance();
      const staged = await runReflectLoop(instance, PRIMARY_CONFIG);
      logger.info({ from, to, staged }, 'Primary session reflect complete');
    } catch (err) {
      logger.error({ err }, 'Primary session reflect failed (non-fatal)');
    }

    // Run a learning study session at each boundary (via Venice, zero Claude cost)
    try {
      const { canStudy, runStudySession } = await import('./learning/study.js');
      if (canStudy(BOT_NAME, 60 * 60 * 1000)) { // 1hr cooldown
        const result = await runStudySession({
          agent: BOT_NAME,
          specialties: ['conversation', 'memory', 'task-routing', 'personality'],
          roleDescription: 'Primary AI assistant with personality tuning',
        });
        logger.info({ topic: result.topic, tokens: result.tokensUsed }, 'Primary study session complete');
      }
    } catch (err) {
      logger.warn({ err }, 'Primary study session failed (non-fatal)');
    }
  });

  logger.info('Reflect system initialized');
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run reflection for a specific agent.
 * Used by scheduled tasks, CLI, and manual invocation.
 */
export async function runReflection(agent: 'primary' | 'strategy' | 'optimizer'): Promise<number> {
  switch (agent) {
    case 'primary':
      return runReflectLoop(createPrimaryReflectInstance(), PRIMARY_CONFIG);
    case 'strategy':
      return runReflectLoop(createScoutReflectInstance(), STRATEGY_CONFIG);
    case 'optimizer':
      return runReflectLoop(createAlphaReflectInstance(), OPTIMIZER_CONFIG);
    default:
      logger.warn({ agent }, 'Unknown reflect agent');
      return 0;
  }
}

/**
 * Run all agent reflections sequentially.
 * Used by nightly scheduled task (3am).
 */
export async function runAllReflections(): Promise<{
  primary: number;
  strategy: number;
  optimizer: number;
}> {
  const primary = await runReflection('primary');
  const strategy = await runReflection('strategy');
  const optimizer = await runReflection('optimizer');

  logger.info(
    { primary, strategy, optimizer },
    'Nightly reflect complete',
  );

  return { primary, strategy, optimizer };
}
