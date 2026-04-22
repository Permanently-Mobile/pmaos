/**
 * ToolExecutor -- Lightweight local tool execution engine.
 *
 * Standalone module with ZERO AI dependencies. Executes safe, whitelisted
 * operations locally so that REST-based fallback providers can perform
 * basic tool actions when Claude is unavailable.
 *
 * Safety model: whitelist-only. Every bash command is checked against
 * allowed prefixes before execution. All executions are logged.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { PROJECT_ROOT } from '../config.js';
import { getResolvedBashPrefixes, getCompiledBlockedPatterns } from '../policy-loader.js';
import { paladinCheck } from '../paladin-client.js';
import { requestApproval } from '../permission-relay.js';
import type { Operation, CheckResult } from '../paladin-types.js';

// ── Constants ───────────────────────────────────────────────────────

const VAULT_PATH = process.env.VAULT_ROOT || '';
const DEFAULT_BASH_TIMEOUT_MS = 30_000;

// ── Tool result type ────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ── Tool definition (for system prompt injection) ───────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  args: Record<string, { type: string; description: string; required?: boolean }>;
}

// ── Bash whitelist (loaded from Paladin policy.yaml) ────────────────
// Rules are now managed in config/policy.yaml with hot-reload.
// Dynamic PROJECT_ROOT prefixes are injected by getResolvedBashPrefixes().
// Hardcoded fallback defaults live in src/policy-loader.ts.

// ── ToolExecutor class ──────────────────────────────────────────────

/** Tools that require manual approval when running in restricted (fallback) mode. */
const RESTRICTED_TOOLS = new Set(['writeFile', 'runBash']);

export class ToolExecutor {
  private projectRoot: string;
  private vaultPath: string;
  /** When true, writeFile and runBash require manual Telegram approval before execution.
   *  Used by ToolAugmentedProvider when a fallback model (not Claude) has tool access. */
  public restrictedMode: boolean;

  constructor(projectRoot: string, vaultPath = VAULT_PATH, restrictedMode = false) {
    this.projectRoot = projectRoot;
    this.vaultPath = vaultPath;
    this.restrictedMode = restrictedMode;
  }

