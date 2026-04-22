/**
 * Avatar State Emitter
 *
 * Central nervous system for the kiosk avatar display.
 * Manages WebSocket connections to display clients and broadcasts
 * state changes triggered by the bot's conversation pipeline.
 *
 * State machine:
 *   screensaver <-> materializing -> active <-> speaking / thinking
 *                                      |
 *                               (5min idle)
 *                                      v
 *                                  shutdown -> screensaver
 */

import { WebSocket } from 'ws';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────

export type AvatarState =
  | 'screensaver'
  | 'materializing'
  | 'active'
  | 'speaking'
  | 'thinking'
  | 'shutdown';

export interface AvatarStateMessage {
  type: 'state';
  state: AvatarState;
  ts: number;
}

export interface AvatarVoiceActivityMessage {
  type: 'voice_activity';
  level: number;
  ts: number;
}

export interface AvatarEmotionMessage {
  type: 'emotion';
  register: string;
  ts: number;
}

export interface AvatarAudioPlayMessage {
  type: 'audio_play';
  audioId: string;
  ts: number;
}

export interface AvatarTextResponseMessage {
  type: 'text_response';
  text: string;
  ts: number;
}

// ── Conversation Mode Streaming Types ──────────────────────────────

export interface AvatarStreamStartMessage {
  type: 'stream_start';
  totalChunks: number;
  mode: 'conversation' | 'task';
  ts: number;
}

export interface AvatarTextChunkMessage {
  type: 'text_chunk';
  text: string;
  index: number;
  total: number;
  isLast: boolean;
  ts: number;
}

export interface AvatarAudioChunkMessage {
  type: 'audio_chunk';
  audioId: string;
  index: number;
  total: number;
  isLast: boolean;
  ts: number;
}

export interface AvatarStreamEndMessage {
  type: 'stream_end';
  ts: number;
}

export type AvatarMessage =
  | AvatarStateMessage
  | AvatarVoiceActivityMessage
  | AvatarEmotionMessage
  | AvatarAudioPlayMessage
  | AvatarTextResponseMessage
  | AvatarStreamStartMessage
  | AvatarTextChunkMessage
  | AvatarAudioChunkMessage
  | AvatarStreamEndMessage;

// ── Version (bump this on every display code change) ──────────────
export const AVATAR_VERSION = 'v21.0';

// ── Audio Cache (serves TTS buffers to kiosk clients) ─────────────

const audioCache = new Map<string, { buffer: Buffer; expires: number }>();
const AUDIO_CACHE_TTL_MS = 120_000; // Keep audio for 2 minutes

function generateAudioId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cacheAudioBuffer(buf: Buffer): string {
  const id = generateAudioId();
  audioCache.set(id, { buffer: buf, expires: Date.now() + AUDIO_CACHE_TTL_MS });
  // Cleanup expired entries
  for (const [key, val] of audioCache) {
    if (val.expires < Date.now()) audioCache.delete(key);
  }
  return id;
}

/** Retrieve cached audio buffer by ID. Returns null if expired or missing. */
export function getAudioBuffer(id: string): Buffer | null {
  const entry = audioCache.get(id);
  if (!entry || entry.expires < Date.now()) {
    audioCache.delete(id);
    return null;
  }
  return entry.buffer;
}

// ── Singleton State ────────────────────────────────────────────────

const clients = new Set<WebSocket>();
const clientAlive = new WeakMap<WebSocket, boolean>();
let currentState: AvatarState = 'screensaver';
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let materializeTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
let stateStuckTimeout: ReturnType<typeof setTimeout> | null = null;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;        // 10 minutes -> shutdown
const SHUTDOWN_DURATION_MS = 8_000;              // 8s shutdown animation
const MATERIALIZATION_DURATION_MS = 3_000;       // 3s materialization

// ── WebSocket Heartbeat ───────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30_000;  // Ping every 30s
const HEARTBEAT_TIMEOUT_MS = 10_000;   // Dead if no pong in 10s

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/** Start heartbeat pings to detect dead WebSocket connections. */
export function startAvatarHeartbeat(): void {
  if (heartbeatInterval) return; // Already running
  heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      if (clientAlive.get(ws) === false) {
        // No pong received since last ping -- connection is dead
        logger.warn({ clientCount: clients.size - 1 }, 'Avatar client heartbeat timeout, terminating');
        clients.delete(ws);
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      // Mark as not-alive, wait for pong to flip it back
      clientAlive.set(ws, false);
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { /* ignore */ }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ── Client Management ──────────────────────────────────────────────

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  clientAlive.set(ws, true);

  // Send version first so client can auto-reload if stale
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'version', version: AVATAR_VERSION, ts: Date.now() }));
  }
  // Then tell the new client what state we're in
  sendTo(ws, { type: 'state', state: currentState, ts: Date.now() });
  logger.info({ clientCount: clients.size }, 'Avatar client connected');

  // Heartbeat pong -- marks connection as alive
  ws.on('pong', () => {
    clientAlive.set(ws, true);
  });

  // Client -> server messages (audio playback events from kiosk)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'audio_ended') {
        avatarOnSpeakingEnd();
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    logger.info({ clientCount: clients.size }, 'Avatar client disconnected');
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
}

// ── Broadcasting ───────────────────────────────────────────────────

