import { query } from '@anthropic-ai/claude-agent-sdk';

import { PROJECT_ROOT } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed';
  description: string;
}

export interface AgentResult {
  text: string | null;
  resumeToken: string | undefined;
  usage: UsageInfo | null;
  /** Which provider handled this message: 'claude', 'venice', or fallback provider name */
  provider?: string;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  timeoutMs?: number,
  model?: string,
  cwd?: string,
): Promise<AgentResult> {
  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  // Prevent "cannot launch inside another Claude Code session" error
  delete sdkEnv.CLAUDECODE;
  delete sdkEnv.CLAUDE_CODE_ENTRYPOINT;
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (secrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }

  let resumeToken: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  try {
    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length },
      'Starting agent query',
    );

    // ── Timeout wrapper ────────────────────────────────────────────────
    // Prevents indefinite hangs when the Claude subprocess stalls.
    // Model-aware defaults: Opus gets 15 min (deep work), others 10 min.
    // Workers pass their own timeout via timeoutMs parameter.
    const isOpus = model?.includes('opus');
    const defaultTimeout = isOpus ? 15 * 60 * 1000 : 10 * 60 * 1000;
    const effectiveTimeout = timeoutMs ?? defaultTimeout;

    const queryWork = (async () => {
      for await (const event of query({
        prompt: singleTurn(message),
        options: {
          // cwd = project root (or worker bot dir when cwd override is provided)
          cwd: cwd || PROJECT_ROOT,

          // Resume the previous session for this chat (persistent context)
          resume: sessionId,

          // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills/ and user settings
          settingSources: ['project', 'user'],

          // Skip all permission prompts — this is a trusted personal bot on your own machine
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,

          // Pass secrets to the subprocess without polluting our own process.env
          env: sdkEnv,

          // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5')
          ...(model ? { model } : {}),
        },
      })) {
        const ev = event as Record<string, unknown>;

        if (ev['type'] === 'system' && ev['subtype'] === 'init') {
          resumeToken = ev['session_id'] as string;
          logger.info({ resumeToken }, 'Session initialized');
        }

        // Detect auto-compaction (context window was getting full)
        if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
          didCompact = true;
          const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
          preCompactTokens = meta?.pre_tokens ?? null;
          logger.warn(
            { trigger: meta?.trigger, preCompactTokens },
            'Context window compacted',
          );
        }

        // Track per-call token usage from assistant message events.
        // Each assistant message represents one API call; its usage reflects
        // that single call's context size (not cumulative across the turn).
        if (ev['type'] === 'assistant') {
          const msgUsage = (ev['message'] as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined;
          const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
          const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
          if (callCacheRead > 0) {
            lastCallCacheRead = callCacheRead;
          }
          if (callInputTokens > 0) {
            lastCallInputTokens = callInputTokens;
          }
        }

        // Sub-agent lifecycle events — surface to Telegram for user feedback
        if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
          const desc = (ev['description'] as string) ?? 'Sub-agent started';
          onProgress({ type: 'task_started', description: desc });
        }
        if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
          const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
          const status = (ev['status'] as string) ?? 'completed';
          onProgress({
            type: 'task_completed',
            description: status === 'failed' ? `Failed: ${summary}` : summary,
          });
        }

        if (ev['type'] === 'result') {
          resultText = (ev['result'] as string | null | undefined) ?? null;

          // Extract usage info from result event
          const evUsage = ev['usage'] as Record<string, number> | undefined;
          if (evUsage) {
            usage = {
              inputTokens: evUsage['input_tokens'] ?? 0,
              outputTokens: evUsage['output_tokens'] ?? 0,
              cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
              totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
              didCompact,
              preCompactTokens,
              lastCallCacheRead,
              lastCallInputTokens,
            };
            logger.info(
              {
                inputTokens: usage.inputTokens,
                cacheReadTokens: usage.cacheReadInputTokens,
                lastCallCacheRead: usage.lastCallCacheRead,
                lastCallInputTokens: usage.lastCallInputTokens,
                costUsd: usage.totalCostUsd,
                didCompact,
              },
              'Turn usage',
            );
          }

          logger.info(
            { hasResult: !!resultText, subtype: ev['subtype'] },
            'Agent result received',
          );
        }
      }
    })();

    let queryTimeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutRace = new Promise<never>((_, reject) => {
      queryTimeoutHandle = setTimeout(() => {
        logger.error(
          { timeoutMs: effectiveTimeout, sessionId: sessionId ?? 'new' },
          'Agent query timed out -- breaking out of stalled query loop',
        );
        reject(new Error(`Agent query timed out after ${Math.round(effectiveTimeout / 60000)} minutes`));
      }, effectiveTimeout);
    });

    try {
      await Promise.race([queryWork, timeoutRace]);
    } catch (agentErr) {
      logger.error({ err: agentErr }, 'Agent query failed');
      throw agentErr instanceof Error ? agentErr : new Error(String(agentErr));
    } finally {
      clearTimeout(queryTimeoutHandle!);
    }
  } finally {
    clearInterval(typingInterval);
  }

  return { text: resultText, resumeToken, usage };
}
