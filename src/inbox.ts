/**
 * Inbox Processor
 *
 * Manages the flow of results from agents (researcher, coder, processor, etc.)
 * back to the user via Telegram, respecting priority tiers and conversation state.
 *
 * Priority tiers:
 *   3 (HIGH)   - Critical failures, trade emergencies -> immediate interrupt
 *   2 (MEDIUM) - Flagged "let me know" items -> next natural pause or idle
 *   1 (LOW)    - Research, routine completions -> batch during flow or idle
 *
 * Conversation state awareness:
 *   - Tracks the user's last message and the bot's last response timestamps
 *   - Attention override sets DIRECT_ATTENTION flag
 *   - Idle = no message from the user in 5+ minutes
 *   - Active = message within last 5 minutes
 */

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  getCompletedResults,
  acknowledgeResult,
  getTaskById,
  ResultPayload,
} from './bridge.js';
import {
  addInboxItem,
  getInboxByPriority,
  getPendingInbox,
  markInboxDelivered,
  countPendingInbox,
  pruneInbox,
  InboxItem,
} from './db.js';
import { logger } from './logger.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { processVaultFeedback } from './vault-feedback.js';
import { scanContent } from './wraith/guardrails.js';

// ── Conversation State ──────────────────────────────────────────────

export interface ConversationState {
  lastUserMessageAt: number;     // timestamp of the user's last message
  lastBotResponseAt: number;     // timestamp of the bot's last response
  inActiveSession: boolean;      // message within last 5 min
  attentionOverride: boolean;    // attention override was triggered this turn
}

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;       // 5 minutes
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;    // 30 minutes

// Module-level state (persists across polling cycles)
const state: ConversationState = {
  lastUserMessageAt: 0,
  lastBotResponseAt: 0,
  inActiveSession: false,
  attentionOverride: false,
};

/**
 * Update state when the user sends a message.
 */
export function onUserMessage(): void {
  state.lastUserMessageAt = Date.now();
  state.inActiveSession = true;
}

/**
 * Update state when the bot sends a response.
 */
export function onBotResponse(): void {
  state.lastBotResponseAt = Date.now();
}

/**
 * Set the attention override.
 * Cleared after the next inbox check cycle.
 */
export function setAttentionOverride(value: boolean): void {
  state.attentionOverride = value;
}

/**
 * Check if the user is currently idle (no message in 5+ minutes).
 */
export function isIdle(): boolean {
  return Date.now() - state.lastUserMessageAt > IDLE_THRESHOLD_MS;
}

/**
 * Check if the user is offline (no message in 30+ minutes).
 */
export function isOffline(): boolean {
  return Date.now() - state.lastUserMessageAt > OFFLINE_THRESHOLD_MS;
}

/**
 * Check if we're at a natural conversation pause.
 * True when the bot just responded and no new user message has come in.
 */
export function isNaturalPause(): boolean {
  return state.lastBotResponseAt > state.lastUserMessageAt &&
    Date.now() - state.lastBotResponseAt < 30_000; // within 30s of our last response
}

/**
 * Get the current conversation state (read-only snapshot).
 */
export function getConversationState(): Readonly<ConversationState> {
  return { ...state, inActiveSession: !isIdle() };
}

/**
 * Get the pending inbox count (for attention override responses).
 */
export function getPendingCount(): number {
  return countPendingInbox();
}

// ── Bridge -> Inbox Intake ──────────────────────────────────────────

/**
 * Poll the bridge for completed results and route them into the inbox.
 * This replaces the old direct-to-Telegram delivery in index.ts.
 */
// Agents whose results are stored but NOT delivered to Telegram.
// Results stay in bridge DB and can be reviewed on demand.
const SILENT_AGENTS = new Set(['coder-1']);