function broadcast(msg: AvatarMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function sendTo(ws: WebSocket, msg: AvatarMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── State Transitions ──────────────────────────────────────────────

function setState(newState: AvatarState): void {
  if (currentState === newState) return;
  logger.info({ from: currentState, to: newState }, 'Avatar state change');
  currentState = newState;
  broadcast({ type: 'state', state: newState, ts: Date.now() });

  // Safety timeout: auto-recover from stuck states
  if (stateStuckTimeout) { clearTimeout(stateStuckTimeout); stateStuckTimeout = null; }
  if (newState === 'materializing') {
    // Materializing should never last more than 10s -- force to thinking
    stateStuckTimeout = setTimeout(() => {
      if (currentState === 'materializing') {
        logger.warn('Avatar materializing stuck, forcing thinking');
        setState('thinking');
      }
    }, 10_000);
  } else if (newState === 'thinking' || newState === 'speaking') {
    stateStuckTimeout = setTimeout(() => {
      if (currentState === newState) {
        logger.warn({ state: currentState }, 'Avatar state stuck timeout, forcing active');
        setState('active');
        resetIdleTimer();
      }
    }, 90_000);
  }
}

function clearTimers(): void {
  if (materializeTimer) { clearTimeout(materializeTimer); materializeTimer = null; }
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (currentState === 'active') {
      setState('shutdown');
      shutdownTimer = setTimeout(() => {
        if (currentState === 'shutdown') {
          setState('screensaver');
        }
      }, SHUTDOWN_DURATION_MS);
    }
  }, IDLE_TIMEOUT_MS);
}

// ── Public API (called from bot.ts, voice.ts) ──────────────────────

/** A user message arrived -- wake the avatar up. */
export function avatarOnMessageReceived(): void {
  if (clients.size === 0) return;

  clearTimers();

  if (currentState === 'screensaver' || currentState === 'shutdown') {
    setState('materializing');
    materializeTimer = setTimeout(() => {
      if (currentState === 'materializing') {
        setState('thinking');
      }
    }, MATERIALIZATION_DURATION_MS);
  } else {
    setState('thinking');
  }
  resetIdleTimer();
}

/** Claude is processing the response. */
export function avatarOnThinking(): void {
  if (clients.size === 0) return;
  if (currentState !== 'materializing') {
    setState('thinking');
  }
  resetIdleTimer();
}

/** Text response is ready (non-voice path). */
export function avatarOnResponseReady(): void {
  if (clients.size === 0) return;
  clearTimers();
  setState('active');
  resetIdleTimer();
}

/** TTS audio is about to play. */
export function avatarOnSpeakingStart(): void {
  if (clients.size === 0) return;
  setState('speaking');
  resetIdleTimer();
}

/** TTS audio finished. */
export function avatarOnSpeakingEnd(): void {
  if (clients.size === 0) return;
  setState('active');
  resetIdleTimer();
}

/** Push voice amplitude for face brightness pulsing. */
export function avatarVoiceLevel(level: number): void {
  if (clients.size === 0) return;
  broadcast({
    type: 'voice_activity',
    level: Math.max(0, Math.min(1, level)),
    ts: Date.now(),
  });
}

/** Push emotional register change. */
export function avatarEmotionChange(register: string): void {
  if (clients.size === 0) return;
  broadcast({ type: 'emotion', register, ts: Date.now() });
}

/** Current state (for status endpoint). */
export function getAvatarState(): AvatarState {
  return currentState;
}

/** Connected client count. */
export function getAvatarClientCount(): number {
  return clients.size;
}

/** Play TTS audio through all connected kiosk displays. */
export function avatarPlayAudio(audioBuffer: Buffer): void {
  if (clients.size === 0) return;
  const audioId = cacheAudioBuffer(audioBuffer);
  logger.info({ audioId, clients: clients.size, bytes: audioBuffer.length }, 'Broadcasting audio to kiosk');
  const data = JSON.stringify({ type: 'audio_play', audioId, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/** Send text response to kiosk displays (for subtitle overlay). */
export function avatarSendText(text: string): void {
  if (clients.size === 0) return;
  const data = JSON.stringify({ type: 'text_response', text, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/** Send user text to kiosk displays (shows what user said in chat log). */
export function avatarSendUserText(text: string): void {
  if (clients.size === 0) return;
  const data = JSON.stringify({ type: 'text_user', text, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/** Send system text to kiosk displays (status/system messages shown in red). */
export function avatarSendSystemText(text: string): void {
  if (clients.size === 0) return;
  const data = JSON.stringify({ type: 'text_system', text, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ── Conversation Mode Streaming API ─────────────────────────────────

/** Signal start of a chunked response stream. */
export function avatarStreamStart(totalChunks: number, mode: 'conversation' | 'task'): void {
  if (clients.size === 0) return;
  broadcast({ type: 'stream_start', totalChunks, mode, ts: Date.now() } as AvatarMessage);
}

/** Send a single text chunk to kiosk displays (progressive sentence delivery). */
export function avatarSendTextChunk(text: string, index: number, total: number): void {
  if (clients.size === 0) return;
  const msg = { type: 'text_chunk', text, index, total, isLast: index === total - 1, ts: Date.now() };
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/** Send a single audio chunk to kiosk displays (progressive TTS delivery). */
export function avatarPlayAudioChunk(audioBuffer: Buffer, index: number, total: number): void {
  if (clients.size === 0) return;
  const audioId = cacheAudioBuffer(audioBuffer);
  const msg = { type: 'audio_chunk', audioId, index, total, isLast: index === total - 1, ts: Date.now() };
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/** Signal end of a chunked response stream. */
export function avatarStreamEnd(): void {
  if (clients.size === 0) return;
  broadcast({ type: 'stream_end', ts: Date.now() } as AvatarMessage);
}
