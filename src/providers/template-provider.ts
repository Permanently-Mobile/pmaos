/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │  PROVIDER TEMPLATE -- Copy this file to add a new provider  │
 * │                                                             │
 * │  Steps:                                                     │
 * │  1. Copy this file to src/providers/<name>-provider.ts      │
 * │  2. Fill in the blanks below (API URL, auth, parsing)       │
 * │  3. Add model entries to model-registry.ts                  │
 * │  4. Add to factory in index.ts (1 line)                     │
 * │  5. Build + restart                                         │
 * └─────────────────────────────────────────────────────────────┘
 */

import type { ChatProvider, ChatMessage, ChatCompletionResult, ProviderHealth, ProviderCapability, NormalizedUsage } from './types.js';
import { logger } from '../logger.js';

export class TemplateProvider implements ChatProvider {
  // ── FILL IN ────────────────────────────────────────────────
  readonly name = 'template';                              // unique provider name
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'chat',                                                 // add: 'privacy', 'local', etc.
  ]);

  private apiKey: string;
  private baseUrl = 'https://api.example.com/v1';          // API base URL
  private _defaultModel = 'example-model';                  // default model ID

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  defaultModel(): string {
    return this._defaultModel;
  }

  availableModels(): Record<string, string> {
    return {
      // alias: 'full-model-id',
    };
  }

  async chat(messages: ChatMessage[], model?: string): Promise<ChatCompletionResult> {
    const useModel = model || this._defaultModel;

    // ── Make the API call ──────────────────────────────────
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${this.name} ${response.status}: ${body.slice(0, 500)}`);
    }

    // ── Parse the response (OpenAI-compatible format) ──────
    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const text = data.choices?.[0]?.message?.content || `No response from ${this.name}.`;
    const rawUsage = data.usage;

    const usage: NormalizedUsage = {
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      totalTokens: rawUsage?.total_tokens ?? 0,
      costUsd: null,  // set if provider reports cost, null otherwise
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
      return { status: 'degraded', latencyMs, lastChecked: Date.now(), lastError: `HTTP ${response.status}`, consecutiveFailures: 0 };
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
