/**
 * Prime Directives -- HARDCODED, IMMUTABLE behavioral rules.
 *
 * These rules are compiled into the Paladin binary and CANNOT be
 * overridden by YAML policy, environment variables, or any agent.
 *
 * An attacker who gains write access to policy.yaml, .env, or even
 * CLAUDE.md still cannot bypass these rules. That's the point.
 *
 * To modify prime directives, you must:
 *   1. Edit this file directly
 *   2. Rebuild the project (npm run build)
 *   3. Restart Paladin
 *   4. The owner must approve the PR / commit
 *
 * DO NOT add configurable rules here. Those go in policy.yaml.
 * Prime directives are for ABSOLUTE rules that protect core safety.
 */

import type { Operation, CheckResult } from './paladin-types.js';

// ── Types ───────────────────────────────────────────────────────────

export interface PrimeDirective {
  id: string;
  description: string;
  check: (op: Operation) => CheckResult | null;  // null = no opinion (pass to next)
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Case-insensitive check if a string contains any of the patterns. */
function containsAny(str: string, patterns: string[]): boolean {
  const lower = str.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

// ── Family data patterns (names, addresses, SSN-like, etc.) ─────────
const FAMILY_DATA_PATTERNS = [
  // These are intentionally broad -- better to over-protect
  'social security', 'ssn', 'passport',
  'bank account', 'routing number', 'credit card',
  'medical record', 'health record',
  'date of birth', 'dob',
];

// ── Protected file paths ────────────────────────────────────────────
const SECURITY_FILES = [
  'prime-directives.ts',
  'prime-directives.js',
  'paladin.ts',
  'paladin.js',
  'paladin-client.ts',
  'paladin-client.js',
  'policy-loader.ts',
  'policy-loader.js',
  'prompt-guard.ts',
  'prompt-guard.js',
];

const CREDENTIAL_FILES = [
  '.env',
  '.env.age',
  'keys.txt',
  'credentials',
  'DB_PASSPHRASE',
];

// ── The Directives ──────────────────────────────────────────────────

export const PRIME_DIRECTIVES: PrimeDirective[] = [

  // ── 1. Protect Family Data ──────────────────────────────────────
  {
    id: 'protect-family-data',
    description: 'Never expose family personal data to external services or logs',
    check(op: Operation): CheckResult | null {
      // Check bash commands that might pipe sensitive data externally
      if (op.type === 'bash' && op.command) {
        const cmd = op.command;
        // Block curl/wget with family data patterns in the command
        if (/\bcurl\b|\bwget\b|\bfetch\b/i.test(cmd) && containsAny(cmd, FAMILY_DATA_PATTERNS)) {
          return { verdict: 'deny', reason: 'Attempted to send family data to external endpoint', directiveId: this.id };
        }
      }

      // Check file writes that might contain family data being sent externally
      if (op.type === 'writeFile' && op.content && op.filePath) {
        // Only flag if writing OUTSIDE the vault and content has sensitive patterns
        const isVaultWrite = op.filePath.includes('vault');
        if (!isVaultWrite && containsAny(op.content, FAMILY_DATA_PATTERNS)) {
          return { verdict: 'needs_approval', reason: 'File write contains potential family data outside vault', directiveId: this.id };
        }
      }

      return null; // no opinion
    },
  },

  // ── 2. Protect Security Layer ───────────────────────────────────
  {
    id: 'protect-security-layer',
    description: 'Never disable, modify, or circumvent security systems',
    check(op: Operation): CheckResult | null {
      if (op.type === 'writeFile' && op.filePath) {
        const filename = op.filePath.replace(/\\/g, '/').split('/').pop() || '';
        if (SECURITY_FILES.includes(filename)) {
          return { verdict: 'deny', reason: `Write to security file blocked: ${filename}`, directiveId: this.id };
        }
      }

      if (op.type === 'bash' && op.command) {
        // Block direct edits to security files via shell
        for (const sf of SECURITY_FILES) {
          if (op.command.includes(sf) && /\b(sed|awk|echo|cat\s*>|tee|mv|cp)\b/.test(op.command)) {
            return { verdict: 'deny', reason: `Shell edit of security file blocked: ${sf}`, directiveId: this.id };
          }
        }
      }

      return null;
    },
  },

  // ── 3. Protect System Prompt ────────────────────────────────────
  {
    id: 'protect-system-prompt',
    description: 'Never modify CLAUDE.md without explicit approval',
    check(op: Operation): CheckResult | null {
      if (op.type === 'writeFile' && op.filePath) {
        const normalized = op.filePath.replace(/\\/g, '/');
        if (normalized.endsWith('CLAUDE.md')) {
          return { verdict: 'needs_approval', reason: 'Modifying CLAUDE.md requires approval', directiveId: this.id };
        }
      }

      return null;
    },
  },

  // ── 4. Protect Credentials ──────────────────────────────────────
  {
    id: 'protect-credentials',
    description: 'Never expose API keys, tokens, passphrases, or encryption keys',
    check(op: Operation): CheckResult | null {
      if (op.type === 'readFile' && op.filePath) {
        const filename = op.filePath.replace(/\\/g, '/').split('/').pop() || '';
        if (CREDENTIAL_FILES.some(cf => filename.includes(cf))) {
          return { verdict: 'deny', reason: `Read of credential file blocked: ${filename}`, directiveId: this.id };
        }
      }

      if (op.type === 'bash' && op.command) {
        // Block commands that would dump credential files
        const cmd = op.command;
        for (const cf of CREDENTIAL_FILES) {
          if (cmd.includes(cf) && /\b(cat|type|more|less|head|tail|bat|print)\b/.test(cmd)) {
            return { verdict: 'deny', reason: `Shell read of credential file blocked: ${cf}`, directiveId: this.id };
          }
        }
      }

      return null;
    },
  },

  // ── 5. Protect Paladin ──────────────────────────────────────────
  {
    id: 'protect-paladin',
    description: 'Never allow agents to stop, modify, or restart Paladin',
    check(op: Operation): CheckResult | null {
      if (op.type === 'bash' && op.command) {
        const cmd = op.command.toLowerCase();
        // Block PM2 operations targeting paladin
        if (/pm2\s+(stop|delete|restart|kill)\s+paladin/.test(cmd)) {
          return { verdict: 'deny', reason: 'Cannot stop/restart Paladin via agent command', directiveId: this.id };
        }
        // Block kill signals to paladin
        if (/\bkill\b/.test(cmd) && cmd.includes('paladin')) {
          return { verdict: 'deny', reason: 'Cannot kill Paladin process', directiveId: this.id };
        }
      }

      return null;
    },
  },
];
