/**
 * Venice AI client -- privacy-first AI provider.
 *
 * OpenAI-compatible REST API at https://api.venice.ai/api/v1
 * Zero data retention, uncensored models, no training on user data.
 *
 * Endpoints: chat, image generation, embeddings, TTS, transcription, video.
 * Used when the user requests privacy or when fallback-model.ts cascades here.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ── Config ────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.venice.ai/api/v1';

function getApiKey(): string {
  // Check process.env first (workers may load via ensureVeniceKey from BRIDGE_MAIN_ROOT)
  if (process.env.VENICE_API_KEY) return process.env.VENICE_API_KEY;
  const env = readEnvFile(['VENICE_API_KEY']);
  const key = env.VENICE_API_KEY || '';
  if (!key) throw new Error('VENICE_API_KEY not set in .env');
  return key;
}

function headers(apiKey: string, contentType = 'application/json'): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': contentType,
  };
}

// ── Types ─────────────────────────────────────────────────────────────

export interface VeniceChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface VeniceChatOptions {
  model?: string;
  messages: VeniceChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Venice-specific: character slug for persona */
  veniceCharacter?: string;
}

export interface VeniceChatResult {
  text: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface VeniceImageOptions {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  /** Number of images to generate (1-4) */
  n?: number;
  /** Style preset */
  stylePreset?: string;
  /** Negative prompt */
  negativePrompt?: string;
}

export interface VeniceImageResult {
  images: Array<{
    url?: string;
    b64Json?: string;
  }>;
}

export interface VeniceEmbeddingOptions {
  input: string | string[];
  model?: string;
}

export interface VeniceEmbeddingResult {
  embeddings: number[][];
  model: string;
  usage?: { promptTokens: number; totalTokens: number };
}

export interface VeniceTTSOptions {
  text: string;
  model?: string;
  voice?: string;
  speed?: number;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac';
}

export interface VeniceTranscriptionOptions {
  filePath: string;
  model?: string;
  language?: string;
}

export interface VeniceVideoOptions {
  prompt: string;
  model?: string;
  /** Duration in seconds */
  duration?: number;
}

export interface VeniceModel {
  id: string;
  object: string;
  owned_by: string;
}

// ── Chat Completions ──────────────────────────────────────────────────

export async function veniceChat(options: VeniceChatOptions): Promise<VeniceChatResult> {
  // Local-first: try Ollama for all chat calls (skip if Venice-specific features needed)
  if (!options.veniceCharacter && await isOllamaHealthy()) {
    const localResult = await tryOllamaChat(
      options.messages,
      { temperature: options.temperature, maxTokens: options.maxTokens },
    );
    if (localResult) {
      return {
        text: localResult,
        model: `ollama/${OLLAMA_MODEL}`,
        usage: undefined, // Ollama usage tracked in tryOllamaChat logs
      };
    }
  }

  // Venice fallback
  const apiKey = getApiKey();

  const body: Record<string, unknown> = {
    model: options.model || 'llama-3.3-70b',
    messages: options.messages,
    max_tokens: options.maxTokens || 4096,
  };

  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.veniceCharacter) {
    body.venice_parameters = { character: options.veniceCharacter };
  }

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice chat ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  logger.info(
    { model: data.model, tokens: data.usage?.total_tokens },
    'Venice chat completed (Ollama unavailable)',
  );

  return {
    text: data.choices?.[0]?.message?.content || '',
    model: data.model || options.model || 'unknown',
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  };
}

// ── Image Generation ──────────────────────────────────────────────────

export async function veniceImageGenerate(options: VeniceImageOptions): Promise<VeniceImageResult> {
  const apiKey = getApiKey();

  const body: Record<string, unknown> = {
    prompt: options.prompt,
    model: options.model || 'fluently-xl',
    width: options.width || 1024,
    height: options.height || 1024,
    n: options.n || 1,
    response_format: 'url',
  };

  if (options.steps) body.steps = options.steps;
  if (options.stylePreset) body.style_preset = options.stylePreset;
  if (options.negativePrompt) body.negative_prompt = options.negativePrompt;

  const response = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice image ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as {
    data: Array<{ url?: string; b64_json?: string }>;
  };

  return {
    images: (data.data || []).map(img => ({
      url: img.url,
      b64Json: img.b64_json,
    })),
  };
}

