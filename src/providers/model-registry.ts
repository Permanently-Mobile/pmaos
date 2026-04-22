/**
 * Model Registry -- Central catalog of all known models.
 *
 * Queried by /model command, cost-aware routing, and provider selection.
 * Add new models here when wiring new providers.
 */

import type { ModelEntry } from './types.js';

export const MODEL_REGISTRY: ModelEntry[] = [
  // ── Claude tiers (via Agent SDK, MAX plan) ───────────────────────
  {
    id: 'claude-opus-4-6',
    alias: 'opus',
    provider: 'claude',
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    contextWindow: 1_000_000,
    capabilities: ['chat', 'tools', 'session', 'code-gen'],
  },
  {
    id: 'claude-sonnet-4-5',
    alias: 'sonnet',
    provider: 'claude',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200_000,
    capabilities: ['chat', 'tools', 'session', 'code-gen'],
  },
  {
    id: 'claude-haiku-4-5',
    alias: 'haiku',
    provider: 'claude',
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    contextWindow: 200_000,
    capabilities: ['chat', 'tools', 'session', 'code-gen'],
  },

  // ── Venice (privacy-first, zero data retention) ──────────────────
  {
    id: 'llama-3.3-70b',
    alias: 'llama',
    provider: 'venice',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 128_000,
    capabilities: ['chat', 'privacy'],
  },
  {
    id: 'llama-3.1-405b',
    alias: 'llama405',
    provider: 'venice',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 128_000,
    capabilities: ['chat', 'privacy'],
  },
  {
    id: 'dolphin-2.9.2',
    alias: 'dolphin',
    provider: 'venice',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 128_000,
    capabilities: ['chat', 'privacy'],
  },

  // ── Ollama (local inference, zero cost) ──────────────────────────
  {
    id: 'deepseek-r1:latest',
    alias: 'deepseek',
    provider: 'ollama',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 32_000,
    capabilities: ['chat', 'local', 'privacy', 'code-gen'],
  },
  {
    id: 'llama3.1:8b',
    alias: 'ollama-llama',
    provider: 'ollama',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 128_000,
    capabilities: ['chat', 'local', 'privacy'],
  },

  // ── OpenRouter (multi-model passthrough) ─────────────────────────
  {
    id: 'openrouter/auto',
    alias: 'openrouter',
    provider: 'openrouter',
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    contextWindow: 200_000,
    capabilities: ['chat'],
  },

  // ── Open-source code models (via OpenRouter) ───────────────────────
  {
    id: 'deepseek/deepseek-chat',
    alias: 'deepseek-v3',
    provider: 'openrouter',
    costPer1kInput: 0.00027,
    costPer1kOutput: 0.0011,
    contextWindow: 64_000,
    capabilities: ['chat', 'code-gen'],
  },
  {
    id: 'qwen/qwen3-coder-next',
    alias: 'qwen-coder',
    provider: 'openrouter',
    costPer1kInput: 0.00012,
    costPer1kOutput: 0.00075,
    contextWindow: 262_000,
    capabilities: ['chat', 'code-gen'],
  },
  {
    id: 'qwen/qwen3.5-397b-a17b',
    alias: 'qwen3',
    provider: 'openrouter',
    costPer1kInput: 0.00039,
    costPer1kOutput: 0.00234,
    contextWindow: 262_000,
    capabilities: ['chat', 'code-gen'],
  },
];

/**
 * Look up a model by alias or full ID.
 * Case-insensitive on alias, exact match on ID.
 */
export function lookupModel(aliasOrId: string): ModelEntry | undefined {
  const lower = aliasOrId.toLowerCase();
  return MODEL_REGISTRY.find(
    m => m.alias.toLowerCase() === lower || m.id.toLowerCase() === lower,
  );
}

/** Get all models for a specific provider. */
export function modelsForProvider(providerName: string): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.provider === providerName);
}

/** Get all available aliases (for /model help text). */
export function allAliases(): string[] {
  return MODEL_REGISTRY.map(m => m.alias);
}

/** Get all models with a specific capability. */
export function modelsWithCapability(cap: import('./types.js').ProviderCapability): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.capabilities.includes(cap));
}

/** Get all code-gen model aliases (for /coder help text). */
export function coderAliases(): string[] {
  return MODEL_REGISTRY
    .filter(m => m.capabilities.includes('code-gen'))
    .map(m => m.alias);
}

/** Get the cheapest chat-capable model. */
export function cheapestModel(): ModelEntry | undefined {
  return MODEL_REGISTRY
    .filter(m => m.capabilities.includes('chat'))
    .sort((a, b) => a.costPer1kInput - b.costPer1kInput)[0];
}
