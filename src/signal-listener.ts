/**
 * Signal event listener.
 *
 * Polls the signal-cli-rest-api container for incoming messages and
 * converts them to IncomingMessage objects for the shared pipeline.
 *
 * Self-contained -- only imported when SIGNAL_API_URL is set.
 *
 * Two modes supported:
 * 1. WebSocket (preferred) -- real-time via ws://host:port/v1/receive/{number}
 * 2. Polling fallback -- GET /v1/receive/{number} every 2 seconds
 */

import fs from 'fs';
import path from 'path';
import type { IncomingMessage } from './message-interface.js';
import { registerSender } from './message-interface.js';
import { SignalSender, type SignalClientConfig } from './signal-adapter.js';
import {
  SIGNAL_API_URL,
  SIGNAL_PHONE_NUMBER,
  SIGNAL_ALLOWED_NUMBERS,
} from './config.js';
import { logger } from './logger.js';

// ── Media download directory ────────────────────────────────────────

const SIGNAL_UPLOADS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '..',
  'workspace',
  'uploads',
  'signal',
);
fs.mkdirSync(SIGNAL_UPLOADS_DIR, { recursive: true });

// ── Types ───────────────────────────────────────────────────────────

export type SignalMessageHandler = (msg: IncomingMessage) => Promise<void>;

/** Envelope from signal-cli-rest-api /v1/receive or WebSocket. */
interface SignalEnvelope {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp?: number;
    dataMessage?: {
      timestamp?: number;
      message?: string;
      attachments?: Array<{
        contentType?: string;
        filename?: string;
        id?: string;
        size?: number;
      }>;
      groupInfo?: {
        groupId?: string;
        type?: string;
      };
    };
    typingMessage?: {
      action?: string;
    };
    receiptMessage?: {
      type?: string;
    };
  };
  account?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse the SIGNAL_ALLOWED_NUMBERS comma-separated string into a Set. */
function parseAllowedNumbers(): Set<string> {
  if (!SIGNAL_ALLOWED_NUMBERS) return new Set();
  return new Set(
    SIGNAL_ALLOWED_NUMBERS.split(',')
      .map(n => n.trim())
      .filter(Boolean),
  );
}

/** Download an attachment from signal-cli-rest-api. */
async function downloadSignalAttachment(
  apiUrl: string,
  attachmentId: string,
  filename: string,
): Promise<string> {
  const url = `${apiUrl}/v1/attachments/${attachmentId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download Signal attachment: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const localPath = path.join(SIGNAL_UPLOADS_DIR, `${Date.now()}_${sanitized}`);
  fs.writeFileSync(localPath, buffer);
  return localPath;
}

/** Classify attachment content type into our unified media types. */
function classifyMedia(
  contentType?: string,
): 'voice' | 'photo' | 'document' | 'video' | null {
  if (!contentType) return null;
  if (contentType.startsWith('image/')) return 'photo';
  if (contentType.startsWith('audio/')) return 'voice';
  if (contentType.startsWith('video/')) return 'video';
  return 'document';
}

// ── Message processor ───────────────────────────────────────────────

async function processEnvelope(
  envelope: SignalEnvelope,
  onMessage: SignalMessageHandler,
  allowedNumbers: Set<string>,
  ownNumber: string,
): Promise<void> {
  const env = envelope.envelope;
  const sourceNumber = env.source || env.sourceNumber;

  // Ignore our own messages
  if (!sourceNumber || sourceNumber === ownNumber) return;

  // Only data messages (skip typing indicators, receipts, etc.)
  const data = env.dataMessage;
  if (!data) return;

  // Number filter: only process from allowed numbers (if configured)
  if (allowedNumbers.size > 0 && !allowedNumbers.has(sourceNumber)) {
    logger.debug({ source: sourceNumber }, 'Signal message from non-allowed number, ignoring');
    return;
  }

  const text = data.message || '';
  const chatId = data.groupInfo?.groupId || sourceNumber;
  const msgId = data.timestamp || env.timestamp;

  // ── Attachment handling ──────────────────────────────────────────
  const attachments = data.attachments || [];
  if (attachments.length > 0) {
    const att = attachments[0]; // Process first attachment
    const mediaType = classifyMedia(att.contentType);

    if (mediaType && att.id) {
      try {
        const filename = att.filename || `signal_media_${Date.now()}`;
        const localPath = await downloadSignalAttachment(SIGNAL_API_URL, att.id, filename);

        const incoming: IncomingMessage = {
          chatId,
          source: 'signal',
          text: text || '',
          messageId: msgId,
          media: {
            type: mediaType,
            localPath,
            filename,
            caption: text || undefined,
          },
          forceVoiceReply: mediaType === 'voice',
        };
        await onMessage(incoming);
        return;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[signal-listener] Failed to download attachment: ${errMsg}`);
      }
    }
  }

  // ── Text-only message ────────────────────────────────────────────
  if (!text) return; // Empty message with no attachment, skip

  const incoming: IncomingMessage = {
    chatId,
    source: 'signal',
    text,
    messageId: msgId,
  };
  await onMessage(incoming);
}

