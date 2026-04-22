/**
 * Privacy Routing Layer -- Unit Tests
 *
 * Phase 1: SensitivityClassifier, DataSanitizer, classifyWithSensitivity
 * Phase 2: System prompt sanitization, context sanitization, provider indicators,
 *          privacy command handler, fallback cascade behavior
 *
 * Uses vitest (project test runner).
 */

// Set test family names BEFORE module imports evaluate getFamilyNames()
process.env.FAMILY_NAMES = 'Alice,Diana,Charlie';

import { describe, it, expect, beforeAll } from 'vitest';
import { SensitivityClassifier } from './sensitivity.js';
import { DataSanitizer } from './sanitizer.js';
import { classifyWithSensitivity, isPrivacySensitive } from './intent.js';
import { sanitizeSystemPrompt, buildSanitizedSystemPrompt } from './prompt-sanitizer.js';
import { sanitizeMemoryContext, sanitizeMessageForProvider } from './context-sanitizer.js';
import { getProviderIndicator, getProviderEmoji, buildProviderStatusLine } from './provider-indicator.js';
import type { SensitivityConfig, SensitivityResult, SanitizeOptions } from './types.js';

// ── Test config ────────────────────────────────────────────────────────

const TEST_CONFIG: SensitivityConfig = {
  personalNames: ['Alice', 'Bob', 'Charlie'],
};

let classifier: SensitivityClassifier;
let sanitizer: DataSanitizer;

beforeAll(() => {
  classifier = new SensitivityClassifier(TEST_CONFIG);
  sanitizer = new DataSanitizer();
});

// ── SensitivityClassifier tests ────────────────────────────────────────

