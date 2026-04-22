/**
 * ClaudeAgentProvider -- Wraps runAgent() into the AgentProvider interface.
 *
 * Pure adapter: no new logic. Translates between AgentResult and ProviderResult.
 * This is the only provider with full tool execution, session resume,
 * and file system access (via Claude Agent SDK).
 */

import type { AgentProvider, ProviderResult, ProviderCapability, ProviderHealth, NormalizedUsage } from './types.js';
import type { AgentProgressEvent } from '../agent.js';
import { runAgent } from '../agent.js';

export class ClaudeAgentProvider implements AgentProvider {
  readonly name = 'claude';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'chat', 'tools', 'session', 'code-gen',
  ]);

  isConfigured(): boolean {
    // Claude auth lives in ~/.claude/ (OAuth) or ANTHROPIC_API_KEY.
    // runAgent() handles auth internally -- always "configured".
    return true;
  }

  defaultModel(): string {
    return 'claude-opus-4-6';
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const start = Date.now();
      const resp = await fetch('https://api.anthropic.com/', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return {
        status: (resp.ok || resp.status === 401) ? 'healthy' : 'degraded',
        latencyMs: Date.now() - start,
        lastChecked: Date.now(),
        consecutiveFailures: 0,
      };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: null,
        lastChecked: Date.now(),
        lastError: String(err),
        consecutiveFailures: 0,
      };
    }
  }

  async execute(
    message: string,
    resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    timeoutMs?: number,
    model?: string,
    cwd?: string,
  ): Promise<ProviderResult> {
    const result = await runAgent(message, resumeToken, onTyping, onProgress, timeoutMs, model, cwd);

    let normalizedUsage: NormalizedUsage | null = null;
    if (result.usage) {
      normalizedUsage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: result.usage.totalCostUsd,
        provider: this.name,
        model: model || this.defaultModel(),
        agentUsage: result.usage,
      };
    }

    return {
      text: result.text,
      resumeToken: result.resumeToken,
      usage: normalizedUsage,
      provider: result.provider || this.name,
      model: model || this.defaultModel(),
      agentUsage: result.usage ?? undefined,
    };
  }
}
