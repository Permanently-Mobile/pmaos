/**
 * AI Defense Scan -- Shared Utilities
 *
 * Redaction functions for sanitizing evidence fields in scan reports.
 * Prevents plaintext secrets from leaking into git-tracked vault audit files.
 *
 * Pattern coverage:
 *   - Anthropic keys (sk-ant-...)
 *   - OpenAI keys (sk-...)
 *   - Groq keys (gsk_...)
 *   - OpenRouter keys (sk-or-...)
 *   - GitHub PATs (ghp_...)
 *   - AWS access keys (AKIA...)
 *   - Telegram bot tokens (digits:alphanum)
 *   - Age secret keys (AGE-SECRET-KEY-...)
 *   - Hex tokens (32+ chars)
 *   - WireGuard keys (base64= format, 44 chars)
 *   - JWTs (eyJ...)
 *   - Generic KEY=value / TOKEN=value / PASSPHRASE=value
 *   - Bearer tokens
 *   - Private key blocks (PEM)
 *   - Base64 secrets (32+ chars mixed-case)
 */

// Each entry: [pattern, replacement]
// Patterns are ordered most-specific first to avoid partial matches.
const EVIDENCE_REDACT_PATTERNS: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  // PEM private key blocks -- collapse the whole block
  [/-----BEGIN (RSA|EC|OPENSSH|DSA|PRIVATE) PRIVATE KEY-----[\s\S]*?-----END \1 PRIVATE KEY-----/g,
    '[REDACTED:private-key-block]'],

  // Anthropic API keys (sk-ant-api03-...)
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:anthropic-key]'],

  // OpenRouter keys (sk-or-...)
  [/\bsk-or-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:openrouter-key]'],

  // OpenAI-style keys (sk-...)
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED:api-key]'],

  // Groq API keys (gsk_...)
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, '[REDACTED:groq-key]'],

  // GitHub PATs (ghp_...)
  [/\bghp_[a-zA-Z0-9]{36,}\b/g, '[REDACTED:github-pat]'],

  // AWS access keys (AKIA...)
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key]'],

  // Age secret keys
  [/AGE-SECRET-KEY-[A-Z0-9]+/g, '[REDACTED:age-key]'],

  // Telegram bot tokens (digits:alphanumeric)
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED:telegram-token]'],

  // JWTs (eyJ header.payload, optionally with signature)
  [/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]+)?\b/g, '[REDACTED:jwt]'],

  // WireGuard keys (44-char base64 ending with =)
  [/\b[A-Za-z0-9+/]{43}=\b/g, (match: string) => {
    // Only redact if it has mixed case + digits (looks like a real key, not a word)
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED:wireguard-key]';
    }
    return match;
  }],

  // Generic KEY=value, TOKEN=value, SECRET=value, PASSPHRASE=value, PASSWORD=value patterns
  // Captures: ENV_VAR_NAME=<the secret value>
  [/\b(API_KEY|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN|DB_PASSPHRASE|PRIVATE_KEY|PASSPHRASE|PASSWORD|TOKEN|SECRET|VENICE_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY)\s*=\s*(\S{8,})/gi,
    (_match: string, name: string, _value: string) => `${name}=[REDACTED]`],

  // Bearer tokens in headers
  [/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [REDACTED]'],

  // Venice / hex API keys (long hex strings, 32+ chars)
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED:hex-key]'],

  // Base64-encoded secrets (32+ chars of base64 alphabet)
  [/[A-Za-z0-9+/]{32,}={0,2}/g, (match: string) => {
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED:b64]';
    }
    return match;
  }],
];

/**
 * Redact secrets from an evidence string before it hits the report.
 * Applies all known secret patterns and replaces with [REDACTED:type] tags.
 *
 * @param proofMode - When true, bypass all redaction and return input unchanged.
 *   Used only with a validated one-time proof token for unredacted evidence reports.
 */
export function redactSecrets(input: string, proofMode = false): string {
  if (proofMode) return input;

  let result = input;
  for (const [pattern, replacement] of EVIDENCE_REDACT_PATTERNS) {
    // Reset lastIndex for global regexps reused across calls
    pattern.lastIndex = 0;
    if (typeof replacement === 'string') {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

/**
 * Redact evidence from a linPEAS passwords category finding.
 * For password findings, strip everything except the pattern name and file path.
 * Never include actual credential values.
 */
export function redactPasswordEvidence(evidence: string, section: string): string {
  if (section === 'passwords') {
    // For password findings, extract only file paths and pattern names
    const lines = evidence.split('\n');
    const safe: string[] = [];
    for (const line of lines) {
      // Keep lines that look like file paths or section headers
      const trimmed = line.trim();
      if (!trimmed) continue;
      // File path references (starts with / or contains common path indicators)
      if (/^\//.test(trimmed) || /^\w+:.*\//.test(trimmed)) {
        // Redact any inline values after = signs
        safe.push(redactSecrets(trimmed));
      } else if (/^[\[#]/.test(trimmed)) {
        // Section headers like [passwords], # heading
        safe.push(trimmed);
      } else {
        // Everything else gets full redaction
        safe.push(redactSecrets(trimmed));
      }
    }
    return safe.join('\n');
  }
  return redactSecrets(evidence);
}
