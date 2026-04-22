/**
 * Content-Based Sensitivity Classifier -- Privacy Routing Layer
 *
 * Analyzes message content for sensitive data patterns (PII, financial,
 * crypto, medical, legal, personal) and returns a scored assessment
 * with routing recommendations.
 *
 * All pattern matching is synchronous -- no async in the hot path.
 * Regex patterns are compiled once at instantiation.
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import type {
  SensitivityCategory,
  SensitivityResult,
  SensitivityConfig,
  Detection,
} from './types.js';

// ── Pattern definitions ────────────────────────────────────────────────

interface PatternDef {
  name: string;
  regex: RegExp;
  confidence: number;
}

/** PII patterns: SSN, phone, email, physical address, date of birth. */
export const PII_PATTERNS: PatternDef[] = [
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g, confidence: 0.95 },
  { name: 'ssn-no-dash', regex: /\b(?<!\d)\d{9}(?!\d)\b/g, confidence: 0.5 },
  { name: 'phone-us', regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, confidence: 0.7 },
  { name: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, confidence: 0.9 },
  { name: 'address', regex: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Pl|Place|Way|Cir|Circle)\.?\b/gi, confidence: 0.7 },
  { name: 'dob', regex: /\b(?:date of birth|dob|born on|birthday)[:\s]+\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/gi, confidence: 0.85 },
  { name: 'dob-format', regex: /\b(?:0[1-9]|1[0-2])[/\-.](?:0[1-9]|[12]\d|3[01])[/\-.]\d{4}\b/g, confidence: 0.4 },
];

