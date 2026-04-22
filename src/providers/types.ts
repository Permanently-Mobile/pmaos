/**
 * Provider Abstraction Layer -- Core Types
 *
 * Two-tier provider system:
 *   Tier 1: ChatProvider -- REST-based chat completions (Venice, OpenRouter, Ollama, etc.)
 *   Tier 2: AgentProvider -- Tool-executing agents (Claude SDK, future Aider/OpenHands)
 *
 * Both tiers use the same plug-in template pattern.
 * New provider = 1 file implementing the interface + 1 registry entry + 1 factory line.
 */

import type { UsageInfo, AgentProgressEvent } from '../agent.js';

// ── Capability flags ─────────────────────────────────────────────────

export type ProviderCapability =
  | 'chat'           // basic chat completions
  | 'tools'          // tool execution (Claude Agent SDK)
  | 'session'        // session resume across turns
  | 'privacy'        // zero data retention
  | 'local'          // runs on local hardware
  | 'image-gen'      // image generation
  | 'embeddings'     // text embeddings
  | 'tts'            // text-to-speech
  | 'stt'            // speech-to-text
  | 'video-gen'      // video generation
  | 'code-gen'       // code generation (non-tool-executing)
  | 'sanitization';  // supports pre-send data sanitization

// ── Normalized usage info ────────────────────────────────────────────

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;       // null if provider doesn't report cost
  provider: string;
  model: string;
  /** Provider-specific detailed usage (e.g. Claude UsageInfo), present when available */
  agentUsage?: UsageInfo;
}

// ── Chat message format ──────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Chat completion result ───────────────────────────────────────────

export interface ChatCompletionResult {
  text: string;
  usage: NormalizedUsage;
}

// ── Provider health ──────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface ProviderHealth {
  status: HealthStatus;
  latencyMs: number | null;
  lastChecked: number;          // epoch ms
  lastError?: string;
  consecutiveFailures: number;
}

// ── Chat provider interface (Tier 1) ─────────────────────────────────

export interface ChatProvider {
  /** Unique provider name (e.g. 'venice', 'openrouter', 'ollama') */
  readonly name: string;

  /** Set of capabilities this provider supports */
  readonly capabilities: ReadonlySet<ProviderCapability>;

  /** Run a chat completion. Throws on failure. */
  chat(messages: ChatMessage[], model?: string): Promise<ChatCompletionResult>;

  /** Quick health check (lightweight, cacheable). */
  healthCheck(): Promise<ProviderHealth>;

  /** Whether this provider is configured (has API key, endpoint, etc.). */
  isConfigured(): boolean;

  /** Default model for this provider. */
  defaultModel(): string;

  /** Map of alias -> full model ID for this provider. */
  availableModels(): Record<string, string>;
}

// ── Agent provider interface (Tier 2) ────────────────────────────────

export interface AgentProvider {
  /** Unique provider name (e.g. 'claude', future 'aider', 'openhands') */
  readonly name: string;

  /** Set of capabilities this provider supports */
  readonly capabilities: ReadonlySet<ProviderCapability>;

  /** Execute a message with full tool/session support. Throws on failure. */
  execute(
    message: string,
    resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    timeoutMs?: number,
    model?: string,
    cwd?: string,
  ): Promise<ProviderResult>;

  /** Quick health check (lightweight, cacheable). */
  healthCheck(): Promise<ProviderHealth>;

  /** Whether this provider is configured and ready. */
  isConfigured(): boolean;

  /** Default model for this provider. */
  defaultModel(): string;
}

// ── Routing intent ───────────────────────────────────────────────────

export type RoutingIntent =
  | 'chat'           // conversational, no tools needed
  | 'agent'          // needs tool execution (must go to Claude)
  | 'privacy'        // privacy-sensitive (prefer Venice/Ollama)
  | 'cheap';         // cost-sensitive (prefer cheaper model)

// ── Provider result (unified across both tiers) ──────────────────────

export interface ProviderResult {
  text: string | null;
  resumeToken: string | undefined;
  usage: NormalizedUsage | null;
  provider: string;
  model: string;
  /** Provider-specific: full UsageInfo for context tracking */
  agentUsage?: UsageInfo;
}

// ── Model registry entry ─────────────────────────────────────────────

