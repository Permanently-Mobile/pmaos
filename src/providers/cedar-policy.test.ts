/**
 * Cedar Policy Engine -- Unit Tests
 *
 * Tests all policy rules, mode switching, fallback vs normal behavior,
 * command detection, and the full evaluate pipeline.
 *
 * Uses vitest (project test runner).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CedarPolicyEngine } from './cedar-policy.js';
import { CommandValidator } from './command-validator.js';
import type { PolicyContext, CedarPoliciesConfig } from './types.js';

// ── Test policy config ──────────────────────────────────────────────

const TEST_POLICIES: CedarPoliciesConfig = {
  policies: {
    critical_block: {
      patterns: [
        'rm -rf /',
        'DROP DATABASE',
        'DROP TABLE',
        'git push --force.*main',
        'shutdown',
        'format c:',
      ],
      action: 'forbid',
      reason: 'Destructive system command blocked by policy',
    },
    fallback_restricted: {
      patterns: [
        'npm publish',
        'git push',
        'pm2 delete',
        'pm2 restart',
        'docker rm',
        'kill -9',
        'sqlite3.*DELETE',
      ],
      action: 'forbid_on_fallback',
      reason: 'Write/destructive operation blocked during fallback mode',
    },
    fallback_approval: {
      patterns: [
        'npm install',
        'pip install',
        'git commit',
        'git merge',
        'mkdir',
        'touch',
      ],
      action: 'require_approval_on_fallback',
      reason: 'Installation/creation requires approval during fallback mode',
    },
    safe_operations: {
      patterns: [
        'git status',
        'git log',
        'git diff',
        'ls',
        'cat ',
        'pm2 status',
        'pm2 logs',
        'npm list',
        'node --version',
      ],
      action: 'permit',
      reason: 'Read-only operation',
    },
  },
};

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    provider: 'claude',
    intent: 'agent',
    sensitivityScore: 0,
    isFromFallback: false,
    ...overrides,
  };
}

// ── CedarPolicyEngine tests ────────────────────────────────────────

describe('CedarPolicyEngine', () => {
  let engine: CedarPolicyEngine;

  beforeEach(() => {
    engine = new CedarPolicyEngine();
    engine.loadPoliciesFromObject(TEST_POLICIES);
  });

  // ── Policy loading ────────────────────────────────────────────────

  describe('policy loading', () => {
    it('loads policies from object', () => {
      expect(engine.getRuleCount()).toBe(4);
    });

    it('handles empty config', () => {
      const empty = new CedarPolicyEngine();
      empty.loadPoliciesFromObject({ policies: {} });
      expect(empty.getRuleCount()).toBe(0);
    });
  });

  // ── Critical block (always forbidden) ─────────────────────────────

  describe('critical_block rules', () => {
    it('blocks rm -rf / in audit mode', () => {
      engine.setMode('audit');
      const decision = engine.evaluate('rm -rf /', makeContext());
      expect(decision.action).toBe('forbid');
      expect(decision.rule).toBe('critical_block');
    });

    it('blocks rm -rf / in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('rm -rf /', makeContext());
      expect(decision.action).toBe('forbid');
    });

    it('blocks DROP DATABASE regardless of mode', () => {
      engine.setMode('audit');
      const decision = engine.evaluate('sqlite3 mydb.db "DROP DATABASE main"', makeContext());
      expect(decision.action).toBe('forbid');
    });

    it('blocks git push --force main', () => {
      const decision = engine.evaluate('git push --force origin main', makeContext());
      expect(decision.action).toBe('forbid');
    });

    it('blocks shutdown command', () => {
      const decision = engine.evaluate('shutdown -h now', makeContext());
      expect(decision.action).toBe('forbid');
    });

    it('blocks format c: command', () => {
      const decision = engine.evaluate('format c:', makeContext());
      expect(decision.action).toBe('forbid');
    });
  });

  // ── Fallback restricted (blocked during fallback) ─────────────────

  describe('fallback_restricted rules', () => {
    it('permits npm publish in audit mode (Claude)', () => {
      engine.setMode('audit');
      const decision = engine.evaluate('npm publish', makeContext());
      expect(decision.action).toBe('permit');
      expect(decision.reason).toContain('[AUDIT]');
    });

    it('blocks npm publish in enforce mode (fallback)', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('npm publish', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('forbid');
      expect(decision.rule).toBe('fallback_restricted');
    });

    it('blocks git push in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('git push origin feature-branch', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('forbid');
    });

    it('blocks pm2 restart in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('pm2 restart apex-bot', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('forbid');
    });

    it('blocks kill -9 in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('kill -9 1234', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('forbid');
    });

    it('blocks sqlite3 DELETE in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('sqlite3 apex.db "DELETE FROM memories"', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('forbid');
    });

    it('blocks when isFromFallback is true even in audit mode', () => {
      engine.setMode('audit');
      const decision = engine.evaluate('npm publish', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('forbid');
    });
  });

  // ── Fallback approval (require approval during fallback) ──────────

  describe('fallback_approval rules', () => {
    it('permits npm install in audit mode (Claude)', () => {
      engine.setMode('audit');
      const decision = engine.evaluate('npm install express', makeContext());
      expect(decision.action).toBe('permit');
      expect(decision.reason).toContain('[AUDIT]');
    });

    it('requires approval for npm install in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('npm install express', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('require_approval');
      expect(decision.rule).toBe('fallback_approval');
    });

    it('requires approval for git commit in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('git commit -m "fix"', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('require_approval');
    });

    it('requires approval for mkdir in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('mkdir new-dir', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('require_approval');
    });

    it('requires approval for pip install in enforce mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('pip install requests', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('require_approval');
    });
  });

  // ── Safe operations (always permitted) ────────────────────────────

  describe('safe_operations rules', () => {
    it('permits git status', () => {
      const decision = engine.evaluate('git status', makeContext());
      expect(decision.action).toBe('permit');
      expect(decision.rule).toBe('safe_operations');
    });

    it('permits git log', () => {
      const decision = engine.evaluate('git log --oneline', makeContext());
      expect(decision.action).toBe('permit');
    });

    it('permits ls in any mode', () => {
      engine.setMode('enforce');
      const decision = engine.evaluate('ls -la', makeContext({ isFromFallback: true }));
      expect(decision.action).toBe('permit');
    });

    it('permits pm2 status', () => {
      const decision = engine.evaluate('pm2 status', makeContext());
      expect(decision.action).toBe('permit');
    });

    it('permits npm list', () => {
      const decision = engine.evaluate('npm list --depth=0', makeContext());
      expect(decision.action).toBe('permit');
    });

    it('permits node --version', () => {
      const decision = engine.evaluate('node --version', makeContext());
      expect(decision.action).toBe('permit');
    });
  });

  // ── Default behavior (no matching rule) ───────────────────────────

  describe('default behavior', () => {
    it('permits unknown commands (no matching rule)', () => {
      const decision = engine.evaluate('cowsay hello', makeContext());
      expect(decision.action).toBe('permit');
      expect(decision.rule).toBe('default');
    });
  });

  // ── Mode switching ────────────────────────────────────────────────

  describe('mode switching', () => {
    it('starts in audit mode by default', () => {
      const fresh = new CedarPolicyEngine();
      expect(fresh.getMode()).toBe('audit');
    });

    it('switches to enforce mode', () => {
      engine.setMode('enforce');
      expect(engine.getMode()).toBe('enforce');
    });

    it('switches back to audit mode', () => {
      engine.setMode('enforce');
      engine.setMode('audit');
      expect(engine.getMode()).toBe('audit');
    });
  });

  // ── evaluateOutput (full pipeline) ────────────────────────────────

  describe('evaluateOutput', () => {
    it('detects and evaluates commands in fenced code blocks', () => {
      const text = `Here's what I'll do:
\`\`\`bash
git status
npm install express
rm -rf /
\`\`\``;
      const results = engine.evaluateOutput(text, makeContext());
      expect(results.length).toBeGreaterThanOrEqual(3);

      const gitStatus = results.find(r => r.command.includes('git status'));
      expect(gitStatus?.decision.action).toBe('permit');

      const rmRf = results.find(r => r.command.includes('rm -rf /'));
      expect(rmRf?.decision.action).toBe('forbid');
    });

    it('hasBlockedCommands returns true when destructive command found', () => {
      const text = '```bash\nrm -rf /\n```';
      expect(engine.hasBlockedCommands(text, makeContext())).toBe(true);
    });

    it('hasBlockedCommands returns false for safe commands', () => {
      const text = '```bash\ngit status\nls -la\n```';
      expect(engine.hasBlockedCommands(text, makeContext())).toBe(false);
    });

    it('hasApprovalRequired returns true for install commands in enforce mode', () => {
      engine.setMode('enforce');
      const text = '```bash\nnpm install express\n```';
      expect(engine.hasApprovalRequired(text, makeContext({ isFromFallback: true }))).toBe(true);
    });
  });

  // ── Priority: critical > restricted > approval > safe ─────────────

  describe('rule priority', () => {
    it('critical_block overrides safe_operations', () => {
      // A command that matches both critical AND safe shouldn't happen in practice,
      // but if it did, critical should win
      const engine2 = new CedarPolicyEngine();
      engine2.loadPoliciesFromObject({
        policies: {
          safe: {
            patterns: ['shutdown'],
            action: 'permit',
            reason: 'Safe',
          },
          critical: {
            patterns: ['shutdown'],
            action: 'forbid',
            reason: 'Critical',
          },
        },
      });
      const decision = engine2.evaluate('shutdown', makeContext());
      expect(decision.action).toBe('forbid');
    });
  });
});

// ── CommandValidator tests ──────────────────────────────────────────

describe('CommandValidator', () => {
  let validator: CommandValidator;

  beforeEach(() => {
    validator = new CommandValidator();
  });

  describe('extractCommands', () => {
    it('extracts commands from bash code blocks', () => {
      const text = `Let me check:
\`\`\`bash
git status
npm list
\`\`\``;
      const commands = validator.extractCommands(text);
      expect(commands.length).toBe(2);
      expect(commands[0].command).toBe('git status');
      expect(commands[0].source).toBe('fenced-block');
      expect(commands[1].command).toBe('npm list');
    });

    it('extracts commands from shell code blocks', () => {
      const text = '```shell\nls -la /tmp\n```';
      const commands = validator.extractCommands(text);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('ls -la /tmp');
    });

    it('strips $ prefix from commands', () => {
      const text = '```bash\n$ git diff\n$ npm test\n```';
      const commands = validator.extractCommands(text);
      expect(commands.some(c => c.command === 'git diff')).toBe(true);
      expect(commands.some(c => c.command === 'npm test')).toBe(true);
    });

    it('skips comments in code blocks', () => {
      const text = '```bash\n# This is a comment\ngit status\n// Another comment\nnpm list\n```';
      const commands = validator.extractCommands(text);
      expect(commands.length).toBe(2);
      expect(commands.every(c => !c.command.startsWith('#') && !c.command.startsWith('//'))).toBe(true);
    });

    it('handles empty code blocks', () => {
      const text = '```bash\n```';
      const commands = validator.extractCommands(text);
      expect(commands.length).toBe(0);
    });

    it('extracts SQL statements', () => {
      const text = '```sql\nSELECT * FROM users;\nDROP TABLE secrets;\n```';
      const commands = validator.extractCommands(text);
      expect(commands.some(c => c.command.includes('SELECT'))).toBe(true);
      expect(commands.some(c => c.command.includes('DROP TABLE'))).toBe(true);
    });
  });

  describe('looksLikeCommand', () => {
    it('detects git commands', () => {
      expect(validator.looksLikeCommand('git push origin main')).toBe(true);
      expect(validator.looksLikeCommand('git status')).toBe(true);
    });

    it('detects npm commands', () => {
      expect(validator.looksLikeCommand('npm install express')).toBe(true);
      expect(validator.looksLikeCommand('npx vitest run')).toBe(true);
    });

    it('detects system commands', () => {
      expect(validator.looksLikeCommand('rm -rf /tmp/test')).toBe(true);
      expect(validator.looksLikeCommand('mkdir new-directory')).toBe(true);
    });

    it('detects docker commands', () => {
      expect(validator.looksLikeCommand('docker ps -a')).toBe(true);
      expect(validator.looksLikeCommand('docker rm container-id')).toBe(true);
    });

    it('detects pm2 commands', () => {
      expect(validator.looksLikeCommand('pm2 status')).toBe(true);
      expect(validator.looksLikeCommand('pm2 restart apex-bot')).toBe(true);
    });

    it('detects database CLI commands', () => {
      expect(validator.looksLikeCommand('sqlite3 apex.db "SELECT 1"')).toBe(true);
      expect(validator.looksLikeCommand('psql -U admin mydb')).toBe(true);
    });

    it('detects fs.writeFile calls', () => {
      expect(validator.looksLikeCommand('fs.writeFileSync("config.json", data)')).toBe(true);
    });

    it('does not detect normal text', () => {
      expect(validator.looksLikeCommand('Hello, how are you?')).toBe(false);
      expect(validator.looksLikeCommand('The git model is interesting')).toBe(false);
    });
  });
});
