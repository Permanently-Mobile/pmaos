/**
 * System Prompt Sanitizer -- Phase 2: Privacy Routing Layer
 *
 * Strips PII, internal paths, and personal sections from the system prompt
 * (CLAUDE.md) before sending to non-primary providers.
 *
 * Two sanitization levels:
 *   - Light (Venice/Ollama): strip vault paths and family names
 *   - Aggressive (OpenRouter/external): strip all personal sections, paths, names
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import fs from 'fs';
import path from 'path';

import type { PromptSanitizeOptions } from './types.js';

// ── Default family names (configurable via FAMILY_NAMES env var) ──────────

function getFamilyNames(): string[] {
  return process.env.FAMILY_NAMES
    ? process.env.FAMILY_NAMES.split(',').map(n => n.trim()).filter(Boolean)
    : [];
}

// ── Section headings to strip for aggressive sanitization ────────────────

const AGGRESSIVE_STRIP_SECTIONS = [
  '## Who Is the Owner',
  '## Your Environment',
  '## Self-Restart',
  '## Scheduling Tasks',
  '## Work Sessions',
  '## Special Commands',
];

// ── Light-strip sections (even privacy providers shouldn't see vault paths) ─

const LIGHT_STRIP_SECTIONS = [
  '## Self-Restart',
  '## Scheduling Tasks',
  '## Special Commands',
];

// ── Path patterns to replace ─────────────────────────────────────────────

const PATH_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // Windows-style vault paths
  { regex: /C:\/Users\/[^/\s]+\/Desktop\/[^\s`"')]+/g, replacement: '[VAULT_PATH]' },
  // Windows-style project paths
  { regex: /C:\/Users\/[^/\s]+\/[^\s`"')]+/g, replacement: '[INTERNAL_PATH]' },
  // Unix-style home paths (in case any)
  { regex: /\/home\/[^/\s]+\/[^\s`"')]+/g, replacement: '[INTERNAL_PATH]' },
  // Backtick-wrapped paths
  { regex: /`C:\\Users\\[^`]+`/g, replacement: '`[INTERNAL_PATH]`' },
];

// ── Core sanitization functions ──────────────────────────────────────────

/**
 * Strip a markdown section from content (from heading to next same-level heading).
 * Handles ## headings only.
 */
function stripSection(content: string, sectionHeading: string): string {
  const headingLevel = sectionHeading.match(/^(#+)/)?.[1]?.length ?? 2;
  const escapedHeading = sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextHeadingPattern = `^#{1,${headingLevel}}\\s`;

  const lines = content.split('\n');
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith(sectionHeading)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Check if this line is a heading at the same or higher level
      const headingMatch = line.match(/^(#+)\s/);
      if (headingMatch && headingMatch[1].length <= headingLevel) {
        inSection = false;
        result.push(line);
      }
      // Skip lines within the stripped section
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Replace family names in content with [NAME].
 * Case-insensitive, whole-word matching.
 */
function stripFamilyNames(content: string, names: string[]): string {
  let result = content;
  for (const name of names) {
    if (name.length < 2) continue;
    const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    result = result.replace(regex, '[NAME]');
  }
  return result;
}

/**
 * Replace internal paths with placeholder tokens.
 */
function stripPaths(content: string): string {
  let result = content;
  for (const { regex, replacement } of PATH_PATTERNS) {
    // Reset lastIndex for global regexps
    regex.lastIndex = 0;
    result = result.replace(regex, replacement);
  }
  return result;
}

/** Escape special regex characters. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Sanitize the system prompt for a target provider.
 *
 * @param rawPrompt - The full system prompt (CLAUDE.md contents)
 * @param targetProvider - The provider that will receive this prompt
 * @returns Sanitized system prompt
 */
export function sanitizeSystemPrompt(rawPrompt: string, targetProvider: string): string {
  const provider = targetProvider.toLowerCase();
  const isPrivacyProvider = provider === 'venice' || provider === 'ollama';

  if (isPrivacyProvider) {
    return sanitizeLight(rawPrompt);
  }
  return sanitizeAggressive(rawPrompt);
}

/**
 * Light sanitization for privacy providers (Venice, Ollama).
 * Strips vault paths, family names, and restart/scheduling sections.
 * Preserves personality and routing rules.
 */
function sanitizeLight(prompt: string): string {
  let result = prompt;

  // Strip sections that contain internal paths/commands
  for (const section of LIGHT_STRIP_SECTIONS) {
    result = stripSection(result, section);
  }

  // Strip vault/project paths
  result = stripPaths(result);

  // Strip family names
  result = stripFamilyNames(result, getFamilyNames());

  return result;
}

/**
 * Aggressive sanitization for external providers (OpenRouter, etc.).
 * Strips all personal sections, paths, names. Preserves personality
 * and agent routing for coherent fallback behavior.
 */
function sanitizeAggressive(prompt: string): string {
  let result = prompt;

  // Strip all personal/internal sections
  for (const section of AGGRESSIVE_STRIP_SECTIONS) {
    result = stripSection(result, section);
  }

  // Strip all paths
  result = stripPaths(result);

  // Strip family names
  result = stripFamilyNames(result, getFamilyNames());

  // Strip any remaining personal info patterns
  // Obsidian vault references
  result = result.replace(/Obsidian vault[:\s]+`[^`]+`/gi, 'Obsidian vault: `[VAULT_PATH]`');
  result = result.replace(/vault lives at `[^`]+`/gi, 'vault lives at `[VAULT_PATH]`');

  // API keys in text
  result = result.replace(/API key[:\s]+stored in[^.\n]+/gi, 'API key: [REDACTED]');
  result = result.replace(/`\.env`\s+as\s+`[^`]+`/gi, '`[REDACTED]`');

  // Clean up multiple blank lines left by section stripping
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * Build a sanitized system prompt for a specific provider context.
 * Replaces the raw buildSystemPrompt() used in router.ts.
 *
 * @param projectRoot - Path to project root (for reading CLAUDE.md)
 * @param isPrivacy - Whether this is a privacy-mode request
 * @param targetProvider - The provider that will receive this prompt
 * @returns Fully sanitized system prompt with mode suffix
 */
export function buildSanitizedSystemPrompt(
  projectRoot: string,
  isPrivacy: boolean,
  targetProvider: string,
): string {
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    claudeMd = 'You are a personal AI assistant accessible via Telegram.';
  }

  // Sanitize for non-Claude providers
  const sanitized = sanitizeSystemPrompt(claudeMd, targetProvider);

  if (isPrivacy) {
    return `${sanitized}\n\n---\nPRIVACY MODE: Running through a privacy-first provider (zero data retention). You can hold conversation and answer questions with full privacy. If the user needs tool execution (email, calendar, file ops, Obsidian, bash commands, skills), let them know you'll need to route through the main system for that.`;
  }

  return `${sanitized}\n\n---\nFALLBACK MODE ACTIVE: You are running on a fallback model because Claude is unavailable. You can hold conversation and answer questions, but you CANNOT execute tools (bash, file reads, web search, Obsidian, skills). If the user asks you to do something that requires tool execution, explain that you're in fallback mode and can only do conversation until Claude is restored. Keep the same personality and loyalty.`;
}
