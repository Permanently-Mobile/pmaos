/**
 * AiderAgentProvider -- Wraps the Aider CLI into the AgentProvider interface.
 *
 * Aider is an open-source AI coding assistant that edits code in git repos.
 * It supports multiple LLM backends (GPT-4, Claude, Gemini, DeepSeek, Ollama).
 *
 * This provider spawns Aider as a subprocess with:
 *   --message "prompt"       Run non-interactively with a single prompt
 *   --yes                    Auto-accept all changes (non-interactive)
 *   --no-auto-commits        We manage git ourselves (audit pipeline)
 *   --no-pretty              Plain text output (no ANSI styling)
 *   --no-stream              Collect full output (simpler parsing)
 *
 * Model selection: set AIDER_MODEL env var or pass via execute(model).
 * Aider reads its own API keys from env (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
 *
 * Install: pip install aider-chat
 */

import { spawn } from 'child_process';
import type {
  AgentProvider,
  ProviderResult,
  ProviderCapability,
  ProviderHealth,
  NormalizedUsage,
} from './types.js';
import type { AgentProgressEvent } from '../agent.js';
import { logger } from '../logger.js';

// -- Constants ---------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

// -- AiderAgentProvider ------------------------------------------------------

export class AiderAgentProvider implements AgentProvider {
  readonly name = 'aider';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'chat', 'tools', 'code-gen',
  ]);

  private _defaultModel: string;

  constructor(defaultModel?: string) {
    this._defaultModel = defaultModel || process.env.AIDER_MODEL || DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    // Check if aider binary is reachable
    try {
      const { execSync } = require('child_process');
      execSync('which aider', { stdio: 'pipe', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  defaultModel(): string {
    return this._defaultModel;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const version = await this.runAiderCommand(['--version'], HEALTH_CHECK_TIMEOUT_MS);
      const latencyMs = Date.now() - start;

      if (version.exitCode === 0) {
        return {
          status: 'healthy',
          latencyMs,
          lastChecked: Date.now(),
          consecutiveFailures: 0,
        };
      }

      return {
        status: 'down',
        latencyMs,
        lastChecked: Date.now(),
        lastError: `aider --version exited ${version.exitCode}`,
        consecutiveFailures: 0,
      };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: null,
        lastChecked: Date.now(),
        lastError: err instanceof Error ? err.message : 'Aider not installed',
        consecutiveFailures: 0,
      };
    }
  }

  async execute(
    message: string,
    _resumeToken: string | undefined,
    onTyping: () => void,
    onProgress?: (event: AgentProgressEvent) => void,
    timeoutMs?: number,
    model?: string,
    cwd?: string,
  ): Promise<ProviderResult> {
    const useModel = model || this._defaultModel;
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

    logger.info({ provider: this.name, model: useModel, cwd }, 'Aider execution started');
    onTyping();

    if (onProgress) {
      onProgress({ type: 'task_started', description: `Aider (${useModel}) processing` });
    }

    // Build aider command args
    const args = [
      '--message', message,
      '--yes',
      '--no-auto-commits',
      '--no-pretty',
      '--no-stream',
      '--model', useModel,
    ];

    // Execute aider
    const result = await this.runAiderCommand(args, timeout, cwd, onTyping);

    if (onProgress) {
      onProgress({
        type: 'task_completed',
        description: result.exitCode === 0 ? 'Aider completed' : `Aider exited ${result.exitCode}`,
      });
    }

    // Parse output
    const outputText = result.stdout.trim() || result.stderr.trim() || '(no output)';
    const isSuccess = result.exitCode === 0;

    // Aider doesn't expose token counts via CLI, so usage is estimated
    const usage: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null,
      provider: this.name,
      model: useModel,
    };

    const responseText = isSuccess
      ? `[Aider: ${useModel}]\n\n${outputText}`
      : `[Aider: ${useModel} -- exit ${result.exitCode}]\n\n${outputText}`;

    logger.info(
      { provider: this.name, model: useModel, exitCode: result.exitCode, outputLen: outputText.length },
      'Aider execution completed',
    );

    return {
      text: responseText,
      resumeToken: undefined, // Aider doesn't maintain sessions
      usage,
      provider: this.name,
      model: useModel,
    };
  }

  // -- Internal helpers ------------------------------------------------------

  private runAiderCommand(
    args: string[],
    timeoutMs: number,
    cwd?: string,
    onTyping?: () => void,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('aider', args, {
        cwd: cwd || process.cwd(),
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure aider doesn't try to open a browser or prompt
          AIDER_NO_BROWSER: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      let typingInterval: ReturnType<typeof setInterval> | null = null;

      // Keep typing indicator alive during execution
      if (onTyping) {
        typingInterval = setInterval(onTyping, 4000);
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (typingInterval) clearInterval(typingInterval);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      proc.on('error', (err) => {
        if (typingInterval) clearInterval(typingInterval);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('Aider is not installed. Install with: pip install aider-chat'));
        } else {
          reject(err);
        }
      });

      // Close stdin immediately (non-interactive)
      proc.stdin.end();
    });
  }
}