// ── Image Upscale ────────────────────────────────────────────────────

export async function veniceImageUpscale(imageUrl: string, scale?: number): Promise<string> {
  const apiKey = getApiKey();

  const body = {
    image: imageUrl,
    scale: scale || 2,
  };

  const response = await fetch(`${BASE_URL}/images/generations/upscale`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice upscale ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as { data: Array<{ url?: string }> };
  return data.data?.[0]?.url || '';
}

// ── Background Removal ──────────────────────────────────────────────

export async function veniceRemoveBackground(imageUrl: string): Promise<string> {
  const apiKey = getApiKey();

  const response = await fetch(`${BASE_URL}/images/generations/remove-background`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ image: imageUrl }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice bg-remove ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as { data: Array<{ url?: string }> };
  return data.data?.[0]?.url || '';
}

// ── Embeddings ──────────────────────────────────────────────────────

export async function veniceEmbed(options: VeniceEmbeddingOptions): Promise<VeniceEmbeddingResult> {
  const apiKey = getApiKey();

  const body = {
    input: options.input,
    model: options.model || 'text-embedding-ada-002',
  };

  const response = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice embed ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[] }>;
    model: string;
    usage?: { prompt_tokens: number; total_tokens: number };
  };

  return {
    embeddings: (data.data || []).map(d => d.embedding),
    model: data.model || options.model || 'unknown',
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  };
}

// ── Text-to-Speech ──────────────────────────────────────────────────

export async function veniceTTS(options: VeniceTTSOptions): Promise<Buffer> {
  const apiKey = getApiKey();

  const body: Record<string, unknown> = {
    input: options.text,
    model: options.model || 'tts-kokoro',
    voice: options.voice || 'alloy',
    response_format: options.responseFormat || 'mp3',
  };

  if (options.speed) body.speed = options.speed;

  const response = await fetch(`${BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice TTS ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Transcription (STT) ─────────────────────────────────────────────

export async function veniceTranscribe(options: VeniceTranscriptionOptions): Promise<string> {
  const apiKey = getApiKey();
  const fileBuffer = fs.readFileSync(options.filePath);
  const fileName = path.basename(options.filePath);
  const boundary = `----VeniceFormBoundary${crypto.randomBytes(16).toString('hex')}`;

  // Build multipart/form-data manually
  const parts: Buffer[] = [];

  // File field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${options.model || 'whisper-1'}\r\n`,
  ));

  // Language field (optional)
  if (options.language) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `${options.language}\r\n`,
    ));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice transcribe ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as { text?: string };
  return data.text || '';
}

// ── Video Generation ────────────────────────────────────────────────

export async function veniceVideoGenerate(options: VeniceVideoOptions): Promise<string> {
  const apiKey = getApiKey();

  const body: Record<string, unknown> = {
    prompt: options.prompt,
    model: options.model || 'default',
  };

  if (options.duration) body.duration = options.duration;

  const response = await fetch(`${BASE_URL}/video/generations`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice video ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as { data: Array<{ url?: string }> };
  return data.data?.[0]?.url || '';
}

// ── List Models ─────────────────────────────────────────────────────

export async function veniceListModels(): Promise<VeniceModel[]> {
  const apiKey = getApiKey();

  const response = await fetch(`${BASE_URL}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Venice models ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await response.json() as { data: VeniceModel[] };
  return data.data || [];
}

// ── Billing Balance ──────────────────────────────────────────────────

export async function veniceGetBalance(): Promise<{ balanceUsd: number; balanceDiem: number } | null> {
  try {
    const apiKey = getApiKey();
    const response = await fetch(`${BASE_URL}/billing/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Venice balance check failed');
      return null;
    }

    const data = await response.json() as {
      balances?: { usd?: number | null; diem?: number | null };
      balance_usd?: number;
      balance?: number;
    };
    return {
      balanceUsd: data.balances?.usd ?? data.balance_usd ?? data.balance ?? 0,
      balanceDiem: data.balances?.diem ?? 0,
    };
  } catch (err) {
    logger.warn({ err }, 'Venice balance check error');
    return null;
  }
}

