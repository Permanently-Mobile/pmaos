/**
 * Provider Indicator System -- Phase 2: Privacy Routing Layer
 *
 * Generates display indicators for Telegram responses and dashboards
 * showing which provider handled a request and whether data was sanitized.
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

// ── Provider display indicators ─────────────────────────────────────────

/**
 * Get a human-readable indicator string for Telegram display.
 *
 * @param provider - The provider name (claude, venice, ollama, openrouter, blocked)
 * @param wasSanitized - Whether the data was sanitized before sending
 * @param isFallback - Whether this is a fallback (Claude was unavailable)
 * @returns A short indicator string, or empty string for Claude primary
 */
export function getProviderIndicator(
  provider: string,
  wasSanitized: boolean,
  isFallback: boolean,
): string {
  const p = provider.toLowerCase();

  if (p === 'blocked') {
    return '[Blocked - High Sensitivity]';
  }

  if (p === 'claude') {
    // Claude primary path -- no indicator needed
    return '';
  }

  if (p === 'venice') {
    if (isFallback) return '[Venice - Private Fallback]';
    return '[Venice]';
  }

  if (p === 'ollama') {
    if (isFallback) return '[Local - Private Fallback]';
    return '[Local]';
  }

  if (p === 'openrouter') {
    return '[External - Data Sanitized]';
  }

  // Tool-augmented variants
  if (p.endsWith('-augmented')) {
    const base = p.replace('-augmented', '');
    if (base === 'venice') return '[Venice+Tools - Private Fallback]';
    if (base === 'ollama') return '[Local+Tools - Private Fallback]';
    if (base === 'openrouter') return '[External+Tools - Data Sanitized]';
    return `[${base}+Tools - Fallback]`;
  }

  // Unknown provider
  if (wasSanitized) return `[${provider} - Data Sanitized]`;
  if (isFallback) return `[${provider} - Fallback]`;
  return `[${provider}]`;
}

/**
 * Get the emoji indicator for a provider.
 *
 * @param provider - The provider name
 * @returns An emoji character or empty string
 */
export function getProviderEmoji(provider: string): string {
  const p = provider.toLowerCase();

  if (p === 'claude') return '';
  if (p === 'venice') return '\u{1F6E1}\u{FE0F}';      // shield
  if (p === 'ollama') return '\u{1F4BB}';               // computer
  if (p === 'openrouter') return '\u{26A0}\u{FE0F}';    // warning
  if (p === 'blocked') return '\u{1F6D1}';              // stop sign
  if (p === 'none') return '\u{274C}';                  // red X

  // Tool-augmented variants
  if (p.endsWith('-augmented')) {
    const base = p.replace('-augmented', '');
    return getProviderEmoji(base);
  }

  return '';
}

/**
 * Build a full provider status line for display.
 * Combines emoji + indicator text.
 *
 * @param provider - The provider name
 * @param wasSanitized - Whether data was sanitized
 * @param isFallback - Whether this is a fallback
 * @returns Full status line or empty string for Claude primary
 */
export function buildProviderStatusLine(
  provider: string,
  wasSanitized: boolean,
  isFallback: boolean,
): string {
  const indicator = getProviderIndicator(provider, wasSanitized, isFallback);
  if (!indicator) return '';

  const emoji = getProviderEmoji(provider);
  return emoji ? `${emoji} ${indicator}` : indicator;
}
