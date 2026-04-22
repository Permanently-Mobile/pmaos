/**
 * Data Sanitization Pipeline -- Privacy Routing Layer
 *
 * Redacts, masks, or tokenizes sensitive data detected by the
 * SensitivityClassifier before messages are sent to non-privacy providers.
 *
 * Three modes:
 *   - redact: Replace with [REDACTED-PII], [REDACTED-FINANCIAL], etc.
 *   - mask: Partial masking (XXX-XX-1234, ****@email.com)
 *   - tokenize: Reversible tokens ([TOKEN_001]) with a stored mapping
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import type {
  SensitivityCategory,
  SensitivityResult,
  SanitizeOptions,
  SanitizeResult,
  Detection,
} from './types.js';

// ── Category labels for redaction tags ──────────────────────────────────

const REDACT_LABELS: Record<SensitivityCategory, string> = {
  pii: 'REDACTED-PII',
  financial: 'REDACTED-FINANCIAL',
  crypto: 'REDACTED-CRYPTO',
  medical: 'REDACTED-MEDICAL',
  legal: 'REDACTED-LEGAL',
  personal: 'REDACTED-PERSONAL',
};

// ── Sanitizer class ────────────────────────────────────────────────────

/**
 * Sanitizes messages by applying redactions based on SensitivityResult detections.
 * Takes detections from the classifier and applies the chosen sanitization mode.
 */
export class DataSanitizer {
  /**
   * Sanitize a message using detections from the SensitivityClassifier.
   *
   * @param message - The original message text
   * @param sensitivity - The SensitivityResult from the classifier
   * @param options - Sanitization mode and category filter
   * @returns Sanitized message with redaction count and optional token map
   */
  sanitize(message: string, sensitivity: SensitivityResult, options: SanitizeOptions): SanitizeResult {
    const { mode, categories } = options;

    // Filter detections by requested categories (default: all)
    let detections = sensitivity.detections;
    if (categories && categories.length > 0) {
      const catSet = new Set(categories);
      detections = detections.filter(d => catSet.has(d.category));
    }

    if (detections.length === 0) {
      return { sanitized: message, redactions: 0 };
    }

    // Sort detections by position (end first, then start) so we can replace
    // from the end of the string backward without shifting positions.
    const sorted = [...detections].sort((a, b) => {
      if (b.position.end !== a.position.end) return b.position.end - a.position.end;
      return b.position.start - a.position.start;
    });

    // De-duplicate overlapping detections -- keep the one with higher confidence
    const deduped = this.deduplicateDetections(sorted);

    switch (mode) {
      case 'redact':
        return this.applyRedact(message, deduped);
      case 'mask':
        return this.applyMask(message, deduped);
      case 'tokenize':
        return this.applyTokenize(message, deduped);
      default:
        return { sanitized: message, redactions: 0 };
    }
  }

  /**
   * Reverse tokenization -- restore original values from token map.
   *
   * @param sanitized - The tokenized message
   * @param tokenMap - Map of token -> original value
   * @returns The restored message
   */
  detokenize(sanitized: string, tokenMap: Map<string, string>): string {
    let result = sanitized;
    for (const [token, original] of tokenMap) {
      result = result.replace(token, original);
    }
    return result;
  }

  // ── Redact mode ──────────────────────────────────────────────────────

  private applyRedact(message: string, detections: Detection[]): SanitizeResult {
    let result = message;
    let redactions = 0;

    for (const det of detections) {
      const label = `[${REDACT_LABELS[det.category]}]`;
      result = result.slice(0, det.position.start) + label + result.slice(det.position.end);
      redactions++;
    }

    return { sanitized: result, redactions };
  }

  // ── Mask mode ────────────────────────────────────────────────────────

  private applyMask(message: string, detections: Detection[]): SanitizeResult {
    let result = message;
    let redactions = 0;

    for (const det of detections) {
      const masked = this.maskValue(det);
      result = result.slice(0, det.position.start) + masked + result.slice(det.position.end);
      redactions++;
    }

    return { sanitized: result, redactions };
  }

  /** Apply category-aware partial masking to a detected value. */
  private maskValue(detection: Detection): string {
    const val = detection.match;

    switch (detection.pattern) {
      case 'ssn':
        // XXX-XX-1234
        return 'XXX-XX-' + val.slice(-4);

      case 'email': {
        const atIdx = val.indexOf('@');
        if (atIdx > 0) {
          return '****' + val.slice(atIdx);
        }
        return '****@****';
      }

      case 'phone-us':
        // Keep last 4 digits
        return val.replace(/\d(?=\d{4})/g, '*');

      case 'credit-card':
        // ****-****-****-1234
        return val.replace(/\d(?=[\d\s-]{4,})/g, '*');

      case 'eth-address':
        // 0x1234...abcd
        return val.slice(0, 6) + '...' + val.slice(-4);

      case 'btc-address-legacy':
      case 'btc-address-bech32':
        return val.slice(0, 6) + '...' + val.slice(-4);

      case 'xpub':
        return val.slice(0, 8) + '...' + val.slice(-4);

      case 'account-number':
      case 'routing-number':
        // Show last 4
        return val.replace(/\d(?=\d{4})/g, '*');

      default:
        // Generic: replace middle portion with asterisks
        if (val.length <= 4) return '****';
        return val.slice(0, 2) + '*'.repeat(Math.max(val.length - 4, 2)) + val.slice(-2);
    }
  }

  // ── Tokenize mode ────────────────────────────────────────────────────

  private applyTokenize(message: string, detections: Detection[]): SanitizeResult {
    let result = message;
    let redactions = 0;
    const tokenMap = new Map<string, string>();
    let tokenCounter = 1;

    for (const det of detections) {
      const token = `[TOKEN_${String(tokenCounter).padStart(3, '0')}]`;
      tokenMap.set(token, det.match);
      result = result.slice(0, det.position.start) + token + result.slice(det.position.end);
      redactions++;
      tokenCounter++;
    }

    return { sanitized: result, redactions, tokenMap };
  }

  // ── Deduplication ────────────────────────────────────────────────────

  /**
   * Remove overlapping detections, keeping the higher-confidence one.
   * Input must be sorted by position (descending end, then descending start).
   */
  private deduplicateDetections(detections: Detection[]): Detection[] {
    if (detections.length <= 1) return detections;

    const result: Detection[] = [detections[0]];

    for (let i = 1; i < detections.length; i++) {
      const current = detections[i];
      const prev = result[result.length - 1];

      // Check for overlap (since sorted descending, current.start might overlap with prev)
      const overlaps =
        current.position.start < prev.position.end &&
        current.position.end > prev.position.start;

      if (overlaps) {
        // Keep the one with higher confidence
        if (current.confidence > prev.confidence) {
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
