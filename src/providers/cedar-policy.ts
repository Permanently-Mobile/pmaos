/**
 * Cedar Policy Engine -- Deterministic Command Guardrails
 *
 * Validates LLM-generated commands against a YAML policy file before execution.
 *
 * Two modes:
 *   audit   -- log violations during normal Claude operation (never blocks)
 *   enforce -- block + notify during fallback model operation
 *
 * Uses the existing audit-logger.ts for recording policy decisions.
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import fs from 'fs';
import yaml from 'js-yaml';

import type {
  CedarMode,
  PolicyContext,
  PolicyDecision,
  PolicyAction,
  PolicyRule,
  CedarPoliciesConfig,
} from './types.js';
import { CommandValidator } from './command-validator.js';
import { logger } from '../logger.js';

// ── CedarPolicyEngine class ────────────────────────────────────────

export class CedarPolicyEngine {
  private mode: CedarMode = 'audit';
  private rules: PolicyRule[] = [];
  private commandValidator: CommandValidator;

  constructor() {
    this.commandValidator = new CommandValidator();
  }

  /**
   * Load policy rules from a YAML file.
   * Expected format: { policies: { [name]: { patterns, action, reason } } }
   */
  loadPolicies(filePath: string): void {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(raw) as CedarPoliciesConfig;

      if (!parsed || !parsed.policies) {
        logger.warn({ filePath }, 'Cedar policy file has no policies section');
        return;
      }

      this.rules = [];

      for (const [name, policy] of Object.entries(parsed.policies)) {
        const compiledPatterns = policy.patterns.map((p: string) => {
          try {
            return new RegExp(p, 'i');
          } catch {
            logger.warn({ pattern: p, rule: name }, 'Invalid regex pattern in Cedar policy, using literal match');
            return new RegExp(escapeRegex(p), 'i');
          }
        });

        this.rules.push({
          name,
          patterns: compiledPatterns,
          action: policy.action as PolicyAction,
          reason: policy.reason,
        });
      }

      logger.info(
        { ruleCount: this.rules.length, filePath },
        'Cedar policies loaded',
      );
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to load Cedar policies');
      throw err;
    }
  }

  /**
   * Load policies from a pre-parsed object (for testing or inline config).
   */
  loadPoliciesFromObject(config: CedarPoliciesConfig): void {
    if (!config || !config.policies) return;

    this.rules = [];

    for (const [name, policy] of Object.entries(config.policies)) {
      const compiledPatterns = policy.patterns.map((p: string) => {
        try {
          return new RegExp(p, 'i');
        } catch {
          return new RegExp(escapeRegex(p), 'i');
        }
      });

      this.rules.push({
        name,
        patterns: compiledPatterns,
        action: policy.action as PolicyAction,
        reason: policy.reason,
      });
    }
  }

  /**
   * Evaluate a single command against loaded policies.
   *
   * Policy evaluation order:
   *   1. safe_operations (permit) -- checked first, short-circuits
   *   2. critical_block (forbid) -- always blocked
   *   3. fallback_restricted (forbid_on_fallback)
   *   4. fallback_approval (require_approval_on_fallback)
   *   5. Default: permit (no matching rule)
   */
  evaluate(command: string, context: PolicyContext): PolicyDecision {
    const normalizedCmd = command.trim();

    // Walk through rules in priority order
    let safeMatch: PolicyRule | null = null;
    let criticalMatch: PolicyRule | null = null;
    let restrictedMatch: PolicyRule | null = null;
    let approvalMatch: PolicyRule | null = null;

    for (const rule of this.rules) {
      const matched = rule.patterns.some(p => {
        p.lastIndex = 0;
        return p.test(normalizedCmd);
      });

      if (!matched) continue;

      switch (rule.action) {
        case 'permit':
          safeMatch = rule;
          break;
        case 'forbid':
          criticalMatch = rule;
          break;
        case 'forbid_on_fallback':
          restrictedMatch = rule;
          break;
        case 'require_approval_on_fallback':
          approvalMatch = rule;
          break;
      }
    }

    // Critical block always wins
    if (criticalMatch) {
      return {
        action: 'forbid',
        rule: criticalMatch.name,
        reason: criticalMatch.reason,
        mode: this.mode,
      };
    }

    // If explicitly safe, permit immediately
    if (safeMatch && !restrictedMatch && !approvalMatch) {
      return {
        action: 'permit',
        rule: safeMatch.name,
        reason: safeMatch.reason,
        mode: this.mode,
      };
    }

    // Fallback-restricted: block in enforce mode, audit in audit mode
    if (restrictedMatch) {
      if (this.mode === 'enforce' || context.isFromFallback) {
        return {
          action: 'forbid',
          rule: restrictedMatch.name,
          reason: restrictedMatch.reason,
          mode: this.mode,
        };
      }
      // Audit mode: log but permit
      return {
        action: 'permit',
        rule: restrictedMatch.name,
        reason: `[AUDIT] ${restrictedMatch.reason}`,
        mode: this.mode,
      };
    }

    // Fallback-approval: require approval in enforce mode, permit in audit mode
    if (approvalMatch) {
      if (this.mode === 'enforce' || context.isFromFallback) {
        return {
          action: 'require_approval',
          rule: approvalMatch.name,
          reason: approvalMatch.reason,
          mode: this.mode,
        };
      }
      // Audit mode: log but permit
      return {
        action: 'permit',
        rule: approvalMatch.name,
        reason: `[AUDIT] ${approvalMatch.reason}`,
        mode: this.mode,
      };
    }

    // Default: no matching rule, permit
    return {
      action: 'permit',
      rule: 'default',
      reason: 'No matching policy rule',
      mode: this.mode,
    };
  }

  /**
   * Evaluate all commands found in LLM output text.
   * Uses CommandValidator to extract commands first, then evaluates each.
   */
  evaluateOutput(text: string, context: PolicyContext): Array<{ command: string; decision: PolicyDecision }> {
    const commands = this.commandValidator.extractCommands(text);
    const results: Array<{ command: string; decision: PolicyDecision }> = [];

    for (const cmd of commands) {
      const decision = this.evaluate(cmd.command, context);
      results.push({ command: cmd.command, decision });
    }

    return results;
  }

  /**
   * Check if any command in the LLM output would be blocked.
   * Quick check for the router to decide if it should block execution.
   */
  hasBlockedCommands(text: string, context: PolicyContext): boolean {
    const results = this.evaluateOutput(text, context);
    return results.some(r => r.decision.action === 'forbid');
  }

  /**
   * Check if any command in the LLM output requires approval.
   */
  hasApprovalRequired(text: string, context: PolicyContext): boolean {
    const results = this.evaluateOutput(text, context);
    return results.some(r => r.decision.action === 'require_approval');
  }

  // ── Mode management ──────────────────────────────────────────────

  getMode(): CedarMode {
    return this.mode;
  }

  setMode(mode: CedarMode): void {
    const prev = this.mode;
    this.mode = mode;
    if (prev !== mode) {
      logger.info({ previousMode: prev, newMode: mode }, 'Cedar policy mode changed');
    }
  }

  // ── Accessors ────────────────────────────────────────────────────

  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  getRuleCount(): number {
    return this.rules.length;
  }

  getCommandValidator(): CommandValidator {
    return this.commandValidator;
  }
}

// ── Factory function ────────────────────────────────────────────────

/**
 * Create a CedarPolicyEngine with the default policy file loaded.
 * Falls back to an empty engine if the policy file is missing.
 */
export function createCedarPolicyEngine(policyFilePath?: string): CedarPolicyEngine {
  const engine = new CedarPolicyEngine();

  const filePath = policyFilePath ?? new URL('./cedar-policies.yaml', import.meta.url).pathname;

  // On Windows, import.meta.url gives file:///C:/... which URL.pathname
  // decodes to /C:/... -- strip the leading slash on Windows paths
  const normalizedPath = filePath.replace(/^\/([A-Za-z]:)/, '$1');

  try {
    if (fs.existsSync(normalizedPath)) {
      engine.loadPolicies(normalizedPath);
    } else {
      logger.warn({ filePath: normalizedPath }, 'Cedar policy file not found, engine will permit all commands');
    }
  } catch {
    logger.warn({ filePath: normalizedPath }, 'Failed to load Cedar policies, engine will permit all commands');
  }

  return engine;
}

// ── Helpers ─────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
