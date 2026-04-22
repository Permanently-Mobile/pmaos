import { CronExpressionParser } from 'cron-parser';

import { ALLOWED_CHAT_ID } from './config.js';
import {
  getDueTasks,
  markTaskRunning,
  markTaskActive,
  updateTaskAfterRun,
  saveMemoryReturningId,
  saveEmbedding,
  type ScheduledTask,
} from './db.js';
import { logger } from './logger.js';
import { buildMemoryContext } from './memory.js';
import { embedText } from './memory-extract.js';
import { runWithFallback } from './fallback-model.js';
import { formatForTelegram } from './bot.js';
import { sendTask } from './bridge.js';
import { checkSessionBoundary } from './session-boundary.js';

type Sender = (text: string) => Promise<void>;

let sender: Sender;

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
export function initScheduler(send: Sender): void {
  // Internal automation -- disabled by default in release builds
  if (process.env.ENABLE_SCHEDULER !== 'true') {
    logger.info('Scheduler disabled (set ENABLE_SCHEDULER=true to enable)');
    return;
  }
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  setInterval(() => void runDueTasks(), 60_000);
  logger.info('Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  // Session boundary detection (piggybacks on the same 60s interval)
  checkSessionBoundary();

  // Check workflow cron triggers (piggybacks on the same 60s interval)
  try {
    const { checkCronTriggers } = await import('./workflow/index.js');
    checkCronTriggers();
  } catch {
    // Workflow system may not be initialized -- non-fatal
  }

  const tasks = getDueTasks();
  if (tasks.length === 0) return;

  logger.info({ count: tasks.length }, 'Running due scheduled tasks');

  for (const task of tasks) {
    logger.info({ taskId: task.id, agent: task.agent || 'local', prompt: task.prompt.slice(0, 60) }, 'Firing task');

    try {
      // Mark as running so the next scheduler tick doesn't pick it up again
      markTaskRunning(task.id);

      // Agent-scoped dispatch: route to a specific agent via bridge
      if (task.agent) {
        await runAgentScopedTask(task);
        continue;
      }

      // Local execution (existing behavior for agent=NULL tasks)

      // Phase 5 Feature 3b: Inject memory context into task prompt.
      // The task prompt becomes the search query, so a crypto task naturally
      // pulls prior crypto scan results, an audit pulls prior audit findings, etc.
      // This closes the bridge: output→memory (3a) + memory→input (3b).
      let contextualPrompt = task.prompt;
      if (ALLOWED_CHAT_ID) {
        try {
          const memCtx = await buildMemoryContext(ALLOWED_CHAT_ID, task.prompt);
          if (memCtx) {
            contextualPrompt = `${memCtx}\n\n${task.prompt}`;
            logger.debug({ taskId: task.id, ctxLen: memCtx.length }, 'Memory context injected into task');
          }
        } catch (memErr) {
          // Non-fatal: run the task without context rather than skipping it
          logger.warn({ err: memErr, taskId: task.id }, 'Memory context injection failed (running without)');
        }
      }

      // Run as a fresh agent call (no session — scheduled tasks are autonomous)
      // No start notification — only send the final result to keep Telegram clean.
      const result = await runWithFallback(contextualPrompt, undefined, () => {});
      const text = result.text?.trim() || 'Task completed with no output.';

      // Convention: if the LLM output contains [SILENT], suppress Telegram notification.
      // Used by rotation tasks that frequently no-op (e.g. cooldown not elapsed).
      const isSilent = text.includes('[SILENT]');
      if (!isSilent) {
        await sender(formatForTelegram(text));
      } else {
        logger.info({ taskId: task.id }, 'Task returned [SILENT] — suppressing Telegram output');
      }

      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, text);

      // Phase 5 Feature 3: Save task output to memory (fire-and-forget)
      if (!isSilent && text.length > 50 && ALLOWED_CHAT_ID) {
        saveTaskOutputToMemory(task.id, task.prompt, text).catch((err) => {
          logger.error({ err, taskId: task.id }, 'Task memory save failed (non-fatal)');
        });
      }

      logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed');
      // Reset to active so it can be retried on next cycle
      markTaskActive(task.id);
      try {
        await sender(`Task failed: "${task.prompt.slice(0, 60)}..." -- check logs.`);
      } catch {
        // ignore send failure
      }
    }
  }
}