// ── WebSocket listener ──────────────────────────────────────────────

let ws: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function startWebSocket(
  config: SignalClientConfig,
  onMessage: SignalMessageHandler,
  allowedNumbers: Set<string>,
): Promise<void> {
  const wsUrl = config.apiUrl.replace(/^http/, 'ws') + `/v1/receive/${config.phoneNumber}`;
  logger.info({ url: wsUrl }, 'Connecting to Signal WebSocket...');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      logger.info('Signal WebSocket connected');
    };

    ws.onmessage = async (event) => {
      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const envelope: SignalEnvelope = JSON.parse(data);
        await processEnvelope(envelope, onMessage, allowedNumbers, config.phoneNumber);
      } catch (err) {
        logger.error({ err }, 'Failed to process Signal WebSocket message');
      }
    };

    ws.onerror = (event) => {
      logger.warn({ error: event }, 'Signal WebSocket error');
    };

    ws.onclose = () => {
      logger.warn('Signal WebSocket disconnected, falling back to polling');
      ws = null;
      // Fall back to polling if WebSocket drops
      if (running) {
        startPolling(config, onMessage, allowedNumbers);
      }
    };
  } catch (err) {
    logger.warn({ err }, 'Signal WebSocket connection failed, using polling');
    startPolling(config, onMessage, allowedNumbers);
  }
}

// ── Polling fallback ────────────────────────────────────────────────

function startPolling(
  config: SignalClientConfig,
  onMessage: SignalMessageHandler,
  allowedNumbers: Set<string>,
): void {
  if (pollTimer) return; // Already polling

  const POLL_INTERVAL = 2000; // 2 seconds
  logger.info('Signal polling started (2s interval)');

  pollTimer = setInterval(async () => {
    try {
      const url = `${config.apiUrl}/v1/receive/${config.phoneNumber}`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status !== 204) { // 204 = no messages, expected
          logger.warn({ status: res.status }, 'Signal poll failed');
        }
        return;
      }

      const envelopes = (await res.json()) as SignalEnvelope[];
      for (const envelope of envelopes) {
        await processEnvelope(envelope, onMessage, allowedNumbers, config.phoneNumber);
      }
    } catch (err) {
      logger.debug({ err }, 'Signal poll error (will retry)');
    }
  }, POLL_INTERVAL);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start listening for Signal messages.
 *
 * Registers the SignalSender in the platform registry and begins
 * receiving messages. Tries WebSocket first, falls back to polling.
 *
 * @param onMessage  Callback that receives each IncomingMessage.
 */
export async function startSignalListener(
  onMessage: SignalMessageHandler,
): Promise<void> {
  // Internal automation -- disabled by default in release builds
  if (process.env.ENABLE_SIGNAL !== 'true') {
    logger.info('Signal listener disabled (set ENABLE_SIGNAL=true to enable)');
    return;
  }

  if (!SIGNAL_API_URL || !SIGNAL_PHONE_NUMBER) {
    throw new Error('Signal listener requires SIGNAL_API_URL and SIGNAL_PHONE_NUMBER');
  }

  const config: SignalClientConfig = {
    apiUrl: SIGNAL_API_URL,
    phoneNumber: SIGNAL_PHONE_NUMBER,
  };

  // Register the sender so the rest of PMAOS can reply on Signal
  registerSender(new SignalSender(config));

  const allowedNumbers = parseAllowedNumbers();
  running = true;

  // Verify the signal-cli-rest-api is reachable
  try {
    const healthUrl = `${config.apiUrl}/v1/about`;
    const res = await fetch(healthUrl);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    const about = (await res.json()) as Record<string, unknown>;
    logger.info({ version: about.versions }, 'Signal API reachable');
  } catch (err) {
    logger.warn({ err }, 'Signal API health check failed -- will retry on message poll');
  }

  // Try WebSocket first (real-time), fall back to polling
  await startWebSocket(config, onMessage, allowedNumbers);
}

/**
 * Stop the Signal listener (cleanup for shutdown).
 */
export function stopSignalListener(): void {
  running = false;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Check if Signal is configured (env vars present).
 * Use this to conditionally start the listener.
 */
export function isSignalConfigured(): boolean {
  return !!(SIGNAL_API_URL && SIGNAL_PHONE_NUMBER);
}
