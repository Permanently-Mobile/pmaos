/**
 * Permission Relay -- Telegram inline keyboard approval for Paladin.
 *
 * When Paladin returns `needs_approval`, this module:
 *   1. Sends an inline keyboard message to the owner's Telegram
 *   2. Waits for a button press (Allow / Deny)
 *   3. Reports the decision back to Paladin
 *   4. Returns the final verdict to the caller
 *
 * Timeout: 60 seconds. No response = DENY (fail-closed).
 */

import { InlineKeyboard } from 'grammy';
import type { Api, RawApi } from 'grammy';
import { ALLOWED_CHAT_ID } from './config.js';
import { paladinReportApproval } from './paladin-client.js';
import { logger } from './logger.js';
import type { Operation, Verdict } from './paladin-types.js';

// ── Config ──────────────────────────────────────────────────────────

const APPROVAL_TIMEOUT_MS = 60_000; // 60 seconds, then deny

// ── Pending approval registry ───────────────────────────────────────

interface PendingApproval {
  requestId: string;
  operation: Operation;
  reason: string;
  resolve: (verdict: Verdict) => void;
  timeout: ReturnType<typeof setTimeout>;
  messageId?: number;  // Telegram message ID for editing after resolution
  createdAt: number;
}

const pendingApprovals = new Map<string, PendingApproval>();

// Bot API reference (set during bot init)
let botApi: Api<RawApi> | null = null;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize the permission relay with the bot API.
 * Must be called during bot setup (in createBot).
 */
export function initPermissionRelay(api: Api<RawApi>): void {
  botApi = api;
  logger.info('Permission relay initialized');
}

/**
 * Request approval from the owner via Telegram inline keyboard.
 *
 * Returns a Promise that resolves to 'allow' or 'deny'.
 * Times out after 60 seconds -> deny (fail-closed).
 */
export function requestApproval(
  operation: Operation,
  requestId: string,
  reason: string,
): Promise<Verdict> {
  return new Promise<Verdict>(async (resolve) => {
    if (!botApi || !ALLOWED_CHAT_ID) {
      logger.warn('Permission relay not initialized or no ALLOWED_CHAT_ID -- denying');
      resolve('deny');
      return;
    }

    // Set up timeout (fail-closed)
    const timeout = setTimeout(() => {
      const pending = pendingApprovals.get(requestId);
      if (pending) {
        pendingApprovals.delete(requestId);
        // Report timeout to Paladin
        paladinReportApproval(requestId, false).catch(() => {});
        // Edit the message to show it expired
        if (pending.messageId && botApi) {
          botApi.editMessageText(
            Number(ALLOWED_CHAT_ID),
            pending.messageId,
            formatApprovalMessage(operation, reason, 'EXPIRED (auto-denied)'),
            { parse_mode: 'HTML' },
          ).catch(() => {});
        }
        logger.warn({ requestId, agent: operation.agent }, 'Approval timed out -- denied');
        resolve('deny');
      }
    }, APPROVAL_TIMEOUT_MS);

    // Register the pending approval
    const pending: PendingApproval = {
      requestId,
      operation,
      reason,
      resolve,
      timeout,
      createdAt: Date.now(),
    };
    pendingApprovals.set(requestId, pending);

    // Build and send the Telegram message with inline keyboard
    try {
      const keyboard = new InlineKeyboard()
        .text('Allow', `paladin:allow:${requestId}`)
        .text('Deny', `paladin:deny:${requestId}`)
        .row()
        .text('Details', `paladin:details:${requestId}`);

      const message = formatApprovalMessage(operation, reason);

      const sent = await botApi.sendMessage(
        Number(ALLOWED_CHAT_ID),
        message,
        {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        },
      );

      // Store message ID for later editing
      pending.messageId = sent.message_id;
    } catch (err) {
      logger.error({ err: String(err), requestId }, 'Failed to send approval request to Telegram');
      // Clean up and deny
      clearTimeout(timeout);
      pendingApprovals.delete(requestId);
      resolve('deny');
    }
  });
}

