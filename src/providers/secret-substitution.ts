/**
 * Secret Substitution Layer -- System Secret Protection
 *
 * Strips system secrets (API keys, tokens, DB passwords, connection strings,
 * private keys) from ANY context before it reaches an LLM. The LLM works
 * with placeholders like {{SECRET_001}}. Real values are restored at
 * execution time only.
 *
 * The secret map is held IN MEMORY ONLY. Never persisted to disk. Never logged.
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import { ALL_SECRET_PATTERNS, type SecretPatternDef } from './secret-patterns.js';
import type { SecretMatch, SecretSubstitutionResult, SecretSubstitutionMode } from './types.js';
import { logger } from '../logger.js';

// ── SecretSubstitution class ────────────────────────────────────────

export class SecretSubstitution {
  private patterns: SecretPatternDef[];

  constructor(customPatterns?: SecretPatternDef[]) {
    this.patterns = customPatterns ?? [...ALL_SECRET_PATTERNS];
  }

  /**
   * Scan text for all secret matches without substituting.
   * Returns detected secrets with their positions and categories.
   */
  scan(text: string): SecretMatch[] {
    const matches: SecretMatch[] = [];

    for (const pat of this.patterns) {
      // Reset lastIndex for global regexps
      pat.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pat.regex.exec(text)) !== null) {
        matches.push({
          category: pat.category,
          pattern: pat.name,
          match: match[0],
          confidence: pat.confidence,
          position: { start: match.index, end: match.index + match[0].length },
        });
        // Prevent infinite loops on zero-length matches
        if (match[0].length === 0) {
          pat.regex.lastIndex++;
        }
      }
    }

    // De-duplicate overlapping matches, keeping higher confidence
    return this.deduplicateMatches(matches);
  }

  /**
   * Substitute all detected secrets with placeholders.
   * Returns the sanitized text and a mapping from placeholder to real value.
   *
   * The map is IN MEMORY ONLY. Never persist it. Never log real values.
   */
  substitute(text: string): SecretSubstitutionResult {
    const matches = this.scan(text);

    if (matches.length === 0) {
      return { sanitized: text, map: new Map(), matchCount: 0 };
    }

    // Sort by position descending so we can replace from end to start
    // without shifting indices
    const sorted = [...matches].sort((a, b) => {
      if (b.position.start !== a.position.start) return b.position.start - a.position.start;
      return b.position.end - a.position.end;
    });

    let result = text;
    const map = new Map<string, string>();
    let counter = sorted.length;

    for (const m of sorted) {
      const placeholder = `{{SECRET_${String(counter).padStart(3, '0')}}}`;
      map.set(placeholder, m.match);
      result = result.slice(0, m.position.start) + placeholder + result.slice(m.position.end);
      counter--;
    }

    logger.debug(
      { matchCount: matches.length, categories: [...new Set(matches.map(m => m.category))] },
      'Secret substitution applied',
    );

    return { sanitized: result, map, matchCount: matches.length };
  }

  /**
   * Restore placeholders back to real values before execution.
   *
   * @param text - The text containing {{SECRET_NNN}} placeholders
   * @param map - The placeholder-to-value mapping from substitute()
   * @returns The text with real secret values restored
   */
  restore(text: string, map: Map<string, string>): string {
    if (map.size === 0) return text;

    let result = text;
    for (const [placeholder, realValue] of map) {
      // Replace all occurrences of the placeholder (LLM may have repeated it)
      result = result.split(placeholder).join(realValue);
    }

    return result;
  }

  /**
   * Get the number of patterns loaded.
   */
  getPatternCount(): number {
    return this.patterns.length;
  }

  // ── Deduplication ──────────────────────────────────────────────────

  /**
   * Remove overlapping matches, keeping the one with higher confidence.
   * For equal confidence, keep the longer match.
   */
  private deduplicateMatches(matches: SecretMatch[]): SecretMatch[] {
    if (matches.length <= 1) return matches;

    // Sort by start position ascending, then by length descending
    const sorted = [...matches].sort((a, b) => {
      if (a.position.start !== b.position.start) return a.position.start - b.position.start;
      return (b.position.end - b.position.start) - (a.position.end - a.position.start);
    });

    const result: SecretMatch[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const prev = result[result.length - 1];

      // Check for overlap
      const overlaps = current.position.start < prev.position.end;

      if (overlaps) {
        // Keep the one with higher confidence, or longer match on tie
        const prevLen = prev.position.end - prev.position.start;
        const currLen = current.position.end - current.position.start;
        if (
          current.confidence > prev.confidence ||
          (current.confidence === prev.confidence && currLen > prevLen)
        ) {
          result[result.length - 1] = current;
        }
        // Otherwise skip current (prev stays)
      } else {
        result.push(current);
      }
    }

    return result;
  }
}

// ── Factory function ────────────────────────────────────────────────

/**
 * Create a configured SecretSubstitution instance.
 * Uses the default ALL_SECRET_PATTERNS list.
 */
export function createSecretSubstitution(): SecretSubstitution {
  return new SecretSubstitution();
}
