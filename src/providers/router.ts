/**
 * ProviderRouter -- Central routing engine for all LLM providers.
 *
 * Handles:
 *   - Intent classification (does this need tools? privacy?)
 *   - Content-based sensitivity analysis (Privacy Routing Layer)
 *   - Model override lookup (/model command)
 *   - Provider selection based on intent + health + config
 *   - Fallback cascade on failure
 *   - Normalized usage tracking
 *   - Background health checks
 *   - Privacy audit logging
 */

import fs from 'fs';
import path from 'path';

import type {
  AgentProvider,
  ChatProvider,
  ChatMessage,
  ProviderResult,
  ProviderHealth,
  RouterConfig,
  NormalizedUsage,
  PrivacyLevel,
  AuditStats,
  SensitivityConfig,
  SecretSubstitutionMode,
  CedarMode,
  PolicyContext,
  PolicyDecision,
} from './types.js';
import { lookupModel } from './model-registry.js';
import { classifyIntent, classifyWithSensitivity, needsToolExecution } from './intent.js';
import { SensitivityClassifier } from './sensitivity.js';
import { DataSanitizer } from './sanitizer.js';
import { PrivacyAuditLogger } from './audit-logger.js';
import { SecretSubstitution, createSecretSubstitution } from './secret-substitution.js';
import { CedarPolicyEngine, createCedarPolicyEngine } from './cedar-policy.js';
import { SystemPromptLoader } from './system-prompt-loader.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolAugmentedProvider } from './tool-augmented-provider.js';
import { buildSanitizedSystemPrompt } from './prompt-sanitizer.js';
import { sanitizeMemoryContext, sanitizeMessageForProvider } from './context-sanitizer.js';
import { getProviderIndicator } from './provider-indicator.js';
import { runAgent } from '../agent.js';
import type { AgentProgressEvent } from '../agent.js';
import { getRecentConversation, getDatabase, clearSession } from '../db.js';
import { saveSessionSummary } from '../memory.js';
import { PROJECT_ROOT } from '../config.js';
import { buildVoiceFilter } from '../voice-filter.js';
import { logger } from '../logger.js';

