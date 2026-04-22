import pino from 'pino';

// ── Log Sanitization ────────────────────────────────────────────────
// Strip API keys and secrets from log output before they hit PM2 logs.
// Each pattern replaces the sensitive portion with a redacted placeholder.

const REDACT_PATTERNS: Array<[RegExp, string | ((match: string) => string)]> = [
  // Anthropic API keys (sk-ant-api03-...)
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:anthropic-key]'],
  // OpenAI-style keys (sk-...)
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED:api-key]'],
  // Groq API keys (gsk_...)
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, '[REDACTED:groq-key]'],
  // Telegram bot tokens (digits:alphanumeric)
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED:telegram-token]'],
  // Venice / hex API keys (long hex strings, 32+ chars)
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED:hex-key]'],
  // age secret keys
  [/AGE-SECRET-KEY-[A-Z0-9]+/g, '[REDACTED:age-key]'],
  // Bearer tokens in headers
  [/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [REDACTED]'],
  // Base64-encoded passphrases (at least 32 chars of base64)
  [/[A-Za-z0-9+/]{32,}={0,2}/g, (match: string) => {
    // Only redact if it looks like a real base64 secret (contains mixed case + special)
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED:b64]';
    }
    return match;
  }],
];

/**
 * Scrub sensitive data from a log string.
 * Applied to serialized log output before it reaches PM2/stdout.
 */
function sanitize(str: string): string {
  let result = str;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
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

// ── Pino configuration ──────────────────────────────────────────────

// Always sanitize log output regardless of NODE_ENV.
// pino-pretty runs in-process so we can pipe through sanitization first.

// Custom writable destination that sanitizes output
function createSanitizedDestination(): pino.DestinationStream {
  return {
    write(msg: string): boolean {
      process.stdout.write(sanitize(msg));
      return true;
    },
  } as pino.DestinationStream;
}

// Pino's serializers sanitize known fields in structured logs.
// Error objects have non-enumerable properties, so we must extract them
// into a plain object for JSON.stringify to include message/stack/code.
const serializers: Record<string, (value: unknown) => unknown> = {
  err: (value: unknown) => {
    if (value instanceof Error) {
      const plain: Record<string, unknown> = {
        type: value.constructor.name,
        message: sanitize(value.message || 'Unknown error'),
        stack: value.stack ? sanitize(value.stack) : undefined,
      };
      if ('code' in value) plain.code = (value as NodeJS.ErrnoException).code;
      if ('statusCode' in value) plain.statusCode = (value as Record<string, unknown>).statusCode;
      return plain;
    }
    if (value && typeof value === 'object') {
      const err = value as Record<string, unknown>;
      if (typeof err.message === 'string') {
        err.message = sanitize(err.message);
      }
      if (typeof err.stack === 'string') {
        err.stack = sanitize(err.stack);
      }
    }
    return value;
  },
};

// Sanitized destination is always active -- secrets never hit disk
export const logger: pino.Logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    serializers,
  },
  createSanitizedDestination(),
);

// Export sanitize for direct use (e.g. sanitizing error messages before logging)
export { sanitize };
