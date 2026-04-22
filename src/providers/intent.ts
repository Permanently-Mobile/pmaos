/**
 * Intent Classification -- Determines routing intent for incoming messages.
 *
 * Extracted from fallback-model.ts needsToolExecution().
 * Same patterns, same behavior, now callable by the ProviderRouter.
 *
 * Enhanced with SensitivityClassifier integration for content-based
 * privacy routing (Phase 1 of Privacy Routing Layer).
 */

import type { RoutingIntent, ClassificationResult } from './types.js';
import type { SensitivityClassifier } from './sensitivity.js';

/**
 * Quick heuristic: does this message likely need tool execution?
 * If so, it must go to Claude (REST providers can't run tools).
 * Intentionally lightweight -- not a classifier, just pattern matching.
 */
export function needsToolExecution(message: string): boolean {
  const lower = message.toLowerCase();

  const toolPatterns = [
    // Obsidian / vault operations
    /\b(add|create|update|edit|mark|check off|save)\s+(a\s+)?(task|note|project|daily)/,
    /\btasks?\b.*\b(done|complete|finished)\b/,
    /\bvault\b/,
    /\bobsidian\b/,
    // Email / calendar
    /\b(send|read|check|reply|forward)\s+(an?\s+)?(email|mail|inbox)/,
    /\b(schedule|calendar|meeting|availability|appointment)/,
    // File operations
    /\b(read|write|create|delete|move|copy)\s+(a\s+)?(file|folder|directory)/,
    /\b(download|upload|save)\s+(to|from)/,
    // Web / browser
    /\b(browse|scrape|fetch|open|visit)\s+(a\s+)?(url|website|page|link)/,
    // System commands
    /\b(run|execute|install|build|deploy|restart|start|stop)\b/,
    /\b(git|npm|docker|pm2|pip)\b/,
    // Agent dispatch
    /\b(researcher|coder|processor|council)\b/,
    // Slash commands (skills)
    /^\//,
    // Bridge commands
    /\bbridge\b/,
    // Search / research with action
    /\b(search|look up|find|grep|glob)\b.*\b(file|code|folder)/,
    // WhatsApp / Slack
    /\b(whatsapp|wa|slack)\b/,
    // Image generation
    /\b(generate|create|make)\s+(an?\s+)?(image|picture|photo|art)/,
    // Voice
    /\bvoice\b.*\b(note|reply|respond)/,
    // Special commands
    /\b(convolife|checkpoint|systems?\s*check)\b/,
    // Memory operations
    /\b(remember|forget)\b/,
    // Dashboard
    /\bdashboard\b/,
  ];

  return toolPatterns.some(pattern => pattern.test(lower));
}

/**
 * Privacy keywords that signal the message should route to a
 * zero-retention provider (Venice, Ollama).
 * Kept as a fast path -- no classifier needed for explicit keywords.
 */
export function isPrivacySensitive(message: string): boolean {
  const lower = message.toLowerCase();
  const privacyPatterns = [
    /\bprivate\b/,
    /\bkeep.*(private|secret|confidential)\b/,
    /\buse\s+venice\b/,
    /\bdon'?t\s+send.*claude\b/,
    /\blocal\s+only\b/,
    /\boffline\b/,
    /\bzero\s+retention\b/,
  ];
  return privacyPatterns.some(pattern => pattern.test(lower));
}

/**
 * Classify the routing intent of a message.
 * Used by the ProviderRouter to decide which provider handles it.
 *
 * Backward-compatible -- does NOT use the sensitivity classifier.
 * For enhanced classification with content analysis, use classifyWithSensitivity().
 */
export function classifyIntent(message: string, hasModelOverride: boolean): RoutingIntent {
  // If user has explicitly set a model override, honor it.
  // The router will resolve the override to the correct provider.
  // We still check tool execution because even with an override,
  // tool-requiring messages must go to Claude.
  if (needsToolExecution(message)) {
    return 'agent';
  }

  if (isPrivacySensitive(message)) {
    return 'privacy';
  }

  // Default: conversational chat
  return 'chat';
}

/**
 * Enhanced intent classification with content-based sensitivity analysis.
 *
 * Flow:
 *   1. Check tool execution need -> agent (but still run sensitivity)
 *   2. Check explicit privacy keywords -> privacy (fast path)
 *   3. Run SensitivityClassifier on content
 *      - If recommendation = privacy or block -> privacy intent
 *      - If recommendation = standard -> chat intent
 *   4. For agent intent with high sensitivity -> flag requiresSanitization
 *
 * @param message - The user's message text
 * @param classifier - An initialized SensitivityClassifier instance
 * @returns ClassificationResult with intent, sensitivity data, and sanitization flag
 */
export function classifyWithSensitivity(
  message: string,
  classifier: SensitivityClassifier,
): ClassificationResult {
  const isAgent = needsToolExecution(message);
  const isKeywordPrivacy = isPrivacySensitive(message);
  const sensitivity = classifier.classify(message);

  // Agent intent: tools needed, must go to Claude.
  // But if content is sensitive, flag for history sanitization.
  if (isAgent) {
    return {
      intent: 'agent',
      sensitivity,
      requiresSanitization: sensitivity.recommendation !== 'standard',
    };
  }

  // Explicit privacy keywords -- fast path, skip classifier threshold
  if (isKeywordPrivacy) {
    return {
      intent: 'privacy',
      sensitivity,
      requiresSanitization: false,
    };
  }

  // Content-based routing from classifier
  if (sensitivity.recommendation === 'privacy' || sensitivity.recommendation === 'block') {
    return {
      intent: 'privacy',
      sensitivity,
      requiresSanitization: false,
    };
  }

  // No sensitivity triggers -- standard chat
  return {
    intent: 'chat',
    sensitivity,
    requiresSanitization: false,
  };
}