describe('SensitivityClassifier', () => {
  // ── PII detection ──────────────────────────────────────────────────

  describe('PII detection', () => {
    it('detects SSN patterns', () => {
      const result = classifier.classify('My SSN is 123-45-6789');
      expect(result.categories).toContain('pii');
      expect(result.detections.some(d => d.pattern === 'ssn')).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.6);
    });

    it('detects email addresses', () => {
      const result = classifier.classify('Contact me at user@example.com');
      expect(result.categories).toContain('pii');
      expect(result.detections.some(d => d.pattern === 'email')).toBe(true);
    });

    it('detects phone numbers', () => {
      const result = classifier.classify('Call me at (555) 123-4567');
      expect(result.categories).toContain('pii');
      expect(result.detections.some(d => d.pattern === 'phone-us')).toBe(true);
    });

    it('detects physical addresses', () => {
      const result = classifier.classify('I live at 123 Main Street');
      expect(result.categories).toContain('pii');
      expect(result.detections.some(d => d.pattern === 'address')).toBe(true);
    });

    it('returns recommendation = privacy for PII', () => {
      const result = classifier.classify('SSN: 123-45-6789');
      expect(result.recommendation).toBe('privacy');
    });
  });

  // ── Financial detection ────────────────────────────────────────────

  describe('Financial detection', () => {
    it('detects large dollar amounts', () => {
      const result = classifier.classify('The balance is $15,000.00');
      expect(result.categories).toContain('financial');
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });

    it('detects credit card numbers', () => {
      const result = classifier.classify('Card: 4111 1111 1111 1111');
      expect(result.categories).toContain('financial');
      expect(result.detections.some(d => d.pattern === 'credit-card')).toBe(true);
    });

    it('detects account numbers', () => {
      const result = classifier.classify('Account #12345678901');
      expect(result.categories).toContain('financial');
      expect(result.detections.some(d => d.pattern === 'account-number')).toBe(true);
    });

    it('detects routing numbers', () => {
      const result = classifier.classify('Routing: 021000021');
      expect(result.categories).toContain('financial');
    });

    it('detects bank + amount combos', () => {
      const result = classifier.classify('Chase checking has $5000');
      expect(result.categories).toContain('financial');
    });
  });

  // ── Crypto detection ───────────────────────────────────────────────

  describe('Crypto detection', () => {
    it('detects Ethereum addresses', () => {
      const result = classifier.classify('Send to 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18');
      expect(result.categories).toContain('crypto');
      expect(result.detections.some(d => d.pattern === 'eth-address')).toBe(true);
    });

    it('detects Bitcoin bech32 addresses', () => {
      const result = classifier.classify('BTC address: bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
      expect(result.categories).toContain('crypto');
    });

    it('detects seed phrase references', () => {
      const result = classifier.classify('Seed phrase: apple banana cherry dog elephant fox grape hello ice juice king lemon');
      expect(result.categories).toContain('crypto');
      expect(result.detections.some(d => d.pattern === 'seed-phrase')).toBe(true);
    });

    it('detects exchange + balance combos', () => {
      const result = classifier.classify('Coinbase has 2.5 BTC');
      expect(result.categories).toContain('crypto');
    });
  });

  // ── Medical detection ──────────────────────────────────────────────

  describe('Medical detection', () => {
    it('detects medical record numbers', () => {
      const result = classifier.classify('Patient MRN: ABC123456');
      expect(result.categories).toContain('medical');
    });

    it('detects diagnoses', () => {
      const result = classifier.classify('He was diagnosed with Type 2 Diabetes');
      expect(result.categories).toContain('medical');
    });

    it('detects medication names', () => {
      const result = classifier.classify('Currently taking Metformin for blood sugar');
      expect(result.categories).toContain('medical');
    });
  });

  // ── Legal detection ────────────────────────────────────────────────

  describe('Legal detection', () => {
    it('detects attorney-client privilege language', () => {
      const result = classifier.classify('This is a privileged attorney-client communication');
      expect(result.categories).toContain('legal');
    });

    it('detects court names', () => {
      const result = classifier.classify('Filed in the U.S. District Court');
      expect(result.categories).toContain('legal');
    });

    it('detects case numbers', () => {
      const result = classifier.classify('Case# 24-CV-001234');
      expect(result.categories).toContain('legal');
    });
  });

  // ── Personal detection ─────────────────────────────────────────────

  describe('Personal detection', () => {
    it('detects configured personal names', () => {
      const result = classifier.classify('Alice picked up Bob from school');
      expect(result.categories).toContain('personal');
    });

    it('scores personal-only at 0.4', () => {
      // Use a message that ONLY triggers personal category
      const result = classifier.classify('Alice is great');
      expect(result.score).toBeCloseTo(0.4, 1);
      expect(result.recommendation).toBe('standard');
    });

    it('ignores names not in config', () => {
      const result = classifier.classify('Dave went to the store');
      expect(result.categories).not.toContain('personal');
    });
  });

  // ── Scoring rules ─────────────────────────────────────────────────

  describe('Scoring rules', () => {
    it('returns 0 for clean messages', () => {
      const result = classifier.classify('What is the weather today?');
      expect(result.score).toBe(0);
      expect(result.categories).toHaveLength(0);
      expect(result.recommendation).toBe('standard');
    });

    it('bumps score for multiple categories', () => {
      // SSN (PII) + dollar amount (financial)
      const result = classifier.classify('SSN 123-45-6789 and balance is $50,000');
      expect(result.categories.length).toBeGreaterThanOrEqual(2);
      expect(result.score).toBeGreaterThan(0.7);
    });

    it('caps score at 1.0', () => {
      // Trigger many categories at once
      const result = classifier.classify(
        'SSN 123-45-6789, card 4111111111111111, ' +
        '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18, ' +
        'diagnosed with diabetes, attorney-client privilege, ' +
        'Alice sent $10,000'
      );
      expect(result.score).toBeLessThanOrEqual(1.0);
    });

    it('returns privacy recommendation at >= 0.6', () => {
      const result = classifier.classify('My SSN is 123-45-6789');
      expect(result.score).toBeGreaterThanOrEqual(0.6);
      expect(result.recommendation).toBe('privacy');
    });

    it('returns block recommendation at >= 0.9', () => {
      // PII + financial + crypto + medical = high score
      const result = classifier.classify(
        'SSN 123-45-6789, card 4111111111111111, ' +
        '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18, ' +
        'diagnosed with diabetes'
      );
      expect(result.score).toBeGreaterThanOrEqual(0.9);
      expect(result.recommendation).toBe('block');
    });
  });
});