// ── Capabilities Check ──────────────────────────────────────────────

/**
 * Check whether Venice API is configured and available.
 */
export function veniceCapabilities(): {
  configured: boolean;
  features: string[];
} {
  const env = readEnvFile(['VENICE_API_KEY']);
  const configured = !!env.VENICE_API_KEY;

  return {
    configured,
    features: configured
      ? ['chat', 'image-generation', 'image-upscale', 'background-removal', 'embeddings', 'tts', 'transcription', 'video-generation']
      : [],
  };
}

// ── Local-first: Ollama routing ──────────────────────────────────────

const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'llama3.1:8b';
const OLLAMA_INFERENCE_TIMEOUT = 60_000; // 60s for CPU inference
const OLLAMA_HEALTH_CACHE_MS = 60_000;   // Re-check health every 60s

let _ollamaHealthy = false;
let _ollamaLastCheck = 0;

/** Cached Ollama health check. Only pings the server once per minute. */
async function isOllamaHealthy(): Promise<boolean> {
  const now = Date.now();
  if (now - _ollamaLastCheck < OLLAMA_HEALTH_CACHE_MS) return _ollamaHealthy;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(2_000),
    });
    _ollamaHealthy = res.ok;
  } catch {
    _ollamaHealthy = false;
  }
  _ollamaLastCheck = now;
  return _ollamaHealthy;
}

/** Try local Ollama inference. Returns text on success, null on any failure. */
async function tryOllamaChat(
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      model: OLLAMA_MODEL,
      messages,
      stream: false,
    };
    // Map Venice-style options to Ollama options
    if (opts?.temperature !== undefined || opts?.maxTokens !== undefined) {
      const options: Record<string, unknown> = {};
      if (opts.temperature !== undefined) options.temperature = opts.temperature;
      if (opts.maxTokens !== undefined) options.num_predict = opts.maxTokens;
      body.options = options;
    }

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OLLAMA_INFERENCE_TIMEOUT),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Ollama chat returned non-OK');
      return null;
    }

    const data = await res.json() as {
      message?: { content?: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };
    const text = data.message?.content;
    if (!text) {
      logger.warn('Ollama returned empty content');
      return null;
    }

    logger.info(
      { model: OLLAMA_MODEL, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
      'Local Ollama inference completed (zero cost)',
    );
    return text;
  } catch (err) {
    logger.debug({ err }, 'Ollama chat failed, falling back to Venice');
    return null;
  }
}

// ── Convenience: private chat ──────────────────────────────────────

/**
 * Quick private chat -- single prompt in, text out.
 * Routes through veniceChat which tries Ollama first, then Venice.
 */
export async function venicePrivateChat(
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  const messages: VeniceChatMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const result = await veniceChat({ messages });
  return result.text;
}

// ── Convenience: save generated image ──────────────────────────────

/**
 * Generate an image and save it locally.
 * Returns the local file path.
 */
export async function veniceGenerateAndSave(
  prompt: string,
  destDir: string,
  options?: Partial<VeniceImageOptions>,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });

  const result = await veniceImageGenerate({ prompt, ...options });

  if (result.images.length === 0) {
    throw new Error('Venice returned no images');
  }

  const img = result.images[0];
  const filename = `venice-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  const filePath = path.join(destDir, filename);

  if (img.url) {
    // Download from URL
    const response = await fetch(img.url);
    if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
  } else if (img.b64Json) {
    // Decode base64
    const buffer = Buffer.from(img.b64Json, 'base64');
    fs.writeFileSync(filePath, buffer);
  } else {
    throw new Error('Venice image response has no URL or base64 data');
  }

  logger.info({ filePath, prompt: prompt.slice(0, 60) }, 'Venice image saved');
  return filePath;
}
