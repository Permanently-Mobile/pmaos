/**
 * Prompt Injection Detection Layer
 * Scans incoming messages for prompt injection patterns before they reach the LLM.
 * Uses pattern matching + heuristic scoring. Lightweight, runs synchronously.
 *
 * Risk levels:
 *   0 = clean
 *   1 = low (suspicious but likely benign)
 *   2 = medium (likely injection attempt)
 *   3 = high (definite injection attempt, block or alert)
 */

export interface InjectionResult {
  risk: 0 | 1 | 2 | 3;
  score: number;
  triggers: string[];
  blocked: boolean;
}

interface PatternRule {
  name: string;
  pattern: RegExp;
  weight: number;
}

// ─── Pattern Categories ───────────────────────────────────────────────

const ROLE_HIJACK: PatternRule[] = [
  { name: 'ignore-previous', pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?|directives?)/i, weight: 8 },
  { name: 'you-are-now', pattern: /you\s+are\s+now\s+(a|an|the|my)\s+/i, weight: 6 },
  { name: 'new-instructions', pattern: /(?:new|updated|revised|real)\s+instructions?\s*:/i, weight: 7 },
  { name: 'act-as', pattern: /(?:act|behave|pretend|function)\s+as\s+(a|an|if)\s+/i, weight: 5 },
  { name: 'system-override', pattern: /\[?\s*system\s*(?:prompt|message|override|instruction)\s*[\]:]?/i, weight: 8 },
  { name: 'forget-everything', pattern: /forget\s+(everything|all|what)\s+(you|about)/i, weight: 7 },
  { name: 'disregard', pattern: /disregard\s+(all|any|every|your|the)\s+(previous|prior|above|safety|rules?|instructions?)/i, weight: 8 },
  { name: 'override-safety', pattern: /(?:override|bypass|disable|turn\s+off|ignore)\s+(?:your\s+)?(?:safety|content|ethical|moral)\s+(?:filters?|guidelines?|rules?|restrictions?|protocols?)/i, weight: 9 },
  { name: 'jailbreak-dan', pattern: /\b(?:DAN|do\s+anything\s+now|evil\s+mode|developer\s+mode|god\s+mode|unrestricted\s+mode)\b/i, weight: 9 },
  { name: 'roleplay-escape', pattern: /(?:stop|end|exit)\s+(?:being|playing|acting\s+as)\s+(?:assistant|ai|bot|helper)/i, weight: 6 },
];

const EXTRACTION: PatternRule[] = [
  { name: 'reveal-prompt', pattern: /(?:reveal|show|display|print|output|repeat|echo)\s+(?:your|the|system)\s+(?:system\s+)?(?:prompt|instructions?|rules?|directives?|context)/i, weight: 7 },
  { name: 'what-instructions', pattern: /what\s+(?:are|were)\s+your\s+(?:initial|original|system|hidden|secret)\s+(?:instructions?|prompts?|rules?|directives?)/i, weight: 6 },
  { name: 'copy-paste-prompt', pattern: /(?:copy|paste|dump|leak|exfiltrate)\s+(?:your|the|system)\s+(?:prompt|instructions?|config)/i, weight: 8 },
  { name: 'verbatim-above', pattern: /(?:repeat|recite|print)\s+(?:everything|verbatim|word\s+for\s+word)\s+(?:above|before|from\s+the\s+(?:start|beginning))/i, weight: 8 },
  { name: 'claude-md', pattern: /(?:contents?\s+of|show\s+me|read|cat|print)\s+(?:your\s+)?(?:CLAUDE\.md|claude\.md|system\s+prompt\s+file)/i, weight: 7 },
];