/**
 * Dispatch an agent-scoped scheduled task via the bridge queue.
 * The target agent picks it up through normal bridge polling,
 * and results are delivered to Telegram by the bridge inbox handler.
 */
async function runAgentScopedTask(task: ScheduledTask): Promise<void> {
  const agent = task.agent!;
  // Research agents get longer timeout (deep research); others get 30 min
  const timeoutMinutes = agent.startsWith('researcher') ? 90 : 30;
  // Research agents get 12h TTL (2h cooldown between tasks); others get 60 min
  const ttlMinutes = agent.startsWith('researcher') ? 720 : 60;

  const bridgeId = sendTask(
    process.env.BOT_NAME || 'apex-bot',
    agent,
    { prompt: task.prompt, timeout_minutes: timeoutMinutes },
    1,       // priority: low (scheduled, not urgent)
    ttlMinutes,
  );

  const nextRun = computeNextRun(task.schedule);
  updateTaskAfterRun(task.id, nextRun, `Dispatched to ${agent} (bridge: ${bridgeId})`);

  logger.info(
    { taskId: task.id, agent, bridgeId, nextRun },
    'Agent-scoped task dispatched via bridge',
  );
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}

// ── Phase 5 Feature 3: Scheduled Task Context Bridging ──────────────

/** Keyword sets for topic derivation from task prompts. */
const TOPIC_KEYWORDS: Array<[string, RegExp]> = [
  ['tools', /\b(security|audit|scan|health|systems?\s*check|log|pm2|sysmon|encrypt)\b/i],
  ['crypto', /\b(trad|crypto|bitcoin|btc|eth|defi|market|price|token|swap|portfolio)\b/i],
  ['projects', /\b(build|deploy|project|kiosk|avatar|agent)\b/i],
  ['personal', /\b(family|spouse|child|personal|birthday|reminder)\b/i],
];

/**
 * Derive a topic_key from a task prompt by keyword matching.
 */
function deriveTaskTopic(prompt: string): string {
  for (const [topic, pattern] of TOPIC_KEYWORDS) {
    if (pattern.test(prompt)) return topic;
  }
  return 'general';
}

/**
 * Save a scheduled task's output as a memory.
 * Stored as episodic memories with a [Scheduled] prefix so they're
 * naturally surfaced by hybrid search when the topic is relevant.
 *
 * Salience is based on output length:
 *   <100 chars -> 1.5 (trivial ack)
 *   100-500    -> 2.5 (moderate report)
 *   >500       -> 3.5 (detailed report)
 *
 * Fire-and-forget: never throws, logs errors internally.
 */
async function saveTaskOutputToMemory(
  taskId: string,
  prompt: string,
  output: string,
): Promise<void> {
  if (!ALLOWED_CHAT_ID) return;

  const topicKey = deriveTaskTopic(prompt);
  const shortId = taskId.slice(0, 8);

  // Calculate salience from output significance
  let salience = 1.5;
  if (output.length >= 500) salience = 3.5;
  else if (output.length >= 100) salience = 2.5;

  // Build memory content: prefix + truncated output
  const truncated = output.length > 500 ? output.slice(0, 497) + '...' : output;
  const content = `[Scheduled: ${shortId}] ${truncated}`;

  const memId = saveMemoryReturningId(
    ALLOWED_CHAT_ID,
    content,
    'episodic',
    topicKey,
    salience,
  );

  // Embed for vector search (fire-and-forget)
  const embedding = await embedText(content);
  if (embedding) {
    saveEmbedding(memId, embedding, 'text-embedding-bge-m3', ALLOWED_CHAT_ID);
  }

  logger.debug({ memId, taskId: shortId, topic: topicKey }, 'Task output saved to memory');
}