export interface ModelEntry {
  /** Full model ID (e.g. 'claude-opus-4-6', 'llama-3.3-70b') */
  id: string;
  /** Short alias for /model command (e.g. 'opus', 'llama') */
  alias: string;
  /** Provider name (e.g. 'claude', 'venice', 'ollama') */
  provider: string;
  /** Approximate cost in USD per 1k input tokens */
  costPer1kInput: number;
  /** Approximate cost in USD per 1k output tokens */
  costPer1kOutput: number;
  /** Max context window size in tokens */
  contextWindow: number;
  /** Capabilities this model supports */
  capabilities: ProviderCapability[];
}

// ── Router config ────────────────────────────────────────────────────

export interface RouterConfig {
  /** Primary provider for conversational messages (e.g. 'venice' for privacy-first) */
  primaryProvider: string;
  /** Whether Venice API key is available */
  veniceConfigured: boolean;
  /** Fallback provider preference */
  fallbackProvider: string;
  /** Ollama endpoint URL */
  ollamaUrl: string;
}

// ── Privacy Routing Layer types ────────────────────────────────────────

/** Categories of sensitive content the classifier can detect. */
export type SensitivityCategory = 'pii' | 'financial' | 'crypto' | 'medical' | 'legal' | 'personal';

/** A single sensitive content detection with location and confidence. */
export interface Detection {
  category: SensitivityCategory;
  /** Name of the pattern that matched */
  pattern: string;
  /** The actual matched text (REDACTED in logs -- only used in sanitizer) */
  match: string;
  /** Confidence of the match, 0.0 to 1.0 */
  confidence: number;
  /** Character position in the original message */
  position: { start: number; end: number };
}

/** Result of running the sensitivity classifier on a message. */
export interface SensitivityResult {
  /** Overall sensitivity score, 0.0 (safe) to 1.0 (highly sensitive) */
  score: number;
  /** Which categories triggered */
  categories: SensitivityCategory[];
  /** Specific pattern matches found */
  detections: Detection[];
  /** Routing recommendation based on score */
  recommendation: 'standard' | 'privacy' | 'block';
}

/** Options for the data sanitizer. */
export interface SanitizeOptions {
  /** Sanitization mode: full redact, partial mask, or reversible tokens */
  mode: 'redact' | 'mask' | 'tokenize';
  /** Which categories to sanitize (default: all detected) */
  categories?: SensitivityCategory[];
  /** Keep sentence structure, replace only sensitive values */
  preserveStructure?: boolean;
}

/** Result of running the sanitizer on a message. */
export interface SanitizeResult {
  /** The cleaned message */
  sanitized: string;
  /** Count of redactions applied */
  redactions: number;
  /** For tokenize mode: token -> original mapping (for de-tokenization) */
  tokenMap?: Map<string, string>;
}

/** A single privacy audit log entry. */
export interface AuditEntry {
  id?: number;
  /** Unix epoch seconds */
  timestamp: number;
  chatId: string;
  /** SHA-256 hash of the original message (NOT the message itself) */
  messageHash: string;
  sensitivityScore: number;
  /** JSON-serialized SensitivityCategory array */
  categories: string;
  detectionCount: number;
  recommendation: string;
  /** Which provider actually handled the request */
  actualRoute: string;
  wasSanitized: boolean;
  redactionCount: number;
  /** True if user/system overrode the recommendation */
  overridden: boolean;
  overrideReason?: string;
}

/** Aggregate stats from the privacy audit log. */
export interface AuditStats {
  totalRequests: number;
  privacyRouted: number;
  standardRouted: number;
  blocked: number;
  topCategories: Array<{ category: string; count: number }>;
  averageSensitivityScore: number;
}

/** Enhanced classification result that includes sensitivity data. */
export interface ClassificationResult {
  intent: RoutingIntent;
  sensitivity: SensitivityResult;
  /** True if intent is 'agent' but content is sensitive (needs history sanitization) */
  requiresSanitization: boolean;
}

/** Per-chat privacy enforcement level. */
export type PrivacyLevel = 'off' | 'keywords' | 'content' | 'full';

/** Configuration for the sensitivity classifier. */
export interface SensitivityConfig {
  /** Personal names to detect (family members, etc.) */
  personalNames: string[];
  /** Additional custom patterns per category */
  customPatterns?: Partial<Record<SensitivityCategory, RegExp[]>>;
}

// ── Phase 2: Privacy Routing Layer additions ─────────────────────────────

