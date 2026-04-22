/**
 * Backward-compatible shim for runWithFallback().
 *
 * All routing logic has moved to src/providers/router.ts.
 * This file preserves the original function signature so existing callers
 * (bot.ts, scheduler.ts) work without changes during the transition.
 *
 * The singleton router is created on first call and reused.
 */

import type { AgentResult, AgentProgressEvent } from './agent.js';
import { createRouter, ProviderRouter } from './providers/index.js';
import { logger } from './logger.js';

// Singleton router instance -- created on first use
let _router: ProviderRouter | null = null;

/**
 * Get or create the singleton ProviderRouter.
 * Exported so bot.ts can access it for /model command.
 */
export function getRouter(): ProviderRouter {
  if (!_router) {
    _router = createRouter();
    logger.info('ProviderRouter singleton created');
  }
  return _router;
}

/**
 * Run a message through the ProviderRouter, falling back to alternative
 * models if Claude is unavailable.
 *
 * Drop-in replacement for the original runWithFallback() -- same signature,
 * same return type. Now delegates to ProviderRouter.route() internally.
 */
export async function runWithFallback(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  chatId?: string,
): Promise<AgentResult> {
  const router = getRouter();
  const result = await router.route(message, sessionId, onTyping, onProgress, chatId);

  // Convert ProviderResult back to AgentResult for backward compatibility.
  // Callers that understand ProviderResult can use the router directly.
  return {
    text: result.text,
    resumeToken: result.resumeToken,
    usage: result.agentUsage ?? null,
    provider: result.provider,
  };
}

/**
 * Run a code/tool-execution request through the ProviderRouter's code path.
 * Uses coderOverrides to select model, falls back to Claude agent.
 *
 * Same signature as runWithFallback() for backward compatibility.
 */
export async function runWithCodeFallback(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  chatId?: string,
): Promise<AgentResult> {
  const router = getRouter();
  const result = await router.routeCode(message, sessionId, onTyping, onProgress, chatId);

  return {
    text: result.text,
    resumeToken: result.resumeToken,
    usage: result.agentUsage ?? null,
    provider: result.provider,
  };
}