export function intakeBridgeResults(): void {
  try {
    const results = getCompletedResults(process.env.BOT_NAME || 'apex-bot', 5);

    for (const msg of results) {
      let payload: ResultPayload;
      try {
        payload = JSON.parse(msg.payload) as ResultPayload;
      } catch {
        acknowledgeResult(msg.id);
        continue;
      }

      // ── Guardrail scan: check result payload for injection patterns ──
      const scanSource = `bridge-result:${msg.from_agent || 'unknown'}`;
      const scanResult = scanContent(payload.summary || '', scanSource);

      if (scanResult.action === 'block') {
        logger.warn(
          { agent: msg.from_agent, msgId: msg.id, patterns: scanResult.matchedPatterns.length, details: scanResult.details },
          'GUARDRAIL BLOCKED bridge result -- payload contains injection patterns',
        );
        // Don't process, but acknowledge so it doesn't loop. Log for review.
        acknowledgeResult(msg.id);
        // Route a security alert to inbox instead
        const alertId = randomBytes(8).toString('hex');
        addInboxItem({
          id: alertId,
          source: 'wraith-guardrails',
          priority: 3,
          category: 'security',
          title: `BLOCKED: ${msg.from_agent} result failed guardrail scan`,
          content: `A result from ${msg.from_agent} was blocked by guardrail scanning.\n\n${scanResult.details}\n\nPatterns matched: ${scanResult.matchedPatterns.map(p => p.name).join(', ')}\n\nThe original payload has been discarded. Review bridge DB message ID: ${msg.id}`,
        });
        continue;
      }

      if (scanResult.action === 'flag') {
        logger.warn(
          { agent: msg.from_agent, msgId: msg.id, patterns: scanResult.matchedPatterns.length, details: scanResult.details },
          'GUARDRAIL FLAGGED bridge result -- processing with elevated priority',
        );
        // Still process, but bump priority to HIGH so owner sees it immediately
      }

      // Silent agents: acknowledge the bridge message (clears the queue)
      // but do NOT route into the inbox for Telegram delivery.
      // The bot reviews code agent output before surfacing anything to the user.
      if (SILENT_AGENTS.has(msg.from_agent)) {
        logger.info(
          { agent: msg.from_agent, msgId: msg.id },
          'Silent agent result acknowledged (not routed to Telegram)',
        );
        acknowledgeResult(msg.id);
        continue;
      }

      // Look up original task for context
      const originalTask = msg.parent_id ? getTaskById(msg.parent_id) : null;
      let taskPrompt = 'unknown task';
      let taskPriority = 1; // default low

      if (originalTask) {
        try {
          const taskPayload = JSON.parse(originalTask.payload);
          taskPrompt = taskPayload?.prompt?.slice(0, 200) || 'unknown task';
        } catch { /* ignore */ }
        // Inherit priority from the original dispatched task
        taskPriority = originalTask.priority || 1;
      }

      const agentLabel = msg.from_agent
        ? msg.from_agent.charAt(0).toUpperCase() + msg.from_agent.slice(1)
        : 'Agent';

      // Determine category from agent name
      const categoryMap: Record<string, string> = {
        'researcher-1': 'research',
        'coder-1': 'build',
        'processor-1': 'notes',
        scheduler: 'scheduled',
      };
      const category = categoryMap[msg.from_agent] || 'general';

      // Build content
      let content: string;
      let title: string;

      if (msg.msg_type === 'error') {
        content = `${agentLabel} failed: "${taskPrompt.slice(0, 80)}"\nReason: ${msg.error || 'unknown'}`;
        title = `${agentLabel}: FAILED`;
        // Errors auto-bump to at least medium priority
        if (taskPriority < 2) taskPriority = 2;
      } else {
        const cost = payload.cost_usd ? ` ($${payload.cost_usd.toFixed(3)})` : '';
        title = `${agentLabel} complete${cost}`;
        const reportNote = payload.report_path ? `\n\nFull report: ${payload.report_path}` : '';
        content = `${title}\n\n${payload.summary}${reportNote}`;
      }

      // Insert into inbox
      const inboxId = randomBytes(8).toString('hex');
      addInboxItem({
        id: inboxId,
        source: msg.from_agent || 'unknown',
        priority: taskPriority,
        category,
        title,
        content,
        report_path: payload.report_path,
        parent_task_id: msg.parent_id || undefined,
        original_prompt: taskPrompt.slice(0, 200),
      });

      logger.info(
        { inboxId, source: msg.from_agent, priority: taskPriority, title },
        'Bridge result routed to inbox',
      );

      // Acknowledge from bridge (remove from bridge queue)
      acknowledgeResult(msg.id);

      // Vault feedback: auto-update vault (daily log, research saves, etc.)
      try {
        processVaultFeedback({
          agent: msg.from_agent || 'unknown',
          prompt: taskPrompt,
          payload,
          msgType: msg.msg_type,
          title: title || `${agentLabel} task`,
        });
      } catch {
        // Vault feedback is fire-and-forget, never blocks inbox
      }

      // Write cooldown timestamp for completion-based scheduling.
      // Used by rotation tasks to enforce "2h after last job" cooldown.
      if (msg.from_agent) {
        try {
          const wsDir = path.join(process.cwd(), 'workspace');
          fs.mkdirSync(wsDir, { recursive: true });
          fs.writeFileSync(
            path.join(wsDir, `${msg.from_agent}-cooldown.txt`),
            String(Math.floor(Date.now() / 1000)),
          );
        } catch { /* non-critical */ }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Bridge intake error');
  }
}

// ── Inbox Delivery Engine ───────────────────────────────────────────

type SendFn = (text: string) => Promise<void>;

// Agents whose results route to the Workflow Telegram group instead of
// the owner's personal chat. Keeps research/audit noise off the main channel.
// HIGH priority (3) items ALWAYS go to personal chat regardless of source.
const WORKFLOW_ROUTED_AGENTS = new Set([
  'researcher-1',
  'researcher-2',
  'processor-1',
  'strategy-1',
]);

// Module-level send functions (set by startInboxSystem)
let sendPersonal: SendFn;
let sendWorkflow: SendFn | null = null;

/**
 * Pick the right send function for an inbox item.
 * HIGH priority always goes to personal chat (critical items shouldn't be buried).
 * Workflow-routed agents go to the workflow group if configured.
 * Everything else goes to personal chat.
 */
function pickSender(item: InboxItem): SendFn {
  if (item.priority >= 3) return sendPersonal;
  if (sendWorkflow && WORKFLOW_ROUTED_AGENTS.has(item.source)) return sendWorkflow;
  return sendPersonal;
}

/**
 * Process the inbox and deliver items based on priority + conversation state.
 *
 * @param send  Function to send a message to Telegram (personal chat)
 */
export function processInbox(send: SendFn): void {
  try {
    // ── HIGH PRIORITY (3): Always deliver immediately ──
    const highItems = getInboxByPriority(3, 10);
    for (const item of highItems) {
      deliverItem(item, pickSender(item));
    }

    // If attention override is active, skip medium/low delivery this cycle
    if (state.attentionOverride) {
      state.attentionOverride = false;
      return;
    }

    // ── MEDIUM PRIORITY (2): Conversation-aware delivery ──
    const mediumItems = getInboxByPriority(2, 5);
    if (mediumItems.length > 0) {
      if (isIdle()) {
        // User is idle -- deliver all medium items now
        for (const item of mediumItems) {
          deliverItem(item, pickSender(item));
        }
      } else if (isNaturalPause()) {
        // We're at a natural pause -- deliver one
        deliverItem(mediumItems[0], pickSender(mediumItems[0]));
      }
      // Otherwise: user is mid-conversation, hold them
    }

    // ── LOW PRIORITY (1): Batch during idle or mention at wrap-up ──
    const lowItems = getInboxByPriority(1, 20);
    if (lowItems.length > 0) {
      // Split into personal and workflow items for batching
      const personalItems = lowItems.filter(i => pickSender(i) === sendPersonal);
      const workflowItems = sendWorkflow ? lowItems.filter(i => pickSender(i) !== sendPersonal) : [];

      if (isIdle()) {
        // Deliver personal items
        if (personalItems.length >= 2) {
          deliverBatchSummary(personalItems, sendPersonal);
        } else if (personalItems.length === 1) {
          deliverItem(personalItems[0], sendPersonal);
        }

        // Deliver workflow items (no conversation-awareness needed for group)
        if (workflowItems.length >= 2) {
          deliverBatchSummary(workflowItems, sendWorkflow!);
        } else if (workflowItems.length === 1) {
          deliverItem(workflowItems[0], sendWorkflow!);
        }
      }
      // If user is active: hold everything. Items will surface
      // during natural conversation via the inbox mention hook.
    }

    // Prune old delivered/processed items (keep 7 days)
    pruneInbox(7);
  } catch (err) {
    logger.error({ err }, 'Inbox processing error');
  }
}

/**
 * Deliver a single inbox item to Telegram.
 */
function deliverItem(item: InboxItem, send: SendFn): void {
  const formatted = formatForTelegram(item.content);
  const dest = send === sendWorkflow ? 'workflow' : 'personal';
  for (const part of splitMessage(formatted)) {
    void send(part).catch((err) => {
      logger.error({ err, inboxId: item.id }, 'Failed to deliver inbox item');
    });
  }
  markInboxDelivered(item.id);
  logger.info({ inboxId: item.id, priority: item.priority, source: item.source, dest }, 'Inbox item delivered');
}

/**
 * Deliver a batch summary of low-priority items.
 */
function deliverBatchSummary(items: InboxItem[], send: SendFn): void {
  const lines = items.map((item) => `- ${item.title || item.source}`);
  const summary = `Inbox roundup (${items.length} items):\n\n${lines.join('\n')}\n\nWant details on any of these?`;

  const formatted = formatForTelegram(summary);
  for (const part of splitMessage(formatted)) {
    void send(part).catch((err) => {
      logger.error({ err }, 'Failed to deliver batch summary');
    });
  }

  // Mark all as delivered
  for (const item of items) {
    markInboxDelivered(item.id);
  }

  logger.info({ count: items.length }, 'Inbox batch summary delivered');
}

// ── Startup ─────────────────────────────────────────────────────────

/**
 * Start the inbox system: bridge intake (30s) + inbox processor (15s).
 *
 * @param send          Function to send a message to the owner's personal Telegram chat
 * @param workflowSend  Optional function to send to the Workflow Telegram group
 */
export function startInboxSystem(send: SendFn, workflowSend?: SendFn): void {
  // Internal automation -- disabled by default in release builds
  if (process.env.ENABLE_INBOX !== 'true') {
    logger.info('Inbox system disabled (set ENABLE_INBOX=true to enable)');
    return;
  }

  sendPersonal = send;
  sendWorkflow = workflowSend ?? null;

  // Bridge intake: pull completed results into inbox every 30s
  setInterval(() => intakeBridgeResults(), 30_000);

  // Inbox processor: check priorities and deliver every 15s
  setInterval(() => processInbox(send), 15_000);

  const workflowStatus = sendWorkflow ? 'active' : 'disabled (no WORKFLOW_CHAT_ID)';
  logger.info({ workflowStatus }, 'Inbox system started (intake: 30s, processor: 15s)');
}