/** Options for system prompt sanitization. */
export interface PromptSanitizeOptions {
  /** Target provider receiving the sanitized prompt */
  targetProvider: string;
  /** Strip personal sections (Who Is the Owner, Work Sessions, etc.) */
  stripPersonalSections: boolean;
  /** Strip internal file/vault paths */
  stripPaths: boolean;
  /** Strip configured family names */
  stripFamilyNames: boolean;
  /** List of personal names to strip */
  personalNames: string[];
}

/** Privacy status report for /privacy command. */
export interface PrivacyStatusReport {
  /** Current privacy level */
  level: PrivacyLevel;
  /** Which provider is handling requests */
  primaryProvider: string;
  /** Fallback cascade order */
  fallbackOrder: string[];
  /** Whether Venice is configured and reachable */
  veniceAvailable: boolean;
  /** Recent audit statistics */
  recentStats: AuditStats;
}

// ── Secret Substitution Layer types ────────────────────────────────────

/** A single secret match found by the SecretSubstitution scanner. */
export interface SecretMatch {
  /** Category of the secret (e.g. 'aws', 'database', 'jwt') */
  category: string;
  /** Name of the pattern that matched */
  pattern: string;
  /** The actual matched text (NEVER log this) */
  match: string;
  /** Confidence of the match, 0.0 to 1.0 */
  confidence: number;
  /** Character position in the original text */
  position: { start: number; end: number };
}

/** Result of running secret substitution on text. */
export interface SecretSubstitutionResult {
  /** The text with secrets replaced by {{SECRET_NNN}} placeholders */
  sanitized: string;
  /** Placeholder -> real value mapping (IN MEMORY ONLY, never persist) */
  map: Map<string, string>;
  /** Number of secrets that were substituted */
  matchCount: number;
}

/** Secret substitution operating mode. */
export type SecretSubstitutionMode = 'on' | 'off' | 'audit';

// ── Cedar Policy Engine types ──────────────────────────────────────────

/** Cedar policy engine operating mode. */
export type CedarMode = 'audit' | 'enforce';

/** Policy action types from the YAML config. */
export type PolicyAction = 'permit' | 'forbid' | 'forbid_on_fallback' | 'require_approval_on_fallback';

/** Resolved policy decision action (after mode evaluation). */
export type PolicyDecisionAction = 'permit' | 'forbid' | 'require_approval';

/** Context for policy evaluation. */
export interface PolicyContext {
  /** Which LLM generated this command */
  provider: string;
  /** Intent classification from the intent classifier */
  intent: string;
  /** Sensitivity score from the sensitivity classifier */
  sensitivityScore: number;
  /** True when the command came from a non-Claude fallback provider */
  isFromFallback: boolean;
}

/** Result of evaluating a command against policies. */
export interface PolicyDecision {
  /** The resolved action: permit, forbid, or require_approval */
  action: PolicyDecisionAction;
  /** Name of the policy rule that matched */
  rule: string;
  /** Human-readable explanation */
  reason: string;
  /** Current engine mode when the decision was made */
  mode: CedarMode;
}

/** A compiled policy rule (loaded from YAML). */
export interface PolicyRule {
  /** Rule name from the YAML key */
  name: string;
  /** Compiled regex patterns */
  patterns: RegExp[];
  /** Raw action from the YAML config */
  action: PolicyAction;
  /** Human-readable reason */
  reason: string;
}

/** Structure of the cedar-policies.yaml file. */
export interface CedarPoliciesConfig {
  policies: Record<string, {
    patterns: string[];
    action: string;
    reason: string;
  }>;
}

/** A command detected in LLM output by the CommandValidator. */
export interface DetectedCommand {
  /** The extracted command string */
  command: string;
  /** Where it was found: fenced-block, inline, inline-code */
  source: 'fenced-block' | 'inline' | 'inline-code';
  /** The raw line/match as found in the text */
  raw: string;
}

/** A Cedar policy audit log entry. */
export interface CedarAuditEntry {
  /** Unix epoch seconds */
  timestamp: number;
  /** The command that was evaluated */
  command: string;
  /** The policy decision */
  decision: PolicyDecisionAction;
  /** Which rule matched */
  rule: string;
  /** Reason for the decision */
  reason: string;
  /** Current engine mode */
  mode: CedarMode;
  /** Which provider generated the command */
  provider: string;
  /** Whether the command was blocked */
  wasBlocked: boolean;
}
