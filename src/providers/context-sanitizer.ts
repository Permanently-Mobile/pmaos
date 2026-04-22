/**
 * Context Sanitizer for Fallback -- Phase 2: Privacy Routing Layer
 *
 * Sanitizes memory context blocks before they reach non-privacy providers.
 * Separate from the message-level DataSanitizer because memory context
 * has different structure and needs (preserving technical context while
 * stripping personal details).
 *
 * Uses the existing SensitivityClassifier + DataSanitizer internally.
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import { SensitivityClassifier } from './sensitivity.js';
import { DataSanitizer } from './sanitizer.js';
import type { SensitivityConfig, SensitivityCategory } from './types.js';
import { logger } from '../logger.js';

// ── Default config ───────────────────────────────────────────────────────

function getFamilyNames(): string[] {
  return process.env.FAMILY_NAMES
    ? process.env.FAMILY_NAMES.split(',').map(n => n.trim()).filter(Boolean)
    : [];
}

const LIGHT_STRIP_CATEGORIES: SensitivityCategory[] = ['pii', 'personal'];
const FULL_STRIP_CATEGORIES: SensitivityCategory[] = [
  'pii', 'financial', 'crypto', 'medical', 'legal', 'personal',
];

// ── Name stripping (separate from classifier for memory blocks) ──────────

/**
 * Strip family/personal names from a memory block.
 * Uses whole-word replacement, case-insensitive.
 */
function stripNames(content: string, names: string[]): string {
  let result = content;
  for (const name of names) {
    if (name.length < 2) continue;
    const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    result = result.replace(regex, '[NAME]');
  }
  return result;
}

/**
 * Strip relationship terms that could identify family members.
 */
function stripRelationships(content: string): string {
  const patterns = [
    /\b(my|his|her)\s+(wife|husband|spouse|partner|son|daughter|child|kid|mother|father|mom|dad|brother|sister)\b/gi,
    /\b(wife|husband|spouse|partner)\s+[A-Z][a-z]+/g,
  ];
  let result = content;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[FAMILY_MEMBER]');
  }
  return result;
}

/**
 * Strip location references from memory blocks.
 */
function stripLocations(content: string): string {
  const patterns = [
    // Street addresses
    /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Pl|Place|Way|Cir|Circle)\.?\b/gi,
    // City, State ZIP
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g,
  ];
  let result = content;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[LOCATION]');
  }
  return result;
}

/** Escape special regex characters. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Maximal strip (nuclear option on sanitization failure) ────────────────

/**
 * Aggressively strip ALL potentially identifying content.
 * Used when normal sanitization fails -- we'd rather lose content
 * than leak private data to an external provider.
 *
 * Removes: names, relationships, locations, emails, phone numbers,
 * multi-digit numbers, capitalized proper noun sequences, URLs.
 */
function maximalStrip(content: string): string {
  let result = content;
  // Strip known family names
  result = stripNames(result, getFamilyNames());
  // Strip relationship terms
  result = stripRelationships(result);
  // Strip locations/addresses
  result = stripLocations(result);
  // Strip email addresses
  result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED]');
  // Strip phone-like number sequences
  result = result.replace(/\b\+?\d[\d\s\-().]{6,}\d\b/g, '[REDACTED]');
  // Strip multi-digit numbers (account numbers, SSN, zip codes, etc.)
  result = result.replace(/\b\d{3,}\b/g, '[REDACTED]');
  // Strip capitalized multi-word sequences (likely proper nouns: "John Smith", "Goldman Sachs")
  result = result.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, '[REDACTED]');
  // Strip standalone capitalized words mid-sentence (likely proper nouns)
  result = result.replace(/(?<=\s)[A-Z][a-z]{2,}(?=[\s,.])/g, '[REDACTED]');
  // Strip URLs that may contain identifying info
  result = result.replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]');
  return result;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Sanitize a memory context block for a target provider.
 *
 * @param memoryBlock - The raw memory context string
 * @param targetProvider - The provider that will receive this context
 * @returns Sanitized memory context with personal details stripped
 */
export function sanitizeMemoryContext(memoryBlock: string, targetProvider: string): string {
  if (!memoryBlock || memoryBlock.trim().length === 0) {
    return memoryBlock;
  }

  const provider = targetProvider.toLowerCase();
  const isPrivacyProvider = provider === 'venice' || provider === 'ollama';

  try {
    if (isPrivacyProvider) {
      return sanitizeLight(memoryBlock);
    }
    return sanitizeFull(memoryBlock);
  } catch (err) {
    // Sanitization failure: fail safe by stripping aggressively rather than leaking data.
    // Do NOT fall back to the original unsanitized content.
    logger.error({ err, targetProvider }, 'Memory context sanitization FAILED - applying maximal strip (fail-safe)');
    return maximalStrip(memoryBlock);
  }
}

/**
 * Light sanitization for privacy providers (Venice, Ollama).
 * Just strip names and addresses -- these providers have zero retention.
 */
function sanitizeLight(memoryBlock: string): string {
  let result = memoryBlock;

  // Strip personal names
  result = stripNames(result, getFamilyNames());

  // Strip physical addresses
  result = stripLocations(result);

  return result;
}

/**
 * Full sanitization for external providers (OpenRouter, etc.).
 * Strip all PII, financial data, crypto data, personal info.
 */
function sanitizeFull(memoryBlock: string): string {
  let result = memoryBlock;

  // Step 1: Strip names
  result = stripNames(result, getFamilyNames());

  // Step 2: Strip relationship terms
  result = stripRelationships(result);

  // Step 3: Strip locations
  result = stripLocations(result);

  // Step 4: Run through SensitivityClassifier + DataSanitizer
  // for pattern-based detection of financial/crypto/medical/legal data
  const classifier = new SensitivityClassifier({ personalNames: getFamilyNames() });
  const sanitizer = new DataSanitizer();

  const sensitivity = classifier.classify(result);
  if (sensitivity.detections.length > 0) {
    const sanitized = sanitizer.sanitize(result, sensitivity, {
      mode: 'redact',
      categories: FULL_STRIP_CATEGORIES,
    });
    result = sanitized.sanitized;
  }

  return result;
}

/**
 * Sanitize a single chat message content for a target provider.
 * Used when sanitizing the current message before sending to OpenRouter.
 *
 * @param content - The message content
 * @param targetProvider - The target provider
 * @returns Sanitized message content
 */
export function sanitizeMessageForProvider(content: string, targetProvider: string): string {
  if (!content || content.trim().length === 0) {
    return content;
  }

  const provider = targetProvider.toLowerCase();
  // Privacy providers don't need message sanitization (zero retention)
  if (provider === 'venice' || provider === 'ollama') {
    return content;
  }

  try {
    return sanitizeFull(content);
  } catch (err) {
    // Sanitization failure: fail safe by stripping aggressively rather than leaking data.
    // Do NOT fall back to the original unsanitized content.
    logger.error({ err, targetProvider }, 'Message sanitization FAILED - applying maximal strip (fail-safe)');
    return maximalStrip(content);
  }
}