// ── DataSanitizer tests ────────────────────────────────────────────────

describe('DataSanitizer', () => {
  function classifyAndSanitize(message: string, options: SanitizeOptions) {
    const sensitivity = classifier.classify(message);
    return { ...sanitizer.sanitize(message, sensitivity, options), sensitivity };
  }

  describe('redact mode', () => {
    it('replaces SSN with [REDACTED-PII]', () => {
      const { sanitized, redactions } = classifyAndSanitize(
        'My SSN is 123-45-6789',
        { mode: 'redact' },
      );
      expect(sanitized).toContain('[REDACTED-PII]');
      expect(sanitized).not.toContain('123-45-6789');
      expect(redactions).toBeGreaterThanOrEqual(1);
    });

    it('replaces dollar amounts with [REDACTED-FINANCIAL]', () => {
      const { sanitized } = classifyAndSanitize(
        'Balance is $15,000.00',
        { mode: 'redact' },
      );
      expect(sanitized).toContain('[REDACTED-FINANCIAL]');
    });

    it('replaces crypto addresses with [REDACTED-CRYPTO]', () => {
      const { sanitized } = classifyAndSanitize(
        'Send to 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
        { mode: 'redact' },
      );
      expect(sanitized).toContain('[REDACTED-CRYPTO]');
    });

    it('filters by category when specified', () => {
      const message = 'SSN 123-45-6789, balance $15,000';
      const sensitivity = classifier.classify(message);
      const result = sanitizer.sanitize(message, sensitivity, {
        mode: 'redact',
        categories: ['pii'],
      });
      // SSN should be redacted
      expect(result.sanitized).toContain('[REDACTED-PII]');
      // Financial should remain
      expect(result.sanitized).toContain('$15,000');
    });
  });

  describe('mask mode', () => {
    it('masks SSN to XXX-XX-XXXX', () => {
      const { sanitized } = classifyAndSanitize(
        'My SSN is 123-45-6789',
        { mode: 'mask' },
      );
      expect(sanitized).toContain('XXX-XX-6789');
      expect(sanitized).not.toContain('123-45-6789');
    });

    it('masks email addresses', () => {
      const { sanitized } = classifyAndSanitize(
        'Email: user@example.com',
        { mode: 'mask' },
      );
      expect(sanitized).toContain('****@example.com');
    });

    it('masks ETH addresses partially', () => {
      const { sanitized } = classifyAndSanitize(
        'Wallet: 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
        { mode: 'mask' },
      );
      expect(sanitized).toContain('0x742d');
      expect(sanitized).toContain('bD18');
      expect(sanitized).not.toContain('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18');
    });
  });

  describe('tokenize mode', () => {
    it('replaces with [TOKEN_XXX] and stores mapping', () => {
      const { sanitized, redactions, tokenMap } = classifyAndSanitize(
        'SSN: 123-45-6789',
        { mode: 'tokenize' },
      );
      expect(sanitized).toMatch(/\[TOKEN_\d{3}\]/);
      expect(redactions).toBeGreaterThanOrEqual(1);
      expect(tokenMap).toBeDefined();
      expect(tokenMap!.size).toBeGreaterThanOrEqual(1);
    });

    it('is reversible with detokenize', () => {
      const original = 'My SSN is 123-45-6789';
      const sensitivity = classifier.classify(original);
      const { sanitized, tokenMap } = sanitizer.sanitize(original, sensitivity, { mode: 'tokenize' });
      expect(tokenMap).toBeDefined();
      const restored = sanitizer.detokenize(sanitized, tokenMap!);
      expect(restored).toBe(original);
    });
  });

  describe('edge cases', () => {
    it('returns original message when no detections', () => {
      const message = 'Just a normal message about the weather';
      const sensitivity = classifier.classify(message);
      const result = sanitizer.sanitize(message, sensitivity, { mode: 'redact' });
      expect(result.sanitized).toBe(message);
      expect(result.redactions).toBe(0);
    });

    it('handles empty messages', () => {
      const sensitivity = classifier.classify('');
      const result = sanitizer.sanitize('', sensitivity, { mode: 'redact' });
      expect(result.sanitized).toBe('');
      expect(result.redactions).toBe(0);
    });
  });
});