const DELIMITER_INJECTION: PatternRule[] = [
  { name: 'xml-system-tag', pattern: /<\/?(?:system|instructions?|prompt|rules?|context|assistant|human|user)>/i, weight: 5 },
  { name: 'markdown-system', pattern: /```(?:system|instructions?|prompt)\b/i, weight: 5 },
  { name: 'triple-dash-break', pattern: /^---+\s*$/m, weight: 1 },
  { name: 'fake-assistant', pattern: /(?:^|\n)\s*(?:Assistant|AI|Helper|Bot)\s*:\s*/i, weight: 4 },
  { name: 'end-of-prompt', pattern: /(?:END|STOP)\s+(?:OF\s+)?(?:SYSTEM\s+)?(?:PROMPT|INSTRUCTIONS?|CONTEXT)/i, weight: 7 },
];

const ENCODING_OBFUSCATION: PatternRule[] = [
  { name: 'base64-payload', pattern: /(?:base64|decode|atob|btoa)\s*[\(:]?\s*[A-Za-z0-9+/=]{40,}/i, weight: 6 },
  { name: 'hex-payload', pattern: /(?:\\x[0-9a-f]{2}){8,}/i, weight: 5 },
  { name: 'unicode-escape', pattern: /(?:\\u[0-9a-f]{4}){4,}/i, weight: 5 },
  { name: 'rot13-reference', pattern: /\brot13\b/i, weight: 3 },
  { name: 'leetspeak-ignore', pattern: /1gn0r3|pr3v10u5|1nstruct10n|syst3m|pr0mpt/i, weight: 4 },
];

const EXFILTRATION: PatternRule[] = [
  { name: 'send-to-url', pattern: /(?:send|post|upload|forward|transmit|fetch)\s+.{0,40}(?:to|at|via)\s+(?:https?:\/\/|ftp:\/\/)/i, weight: 7 },
  { name: 'webhook-mention', pattern: /(?:webhook|callback|endpoint|ngrok|requestbin|pipedream|hookbin)/i, weight: 5 },
  { name: 'curl-wget', pattern: /(?:curl|wget|fetch|requests?\.(?:get|post))\s+(?:https?:\/\/)/i, weight: 6 },
  { name: 'email-exfil', pattern: /(?:email|send\s+mail|smtp)\s+(?:to|this|all|the|my)\s+/i, weight: 3 },
];

const SOCIAL_ENGINEERING: PatternRule[] = [
  { name: 'helpful-must', pattern: /as\s+a\s+helpful\s+(?:assistant|AI|bot),?\s+you\s+(?:must|should|need\s+to|have\s+to)/i, weight: 5 },
  { name: 'for-research', pattern: /(?:this\s+is\s+)?(?:just\s+)?(?:for|purely\s+for)\s+(?:research|educational|academic|testing)\s+purposes?/i, weight: 4 },
  { name: 'hypothetical', pattern: /(?:hypothetically|in\s+theory|imagine\s+you\s+(?:could|were))\s+(?:ignore|bypass|override)/i, weight: 6 },
  { name: 'admin-override', pattern: /(?:admin|administrator|root|superuser|developer|maintenance)\s+(?:mode|override|access|command)/i, weight: 7 },
  { name: 'emergency-auth', pattern: /(?:emergency|urgent|critical)\s+(?:override|authorization|protocol|access)/i, weight: 5 },
  { name: 'creator-says', pattern: /(?:your\s+(?:creator|developer|programmer|owner|maker)\s+(?:said|told|wants|instructed))/i, weight: 6 },
  { name: 'openai-anthropic-says', pattern: /(?:anthropic|openai|claude\s+team)\s+(?:says?|told|wants?|instructed|approved|authorized)/i, weight: 7 },
];

const ALL_RULES: PatternRule[] = [
  ...ROLE_HIJACK,
  ...EXTRACTION,
  ...DELIMITER_INJECTION,
  ...ENCODING_OBFUSCATION,
  ...EXFILTRATION,
  ...SOCIAL_ENGINEERING,
];

// ─── Scoring Thresholds ───────────────────────────────────────────────

const THRESHOLD_LOW = 4;
const THRESHOLD_MEDIUM = 8;
const THRESHOLD_HIGH = 14;

// ─── Allow-list (the owner's legitimate patterns) ───────────────────────────

const ALLOWLIST_PATTERNS = [
  // The owner legitimately discusses Claude/system internals
  /(?:CLAUDE\.md|claude\.md)\s+(?:update|edit|change|add|modify)/i,
  // The owner legitimately asks about system prompt for debugging
  /(?:what|how)\s+(?:does|is)\s+(?:the|your)\s+(?:system\s+)?(?:check|config|setup)/i,
  // Legitimate dev commands
  /^(?:systems?\s+check|convolife|checkpoint)$/i,
];

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Scan a message for prompt injection patterns.
 * Returns risk level, cumulative score, triggered rule names, and whether to block.
 */
export function scanForInjection(message: string): InjectionResult {
  // Short messages are rarely injection attempts
  if (message.length < 15) {
    return { risk: 0, score: 0, triggers: [], blocked: false };
  }

  // Check allow-list first
  for (const allow of ALLOWLIST_PATTERNS) {
    if (allow.test(message)) {
      return { risk: 0, score: 0, triggers: [], blocked: false };
    }
  }

  let totalScore = 0;
  const triggers: string[] = [];

  for (const rule of ALL_RULES) {
    if (rule.pattern.test(message)) {
      totalScore += rule.weight;
      triggers.push(rule.name);
    }
  }

  // Density bonus: many triggers in a short message = more suspicious
  if (triggers.length >= 3 && message.length < 200) {
    totalScore += 3;
  }

  // Classify risk
  let risk: 0 | 1 | 2 | 3;
  if (totalScore >= THRESHOLD_HIGH) {
    risk = 3;
  } else if (totalScore >= THRESHOLD_MEDIUM) {
    risk = 2;
  } else if (totalScore >= THRESHOLD_LOW) {
    risk = 1;
  } else {
    risk = 0;
  }

  return {
    risk,
    score: totalScore,
    triggers,
    blocked: risk >= 3,
  };
}

/**
 * Format detection result for logging.
 */
export function formatDetection(result: InjectionResult, messagePreview: string): string {
  if (result.risk === 0) return '';
  const preview = messagePreview.length > 80 ? messagePreview.slice(0, 80) + '...' : messagePreview;
  const level = ['CLEAN', 'LOW', 'MEDIUM', 'HIGH'][result.risk];
  return `[prompt-guard] ${level} (score=${result.score}) triggers=[${result.triggers.join(', ')}] msg="${preview}"`;
}
