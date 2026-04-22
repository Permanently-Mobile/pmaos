/**
 * Matrix event listener.
 *
 * Converts incoming Matrix room events into IncomingMessage objects
 * that plug into the shared processMessage pipeline.
 *
 * Self-contained -- only imported when MATRIX_HOMESERVER_URL is set.
 *
 * Resilience features:
 *   - Periodic health check (whoami every 60s)
 *   - Auto-reconnect with exponential backoff on sync failure
 *   - M_UNKNOWN_TOKEN detection with Telegram alert
 *   - Graceful degradation (Matrix failure never takes down the bot)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { MatrixClient, AutojoinRoomsMixin } from 'matrix-bot-sdk';
import type { IncomingMessage } from './message-interface.js';
import { registerSender } from './message-interface.js';
import { MatrixSender, createMatrixClient } from './matrix-adapter.js';
import {
  MATRIX_HOMESERVER_URL,
  MATRIX_ACCESS_TOKEN,
  MATRIX_ALLOWED_ROOMS,
} from './config.js';
import { logger } from './logger.js';

// ── Media download directory ────────────────────────────────────────

const MATRIX_UPLOADS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '..',
  'workspace',
  'uploads',
  'matrix',
);
fs.mkdirSync(MATRIX_UPLOADS_DIR, { recursive: true });

// ── Types ───────────────────────────────────────────────────────────

export type MatrixMessageHandler = (msg: IncomingMessage) => Promise<void>;

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse the MATRIX_ALLOWED_ROOMS comma-separated string into a Set. */
function parseAllowedRooms(): Set<string> {
  if (!MATRIX_ALLOWED_ROOMS) return new Set();
  return new Set(
    MATRIX_ALLOWED_ROOMS.split(',')
      .map(r => r.trim())
      .filter(Boolean),
  );
}

/**
 * Download media from a Matrix MXC URL to a local file.
 * MXC URIs look like: mxc://server.domain/mediaId
 * The actual download URL is: {homeserver}/_matrix/media/v3/download/{serverName}/{mediaId}
 */
async function downloadMatrixMedia(
  client: MatrixClient,
  mxcUrl: string,
  filename: string,
): Promise<string> {
  // Parse mxc://server/mediaId
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid MXC URL: ${mxcUrl}`);

  const [, serverName, mediaId] = match;
  const downloadUrl = `${MATRIX_HOMESERVER_URL}/_matrix/media/v3/download/${serverName}/${mediaId}`;

  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${MATRIX_ACCESS_TOKEN}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Matrix media: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const localPath = path.join(MATRIX_UPLOADS_DIR, `${Date.now()}_${sanitized}`);
  fs.writeFileSync(localPath, buffer);
  return localPath;
}

/** Determine media type from msgtype or MIME. */
function classifyMedia(
  msgtype: string,
  mimetype?: string,
): 'voice' | 'photo' | 'document' | 'video' | null {
  switch (msgtype) {
    case 'm.audio':
      return 'voice';
    case 'm.image':
      return 'photo';
    case 'm.video':
      return 'video';
    case 'm.file':
      // Check MIME for images/audio that were sent as generic files
      if (mimetype?.startsWith('image/')) return 'photo';
      if (mimetype?.startsWith('audio/')) return 'voice';
      if (mimetype?.startsWith('video/')) return 'video';
      return 'document';
    default:
      return null;
  }
}

/** Get a reasonable filename from a Matrix event. */
function extractFilename(content: Record<string, unknown>): string {
  if (typeof content.filename === 'string' && content.filename) return content.filename;
  if (typeof content.body === 'string' && content.body) return content.body;
  return `matrix_media_${Date.now()}`;
}

// ── Resilience State ─────────────────────────────────────────────────

let _healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempts = 0;
let _matrixDead = false; // true = token invalid, stop retrying
let _activeClient: MatrixClient | null = null;
let _onMessageHandler: MatrixMessageHandler | null = null;

const MAX_RECONNECT_ATTEMPTS = 10;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // 60 seconds
const BASE_BACKOFF_MS = 5_000; // 5 second base backoff

/**
 * Send a notification to Telegram about Matrix status.
 * Uses execSync + notify script to avoid circular imports with bot.ts.
 */
function notifyTelegram(msg: string): void {
  try {
    const scriptPath = path.join(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '..',
      'scripts',
      'notify.sh',
    );
    execSync(`bash "${scriptPath}" "${msg.replace(/"/g, '\\"')}"`, {
      stdio: 'pipe',
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    // Telegram notify is best-effort
  }
}

