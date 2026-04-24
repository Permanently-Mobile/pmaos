/**
 * Wraith Prompt Template System
 *
 * Loads prompt templates with @include() directives and {{VAR}} interpolation.
 * Adapted from Shannon's prompt-manager pattern, stripped down to what Wraith
 * needs: shared content injection and context variable substitution.
 *
 * Templates live at: bots/wraith/prompts/
 * Shared fragments live at: bots/wraith/prompts/shared/
 *
 * Features:
 *   - @include(shared/scope-rules.md) -- inline file content
 *   - {{TARGET}} / {{MODULE}} / etc. -- variable interpolation
 *   - Path traversal protection (no ../ in includes)
 *   - Unresolved placeholder warnings
 */

import fs from 'fs';
import path from 'path';
import { WraithScanError, WraithErrorType } from './types/errors.js';

/** Default template directory relative to project root */
const DEFAULT_PROMPTS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'bots',
  'wraith',
  'prompts',
);

/**
 * Context variables available for template interpolation.
 * Modules pass their specific context; the manager handles substitution.
 */
export interface PromptContext {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Result of processing @include() directives.
 * Tracked separately so callers know which files were pulled in.
 */
interface IncludeResult {
  /** The placeholder string that was replaced (e.g., @include(shared/scope-rules.md)) */
  placeholder: string;
  /** The content that replaced it */
  content: string;
  /** The resolved file path that was included */
  resolvedPath: string;
}

/**
 * Validate that an include path does not escape the base directory.
 * Blocks ../ traversal and absolute paths in include directives.
 */
function validateIncludePath(rawPath: string, baseDir: string): string {
  // Block absolute paths
  if (path.isAbsolute(rawPath)) {
    throw new WraithScanError(
      `Absolute path in @include() is not allowed: ${rawPath}`,
      'prompt-manager',
      WraithErrorType.VALIDATION,
    );
  }

  // Block explicit traversal
  if (rawPath.includes('..')) {
    throw new WraithScanError(
      `Path traversal detected in @include(): ${rawPath}`,
      'prompt-manager',
      WraithErrorType.VALIDATION,
    );
  }

  const resolved = path.resolve(baseDir, rawPath);
  const normalizedBase = path.resolve(baseDir);

  // Final containment check: resolved path must be inside baseDir
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new WraithScanError(
      `@include() path resolves outside template directory: ${rawPath}`,
      'prompt-manager',
      WraithErrorType.VALIDATION,
      { context: { resolved, baseDir: normalizedBase } },
    );
  }

  return resolved;
}

/**
 * Process @include(filename) directives in template content.
 * Reads the referenced file and inlines its content.
 * Includes are NOT recursive -- a single level only.
 */
async function processIncludes(
  content: string,
  baseDir: string,
): Promise<string> {
  const includeRegex = /@include\(([^)]+)\)/g;
  const matches = Array.from(content.matchAll(includeRegex));

  if (matches.length === 0) {
    return content;
  }

  // Resolve all includes in parallel
  const replacements: IncludeResult[] = await Promise.all(
    matches.map(async (match) => {
      const rawPath = match[1]?.trim() ?? '';
      const resolvedPath = validateIncludePath(rawPath, baseDir);

      if (!fs.existsSync(resolvedPath)) {
        throw new WraithScanError(
          `Included file not found: ${rawPath} (resolved to ${resolvedPath})`,
          'prompt-manager',
          WraithErrorType.CONFIG,
        );
      }

      const fileContent = await fs.promises.readFile(resolvedPath, 'utf-8');
      return {
        placeholder: match[0],
        content: fileContent,
        resolvedPath,
      };
    }),
  );

  let result = content;
  for (const replacement of replacements) {
    result = result.replace(replacement.placeholder, replacement.content);
  }

  return result;
}

/**
 * Interpolate {{VAR}} placeholders with values from the context object.
 * Variable names are case-insensitive for matching convenience.
 *
 * Returns the interpolated string and a list of any unresolved placeholders.
 */
function interpolateVariables(
  template: string,
  context: PromptContext,
): { result: string; unresolved: string[] } {
  // Build a case-insensitive lookup map
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) {
      lookup.set(key.toUpperCase(), String(value));
    }
  }

  const unresolved: string[] = [];

  const result = template.replace(/\{\{([^}]+)\}\}/g, (match, varName: string) => {
    const normalized = varName.trim().toUpperCase();
    const value = lookup.get(normalized);
    if (value !== undefined) {
      return value;
    }
    unresolved.push(varName.trim());
    return match; // Leave unresolved placeholders as-is
  });

  return { result, unresolved };
}

/**
 * Load a prompt template by name, process includes, and interpolate variables.
 *
 * @param templateName - Template filename without extension (e.g., 'recon-prompt')
 * @param context - Variables to interpolate into the template
 * @param promptsDir - Override template directory (defaults to bots/wraith/prompts/)
 * @returns The fully processed prompt string
 */
export async function loadPrompt(
  templateName: string,
  context: PromptContext = {},
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): Promise<string> {
  // Resolve template path
  const templatePath = path.join(promptsDir, `${templateName}.md`);

  if (!fs.existsSync(templatePath)) {
    throw new WraithScanError(
      `Prompt template not found: ${templateName} (looked at ${templatePath})`,
      'prompt-manager',
      WraithErrorType.CONFIG,
    );
  }

  // Read template
  let template = await fs.promises.readFile(templatePath, 'utf-8');

  // Process @include() directives
  template = await processIncludes(template, promptsDir);

  // Interpolate {{VAR}} placeholders
  const { result, unresolved } = interpolateVariables(template, context);

  if (unresolved.length > 0) {
    // Log but don't fail -- some placeholders might be intentionally left
    // for downstream processing
    const msg = `Unresolved placeholders in ${templateName}: ${unresolved.join(', ')}`;
    // Use console.warn since we don't want to import the full logger here
    // to keep this module lightweight and testable
    console.warn(`[wraith:prompt-manager] ${msg}`);
  }

  return result;
}

/**
 * Load a raw template file without processing includes or variables.
 * Useful for inspecting templates or building custom processing pipelines.
 */
export async function loadRawTemplate(
  templateName: string,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): Promise<string> {
  const templatePath = path.join(promptsDir, `${templateName}.md`);

  if (!fs.existsSync(templatePath)) {
    throw new WraithScanError(
      `Prompt template not found: ${templateName} (looked at ${templatePath})`,
      'prompt-manager',
      WraithErrorType.CONFIG,
    );
  }

  return fs.promises.readFile(templatePath, 'utf-8');
}

/**
 * List all available template files in the prompts directory.
 * Returns template names (without .md extension).
 */
export function listTemplates(
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string[] {
  if (!fs.existsSync(promptsDir)) {
    return [];
  }

  return fs.readdirSync(promptsDir)
    .filter((f) => f.endsWith('.md') && !fs.statSync(path.join(promptsDir, f)).isDirectory())
    .map((f) => f.replace(/\.md$/, ''));
}

/**
 * List all shared fragment files available for @include().
 * Returns paths relative to the prompts directory.
 */
export function listSharedFragments(
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string[] {
  const sharedDir = path.join(promptsDir, 'shared');
  if (!fs.existsSync(sharedDir)) {
    return [];
  }

  return fs.readdirSync(sharedDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => `shared/${f}`);
}
