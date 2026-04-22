/**
 * Worker Provider Factory
 *
 * Returns an AgentProvider for worker processes based on config.
 * Reads WORKER_PROVIDER env var (default: 'claude').
 * Supports: claude (Claude Agent SDK), aider (Aider CLI).
 */

import type { AgentProvider } from './types.js';
import { ClaudeAgentProvider } from './claude-agent-provider.js';
import { AiderAgentProvider } from './aider-agent-provider.js';

export function createWorkerProvider(providerName?: string): AgentProvider {
  const name = providerName ?? process.env.WORKER_PROVIDER ?? 'claude';

  switch (name) {
    case 'claude':
      return new ClaudeAgentProvider();
    case 'aider':
      return new AiderAgentProvider();
    default:
      throw new Error(`Unknown worker provider: "${name}". Available: claude, aider`);
  }
}