/**
 * Check if a Matrix error is a token expiry/revocation.
 */
function isTokenError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err);
  if (msg.includes('M_UNKNOWN_TOKEN')) return true;
  if (msg.includes('Token is not active')) return true;
  if (msg.includes('Invalid macaroon')) return true;
  // Check err.body or err.errcode if it's an object
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (obj.errcode === 'M_UNKNOWN_TOKEN') return true;
    if (obj.statusCode === 401) return true;
    if (typeof obj.body === 'object' && obj.body !== null) {
      const body = obj.body as Record<string, unknown>;
      if (body.errcode === 'M_UNKNOWN_TOKEN') return true;
    }
  }
  return false;
}

/**
 * Exponential backoff with jitter. Caps at 5 minutes.
 */
function backoffMs(attempt: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), 300_000);
  const jitter = Math.random() * 2000;
  return exp + jitter;
}

// ── Listener ────────────────────────────────────────────────────────

/**
 * Wire up event handlers on a MatrixClient instance.
 * Extracted so we can re-wire on reconnect without duplicating code.
 */
function wireMessageHandlers(
  client: MatrixClient,
  onMessage: MatrixMessageHandler,
  allowedRooms: Set<string>,
): void {
  let ownUserId: string | null = null;

  client.on('room.message', async (roomId: string, event: Record<string, unknown>) => {
    // Ignore our own messages
    if (!ownUserId) {
      try { ownUserId = await client.getUserId(); } catch { /* skip */ }
    }
    if (event.sender === ownUserId) return;

    // Room filter
    if (allowedRooms.size > 0 && !allowedRooms.has(roomId)) return;

    // Ignore redacted/edited events
    const content = event.content as Record<string, unknown> | undefined;
    if (!content || !content.msgtype) return;

    const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined;
    if (relatesTo?.rel_type === 'm.replace') return;

    const msgtype = content.msgtype as string;
    const eventId = event.event_id as string | undefined;
    const body = (content.body as string) || '';

    // ── Text message ──────────────────────────────────────────
    if (msgtype === 'm.text' || msgtype === 'm.notice' || msgtype === 'm.emote') {
      const incoming: IncomingMessage = {
        chatId: roomId,
        source: 'matrix',
        text: body,
        messageId: eventId,
      };
      await onMessage(incoming);
      return;
    }

    // ── Media messages ────────────────────────────────────────
    const mediaType = classifyMedia(msgtype, (content.info as Record<string, unknown>)?.mimetype as string | undefined);
    if (!mediaType) return;

    const mxcUrl = content.url as string | undefined;
    if (!mxcUrl) return;

    try {
      const filename = extractFilename(content);
      const localPath = await downloadMatrixMedia(client, mxcUrl, filename);
      const caption = body !== filename ? body : undefined;

      const incoming: IncomingMessage = {
        chatId: roomId,
        source: 'matrix',
        text: caption || '',
        messageId: eventId,
        media: {
          type: mediaType,
          localPath,
          filename,
          caption,
        },
        forceVoiceReply: mediaType === 'voice',
      };
      await onMessage(incoming);
    } catch (err) {
      logger.warn({ err }, 'Matrix: failed to download media');
    }
  });
}

/**
 * Attempt to reconnect the Matrix client.
 * Creates a fresh client instance each time (tokens don't change mid-run,
 * but the sync state may be corrupt after a failure).
 */