// ── classifyWithSensitivity tests ──────────────────────────────────────

describe('classifyWithSensitivity', () => {
  it('returns agent intent for tool messages with sensitivity data', () => {
    const result = classifyWithSensitivity('run npm build', classifier);
    expect(result.intent).toBe('agent');
    expect(result.sensitivity).toBeDefined();
    expect(result.requiresSanitization).toBe(false);
  });

  it('flags sanitization for agent + sensitive content', () => {
    const result = classifyWithSensitivity(
      'save a note with SSN 123-45-6789',
      classifier,
    );
    expect(result.intent).toBe('agent');
    expect(result.requiresSanitization).toBe(true);
    expect(result.sensitivity.categories).toContain('pii');
  });

  it('returns privacy intent for keyword triggers', () => {
    const result = classifyWithSensitivity('keep this private', classifier);
    expect(result.intent).toBe('privacy');
  });

  it('returns privacy intent for content-detected sensitive data', () => {
    const result = classifyWithSensitivity(
      'My SSN is 123-45-6789 and I need tax advice',
      classifier,
    );
    expect(result.intent).toBe('privacy');
    expect(result.sensitivity.score).toBeGreaterThanOrEqual(0.6);
  });

  it('returns chat intent for clean messages', () => {
    const result = classifyWithSensitivity(
      'What is the capital of France?',
      classifier,
    );
    expect(result.intent).toBe('chat');
    expect(result.sensitivity.score).toBe(0);
    expect(result.requiresSanitization).toBe(false);
  });

  it('keyword detection takes priority (fast path)', () => {
    // "use venice" triggers keyword detection regardless of content
    const result = classifyWithSensitivity('use venice for this chat', classifier);
    expect(result.intent).toBe('privacy');
  });
});

// ── isPrivacySensitive backward compatibility ──────────────────────────

