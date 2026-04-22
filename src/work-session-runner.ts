/**
 * Work Session Runner — Isolated subprocess that executes a Claude SDK query.
 *
 * Spawned by work-session.ts via child_process.fork().
 * Runs in its own Node process with its own PID.
 * Reads task from session directory, runs Claude, writes results back.
 * Self-enforces token budget via SDK's maxTurnTokens and manual tracking.
 * Sends real-time status updates via IPC to parent process.
 *
 * Usage: node work-session-runner.js <sessionDir>
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ── Configuration from environment ───────────────────────────────────

const SESSION_DIR = process.argv[2] || process.env.WORK_SESSION_DIR || '';
const SESSION_ID = process.env.WORK_SESSION_ID || 'unknown';
const BUDGET_USD = parseFloat(process.env.WORK_SESSION_BUDGET_USD || '2.0');
const TIMEOUT_MIN = parseInt(process.env.WORK_SESSION_TIMEOUT_MIN || '15', 10);

// PROJECT_ROOT from env or derive from script location
const PROJECT_ROOT = process.env.APEX_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');

if (!SESSION_DIR || !fs.existsSync(SESSION_DIR)) {
  console.error(`Session directory not found: ${SESSION_DIR}`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────

interface StatusUpdate {
  status?: string;
  tokensUsed?: number;
  outputTokens?: number;
  costUsd?: number;
  stage?: string;
  error?: string;
  result?: string;
}

function sendUpdate(update: StatusUpdate): void {
  // Write to status.json (durable)
  try {
    const statusPath = path.join(SESSION_DIR, 'status.json');
    const current = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    const merged = { ...current, ...update, updatedAt: Date.now() };
    fs.writeFileSync(statusPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch { /* ignore write failures */ }

  // Send via IPC to parent (real-time, non-blocking)
  if (process.send) {
    try { process.send(update); } catch { /* parent may have disconnected */ }
  }
}

function readEnvFile(keys: string[]): Record<string, string> {
  const candidates = [
    process.env.APEX_ROOT ? path.join(process.env.APEX_ROOT, '.env') : '',
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);

  let content: string | undefined;
  for (const envFile of candidates) {
    try {
      content = fs.readFileSync(envFile, 'utf-8');
      break;
    } catch { continue; }
  }
  if (!content) return {};

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

// ── Single-turn prompt generator (matches agent.ts pattern) ──────────

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

// ── Main execution ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read the task
  const taskPath = path.join(SESSION_DIR, 'task.txt');
  const task = fs.readFileSync(taskPath, 'utf-8');

  sendUpdate({ status: 'running', stage: 'Loading secrets and starting agent...' });

  // Read secrets (same pattern as agent.ts)
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  delete sdkEnv.CLAUDECODE;
  delete sdkEnv.CLAUDE_CODE_ENTRYPOINT;
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (secrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }

  // Token tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let lastStageUpdate = 0;
  let resultText: string | null = null;

  // Prepend work session context to the task prompt
  const wrappedTask = [
    `You are running inside an isolated work session (${SESSION_ID}).`,
    `Budget: $${BUDGET_USD} | Timeout: ${TIMEOUT_MIN} minutes.`,
    `Complete the task and provide a clear summary of what was done.`,
    `If you hit errors, document them clearly so the primary bot can review.`,
    '',
    '---',
    '',
    task,
  ].join('\n');

  sendUpdate({ stage: 'Agent query started...' });

  try {
    for await (const event of query({
      prompt: singleTurn(wrappedTask),
      options: {
        cwd: PROJECT_ROOT,
        resume: undefined, // Fresh session, no persistence
        settingSources: ['project', 'user'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: sdkEnv,
      },
    })) {
      const ev = event as Record<string, unknown>;

      // Track token usage from assistant events
      if (ev['type'] === 'assistant') {
        const msgUsage = (ev['message'] as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined;
        if (msgUsage) {
          totalInputTokens += msgUsage['input_tokens'] ?? 0;
          totalOutputTokens += msgUsage['output_tokens'] ?? 0;
        }

        // Throttle status updates to every 5 seconds
        const now = Date.now();
        if (now - lastStageUpdate > 5000) {
          lastStageUpdate = now;
          sendUpdate({
            tokensUsed: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd: totalCostUsd,
            stage: `Processing... (${Math.round(totalInputTokens / 1000)}k tokens)`,
          });
        }
      }

      // Track sub-agent lifecycle for stage updates
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started') {
        const desc = (ev['description'] as string) ?? 'Sub-task started';
        sendUpdate({ stage: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification') {
        const summary = (ev['summary'] as string) ?? 'Sub-task completed';
        sendUpdate({ stage: summary });
      }

      // Detect compaction
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        sendUpdate({ stage: 'Context compacted (getting large)' });
      }

      // Capture result
      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          totalInputTokens = evUsage['input_tokens'] ?? totalInputTokens;
          totalOutputTokens = evUsage['output_tokens'] ?? totalOutputTokens;
        }
        totalCostUsd = (ev['total_cost_usd'] as number) ?? 0;
      }

      // Manual budget check (backup for SDK enforcement)
      if (totalCostUsd > BUDGET_USD) {
        sendUpdate({
          status: 'budget_exceeded',
          stage: `Budget exceeded: $${totalCostUsd.toFixed(3)} > $${BUDGET_USD}`,
          tokensUsed: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd: totalCostUsd,
          error: `Token budget exceeded ($${totalCostUsd.toFixed(3)} of $${BUDGET_USD} limit)`,
        });
        break;
      }
    }

    // Write result
    const output = resultText ?? 'No output returned from agent.';
    fs.writeFileSync(path.join(SESSION_DIR, 'result.md'), output, 'utf-8');

    sendUpdate({
      status: 'completed',
      stage: 'Done',
      tokensUsed: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      result: output.length > 500 ? output.slice(0, 500) + '...' : output,
    });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Check if it's a budget error from the SDK
    const isBudgetError = errMsg.includes('budget') || errMsg.includes('max_budget');

    fs.writeFileSync(path.join(SESSION_DIR, 'error.txt'), errMsg, 'utf-8');

    sendUpdate({
      status: isBudgetError ? 'budget_exceeded' : 'failed',
      stage: 'Error',
      tokensUsed: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      error: errMsg,
    });

    // Write partial result if we got anything
    if (resultText) {
      fs.writeFileSync(path.join(SESSION_DIR, 'result.md'), resultText, 'utf-8');
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Runner fatal error:', err);
    sendUpdate({ status: 'failed', error: String(err) });
    process.exit(1);
  });