async function attemptReconnect(): Promise<void> {
  if (_matrixDead || !_onMessageHandler) return;

  _reconnectAttempts++;
  if (_reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    logger.error(`Matrix: exceeded ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Giving up.`);
    notifyTelegram(`Matrix offline -- failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts. Token may need rotation.`);
    _matrixDead = true;
    return;
  }

  const delay = backoffMs(_reconnectAttempts - 1);
  logger.info({ attempt: _reconnectAttempts, delayMs: Math.round(delay) }, 'Matrix: reconnecting...');

  try {
    // Stop old client if it exists
    if (_activeClient) {
      try { _activeClient.stop(); } catch { /* ignore */ }
    }

    // Create fresh client
    const client = createMatrixClient(MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN);
    AutojoinRoomsMixin.setupOnClient(client);
    registerSender(new MatrixSender(client));

    const allowedRooms = parseAllowedRooms();
    wireMessageHandlers(client, _onMessageHandler, allowedRooms);

    await client.start();

    _activeClient = client;
    _reconnectAttempts = 0;
    logger.info('Matrix: reconnected successfully');
    notifyTelegram('Matrix reconnected.');

    // Restart health checks
    startHealthCheck(client);
  } catch (err) {
    if (isTokenError(err)) {
      logger.error('Matrix: token is invalid (M_UNKNOWN_TOKEN). Cannot reconnect without a new token.');
      notifyTelegram('Matrix token expired or revoked. Need a fresh token to reconnect. Use Element to generate one.');
      _matrixDead = true;
      return;
    }

    logger.warn({ err, attempt: _reconnectAttempts }, 'Matrix: reconnect failed');
    const nextDelay = backoffMs(_reconnectAttempts);
    _reconnectTimeout = setTimeout(() => attemptReconnect(), nextDelay);
  }
}

/**
 * Periodic health check -- calls whoami() to verify the token is still valid.
 * If it fails, triggers reconnect or token-dead alert.
 */
function startHealthCheck(client: MatrixClient): void {
  // Clear any existing health check
  if (_healthCheckInterval) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }

  _healthCheckInterval = setInterval(async () => {
    if (_matrixDead) {
      if (_healthCheckInterval) clearInterval(_healthCheckInterval);
      return;
    }

    try {
      await client.getUserId(); // lightweight API call, validates token
    } catch (err) {
      logger.warn({ err }, 'Matrix: health check failed');

      if (isTokenError(err)) {
        logger.error('Matrix: token expired (caught by health check)');
        notifyTelegram('Matrix token expired. Need a fresh token.');
        _matrixDead = true;
        if (_healthCheckInterval) clearInterval(_healthCheckInterval);
        try { client.stop(); } catch { /* ignore */ }
        return;
      }

      // Non-token error -- likely network. Try reconnect.
      if (_healthCheckInterval) clearInterval(_healthCheckInterval);
      _healthCheckInterval = null;
      try { client.stop(); } catch { /* ignore */ }
      _reconnectTimeout = setTimeout(() => attemptReconnect(), BASE_BACKOFF_MS);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Start listening for Matrix room messages.
 *
 * Registers the MatrixSender in the platform registry and begins
 * syncing. Includes auto-reconnect with exponential backoff and
 * health checks to detect dead tokens.
 *
 * @param onMessage  Callback that receives each IncomingMessage.
 * @returns The MatrixClient instance (for shutdown / testing).
 */
export async function startMatrixListener(
  onMessage: MatrixMessageHandler,
): Promise<MatrixClient> {
  if (!MATRIX_HOMESERVER_URL || !MATRIX_ACCESS_TOKEN) {
    throw new Error('Matrix listener requires MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN');
  }

  _onMessageHandler = onMessage;
  _matrixDead = false;
  _reconnectAttempts = 0;

  const client = createMatrixClient(MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN);
  registerSender(new MatrixSender(client));
  AutojoinRoomsMixin.setupOnClient(client);

  const allowedRooms = parseAllowedRooms();
  wireMessageHandlers(client, onMessage, allowedRooms);

  // Start syncing
  await client.start();

  _activeClient = client;

  // Ensure we have our user ID after start
  try { await client.getUserId(); } catch { /* non-fatal */ }

  // Start periodic health check
  startHealthCheck(client);

  return client;
}

/**
 * Stop the Matrix listener and clean up all timers.
 */
export function stopMatrixListener(): void {
  if (_healthCheckInterval) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }
  if (_reconnectTimeout) {
    clearTimeout(_reconnectTimeout);
    _reconnectTimeout = null;
  }
  if (_activeClient) {
    try { _activeClient.stop(); } catch { /* ignore */ }
    _activeClient = null;
  }
  _onMessageHandler = null;
}

/**
 * Get the current Matrix connection status.
 */
export function getMatrixStatus(): { connected: boolean; dead: boolean; reconnectAttempts: number } {
  return {
    connected: _activeClient !== null && !_matrixDead,
    dead: _matrixDead,
    reconnectAttempts: _reconnectAttempts,
  };
}

/**
 * Check if Matrix is configured (env vars present).
 */
export function isMatrixConfigured(): boolean {
  return !!(MATRIX_HOMESERVER_URL && MATRIX_ACCESS_TOKEN);
}