describe('isPrivacySensitive', () => {
  it('detects "private" keyword', () => {
    expect(isPrivacySensitive('Keep this private please')).toBe(true);
  });

  it('detects "use venice"', () => {
    expect(isPrivacySensitive('use venice for this')).toBe(true);
  });

  it('detects "zero retention"', () => {
    expect(isPrivacySensitive('I need zero retention mode')).toBe(true);
  });

  it('returns false for normal messages', () => {
    expect(isPrivacySensitive('Hello, how are you?')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Phase 2: System Prompt Sanitization
// ══════════════════════════════════════════════════════════════════════════

describe('sanitizeSystemPrompt', () => {
  const SAMPLE_PROMPT = `# Project-Apex

## Personality

Your name is TestBot. You are chill, grounded, and straight up.

## Who Is the Owner

Alice is a jack of all trades with a passion for technology. Alice's wife Diana and son Charlie are the priority. Alice values loyalty above all else.

## Your Environment

- **Obsidian vault**: \`/home/testuser/vault\`
- **Gemini API key**: stored in this project's \`.env\` as \`GOOGLE_API_KEY\`

## Self-Restart

When you need to restart yourself:
\`\`\`bash
nohup bash /home/testuser/project/scripts/restart.sh apex-bot &>/dev/null &
\`\`\`

## Scheduling Tasks

When the owner asks to run something on a schedule:
\`\`\`bash
node /home/testuser/project/dist/schedule-cli.js create "PROMPT" "CRON"
\`\`\`

## Work Sessions

The owner's day is split into three 8-hour work sessions.

| Session | Window |
|---------|--------|
| Session 1 | 12:00a - 8:00a EST |

## Agent Dispatch

Route to researcher-1 for research. Route to coder-1 for code.

## Memory

You maintain context between messages.`;

  describe('aggressive sanitization (OpenRouter)', () => {
    it('strips owner info section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toContain('wife Diana');
      expect(result).not.toContain('son Charlie');
      expect(result).not.toContain('## Who Is the Owner');
    });

    it('strips "Your Environment" section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toContain('## Your Environment');
      expect(result).not.toContain('GOOGLE_API_KEY');
    });

    it('strips "Self-Restart" section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toContain('## Self-Restart');
      expect(result).not.toContain('restart.sh');
    });

    it('strips "Scheduling Tasks" section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toContain('## Scheduling Tasks');
      expect(result).not.toContain('schedule-cli.js');
    });

    it('strips "Work Sessions" section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toContain('## Work Sessions');
      expect(result).not.toContain('8-hour work sessions');
    });

    it('replaces vault paths with [VAULT_PATH]', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toContain('/home/testuser/vault');
    });

    it('replaces family names with [NAME]', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).not.toMatch(/\bAlice\b/);
      expect(result).not.toMatch(/\bDiana\b/);
      expect(result).not.toMatch(/\bCharlie\b/);
    });

    it('preserves personality section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).toContain('## Personality');
      expect(result).toContain('TestBot');
    });

    it('preserves agent dispatch section', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'openrouter');
      expect(result).toContain('## Agent Dispatch');
      expect(result).toContain('researcher-1');
    });
  });

  describe('light sanitization (Venice)', () => {
    it('strips vault paths', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'venice');
      expect(result).not.toContain('/home/testuser/vault');
    });

    it('strips family names', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'venice');
      expect(result).not.toMatch(/\bAlice\b/);
      expect(result).not.toMatch(/\bDiana\b/);
    });

    it('preserves Owner info section structure (stripped of names)', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'venice');
      // Venice still gets the personality context, just sanitized
      expect(result).toContain('## Who Is [NAME]');  // section header name gets stripped
    });

    it('strips Self-Restart and Scheduling sections', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'venice');
      expect(result).not.toContain('## Self-Restart');
      expect(result).not.toContain('## Scheduling Tasks');
    });

    it('preserves Work Sessions for Venice (not stripped in light mode)', () => {
      const result = sanitizeSystemPrompt(SAMPLE_PROMPT, 'venice');
      expect(result).toContain('## Work Sessions');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Phase 2: Context Sanitization
// ══════════════════════════════════════════════════════════════════════════

describe('sanitizeMemoryContext', () => {
  describe('full sanitization (OpenRouter)', () => {
    it('strips personal names from memory blocks', () => {
      const memory = 'Alice talked to Diana about the project. Charlie was at school.';
      const result = sanitizeMemoryContext(memory, 'openrouter');
      expect(result).not.toMatch(/\bAlice\b/);
      expect(result).not.toMatch(/\bDiana\b/);
      expect(result).not.toMatch(/\bCharlie\b/);
      expect(result).toContain('[NAME]');
    });

    it('strips financial data from memory blocks', () => {
      const memory = 'Portfolio balance is $15,000. Chase account has $5000.';
      const result = sanitizeMemoryContext(memory, 'openrouter');
      expect(result).not.toContain('$15,000');
      expect(result).toContain('[REDACTED-FINANCIAL]');
    });

    it('strips crypto data from memory blocks', () => {
      const memory = 'ETH wallet: 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';
      const result = sanitizeMemoryContext(memory, 'openrouter');
      expect(result).not.toContain('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18');
      expect(result).toContain('[REDACTED-CRYPTO]');
    });

    it('preserves technical context', () => {
      const memory = 'Working on the provider router refactor. Using vitest for testing.';
      const result = sanitizeMemoryContext(memory, 'openrouter');
      expect(result).toContain('provider router');
      expect(result).toContain('vitest');
    });
  });

  describe('light sanitization (Venice)', () => {
    it('strips names but keeps financial data', () => {
      const memory = 'Alice has $15,000 in the account.';
      const result = sanitizeMemoryContext(memory, 'venice');
      expect(result).not.toMatch(/\bAlice\b/);
      expect(result).toContain('[NAME]');
      // Venice is zero-retention, so financial data is acceptable
      expect(result).toContain('$15,000');
    });

    it('strips physical addresses', () => {
      const memory = 'Office is at 123 Main Street near downtown.';
      const result = sanitizeMemoryContext(memory, 'venice');
      expect(result).toContain('[LOCATION]');
    });
  });

  describe('edge cases', () => {
    it('handles empty memory blocks', () => {
      expect(sanitizeMemoryContext('', 'openrouter')).toBe('');
      expect(sanitizeMemoryContext('  ', 'openrouter')).toBe('  ');
    });

    it('handles memory with no sensitive data', () => {
      const memory = 'Working on the build system. Tests are passing.';
      const result = sanitizeMemoryContext(memory, 'openrouter');
      expect(result).toBe(memory);
    });
  });
});

describe('sanitizeMessageForProvider', () => {
  it('sanitizes messages for external providers', () => {
    const message = 'Alice sent $15,000 to Diana';
    const result = sanitizeMessageForProvider(message, 'openrouter');
    expect(result).not.toMatch(/\bAlice\b/);
    expect(result).not.toMatch(/\bDiana\b/);
  });

  it('passes through for privacy providers', () => {
    const message = 'Alice sent $15,000 to Diana';
    const result = sanitizeMessageForProvider(message, 'venice');
    expect(result).toBe(message);
  });

  it('passes through for ollama', () => {
    const message = 'My SSN is 123-45-6789';
    const result = sanitizeMessageForProvider(message, 'ollama');
    expect(result).toBe(message);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Phase 2: Provider Indicators
// ══════════════════════════════════════════════════════════════════════════

describe('getProviderIndicator', () => {
  it('returns empty for Claude primary', () => {
    expect(getProviderIndicator('claude', false, false)).toBe('');
  });

  it('returns [Venice] for Venice primary', () => {
    expect(getProviderIndicator('venice', false, false)).toBe('[Venice]');
  });

  it('returns private fallback label for Venice fallback', () => {
    expect(getProviderIndicator('venice', false, true)).toBe('[Venice - Private Fallback]');
  });

  it('returns local label for Ollama', () => {
    expect(getProviderIndicator('ollama', false, false)).toBe('[Local]');
  });

  it('returns local fallback label for Ollama fallback', () => {
    expect(getProviderIndicator('ollama', false, true)).toBe('[Local - Private Fallback]');
  });

  it('returns data sanitized label for OpenRouter', () => {
    expect(getProviderIndicator('openrouter', true, true)).toBe('[External - Data Sanitized]');
  });

  it('returns blocked label', () => {
    expect(getProviderIndicator('blocked', false, false)).toBe('[Blocked - High Sensitivity]');
  });

  it('handles tool-augmented variants', () => {
    expect(getProviderIndicator('venice-augmented', false, true))
      .toBe('[Venice+Tools - Private Fallback]');
    expect(getProviderIndicator('openrouter-augmented', true, true))
      .toBe('[External+Tools - Data Sanitized]');
  });
});

describe('getProviderEmoji', () => {
  it('returns empty for Claude', () => {
    expect(getProviderEmoji('claude')).toBe('');
  });

  it('returns shield for Venice', () => {
    expect(getProviderEmoji('venice')).toBe('\u{1F6E1}\u{FE0F}');
  });

  it('returns computer for Ollama', () => {
    expect(getProviderEmoji('ollama')).toBe('\u{1F4BB}');
  });

  it('returns warning for OpenRouter', () => {
    expect(getProviderEmoji('openrouter')).toBe('\u{26A0}\u{FE0F}');
  });

  it('returns stop for blocked', () => {
    expect(getProviderEmoji('blocked')).toBe('\u{1F6D1}');
  });
});

describe('buildProviderStatusLine', () => {
  it('returns empty for Claude', () => {
    expect(buildProviderStatusLine('claude', false, false)).toBe('');
  });

  it('builds full status line with emoji for Venice', () => {
    const line = buildProviderStatusLine('venice', false, true);
    expect(line).toContain('\u{1F6E1}');
    expect(line).toContain('[Venice - Private Fallback]');
  });

  it('builds full status line for OpenRouter', () => {
    const line = buildProviderStatusLine('openrouter', true, true);
    expect(line).toContain('\u{26A0}');
    expect(line).toContain('[External - Data Sanitized]');
  });
});
