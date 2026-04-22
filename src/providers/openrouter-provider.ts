/**
 * OpenRouter ChatProvider -- Multi-model passthrough.
 *
 * Routes to any model available on OpenRouter (Claude, GPT, Llama, Mistral, etc.)
 * via a single API key. OpenAI-compatible interface.
 */

import type { ChatProvider, ChatMessage, ChatCompletionResult, ProviderHealth, ProviderCapability, NormalizedUsage } from './types.js';
import { logger } from '../logger.js';

export class OpenRouterProvider implements ChatProvider {
  readonly name = 'openrouter';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set(['chat']);

  private apiKey: string;
  private baseUrl = 'https://openrouter.ai/api/v1';
  private _defaultModel: string;

  constructor(apiKey: string, defaultModel = 'anthropic/claude-sonnet-4') {
    this.apiKey = apiKey;
    this._defaultModel = defaultModel;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  defaultModel(): string {
    return this._defaultModel;
  }

  availableModels(): Record<string, string> {
    return {
      openrouter: 'openrouter/auto',
    };
  }

  async chat(messages: ChatMessage[], model?: string): Promise<ChatCompletionResult> {
    const useModel = model || this._defaultModel;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://project-apex.local',
        'X-Title': 'Apex',
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const text = data.choices?.[0]?.message?.content || 'No response from OpenRouter.';
    const rawUsage = data.usage;

    const usage: NormalizedUsage = {
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      totalTokens: rawUsage?.total_tokens ?? 0,
      costUsd: null, // OpenRouter reports cost separately, not in response
      provider: this.name,
      model: useModel,
    };

    return { text, usage };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - start;

      if (response.ok) {
        return { status: 'healthy', latencyMs, lastChecked: Date.now(), consecutiveFailures: 0 };
      }

      return {
        status: 'degraded',
        latencyMs,
        lastChecked: Date.now(),
        lastError: `HTTP ${response.status}`,
        consecutiveFailures: 0,
      };
    } catch (err) {
      logger.debug({ err, provider: this.name }, 'Health check failed');
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        lastChecked: Date.now(),
        lastError: err instanceof Error ? err.message : String(err),
        consecutiveFailures: 1,
      };
    }
  }
}
