/**
 * SystemPromptLoader -- Unified system prompt loading for all providers.
 *
 * Two sources:
 *   1. CLAUDE.md (project root) -- Claude-specific, used by SDK natively
 *   2. aios/ files -- portable, LLM-agnostic, used for REST providers
 *
 * Non-Claude providers get prompts assembled from AIOS files (me.md, voice.md,
 * START-HERE.md) instead of a sanitized copy of CLAUDE.md. This eliminates
 * section-stripping and path-redaction gymnastics -- the AIOS files are
 * already clean, vendor-agnostic, and purpose-built.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

// -- Mode suffixes appended to all prompts -----------------------------------

const PRIVACY_SUFFIX = `\n\n---\nPRIVACY MODE: Running through a privacy-first provider (zero data retention). You can hold conversation and answer questions with full privacy. If the user needs tool execution (email, calendar, file ops, bash commands, skills), let them know you'll need to route through the main system for that.`;

const FALLBACK_SUFFIX = `\n\n---\nFALLBACK MODE ACTIVE: You are running on a fallback model because the primary agent is unavailable. You can hold conversation and answer questions, but you CANNOT execute tools (bash, file reads, web search, skills). If the user asks you to do something that requires tool execution, explain that you're in fallback mode and can only do conversation until the primary agent is restored.`;

const DEFAULT_PROMPT = 'You are a personal AI assistant.';

// -- AIOS files that compose the portable prompt -----------------------------

const PORTABLE_FILES = ['me.md', 'voice.md', 'START-HERE.md'] as const;

// -- SystemPromptLoader ------------------------------------------------------

export class SystemPromptLoader {
  private rawCache: string | null = null;
  private portableCache: string | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly aiosPath: string,
  ) {}

  /**
   * Load raw CLAUDE.md content from project root.
   * Used for Claude's own fallback/privacy mode suffixes in the router.
   */
  loadRaw(): string {
    if (this.rawCache !== null) return this.rawCache;

    const claudeMdPath = path.join(this.projectRoot, 'CLAUDE.md');
    try {
      this.rawCache = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch {
      logger.warn({ path: claudeMdPath }, 'CLAUDE.md not found, using default prompt');
      this.rawCache = DEFAULT_PROMPT;
    }
    return this.rawCache;
  }

  /**
   * Assemble a portable system prompt from AIOS files.
   * Reads me.md, voice.md, and START-HERE.md -- everything a non-Claude
   * provider needs to understand the user's identity, voice preferences,
   * and system behavior. No hardcoded paths, no provider-specific config.
   */
  loadPortable(): string {
    if (this.portableCache !== null) return this.portableCache;

    const sections: string[] = [];

    for (const filename of PORTABLE_FILES) {
      const filePath = path.join(this.aiosPath, filename);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Strip YAML frontmatter (--- block at top)
        const stripped = content.replace(/^---[\s\S]*?---\n*/m, '').trim();
        if (stripped) sections.push(stripped);
      } catch {
        logger.warn({ file: filePath }, `AIOS file not found, skipping: ${filename}`);
      }
    }

    if (sections.length === 0) {
      logger.warn('No AIOS files loaded, falling back to default prompt');
      this.portableCache = DEFAULT_PROMPT;
    } else {
      this.portableCache = sections.join('\n\n---\n\n');
    }

    return this.portableCache;
  }

  /**
   * Get the right system prompt for a target provider and mode.
   *
   * - claude: raw CLAUDE.md + mode suffix
   * - venice/ollama (privacy): portable AIOS prompt + PRIVACY suffix
   * - openrouter/other (fallback): portable AIOS prompt + FALLBACK suffix
   */
  loadForProvider(provider: string, isPrivacy: boolean): string {
    const p = provider.toLowerCase();

    // Claude path: use raw CLAUDE.md (matches existing behavior)
    if (p === 'claude') {
      const raw = this.loadRaw();
      if (isPrivacy) return raw + PRIVACY_SUFFIX;
      return raw + FALLBACK_SUFFIX;
    }

    // All non-Claude providers: use portable AIOS prompt
    const portable = this.loadPortable();
    if (isPrivacy) return portable + PRIVACY_SUFFIX;
    return portable + FALLBACK_SUFFIX;
  }

  /**
   * Clear cached content. Call when AIOS files or CLAUDE.md change
   * and you want fresh reads on next access.
   */
  invalidateCache(): void {
    this.rawCache = null;
    this.portableCache = null;
  }
}

// -- Factory -----------------------------------------------------------------

export function createSystemPromptLoader(projectRoot: string, aiosPath: string): SystemPromptLoader {
  return new SystemPromptLoader(projectRoot, aiosPath);
}