  // ── Tool registry (for system prompt) ──────────────────────────

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'readFile',
        description: 'Read the contents of a file at the given absolute path. Returns file text or error.',
        args: {
          path: { type: 'string', description: 'Absolute file path to read', required: true },
        },
      },
      {
        name: 'writeFile',
        description: 'Write content to a file at the given absolute path. Creates parent dirs if needed.',
        args: {
          path: { type: 'string', description: 'Absolute file path to write', required: true },
          content: { type: 'string', description: 'File content to write', required: true },
        },
      },
      {
        name: 'searchFiles',
        description: 'Search for files matching a glob pattern or grep for text content in a directory.',
        args: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "*.md") or text to grep for', required: true },
          dir: { type: 'string', description: 'Directory to search in (absolute path)', required: true },
        },
      },
      {
        name: 'runBash',
        description: 'Execute a whitelisted bash command. Only safe, read-mostly commands are allowed (pm2, git, ls, cat, grep, node scripts). Destructive commands are blocked.',
        args: {
          command: { type: 'string', description: 'The bash command to execute', required: true },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
        },
      },
      {
        name: 'pm2Status',
        description: 'Get the current PM2 process status table. No arguments needed.',
        args: {},
      },
      {
        name: 'vaultRead',
        description: 'Read a file from the Obsidian vault using a relative path (e.g. "Tasks.md", "Daily Notes/2026-03-21.md").',
        args: {
          relativePath: { type: 'string', description: 'Path relative to the vault root', required: true },
        },
      },
      {
        name: 'vaultSearch',
        description: 'Search the Obsidian vault for files or content matching a query string.',
        args: {
          query: { type: 'string', description: 'Text to search for in the vault', required: true },
        },
      },
      {
        name: 'bridgeStatus',
        description: 'Get the current inter-agent bridge queue status (pending/completed tasks for agents).',
        args: {},
      },
    ];
  }

  // ── Tool execution dispatcher ──────────────────────────────────

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    logger.info({ tool: toolName, args, restrictedMode: this.restrictedMode }, 'ToolExecutor: executing tool');

    // ── Restricted mode gate (fallback providers) ────────────────
    // When a non-Claude fallback model has tool access, write and bash
    // operations require explicit approval from the user via Telegram.
    if (this.restrictedMode && RESTRICTED_TOOLS.has(toolName)) {
      const op = this.buildOperation(toolName, args);
      const reqId = `fallback-${toolName}-${Date.now()}`;
      const reason = `Fallback model requesting ${toolName} access (restricted mode)`;
      logger.info({ tool: toolName, reqId }, 'Restricted mode: requesting manual approval for write/bash');

      const verdict = await requestApproval(op, reqId, reason);
      if (verdict === 'deny') {
        logger.warn({ tool: toolName, reqId }, 'Restricted mode: write/bash DENIED by user');
        return { success: false, output: '', error: `Blocked: ${toolName} requires manual approval in fallback mode. The user denied the request.` };
      }
      logger.info({ tool: toolName, reqId }, 'Restricted mode: write/bash APPROVED by user');
      // Fall through to execution after approval
    }

    // ── Paladin security gate ────────────────────────────────────
    const paladinResult = await this.checkPaladin(toolName, args);
    if (paladinResult) {
      if (paladinResult.verdict === 'deny') {
        logger.warn({ tool: toolName, reason: paladinResult.reason }, 'Paladin DENIED operation');
        return { success: false, output: '', error: `Blocked by Paladin: ${paladinResult.reason}` };
      }
      if (paladinResult.verdict === 'needs_approval') {
        // Send approval request to the user via Telegram inline keyboard
        const requestId = paladinResult.requestId || 'unknown';
        const reason = paladinResult.reason || 'Operation requires approval';
        logger.info({ tool: toolName, reason, requestId }, 'Paladin requesting approval via Telegram');

        // Build the operation for the relay (reconstruct from checkPaladin)
        const op = this.buildOperation(toolName, args);
        const finalVerdict = await requestApproval(op, requestId, reason);

        if (finalVerdict === 'deny') {
          logger.warn({ tool: toolName, requestId }, 'Approval DENIED by user');
          return { success: false, output: '', error: `Operation denied by user: ${reason}` };
        }
        // Approved -- fall through to execution
        logger.info({ tool: toolName, requestId }, 'Approval GRANTED by user');
      }
    }

    try {
      switch (toolName) {
        case 'readFile':
          return this.readFile(args.path as string);
        case 'writeFile':
          return this.writeFile(args.path as string, args.content as string);
        case 'searchFiles':
          return this.searchFiles(args.pattern as string, args.dir as string);
        case 'runBash':
          return this.runBashTool(args.command as string, args.timeoutMs as number | undefined);
        case 'pm2Status':
          return this.pm2Status();
        case 'vaultRead':
          return this.vaultRead(args.relativePath as string);
        case 'vaultSearch':
          return this.vaultSearch(args.query as string);
        case 'bridgeStatus':
          return this.bridgeStatus();
        default:
          return { success: false, output: '', error: `Unknown tool: ${toolName}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ tool: toolName, err: msg }, 'ToolExecutor: tool execution failed');
      return { success: false, output: '', error: msg };
    }
  }

  // ── Individual tool implementations ────────────────────────────

  private readFile(filePath: string): ToolResult {
    if (!filePath) return { success: false, output: '', error: 'path is required' };

    try {
      const resolved = path.resolve(filePath);
      const content = fs.readFileSync(resolved, 'utf-8');
      // Cap output to avoid blowing up model context
      const trimmed = content.length > 50_000
        ? content.slice(0, 50_000) + '\n\n[... truncated at 50k chars ...]'
        : content;
      return { success: true, output: trimmed };
    } catch (err) {
      return { success: false, output: '', error: `Failed to read file: ${(err as Error).message}` };
    }
  }

  private writeFile(filePath: string, content: string): ToolResult {
    if (!filePath) return { success: false, output: '', error: 'path is required' };
    if (content === undefined || content === null) return { success: false, output: '', error: 'content is required' };

    try {
      const resolved = path.resolve(filePath);
      // Create parent directories if needed
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, content, 'utf-8');
      return { success: true, output: `File written: ${resolved}` };
    } catch (err) {
      return { success: false, output: '', error: `Failed to write file: ${(err as Error).message}` };
    }
  }

  private searchFiles(pattern: string, dir: string): ToolResult {
    if (!pattern) return { success: false, output: '', error: 'pattern is required' };
    if (!dir) return { success: false, output: '', error: 'dir is required' };

    try {
      const resolved = path.resolve(dir);
      if (!fs.existsSync(resolved)) {
        return { success: false, output: '', error: `Directory not found: ${resolved}` };
      }

      // Try grep-style search first (search file contents)
      const result = this.execSafe(`grep -r -l --include="*" "${pattern}" "${resolved}"`, 10_000);
      if (result.exitCode === 0 && result.stdout.trim()) {
        const files = result.stdout.trim().split('\n').slice(0, 50);
        return { success: true, output: files.join('\n') };
      }

      // Fallback: try as a glob/find pattern
      const findResult = this.execSafe(`find "${resolved}" -name "${pattern}" -type f 2>/dev/null`, 10_000);
      if (findResult.stdout.trim()) {
        const files = findResult.stdout.trim().split('\n').slice(0, 50);
        return { success: true, output: files.join('\n') };
      }

      return { success: true, output: 'No matches found.' };
    } catch (err) {
      return { success: false, output: '', error: `Search failed: ${(err as Error).message}` };
    }
  }

  private runBashTool(command: string, timeoutMs?: number): ToolResult {
    if (!command) return { success: false, output: '', error: 'command is required' };

    // Safety check
    const safetyCheck = this.isBashAllowed(command);
    if (!safetyCheck.allowed) {
      logger.warn({ command, reason: safetyCheck.reason }, 'ToolExecutor: blocked bash command');
      return { success: false, output: '', error: `Command blocked: ${safetyCheck.reason}` };
    }

    const result = this.execSafe(command, timeoutMs || DEFAULT_BASH_TIMEOUT_MS);
    const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');

    return {
      success: result.exitCode === 0,
      output: output.length > 30_000 ? output.slice(0, 30_000) + '\n[... truncated ...]' : output,
      error: result.exitCode !== 0 ? `Exit code ${result.exitCode}` : undefined,
    };
  }

  private pm2Status(): ToolResult {
    const result = this.execSafe('pm2 status', 10_000);
    return {
      success: result.exitCode === 0,
      output: result.stdout || result.stderr,
      error: result.exitCode !== 0 ? `pm2 status failed (exit ${result.exitCode})` : undefined,
    };
  }

  private vaultRead(relativePath: string): ToolResult {
    if (!relativePath) return { success: false, output: '', error: 'relativePath is required' };

    const fullPath = path.resolve(this.vaultPath, relativePath);
    const normalizedVault = path.resolve(this.vaultPath);
    if (!fullPath.startsWith(normalizedVault + path.sep) && fullPath !== normalizedVault) {
      return { success: false, output: '', error: 'Path traversal blocked' };
    }
    return this.readFile(fullPath);
  }

  private vaultSearch(query: string): ToolResult {
    if (!query) return { success: false, output: '', error: 'query is required' };

    return this.searchFiles(query, this.vaultPath);
  }

  private bridgeStatus(): ToolResult {
    const bridgeCli = path.join(this.projectRoot, 'dist', 'bridge-cli.js');
    const result = this.execSafe(`node "${bridgeCli}" status`, 10_000);
    return {
      success: result.exitCode === 0,
      output: result.stdout || result.stderr,
      error: result.exitCode !== 0 ? `Bridge status failed (exit ${result.exitCode})` : undefined,
    };
  }

  // ── Safety checks ─────────────────────────────────────────────

  private isBashAllowed(command: string): { allowed: boolean; reason?: string } {
    const trimmed = command.trim();

    // Check blocked patterns first (from Paladin policy)
    const blockedPatterns = getCompiledBlockedPatterns();
    for (const pattern of blockedPatterns) {
      if (pattern.test(trimmed)) {
        return { allowed: false, reason: `Matches blocked pattern: ${pattern.source}` };
      }
    }

    // Check whitelist (from Paladin policy + dynamic PROJECT_ROOT prefixes)
    const allowedPrefixes = getResolvedBashPrefixes();
    const isAllowed = allowedPrefixes.some(prefix => trimmed.startsWith(prefix));
    if (!isAllowed) {
      return { allowed: false, reason: `Command does not match any whitelisted prefix. Allowed: ${allowedPrefixes.slice(0, 5).join(', ')}...` };
    }

    return { allowed: true };
  }

  // ── Paladin integration ──────────────────────────────────────

  private async checkPaladin(toolName: string, args: Record<string, unknown>): Promise<CheckResult | null> {
    try {
      // Map tool execution to a Paladin Operation
      let op: Operation;
      switch (toolName) {
        case 'runBash':
          op = { type: 'bash', command: args.command as string, agent: 'tool-executor', timestamp: Date.now() };
          break;
        case 'readFile':
        case 'vaultRead':
          op = { type: 'readFile', filePath: args.path as string || args.relativePath as string, agent: 'tool-executor', timestamp: Date.now() };
          break;
        case 'writeFile':
          op = { type: 'writeFile', filePath: args.path as string, content: (args.content as string)?.slice(0, 500), agent: 'tool-executor', timestamp: Date.now() };
          break;
        case 'searchFiles':
        case 'vaultSearch':
          op = { type: 'searchFiles', command: args.pattern as string, agent: 'tool-executor', timestamp: Date.now() };
          break;
        case 'bridgeStatus':
        case 'pm2Status':
          // Low-risk read-only operations -- still check but fast path
          op = { type: 'bash', command: toolName === 'pm2Status' ? 'pm2 status' : 'bridge status', agent: 'tool-executor', timestamp: Date.now() };
          break;
        default:
          return null; // Unknown tool, let the executor handle it
      }

      return await paladinCheck(op);
    } catch (err) {
      // If Paladin client itself errors, log but don't block
      // (paladinCheck already fail-closes internally, this is a belt+suspenders catch)
      logger.error({ err: String(err), tool: toolName }, 'Paladin client error in tool-executor');
      return null;
    }
  }

  /** Build a Paladin Operation from tool name + args (shared by checkPaladin and approval flow). */
  private buildOperation(toolName: string, args: Record<string, unknown>): Operation {
    switch (toolName) {
      case 'runBash':
        return { type: 'bash', command: args.command as string, agent: 'tool-executor', timestamp: Date.now() };
      case 'readFile':
      case 'vaultRead':
        return { type: 'readFile', filePath: args.path as string || args.relativePath as string, agent: 'tool-executor', timestamp: Date.now() };
      case 'writeFile':
        return { type: 'writeFile', filePath: args.path as string, content: (args.content as string)?.slice(0, 500), agent: 'tool-executor', timestamp: Date.now() };
      case 'searchFiles':
      case 'vaultSearch':
        return { type: 'searchFiles', command: args.pattern as string, agent: 'tool-executor', timestamp: Date.now() };
      default:
        return { type: 'bash', command: toolName, agent: 'tool-executor', timestamp: Date.now() };
    }
  }

  // ── Safe exec wrapper ─────────────────────────────────────────

  private execSafe(command: string, timeoutMs: number): BashResult {
    try {
      const stdout = execSync(command, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024, // 5MB
        cwd: this.projectRoot,
        windowsHide: true,
      });
      return { stdout: stdout || '', stderr: '', exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
      return {
        stdout: execErr.stdout || '',
        stderr: execErr.stderr || execErr.message || '',
        exitCode: execErr.status ?? 1,
      };
    }
  }
}