/** Max age (ms) for conversation turns included in REST provider history. */
const CHAT_HISTORY_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export class ProviderRouter {
  private chatProviders = new Map<string, ChatProvider>();
  private agentProvider: AgentProvider | null = null;
  private healthCache = new Map<string, ProviderHealth>();
  private modelOverrides = new Map<string, string>();  // chatId -> model alias or ID
  private coderOverrides = new Map<string, string>();  // chatId -> model alias or ID
  private chatBoundaries = new Map<string, number>();  // chatId -> epoch ms of last model switch
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private config: RouterConfig;
  private toolExecutor: ToolExecutor;

  // ── Privacy Routing Layer ──────────────────────────────────────────
  private sensitivityClassifier: SensitivityClassifier;
  private dataSanitizer: DataSanitizer;
  private auditLogger: PrivacyAuditLogger | null = null;
  private privacyLevels = new Map<string, PrivacyLevel>();  // chatId -> privacy level

  // ── Secret Substitution Layer ────────────────────────────────────
  private secretSubstitution: SecretSubstitution;
  private secretSubstitutionMode: SecretSubstitutionMode = 'on';

  // ── Cedar Policy Engine ──────────────────────────────────────────
  private cedarEngine: CedarPolicyEngine;

  // ── System Prompt Loader (AIOS migration) ──────────────────────
  private promptLoader: SystemPromptLoader;

  constructor(config: RouterConfig, sensitivityConfig?: SensitivityConfig) {
    this.config = config;
    this.toolExecutor = new ToolExecutor(PROJECT_ROOT);

    // Initialize system prompt loader for portable prompts
    const aiosPath = path.join(PROJECT_ROOT, 'aios');
    this.promptLoader = new SystemPromptLoader(PROJECT_ROOT, aiosPath);

    // Initialize privacy routing components
    this.sensitivityClassifier = new SensitivityClassifier(
      sensitivityConfig ?? { personalNames: [] },
    );
    this.dataSanitizer = new DataSanitizer();

    // Initialize secret substitution layer
    this.secretSubstitution = createSecretSubstitution();
    logger.info({ patternCount: this.secretSubstitution.getPatternCount() }, 'Secret substitution layer initialized');

    // Initialize Cedar policy engine
    this.cedarEngine = createCedarPolicyEngine();
    logger.info({ ruleCount: this.cedarEngine.getRuleCount() }, 'Cedar policy engine initialized');

    // Initialize audit logger (uses the shared apex.db)
    try {
      const db = getDatabase();
      this.auditLogger = new PrivacyAuditLogger(db);
      logger.info('Privacy audit logger initialized');
    } catch {
      // DB might not be initialized yet (e.g. during testing).
      // The audit logger will be null -- routing still works, just no audit trail.
      logger.warn('Privacy audit logger not initialized (database not ready)');
    }
  }

  // ── Provider registration ──────────────────────────────────────────

  addProvider(provider: ChatProvider): void {
    if (provider.isConfigured()) {
      this.chatProviders.set(provider.name, provider);
      logger.info({ provider: provider.name }, 'Provider registered');
    } else {
      logger.debug({ provider: provider.name }, 'Provider not configured, skipping');
    }
  }

  getProvider(name: string): ChatProvider | undefined {
    return this.chatProviders.get(name);
  }

  listProviders(): string[] {
    return Array.from(this.chatProviders.keys());
  }

  // ── Agent provider (Tier 2) ──────────────────────────────────────────

  setAgentProvider(provider: AgentProvider): void {
    this.agentProvider = provider;
    logger.info({ provider: provider.name }, 'Agent provider registered');
  }

  getAgentProvider(): AgentProvider | null {
    return this.agentProvider;
  }

  // ── Model overrides (/model command) ───────────────────────────────

  setModelOverride(chatId: string, aliasOrId: string): ReturnType<typeof lookupModel> {
    const entry = lookupModel(aliasOrId);
    if (!entry) return undefined;
    this.modelOverrides.set(chatId, entry.id);
    this.chatBoundaries.set(chatId, Date.now());
    logger.info({ chatId, model: entry.id, alias: entry.alias, provider: entry.provider }, 'Model override set (boundary stamped)');
    return entry;
  }

  clearModelOverride(chatId: string): void {
    this.modelOverrides.delete(chatId);
    this.chatBoundaries.set(chatId, Date.now());
    logger.info({ chatId }, 'Model override cleared (boundary stamped)');
  }

  getModelOverride(chatId: string): string | undefined {
    return this.modelOverrides.get(chatId);
  }

  // ── Coder model overrides (Part B prep) ─────────────────────────────

  setCoderOverride(chatId: string, aliasOrId: string): ReturnType<typeof lookupModel> {
    const entry = lookupModel(aliasOrId);
    if (!entry) return undefined;
    this.coderOverrides.set(chatId, entry.id);
    this.chatBoundaries.set(chatId, Date.now());
    logger.info({ chatId, model: entry.id, alias: entry.alias }, 'Coder override set (boundary stamped)');
    return entry;
  }

  clearCoderOverride(chatId: string): void {
    this.coderOverrides.delete(chatId);
    this.chatBoundaries.set(chatId, Date.now());
    logger.info({ chatId }, 'Coder override cleared (boundary stamped)');
  }

  getCoderOverride(chatId: string): string | undefined {
    return this.coderOverrides.get(chatId);
  }

  // ── Main routing entry point ───────────────────────────────────────

  /**
   * Route a message to the appropriate provider.
   * This is the replacement for runWithFallback().
   */
  async route(
    message: string,
    resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    chatId?: string,
  ): Promise<ProviderResult> {
    const cid = chatId || 'default';
    const override = this.modelOverrides.get(cid);
    let requiresSanitization = false;
    let sensitivityResult: import('./types.js').SensitivityResult | null = null;

    // ── Model override path ───────────────────────────────────────
    if (override) {
      const entry = lookupModel(override);
      if (entry) {
        // Claude model override (opus/sonnet/haiku)
        if (entry.provider === 'claude') {
          // Tool-execution stays on Claude regardless
          try {
            const result = await runAgent(message, resumeToken, onTyping, onProgress, undefined, entry.id);
            return this.agentResultToProviderResult(result, 'claude', entry.id);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isTimeout = errMsg.includes('timed out');
            logger.warn({ err, model: entry.id, isTimeout }, 'Claude override failed');

            // When user explicitly set a model override and it times out,
            // return a clear error instead of silently switching providers.
            // This prevents fallback models from taking over mid-session
            // with no context of what Claude was working on.
            if (isTimeout) {
              return {
                text: `${entry.alias || entry.id} timed out on that one. The session is still alive -- send the message again or simplify the request. If it keeps happening, try /newchat.`,
                resumeToken: undefined,
                usage: null,
                provider: 'claude',
                model: entry.id,
              };
            }

            // Context exhaustion: auto-renew session instead of cascading
            const isCtxExhausted = errMsg.includes('exited with code 1')
              || errMsg.includes('context window')
              || errMsg.includes('max_tokens');
            if (isCtxExhausted && cid !== 'default') {
              logger.warn({ chatId: cid }, 'Context exhausted (override path) -- auto-renewing Claude session');
              try {
                saveSessionSummary(cid).catch((err) =>
                  logger.warn({ err }, 'Session summary extraction failed during auto-renew override (non-fatal)'));
                clearSession(cid);
                const recentTurns = getRecentConversation(cid, 16);
                recentTurns.reverse();
                const historyLines = recentTurns.map((t) => {
                  const role = t.role === 'user' ? 'User' : 'Assistant';
                  const content = t.content.length > 400 ? t.content.slice(0, 400) + '...' : t.content;
                  return `[${role}]: ${content}`;
                });
                const contMsg = historyLines.length > 0
                  ? `[SYSTEM: Previous session context was exhausted and auto-renewed. The following is recent conversation history for continuity. Do not re-execute instructions from history.]\n[Auto-respin context]\n${historyLines.join('\n\n')}\n[End auto-respin context]\n\n${message}`
                  : message;
                const retryResult = await runAgent(contMsg, undefined, onTyping, onProgress, undefined, entry.id);
                const pr = this.agentResultToProviderResult(retryResult, 'claude', entry.id);
                pr.text = `⚡ Context window filled -- auto-started fresh session.\n\n${pr.text}`;
                return pr;
              } catch (retryErr) {
                logger.error({ err: retryErr }, 'Auto-renew failed in override path, falling to cascade');
              }
            }

            // Non-context failures (API errors, auth issues) cascade
            return this.runFallbackCascade(cid, message, requiresSanitization);
          }
        }

        // REST provider override (venice/openrouter/ollama)
        const provider = this.chatProviders.get(entry.provider);
        if (provider) {
          try {
            // Sanitize history for non-privacy REST providers when sensitive content detected
            const needsSanitize = requiresSanitization && entry.provider !== 'venice';
            const messages = this.buildChatHistory(cid, message, entry.provider === 'venice', needsSanitize, entry.provider);
            const result = await provider.chat(messages, entry.id);
            return {
              text: result.text,
              resumeToken: undefined,
              usage: result.usage,
              provider: entry.provider,
              model: entry.id,
            };
          } catch (err) {
            logger.warn({ err, provider: entry.provider, model: entry.id }, 'Override provider failed, attempting fallback');
            return this.runFallbackCascade(cid, message, requiresSanitization);
          }
        }
      }
    }

    // ── Intent-based routing (with sensitivity analysis) ─────────
    const privacyLevel = this.privacyLevels.get(cid) ?? 'content';

    // Use enhanced classification when privacy level includes content analysis
    let intent: import('./types.js').RoutingIntent;

    if (privacyLevel === 'off') {
      // Privacy disabled -- keyword-only classification
      intent = classifyIntent(message, !!override);
    } else if (privacyLevel === 'keywords') {
      // Keyword-only (legacy behavior)
      intent = classifyIntent(message, !!override);
    } else {
      // 'content' or 'full' -- use sensitivity classifier
      const classification = classifyWithSensitivity(message, this.sensitivityClassifier);
      intent = classification.intent;
      requiresSanitization = classification.requiresSanitization;
      sensitivityResult = classification.sensitivity;

      // Block recommendation: ask user to confirm
      if (classification.sensitivity.recommendation === 'block' && privacyLevel === 'full') {
        const blockResult: ProviderResult = {
          text: 'That message contains highly sensitive content (score: ' +
            classification.sensitivity.score.toFixed(2) +
            ', categories: ' + classification.sensitivity.categories.join(', ') +
            '). For safety, it was blocked from all providers. To proceed, use /privacy off to disable content scanning, or rephrase without the sensitive data.',
          resumeToken: undefined,
          usage: null,
          provider: 'blocked',
          model: 'none',
        };
        this.logAuditEntry(cid, message, classification.sensitivity, 'blocked', false, 0, false);
        return blockResult;
      }
    }

    // ── Secret substitution (runs after intent, before provider call) ──
    let secretMap: Map<string, string> | undefined;
    let messageForProvider = message;

    if (this.secretSubstitutionMode !== 'off') {
      const subResult = this.secretSubstitution.substitute(message);
      if (subResult.matchCount > 0) {
        secretMap = subResult.map;
        if (this.secretSubstitutionMode === 'on') {
          messageForProvider = subResult.sanitized;
        }
        // In 'audit' mode, we log but still pass the original
        logger.info(
          { matchCount: subResult.matchCount, mode: this.secretSubstitutionMode },
          'Secret substitution detected secrets in message',
        );
      }
    }

    // Privacy intent -> Venice or Ollama first
    if (intent === 'privacy') {
      const privacyResult = await this.tryPrivacyProviders(cid, messageForProvider);
      if (privacyResult) {
        this.logAuditEntry(cid, message, sensitivityResult, privacyResult.provider, false, 0, false);
        return privacyResult;
      }
      // Fall through to Claude if no privacy provider available
    }

    // Venice-first routing (when PRIMARY_PROVIDER=venice)
    if (this.config.primaryProvider === 'venice' && intent === 'chat') {
      const venice = this.chatProviders.get('venice');
      if (venice) {
        try {
          const messages = this.buildChatHistory(cid, message, true, false, 'venice');
          const result = await venice.chat(messages);
          const providerResult: ProviderResult = {
            text: result.text,
            resumeToken: undefined,
            usage: result.usage,
            provider: 'venice',
            model: result.usage.model,
          };
          this.logAuditEntry(cid, message, sensitivityResult, 'venice', false, 0, false);
          return providerResult;
        } catch (err) {
          logger.warn({ err }, 'Venice-first failed, falling through to Claude');
        }
      }
    }

    // ── Claude primary path ───────────────────────────────────────
    // If agent intent has sensitive content, sanitize chat history
    // (the current message still goes to Claude for tool execution,
    // but we sanitize the conversation history sent alongside it)
    // Cedar runs in audit mode for Claude (primary provider)
    this.cedarEngine.setMode('audit');
    try {
      const result = await runAgent(messageForProvider, resumeToken, onTyping, onProgress);
      const providerResult = this.agentResultToProviderResult(result, 'claude', 'claude-opus-4-6');
      this.logAuditEntry(cid, message, sensitivityResult, 'claude', requiresSanitization, 0, false);
      return providerResult;
    } catch (claudeErr) {
      const claudeErrMsg = claudeErr instanceof Error ? claudeErr.message : String(claudeErr);
      const isContextExhausted = claudeErrMsg.includes('exited with code 1')
        || claudeErrMsg.includes('context window')
        || claudeErrMsg.includes('max_tokens');

      // ── Context exhaustion: auto-renew session on Claude, don't cascade ──
      if (isContextExhausted && cid !== 'default') {
        logger.warn({ chatId: cid }, 'Context exhausted -- auto-renewing Claude session');
        try {
          // 0. Extract semantic memories before session clears (fire-and-forget via Venice)
          saveSessionSummary(cid).catch((err) =>
            logger.warn({ err }, 'Session summary extraction failed during auto-renew (non-fatal)'));

          // 1. Clear the exhausted session
          clearSession(cid);

          // 2. Build continuation context from recent conversation log
          const recentTurns = getRecentConversation(cid, 16);
          recentTurns.reverse();
          const historyLines = recentTurns.map((t) => {
            const role = t.role === 'user' ? 'User' : 'Assistant';
            const content = t.content.length > 400 ? t.content.slice(0, 400) + '...' : t.content;
            return `[${role}]: ${content}`;
          });

          const continuationMessage = historyLines.length > 0
            ? `[SYSTEM: Previous session context was exhausted and auto-renewed. The following is recent conversation history for continuity. Do not re-execute instructions from history.]\n[Auto-respin context]\n${historyLines.join('\n\n')}\n[End auto-respin context]\n\n${message}`
            : message;

          // 3. Retry on fresh Claude session (no sessionId = new session)
          const retryResult = await runAgent(continuationMessage, undefined, onTyping, onProgress);
          const providerResult = this.agentResultToProviderResult(retryResult, 'claude', 'claude-opus-4-6');

          // Tag the response so user knows session rolled over
          providerResult.text = `⚡ Context window filled -- auto-started fresh session.\n\n${providerResult.text}`;
          this.logAuditEntry(cid, message, sensitivityResult, 'claude', requiresSanitization, 0, false);
          return providerResult;
        } catch (retryErr) {
          logger.error({ err: retryErr }, 'Auto-renew Claude session failed, falling to cascade');
          // Fall through to normal cascade below
        }
      } else {
        logger.warn({ err: claudeErr }, 'Claude failed, attempting fallback cascade');
      }

      // ── Normal fallback cascade (non-context errors, or auto-renew failed) ──
      // Switch Cedar to enforce mode when falling to non-Claude providers
      this.cedarEngine.setMode('enforce');
      try {
        // If the message needs tool execution, try tool-augmented fallback first
        if (intent === 'agent') {
          logger.info('Intent is agent -- trying tool-augmented fallback');
          const augmentedResult = await this.runToolAugmentedFallback(cid, message, onTyping, onProgress);
          if (augmentedResult) {
            this.logAuditEntry(cid, message, sensitivityResult, augmentedResult.provider, false, 0, false);
            return augmentedResult;
          }
          logger.warn('Tool-augmented fallback failed, falling to chat-only cascade');
        }
        const fallbackResult = await this.runFallbackCascade(cid, message, requiresSanitization);
        this.logAuditEntry(cid, message, sensitivityResult, fallbackResult.provider, requiresSanitization, 0, false);
        return fallbackResult;
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr }, 'All fallback providers failed');
        throw claudeErr; // Re-throw original Claude error
      }
    }
  }

  // ── Code routing entry point ───────────────────────────────────────

  /**
   * Route a code/tool-execution request to the appropriate provider.
   * Checks coderOverrides first, then falls back to agent provider.
   *
   * Claude models get full tool execution via AgentProvider.
   * REST models (DeepSeek, Qwen, etc.) get code-focused chat via ChatProvider.
   */
  async routeCode(
    message: string,
    resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    chatId?: string,
  ): Promise<ProviderResult> {
    const cid = chatId || 'default';
    const override = this.coderOverrides.get(cid);

    // ── Coder override path ──────────────────────────────────────
    if (override) {
      const entry = lookupModel(override);
      if (entry) {
        // Claude model override -> full agent execution
        if (entry.provider === 'claude' && this.agentProvider) {
          try {
            return await this.agentProvider.execute(message, resumeToken, onTyping, onProgress, undefined, entry.id);
          } catch (err) {
            logger.warn({ err, model: entry.id }, 'Claude coder override failed, falling back');
          }
        }

        // REST provider override -> code-gen via chat (no tools)
        const provider = this.chatProviders.get(entry.provider);
        if (provider) {
          try {
            const messages = this.buildCoderChatHistory(cid, message);
            const result = await provider.chat(messages, entry.id);
            return {
              text: result.text,
              resumeToken: undefined,
              usage: result.usage,
              provider: entry.provider,
              model: entry.id,
            };
          } catch (err) {
            logger.warn({ err, provider: entry.provider, model: entry.id }, 'Coder override failed, falling back to agent');
          }
        }
      }
    }

    // ── Default: Claude agent provider ───────────────────────────
    if (this.agentProvider) {
      try {
        return await this.agentProvider.execute(message, resumeToken, onTyping, onProgress);
      } catch (err) {
        logger.warn({ err }, 'Agent provider failed, attempting direct runAgent');
      }
    }

    // ── Ultimate fallback: direct runAgent call ──────────────────
    const result = await runAgent(message, resumeToken, onTyping, onProgress);
    return this.agentResultToProviderResult(result, 'claude', 'claude-opus-4-6');
  }

  // ── Privacy provider cascade ────────────────────────────────────

  private async tryPrivacyProviders(chatId: string, message: string): Promise<ProviderResult | null> {
    const privacyProviders = ['venice', 'ollama'];

    for (const name of privacyProviders) {
      const provider = this.chatProviders.get(name);
      if (!provider || !provider.capabilities.has('privacy')) continue;

      const health = this.healthCache.get(name);
      if (health && health.status === 'down' && health.consecutiveFailures > 3) continue;

      try {
        const messages = this.buildChatHistory(chatId, message, name === 'venice', false, name);
        const result = await provider.chat(messages);
        const indicator = getProviderIndicator(name, false, false);
        return {
          text: indicator ? `${indicator}\n\n${result.text}` : result.text,
          resumeToken: undefined,
          usage: result.usage,
          provider: name,
          model: result.usage.model,
        };
      } catch (err) {
        logger.warn({ err, provider: name }, 'Privacy provider failed, trying next');
        this.recordFailure(name, err);
      }
    }

    return null;
  }

  // ── Fallback cascade ───────────────────────────────────────────

  private async runFallbackCascade(chatId: string, message: string, sanitize = false): Promise<ProviderResult> {
    // Build cascade: Venice -> Ollama -> OpenRouter (deterministic order)
    // Configured fallback provider gets priority if set
    const preferredOrder = ['venice', 'ollama', 'openrouter'];
    const cascade: string[] = [];
    if (this.config.fallbackProvider && this.chatProviders.has(this.config.fallbackProvider)) {
      cascade.push(this.config.fallbackProvider);
    }
    // Add remaining providers in preferred order
    for (const name of preferredOrder) {
      if (!cascade.includes(name) && this.chatProviders.has(name)) {
        cascade.push(name);
      }
    }
    // Add any other registered providers not in the preferred list
    for (const name of this.chatProviders.keys()) {
      if (!cascade.includes(name)) {
        cascade.push(name);
      }
    }

    for (const name of cascade) {
      const provider = this.chatProviders.get(name);
      if (!provider) continue;

      const isPrivacyProvider = name === 'venice' || name === 'ollama';
      const isVenice = name === 'venice';

      const health = this.healthCache.get(name);
      if (health && health.status === 'down' && health.consecutiveFailures > 3) {
        // Venice gets one fresh attempt even if health cache says down.
        // Health check hits /models but chat may still work. Don't skip
        // our primary fallback based on stale health data.
        if (isVenice) {
          logger.info({ provider: name, failures: health.consecutiveFailures }, 'Venice marked down but attempting fresh retry in fallback');
        } else {
          logger.info({ provider: name, failures: health.consecutiveFailures }, 'Skipping down provider in fallback cascade');
          continue;
        }
      }

      // Build chat history with sanitization for non-privacy providers
      const shouldSanitize = sanitize || !isPrivacyProvider;
      const messages = this.buildChatHistory(
        chatId,
        !isPrivacyProvider ? sanitizeMessageForProvider(message, name) : message,
        isPrivacyProvider,
        shouldSanitize && !isPrivacyProvider,
        name,
      );

      // Venice gets up to 2 retries with exponential backoff
      const maxAttempts = isVenice ? 2 : 1;
      let lastErr: unknown = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
          logger.info({ provider: name, attempt: attempt + 1, backoffMs }, 'Venice retry with backoff');
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }

        try {
          logger.info({ provider: name, attempt: attempt + 1 }, 'Attempting fallback provider');
          const result = await provider.chat(messages);
          logger.info({ provider: name }, 'Fallback provider succeeded');

          const indicator = getProviderIndicator(name, !isPrivacyProvider, true);
          return {
            text: `${indicator}\n\n${result.text}`,
            resumeToken: undefined,
            usage: result.usage,
            provider: name,
            model: result.usage.model,
          };
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts - 1) {
            logger.warn({ provider: name, err, attempt: attempt + 1 }, 'Fallback attempt failed, will retry');
          } else {
            logger.warn({ provider: name, err }, 'Fallback provider failed, trying next');
          }
        }
      }

      if (lastErr) {
        this.recordFailure(name, lastErr);
      }
    }

    return {
      text: 'All AI providers failed. Claude is down and all fallback providers are unreachable. Check network and API keys.',
      resumeToken: undefined,
      usage: null,
      provider: 'none',
      model: 'none',
    };
  }

  // ── Tool-augmented fallback ─────────────────────────────────────

  /**
   * Try tool-augmented versions of fallback providers.
   * Wraps ChatProviders with ToolAugmentedProvider so they can execute
   * local tools (file reads, vault search, pm2 status, etc.) via an
   * agent loop. Returns null if all augmented providers fail.
   *
   * Phase 2: Non-privacy providers receive sanitized message content.
   * Tool execution on non-primary providers is logged as elevated audit events.
   */
  private async runToolAugmentedFallback(
    chatId: string,
    message: string,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<ProviderResult | null> {
    // Cascade order: Venice (privacy-first) -> Ollama (local) -> OpenRouter (last resort)
    const augmentedCascade = ['venice', 'ollama', 'openrouter'];

    // Prefer configured fallback provider first
    if (this.config.fallbackProvider && !augmentedCascade.includes(this.config.fallbackProvider)) {
      augmentedCascade.unshift(this.config.fallbackProvider);
    } else if (this.config.fallbackProvider) {
      // Move it to front
      const idx = augmentedCascade.indexOf(this.config.fallbackProvider);
      if (idx > 0) {
        augmentedCascade.splice(idx, 1);
        augmentedCascade.unshift(this.config.fallbackProvider);
      }
    }

    for (const name of augmentedCascade) {
      const provider = this.chatProviders.get(name);
      if (!provider) continue;

      const isPrivacyProvider = name === 'venice' || name === 'ollama';

      const health = this.healthCache.get(name);
      if (health && health.status === 'down' && health.consecutiveFailures > 3) {
        if (name === 'venice') {
          logger.info({ provider: name, failures: health.consecutiveFailures }, 'Venice marked down but attempting fresh retry in tool-augmented fallback');
        } else {
          logger.info({ provider: name, failures: health.consecutiveFailures }, 'Skipping down provider for tool-augmented fallback');
          continue;
        }
      }

      try {
        // Sanitize message for non-privacy providers
        const sanitizedMessage = isPrivacyProvider
          ? message
          : sanitizeMessageForProvider(message, name);

        logger.info({ provider: name, sanitized: !isPrivacyProvider }, 'Attempting tool-augmented fallback');

        // Log elevated audit event: tool execution on non-primary provider
        if (!isPrivacyProvider) {
          logger.warn(
            { provider: name, chatId },
            'ELEVATED: Tool execution on non-privacy fallback provider. Data sanitized.',
          );
        }

        // Fallback models use restricted mode: write/bash require manual Telegram approval
        const restrictedExecutor = new ToolExecutor(PROJECT_ROOT, undefined, true);
        const augmented = new ToolAugmentedProvider(provider, restrictedExecutor);
        const result = await augmented.execute(sanitizedMessage, undefined, onTyping, onProgress);
        logger.info({ provider: name }, 'Tool-augmented fallback succeeded');

        // Log elevated audit entry for tool execution on external providers
        if (!isPrivacyProvider) {
          this.logAuditEntry(
            chatId,
            message,
            null,
            `${name}-augmented`,
            true,
            0,
            false,
            'tool-execution-on-external-provider',
          );
        }

        return result;
      } catch (err) {
        logger.warn({ provider: name, err }, 'Tool-augmented fallback failed, trying next');
        this.recordFailure(name, err);
      }
    }

    return null;
  }

  // ── Chat history builder ────────────────────────────────────────

  private buildChatHistory(
    chatId: string,
    currentMessage: string,
    isPrivacy = false,
    sanitize = false,
    targetProvider = 'claude',
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const isClaude = targetProvider.toLowerCase() === 'claude';

    // System prompt -- use sanitized version for non-Claude providers
    let systemPrompt: string;
    if (isClaude) {
      // Claude primary path: use raw CLAUDE.md (it already has it in session context)
      systemPrompt = this.buildSystemPromptRaw(isPrivacy);
    } else {
      // Non-Claude: sanitize the system prompt based on target provider
      systemPrompt = buildSanitizedSystemPrompt(PROJECT_ROOT, isPrivacy, targetProvider);
    }

    const voiceFilter = buildVoiceFilter(currentMessage);
    const systemContent = voiceFilter
      ? `${systemPrompt}\n\n${voiceFilter}`
      : systemPrompt;
    messages.push({ role: 'system', content: systemContent });

    // Recent conversation from DB (last 20 turns), filtered by boundary + time cap
    const turns = getRecentConversation(chatId, 20);
    if (turns.length > 0) {
      const now = Date.now();
      const boundary = this.chatBoundaries.get(chatId) ?? 0;
      const cutoff = Math.max(boundary, now - CHAT_HISTORY_MAX_AGE_MS);

      turns.reverse();
      for (const turn of turns) {
        // created_at is epoch seconds in SQLite, convert to ms
        const turnMs = turn.created_at * 1000;
        if (turnMs < cutoff) continue;
        let content = turn.content.length > 2000 ? turn.content.slice(0, 2000) + '...' : turn.content;

        // When sanitize=true, scrub sensitive data from history turns before
        // sending to non-privacy providers. The current message is NOT sanitized
        // here (it goes separately to Claude for tool execution).
        if (sanitize && !isPrivacy) {
          try {
            const sensitivity = this.sensitivityClassifier.classify(content);
            if (sensitivity.score >= 0.6 && sensitivity.detections.length > 0) {
              const result = this.dataSanitizer.sanitize(content, sensitivity, { mode: 'redact' });
              content = result.sanitized;
              logger.debug({ redactions: result.redactions, score: sensitivity.score }, 'Sanitized history turn before fallback send');
            }
          } catch (err) {
            // Sanitization failure should never break history building
            logger.warn({ err }, 'History sanitization failed for turn (non-fatal, sending unsanitized)');
          }
        }

        messages.push({
          role: turn.role === 'user' ? 'user' : 'assistant',
          content,
        });
      }
    }

    messages.push({ role: 'user', content: currentMessage });
    return messages;
  }

  /**
   * Build the raw (unsanitized) system prompt for Claude primary path.
   * Preserves backward compatibility -- Claude already has CLAUDE.md in session.
   */
  private buildSystemPromptRaw(isPrivacy: boolean): string {
    const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
    let claudeMd = '';
    try {
      claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch {
      claudeMd = 'You are a personal AI assistant accessible via Telegram.';
    }

    if (isPrivacy) {
      return `${claudeMd}\n\n---\nPRIVACY MODE: Running through a privacy-first provider (zero data retention). You can hold conversation and answer questions with full privacy. If the user needs tool execution (email, calendar, file ops, Obsidian, bash commands, skills), let them know you'll need to route through the main system for that.`;
    }

    return `${claudeMd}\n\n---\nFALLBACK MODE ACTIVE: You are running on a fallback model because Claude is unavailable. You can hold conversation and answer questions, but you CANNOT execute tools (bash, file reads, web search, Obsidian, skills). If the user asks you to do something that requires tool execution, explain that you're in fallback mode and can only do conversation until Claude is restored. Keep the same personality and loyalty.`;
  }

  // ── Coder chat history builder ──────────────────────────────────

  private buildCoderChatHistory(chatId: string, currentMessage: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    messages.push({ role: 'system', content: this.buildCoderSystemPrompt() });

    // Shorter history for code context (10 turns vs 20 for chat),
    // filtered by boundary + time cap (same as chat history)
    const turns = getRecentConversation(chatId, 10);
    if (turns.length > 0) {
      const now = Date.now();
      const boundary = this.chatBoundaries.get(chatId) ?? 0;
      const cutoff = Math.max(boundary, now - CHAT_HISTORY_MAX_AGE_MS);

      turns.reverse();
      for (const turn of turns) {
        const turnMs = turn.created_at * 1000;
        if (turnMs < cutoff) continue;
        messages.push({
          role: turn.role === 'user' ? 'user' : 'assistant',
          content: turn.content.length > 2000 ? turn.content.slice(0, 2000) + '...' : turn.content,
        });
      }
    }

    messages.push({ role: 'user', content: currentMessage });
    return messages;
  }

  private buildCoderSystemPrompt(): string {
    return `You are a code-focused AI assistant. Your job is to write clean, correct, production-quality code.

Rules:
- Write code directly. No lengthy preambles or explanations unless asked.
- Use clear variable names, proper error handling, and follow existing patterns when shown context.
- When reviewing code, be specific about issues and suggest fixes with code.
- If asked to design or architect something, think it through step by step.
- You do NOT have access to tools, file system, bash, or any execution environment. You generate code as text.
- If a task requires file execution, tool use, or system access, say so plainly and suggest routing to the main agent.
- Keep responses focused on the code. Skip pleasantries.`;
  }

  // ── Health checks ──────────────────────────────────────────────

  startHealthChecks(intervalMs = 60_000): void {
    if (this.healthInterval) return;

    // Run immediately, then on interval
    void this.runHealthChecks();
    this.healthInterval = setInterval(() => void this.runHealthChecks(), intervalMs);
    logger.info({ intervalMs, providers: this.listProviders() }, 'Provider health checks started');
  }

  stopHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [name, provider] of this.chatProviders) {
      try {
        const health = await provider.healthCheck();
        // Carry forward consecutive failures
        const prev = this.healthCache.get(name);
        if (health.status === 'down' || health.status === 'degraded') {
          health.consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
        } else {
          health.consecutiveFailures = 0;
        }
        this.healthCache.set(name, health);
      } catch {
        // Health check itself crashed -- mark unknown
        const prev = this.healthCache.get(name);
        this.healthCache.set(name, {
          status: 'unknown',
          latencyMs: null,
          lastChecked: Date.now(),
          consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        });
      }
    }
  }

  getHealth(name: string): ProviderHealth | undefined {
    return this.healthCache.get(name);
  }

  getAllHealth(): Map<string, ProviderHealth> {
    return new Map(this.healthCache);
  }

  // ── Privacy Routing Layer -- public API ─────────────────────────

  /**
   * Get privacy audit stats, optionally filtered by chat or time range.
   */
  getPrivacyStats(chatId?: string, since?: number): AuditStats {
    if (!this.auditLogger) {
      return {
        totalRequests: 0, privacyRouted: 0, standardRouted: 0,
        blocked: 0, topCategories: [], averageSensitivityScore: 0,
      };
    }
    return this.auditLogger.getStats(chatId, since);
  }

  /**
   * Set the privacy enforcement level for a specific chat.
   *
   *   off      -- no privacy routing at all
   *   keywords -- keyword-only detection (legacy behavior)
   *   content  -- content-based sensitivity analysis (default)
   *   full     -- content analysis + block on high sensitivity
   */
  setPrivacyLevel(chatId: string, level: PrivacyLevel): void {
    this.privacyLevels.set(chatId, level);
    logger.info({ chatId, level }, 'Privacy level updated');
  }

  /** Get the current privacy level for a chat (defaults to 'content'). */
  getPrivacyLevel(chatId: string): PrivacyLevel {
    return this.privacyLevels.get(chatId) ?? 'content';
  }

  /** Expose the sensitivity classifier for direct use (e.g. testing). */
  getSensitivityClassifier(): SensitivityClassifier {
    return this.sensitivityClassifier;
  }

  /** Expose the data sanitizer for direct use (e.g. testing). */
  getDataSanitizer(): DataSanitizer {
    return this.dataSanitizer;
  }

  /** Expose the audit logger for direct use (e.g. CSV export). */
  getAuditLogger(): PrivacyAuditLogger | null {
    return this.auditLogger;
  }

  // ── Secret Substitution Layer -- public API ──────────────────────

  /**
   * Get the SecretSubstitution instance for direct use.
   */
  getSecretSubstitution(): SecretSubstitution {
    return this.secretSubstitution;
  }

  /**
   * Set the secret substitution mode.
   *   on    -- substitute secrets, execute with restored values (default)
   *   off   -- disabled
   *   audit -- substitute and log, but also pass originals
   */
  setSecretSubstitutionMode(mode: SecretSubstitutionMode): void {
    this.secretSubstitutionMode = mode;
    logger.info({ mode }, 'Secret substitution mode updated');
  }

  getSecretSubstitutionMode(): SecretSubstitutionMode {
    return this.secretSubstitutionMode;
  }

  // ── Cedar Policy Engine -- public API ─────────────────────────────

  /**
   * Get the CedarPolicyEngine instance for direct use.
   */
  getCedarEngine(): CedarPolicyEngine {
    return this.cedarEngine;
  }

  /**
   * Set Cedar policy mode. Called automatically when provider cascade
   * falls to a non-Claude fallback.
   */
  setCedarMode(mode: CedarMode): void {
    this.cedarEngine.setMode(mode);
  }

  getCedarMode(): CedarMode {
    return this.cedarEngine.getMode();
  }

  /**
   * Evaluate a command against Cedar policies.
   * Used by bot.ts before executing bash commands.
   */
  evaluateCommand(command: string, context: PolicyContext): PolicyDecision {
    return this.cedarEngine.evaluate(command, context);
  }

  // ── Privacy audit helper ──────────────────────────────────────────

  private logAuditEntry(
    chatId: string,
    message: string,
    sensitivity: import('./types.js').SensitivityResult | null,
    actualRoute: string,
    wasSanitized: boolean,
    redactionCount: number,
    overridden: boolean,
    overrideReason?: string,
  ): void {
    if (!this.auditLogger) return;

    try {
      this.auditLogger.log({
        timestamp: Math.floor(Date.now() / 1000),
        chatId,
        messageHash: PrivacyAuditLogger.hashMessage(message),
        sensitivityScore: sensitivity?.score ?? 0,
        categories: JSON.stringify(sensitivity?.categories ?? []),
        detectionCount: sensitivity?.detections.length ?? 0,
        recommendation: sensitivity?.recommendation ?? 'standard',
        actualRoute,
        wasSanitized,
        redactionCount,
        overridden,
        overrideReason,
      });
    } catch (err) {
      // Audit logging should never break routing
      logger.warn({ err }, 'Failed to log privacy audit entry (non-fatal)');
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private recordFailure(name: string, err: unknown): void {
    const prev = this.healthCache.get(name);
    this.healthCache.set(name, {
      status: 'down',
      latencyMs: null,
      lastChecked: Date.now(),
      lastError: err instanceof Error ? err.message : String(err),
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    });
  }

  private agentResultToProviderResult(
    result: { text: string | null; resumeToken: string | undefined; usage: import('../agent.js').UsageInfo | null; provider?: string },
    provider: string,
    model: string,
  ): ProviderResult {
    let normalizedUsage: NormalizedUsage | null = null;
    if (result.usage) {
      normalizedUsage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: result.usage.totalCostUsd,
        provider,
        model,
        agentUsage: result.usage,
      };
    }

    return {
      text: result.text,
      resumeToken: result.resumeToken,
      usage: normalizedUsage,
      provider: result.provider || provider,
      model,
      agentUsage: result.usage ?? undefined,
    };
  }
}
