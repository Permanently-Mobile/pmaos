/**
 * Venice ChatProvider -- Privacy-first, zero data retention.
 *
 * Wraps the existing venice.ts chat function into the ChatProvider interface.
 * Non-chat capabilities (image gen, TTS, embeddings, etc.) stay in venice.ts.
 */

import type { ChatProvider, ChatMessage, ChatCompletionResult, ProviderHealth, ProviderCapability, NormalizedUsage } from './types.js';
import { logger } from '../logger.js';

// ── Ollama local-first routing ──────────────────────────────────────
const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'llama3.1:8b';
const OLLAMA_HEALTH_CACHE_MS = 60_000;
let _ollamaOk = false;
let _ollamaLastPing = 0;

async function ollamaReady(): Promise<boolean> {
  const now = Date.now();
  if (now - _ollamaLastPing < OLLAMA_HEALTH_CACHE_MS) return _ollamaOk;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(2_000) });
    _ollamaOk = r.ok;
  } catch { _ollamaOk = false; }
  _ollamaLastPing = now;
  return _ollamaOk;
}

export class VeniceProvider implements ChatProvider {
  readonly name = 'venice';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'chat', 'privacy', 'image-gen', 'embeddings', 'tts', 'stt', 'video-gen',
  ]);

  private apiKey: string;
  private baseUrl = 'https://api.venice.ai/api/v1';
  private _defaultModel: string;

  constructor(apiKey: string, defaultModel = 'llama-3.3-70b') {
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
      llama: 'llama-3.3-70b',
      llama405: 'llama-3.1-405b',
      dolphin: 'dolphin-2.9.2',
    };
  }

  async chat(messages: ChatMessage[], model?: string): Promise<ChatCompletionResult> {
    // Local-first: try Ollama before hitting Venice API
    if (await ollamaReady()) {
      try {
        const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
          signal: AbortSignal.timeout(60_000),
        });

        if (resp.ok) {
          const data = await resp.json() as {
            message?: { content?: string };
            eval_count?: number;
            prompt_eval_count?: number;
          };
          const text = data.message?.content;
          if (text) {
            logger.info(
              { model: OLLAMA_MODEL, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
              'VeniceProvider routed to local Ollama (zero cost)',
            );
            const usage: NormalizedUsage = {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
              totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
              costUsd: 0,
              provider: 'ollama',
              model: OLLAMA_MODEL,
            };
            return { text, usage };
          }
        }
      } catch (err) {
        logger.debug({ err }, 'VeniceProvider: Ollama attempt failed, falling back to Venice API');
      }
    }

    // Venice API fallback
    const useModel = model || this._defaultModel;

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
      throw new Error(`Venice ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const text = data.choices?.[0]?.message?.content || 'No response from Venice.';
    const rawUsage = data.usage;

    logger.info({ model: useModel, tokens: rawUsage?.total_tokens }, 'Venice API chat completed (Ollama unavailable)');

    const usage: NormalizedUsage = {
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      totalTokens: rawUsage?.total_tokens ?? 0,
      costUsd: 0, // Venice is included in subscription
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