/**
 * Handle a callback query from Telegram (button press).
 * Called from bot.ts callback_query handler.
 *
 * Returns true if the callback was handled, false if not a Paladin callback.
 */
export async function handleApprovalCallback(
  callbackData: string,
  answerCallback: (text: string) => Promise<void>,
): Promise<boolean> {
  // Parse callback data: "paladin:action:requestId"
  if (!callbackData.startsWith('paladin:')) return false;

  const parts = callbackData.split(':');
  if (parts.length < 3) return false;

  const action = parts[1];
  const requestId = parts.slice(2).join(':'); // requestId might contain colons (UUID)

  const pending = pendingApprovals.get(requestId);

  if (action === 'details') {
    // Show operation details (don't resolve the approval)
    if (pending) {
      const details = formatOperationDetails(pending.operation);
      await answerCallback(details).catch(() => {});
    } else {
      await answerCallback('No pending approval found for this request.').catch(() => {});
    }
    return true;
  }

  if (action === 'allow' || action === 'deny') {
    if (!pending) {
      await answerCallback('This approval has already been resolved or expired.').catch(() => {});
      return true;
    }

    const approved = action === 'allow';
    const verdict: Verdict = approved ? 'allow' : 'deny';

    // Clean up
    clearTimeout(pending.timeout);
    pendingApprovals.delete(requestId);

    // Report to Paladin server
    paladinReportApproval(requestId, approved).catch((err) => {
      logger.error({ err: String(err), requestId }, 'Failed to report approval to Paladin');
    });

    // Edit the Telegram message to show the decision
    if (pending.messageId && botApi) {
      const statusText = approved ? 'ALLOWED' : 'DENIED';
      botApi.editMessageText(
        Number(ALLOWED_CHAT_ID),
        pending.messageId,
        formatApprovalMessage(pending.operation, pending.reason, statusText),
        { parse_mode: 'HTML' },
      ).catch(() => {});
    }

    // Resolve the promise in tool-executor
    pending.resolve(verdict);

    await answerCallback(approved ? 'Approved.' : 'Denied.').catch(() => {});
    return true;
  }

  return false;
}

/**
 * Get count of currently pending approvals.
 */
export function getPendingApprovalCount(): number {
  return pendingApprovals.size;
}

// ── Formatting ──────────────────────────────────────────────────────

function formatApprovalMessage(op: Operation, reason: string, status?: string): string {
  const header = status ? `<b>Paladin [${status}]</b>` : '<b>Paladin -- Approval Required</b>';
  const agentLine = `Agent: <code>${escapeHtml(op.agent)}</code>`;
  const typeLine = `Type: <code>${escapeHtml(op.type)}</code>`;
  const reasonLine = `Reason: ${escapeHtml(reason)}`;

  let detailLine = '';
  if (op.type === 'bash' && op.command) {
    const cmd = op.command.length > 200 ? op.command.slice(0, 200) + '...' : op.command;
    detailLine = `Command: <code>${escapeHtml(cmd)}</code>`;
  } else if ((op.type === 'writeFile' || op.type === 'readFile') && op.filePath) {
    detailLine = `File: <code>${escapeHtml(op.filePath)}</code>`;
  }

  const lines = [header, '', agentLine, typeLine, reasonLine];
  if (detailLine) lines.push(detailLine);

  if (!status) {
    lines.push('', '<i>60s timeout -- no response = deny</i>');
  }

  return lines.join('\n');
}

function formatOperationDetails(op: Operation): string {
  const parts: string[] = [`Type: ${op.type}`, `Agent: ${op.agent}`];
  if (op.command) parts.push(`Cmd: ${op.command.slice(0, 100)}`);
  if (op.filePath) parts.push(`File: ${op.filePath}`);
  if (op.content) parts.push(`Content: ${op.content.slice(0, 80)}...`);
  if (op.endpoint) parts.push(`Endpoint: ${op.endpoint}`);
  // Telegram callback answer is limited to 200 chars
  return parts.join('\n').slice(0, 200);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