/** Financial patterns: dollar amounts > $1000, account/routing numbers, credit cards, bank references. */
export const FINANCIAL_PATTERNS: PatternDef[] = [
  { name: 'dollar-large', regex: /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g, confidence: 0.8 },
  { name: 'dollar-1k-plus', regex: /\$\s?(?:[1-9]\d{3,})(?:\.\d{2})?\b/g, confidence: 0.75 },
  { name: 'account-number', regex: /\b(?:account|acct)[#:\s]*\d{8,17}\b/gi, confidence: 0.9 },
  { name: 'routing-number', regex: /\b(?:routing|aba|transit)[#:\s]*\d{9}\b/gi, confidence: 0.9 },
  { name: 'credit-card', regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, confidence: 0.95 },
  { name: 'bank-balance', regex: /\b(?:balance|deposit|withdraw|transfer)[:\s]+\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/gi, confidence: 0.7 },
  { name: 'bank-name-amount', regex: /\b(?:Chase|Wells Fargo|Bank of America|Citi|Capital One|TD Bank|PNC|US Bank|USAA|Schwab|Fidelity|Vanguard)[^.]{0,30}\$\d+/gi, confidence: 0.8 },
];

/** Crypto patterns: wallet addresses, seed phrases, private keys, exchange balances. */
export const CRYPTO_PATTERNS: PatternDef[] = [
  { name: 'eth-address', regex: /\b0x[0-9a-fA-F]{40}\b/g, confidence: 0.95 },
  { name: 'btc-address-legacy', regex: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, confidence: 0.8 },
  { name: 'btc-address-bech32', regex: /\bbc1[a-z0-9]{39,59}\b/g, confidence: 0.95 },
  { name: 'xpub', regex: /\b[xyz]pub[1-9A-HJ-NP-Za-km-z]{107,108}\b/g, confidence: 0.95 },
  { name: 'seed-phrase', regex: /\b(?:seed\s+phrase|recovery\s+phrase|mnemonic)[:\s]+(?:\w+\s+){11,23}\w+/gi, confidence: 0.95 },
  { name: 'private-key-hex', regex: /\b(?:private\s+key|priv\s*key)[:\s]+[0-9a-fA-F]{64}\b/gi, confidence: 0.95 },
  { name: 'exchange-balance', regex: /\b(?:Coinbase|Binance|Kraken|Gemini|FTX|Bybit|KuCoin|OKX|Bitfinex|Bitstamp)[^.]{0,30}(?:\d+\.?\d*\s*(?:BTC|ETH|SOL|XRP|ADA|DOT|AVAX|MATIC|LINK|UNI|USDT|USDC|DAI))/gi, confidence: 0.8 },
  { name: 'token-amount-large', regex: /\b\d+\.?\d*\s*(?:BTC|ETH|SOL|XRP|ADA)\b/gi, confidence: 0.5 },
];

/** Medical patterns: record numbers, diagnoses, medications, HIPAA terms. */
export const MEDICAL_PATTERNS: PatternDef[] = [
  { name: 'medical-record', regex: /\b(?:MRN|medical record|patient id|chart)[#:\s]*[A-Z0-9]{6,15}\b/gi, confidence: 0.9 },
  { name: 'diagnosis', regex: /\b(?:diagnosed with|diagnosis|dx)[:\s]+[A-Za-z\s]{3,50}/gi, confidence: 0.75 },
  { name: 'medication', regex: /\b(?:prescribed|taking|medication|rx)[:\s]+(?:Adderall|Ambien|Ativan|Celexa|Cipro|Clonazepam|Gabapentin|Hydrocodone|Lexapro|Lisinopril|Metformin|Oxycodone|Prozac|Sertraline|Tramadol|Valium|Xanax|Zoloft)\b/gi, confidence: 0.85 },
  { name: 'hipaa-terms', regex: /\b(?:patient|diagnosis|prescription|medical record|treatment plan|lab results|health insurance|HIPAA|protected health)\b/gi, confidence: 0.4 },
  { name: 'icd-code', regex: /\b[A-Z]\d{2}(?:\.\d{1,4})?\b/g, confidence: 0.3 },
];

/** Legal patterns: case numbers, attorney-client references, court names, privilege language. */
export const LEGAL_PATTERNS: PatternDef[] = [
  { name: 'case-number', regex: /\b(?:case|docket|cause)[#:\s]*(?:\d{2,4}[-:][A-Z]{2,4}[-:]\d{3,8}|\d{4}[-\s]?[A-Z]{2}\d{4,8})\b/gi, confidence: 0.9 },
  { name: 'attorney-client', regex: /\b(?:attorney.client|lawyer.client|privileged|confidential communication|work product|legal privilege)\b/gi, confidence: 0.85 },
  { name: 'court-name', regex: /\b(?:(?:U\.?S\.?\s+)?(?:District|Circuit|Supreme|Superior|Municipal|Family|Bankruptcy|Tax|Appeals)\s+Court|Court of (?:Appeals|Claims))\b/gi, confidence: 0.7 },
  { name: 'legal-privilege', regex: /\b(?:attorney.client privilege|work product doctrine|litigation hold|under seal|confidential.*legal)\b/gi, confidence: 0.85 },
];

// ── Scoring thresholds ─────────────────────────────────────────────────

const SCORE_PII = 0.6;
const SCORE_HIGH_SENSITIVITY = 0.7;  // financial, crypto, medical, legal
const SCORE_PERSONAL = 0.4;
const SCORE_MULTI_CATEGORY_BUMP = 0.1;
const SCORE_MAX = 1.0;
const THRESHOLD_PRIVACY = 0.6;
const THRESHOLD_BLOCK = 0.9;

// ── Classifier class ───────────────────────────────────────────────────

/**
 * Synchronous content-based sensitivity classifier.
 * Compiles all regex patterns once at construction.
 */
export class SensitivityClassifier {
  private patterns: Map<SensitivityCategory, PatternDef[]>;
  private personalNamePatterns: PatternDef[];

  constructor(config: SensitivityConfig) {
    this.patterns = new Map([
      ['pii', [...PII_PATTERNS]],
      ['financial', [...FINANCIAL_PATTERNS]],
      ['crypto', [...CRYPTO_PATTERNS]],
      ['medical', [...MEDICAL_PATTERNS]],
      ['legal', [...LEGAL_PATTERNS]],
    ]);

    // Build personal name patterns from config
    this.personalNamePatterns = config.personalNames
      .filter(name => name.length > 1)
      .map(name => ({
        name: `personal-name-${name.toLowerCase()}`,
        regex: new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi'),
        confidence: 0.7,
      }));

    // Merge custom patterns if provided
    if (config.customPatterns) {
      for (const [cat, pats] of Object.entries(config.customPatterns)) {
        const category = cat as SensitivityCategory;
        const existing = this.patterns.get(category) ?? [];
        const custom = pats?.map((r, i) => ({
          name: `custom-${category}-${i}`,
          regex: r,
          confidence: 0.8,
        })) ?? [];
        this.patterns.set(category, [...existing, ...custom]);
      }
    }
  }

  /**
   * Analyze a message for sensitive content.
   * Fully synchronous -- safe for the hot path.
   */
  classify(message: string): SensitivityResult {
    const detections: Detection[] = [];
    const triggeredCategories = new Set<SensitivityCategory>();

    // Run all category patterns
    for (const [category, patterns] of this.patterns) {
      for (const pat of patterns) {
        const matches = this.runPattern(message, pat, category);
        if (matches.length > 0) {
          triggeredCategories.add(category);
          detections.push(...matches);
        }
      }
    }

    // Run personal name patterns separately
    for (const pat of this.personalNamePatterns) {
      const matches = this.runPattern(message, pat, 'personal');
      if (matches.length > 0) {
        triggeredCategories.add('personal');
        detections.push(...matches);
      }
    }

    const categories = Array.from(triggeredCategories);
    const score = this.calculateScore(categories);
    const recommendation = this.scoreToRecommendation(score);

    return { score, categories, detections, recommendation };
  }

  /** Run a single pattern against the message, returning all matches. */
  private runPattern(message: string, pat: PatternDef, category: SensitivityCategory): Detection[] {
    const results: Detection[] = [];
    // Reset lastIndex for global regexps
    pat.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pat.regex.exec(message)) !== null) {
      results.push({
        category,
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
    return results;
  }

  /** Calculate the overall sensitivity score based on triggered categories. */
  private calculateScore(categories: SensitivityCategory[]): number {
    if (categories.length === 0) return 0;

    let score = 0;
    const hasHighSensitivity = categories.some(c =>
      c === 'financial' || c === 'crypto' || c === 'medical' || c === 'legal'
    );
    const hasPii = categories.includes('pii');
    const hasPersonalOnly = categories.length === 1 && categories[0] === 'personal';

    if (hasPersonalOnly) {
      score = SCORE_PERSONAL;
    } else if (hasHighSensitivity) {
      score = SCORE_HIGH_SENSITIVITY;
    } else if (hasPii) {
      score = SCORE_PII;
    } else {
      // personal + other combo
      score = SCORE_PERSONAL;
    }

    // Bump for multiple categories
    if (categories.length > 1) {
      score += SCORE_MULTI_CATEGORY_BUMP * (categories.length - 1);
    }

    return Math.min(score, SCORE_MAX);
  }

  /** Map a numeric score to a routing recommendation. */
  private scoreToRecommendation(score: number): 'standard' | 'privacy' | 'block' {
    if (score >= THRESHOLD_BLOCK) return 'block';
    if (score >= THRESHOLD_PRIVACY) return 'privacy';
    return 'standard';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
