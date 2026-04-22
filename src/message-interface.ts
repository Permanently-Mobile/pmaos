/**
 * Unified Message Interface -- platform-agnostic abstraction layer.
 *
 * Every chat platform (Telegram, Matrix, Signal, Kiosk) implements
 * MessageSender. Core message processing runs through processMessage()
 * which is platform-blind -- it builds context, runs the agent, and
 * calls the sender to deliver results.
 *
 * This is the cut point that lets us swap transport without touching logic.
 */

// ── Types ────────────────────────────────────────────────────────────

export type MessageSource = 'telegram' | 'matrix' | 'signal' | 'kiosk' | 'discord';

export interface IncomingMessage {
  /** Unique chat/room identifier (platform-specific format) */
  chatId: string;
  /** Which platform this message arrived from */
  source: MessageSource;
  /** Raw text content */
  text: string;
  /** Platform-specific message ID for dedup */
  messageId?: string | number;
  /** Media attached to this message */
  media?: {
    type: 'voice' | 'photo' | 'document' | 'video' | 'video_note';
    localPath: string;
    filename?: string;
    caption?: string;
  };
  /** Whether to force voice reply (voice input -> voice output) */
  forceVoiceReply?: boolean;
  /** Skip logging this turn (used by /respin) */
  skipLog?: boolean;
}

export interface FileAttachment {
  filePath: string;
  type: 'file' | 'photo';
  caption?: string;
}

export interface MessageSender {
  /** Send a text message (already formatted for this platform) */
  sendText(chatId: string, text: string): Promise<void>;
  /** Send a voice/audio message */
  sendVoice(chatId: string, audioBuffer: Buffer, ext?: string): Promise<void>;
  /** Send a file attachment */
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  /** Send a photo */
  sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void>;
  /** Show typing indicator */
  sendTyping(chatId: string): Promise<void>;
  /** Format text for this platform (markdown -> HTML for Telegram, etc.) */
  formatText(text: string): string;
  /** Split text to fit platform message limits */
  splitText(text: string): string[];
  /** Platform name for logging */
  readonly platform: MessageSource;
}

// ── Response from core processing ────────────────────────────────────

export interface ProcessedResponse {
  /** Raw response text from the agent */
  rawText: string;
  /** Files to send */
  files: FileAttachment[];
  /** Whether voice was synthesized */
  voiceSent: boolean;
  /** Voice audio buffer (if synthesized) */
  voiceBuffer?: Buffer;
  /** Voice file extension */
  voiceExt?: string;
  /** New session ID (if changed) */
  resumeToken?: string;
  /** Provider used */
  provider?: string;
  /** Token usage info */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    contextTokens: number;
    costUsd: number;
    didCompact: boolean;
  };
  /** Context warning message (if any) */
  contextWarning?: string | null;
}

// ── Platform registry ────────────────────────────────────────────────

const senders = new Map<MessageSource, MessageSender>();

export function registerSender(sender: MessageSender): void {
  senders.set(sender.platform, sender);
}

export function getSender(platform: MessageSource): MessageSender | undefined {
  return senders.get(platform);
}

export function getRegisteredPlatforms(): MessageSource[] {
  return [...senders.keys()];
}
