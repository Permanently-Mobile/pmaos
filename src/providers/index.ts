/**
 * Provider Abstraction Layer -- Barrel export + factory.
 *
 * createRouter() reads config, registers all configured providers,
 * and returns an initialized ProviderRouter ready to route messages.
 */

import { ProviderRouter } from './router.js';
import { ClaudeAgentProvider } from './claude-agent-provider.js';
import { VeniceProvider } from './venice-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { PRIMARY_PROVIDER, VENICE_API_KEY } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

import type { RouterConfig } from './types.js';

// Re-export core types and utilities
export { ProviderRouter } from './router.js';
export { ClaudeAgentProvider } from './claude-agent-provider.js';
export { AiderAgentProvider } from './aider-agent-provider.js';
export { createWorkerProvider } from './worker-provider-factory.js';
export { SystemPromptLoader, createSystemPromptLoader } from './system-prompt-loader.js';
export { ToolExecutor } from './tool-executor.js';
export { ToolAugmentedProvider } from './tool-augmented-provider.js';
export { lookupModel, allAliases, modelsForProvider, modelsWithCapability, coderAliases, MODEL_REGISTRY } from './model-registry.js';
export { classifyIntent, classifyWithSensitivity, needsToolExecution } from './intent.js';
export { SensitivityClassifier } from './sensitivity.js';
export { DataSanitizer } from './sanitizer.js';
export { PrivacyAuditLogger } from './audit-logger.js';
export { SecretSubstitution, createSecretSubstitution } from './secret-substitution.js';
export { CedarPolicyEngine, createCedarPolicyEngine } from './cedar-policy.js';
export { CommandValidator, createCommandValidator } from './command-validator.js';
export type { ToolResult, ToolDefinition, BashResult } from './tool-executor.js';
export type {
  AgentProvider,
  ChatProvider,
  ChatMessage,
  ChatCompletionResult,
  NormalizedUsage,
  ProviderResult,
  ProviderHealth,
  HealthStatus,
  RoutingIntent,
  ModelEntry,
  RouterConfig,
  ProviderCapability,
  SensitivityCategory,
  SensitivityResult,
  SensitivityConfig,
  Detection,
  SanitizeOptions,
  SanitizeResult,
  AuditEntry,
  AuditStats,
  ClassificationResult,
  PrivacyLevel,
  SecretMatch,
  SecretSubstitutionResult,
  SecretSubstitutionMode,
  CedarMode,
  PolicyContext,
  PolicyDecision,
  PolicyDecisionAction,
  PolicyAction,
  PolicyRule,
  CedarPoliciesConfig,
  CedarAuditEntry,
  DetectedCommand,
} from './types.js';

/**
 * Create and configure a ProviderRouter with all available providers.
 * Call once at bot startup. Returns a ready-to-use router.
 */
export function createRouter(): ProviderRouter {
  const env = readEnvFile([
    'FALLBACK_MODEL_PROVIDER',
    'FALLBACK_API_KEY',
    'FALLBACK_MODEL',
    'OLLAMA_URL',
  ]);

  const config: RouterConfig = {
    primaryProvider: PRIMARY_PROVIDER || '',
    veniceConfigured: !!VENICE_API_KEY,
    fallbackProvider: env.FALLBACK_MODEL_PROVIDER || '',
    ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
  };

  const router = new ProviderRouter(config);

  // Register configured providers
  if (VENICE_API_KEY) {
    router.addProvider(new VeniceProvider(VENICE_API_KEY, env.FALLBACK_MODEL || 'llama-3.3-70b'));
  }

  if (env.FALLBACK_API_KEY && env.FALLBACK_MODEL_PROVIDER === 'openrouter') {
    router.addProvider(new OpenRouterProvider(env.FALLBACK_API_KEY, env.FALLBACK_MODEL || 'anthropic/claude-sonnet-4'));
  }

  // Ollama is always registered (may or may not be running)
  router.addProvider(new OllamaProvider(config.ollamaUrl));

  // Register agent provider (Tier 2: tool execution)
  router.setAgentProvider(new ClaudeAgentProvider());

  // Start background health checks (every 60s)
  router.startHealthChecks(60_000);

  logger.info({ providers: router.listProviders(), primary: config.primaryProvider }, 'ProviderRouter initialized');

  return router;
}
