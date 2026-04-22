/**
 * Ollama ChatProvider -- Local inference, zero cost, full privacy.
 *
 * Connects to a local Ollama instance. Models run on-device.
 * No data leaves the machine.
 */

import type { ChatProvider, ChatMessage, ChatCompletionResult, ProviderHealth, ProviderCapability, NormalizedUsage } from './types.js';
import { logger } from '../logger.js';

export class OllamaProvider implements ChatProvider {
  readonly name = 'ollama';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'chat', 'local', 'privacy',
  ]);

  private baseUrl: string;
  private _defaultModel: string;

  constructor(baseUrl = 'http://localhost:11434', defaultModel = 'llama3.1:8b') {
    this.baseUrl = baseUrl;
    this._defaultModel = defaultModel;
  }

  isConfigured(): boolean {
    // Ollama is always "configured" if the URL is set. Actual availability
    // is determined by health check (whether the server is running).
    return !!this.baseUrl;
  }

  defaultModel(): string {
    return this._defaultModel;
  }

  availableModels(): Record<string, string> {
    return {
      deepseek: 'deepseek-r1:latest',
      'ollama-llama': 'llama3.1:8b',
    };
  }

  async chat(messages: ChatMessage[], model?: string): Promise<ChatCompletionResult> {
    const useModel = model || this._defaultModel;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json() as {
      message: { content: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const text = data.message?.content || 'No response from Ollama.';

    const usage: NormalizedUsage = {
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      costUsd: 0, // Local, free
      provider: this.name,
      model: useModel,
    };

    return { text, usage };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
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
