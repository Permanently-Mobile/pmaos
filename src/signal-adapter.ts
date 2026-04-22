/**
 * Signal MessageSender adapter.
 *
 * Wraps signal-cli-rest-api calls behind the unified MessageSender interface.
 * Follows the same pattern as TelegramSender and MatrixSender.
 *
 * The signal-cli-rest-api Docker container handles the Signal protocol.
 * This adapter makes HTTP calls to its REST endpoints.
 */

import fs from 'fs';
import path from 'path';
import type { MessageSender, MessageSource } from './message-interface.js';

// Signal supports basic Markdown-ish formatting but clients render it
// inconsistently. We strip heavy HTML and keep it clean plaintext.
const SIGNAL_MAX_MESSAGE_LENGTH = 10000; // Signal doesn't enforce a hard limit, but keep it sane

export interface SignalClientConfig {
  /** Base URL of the signal-cli-rest-api container (e.g. http://localhost:3145) */
  apiUrl: string;
  /** The phone number registered with signal-cli (e.g. +1234567890) */
  phoneNumber: string;
}

// ── Signal REST API helpers ──────────────────────────────────────────

async function signalPost(
  config: SignalClientConfig,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = `${config.apiUrl}/v2${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Signal API ${endpoint} failed: ${res.status} ${res.statusText} -- ${text}`);
  }
  return res;
}

async function signalSendMessage(
  config: SignalClientConfig,
  recipient: string,
  message: string,
  attachments?: string[],
): Promise<void> {
  await signalPost(config, '/send', {
    message,
    number: config.phoneNumber,
    recipients: [recipient],
    ...(attachments?.length ? { base64_attachments: attachments } : {}),
  });
}

/** Convert a local file to a base64 data URI for the Signal API. */
function fileToBase64Attachment(filePath: string): string {
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  return `data:${mime};filename=${path.basename(filePath)};base64,${data.toString('base64')}`;
}

// ── Text formatting ──────────────────────────────────────────────────

/**
 * Format text for Signal.
 *
 * Signal clients (Desktop, Android, iOS) have inconsistent Markdown support.
 * Desktop renders *bold* and _italic_ but mobile barely does. We strip
 * heavy formatting and keep it readable as plaintext with light structure.
 */
export function formatForSignal(text: string): string {
  // Strip HTML tags (in case Claude output includes them)
  let result = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  result = result
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse excessive whitespace
  result = result.replace(/\n{4,}/g, '\n\n\n');

  return result.trim();
}

/** Split text to fit Signal's practical message limits. */
export function splitSignalMessage(text: string): string[] {
  if (text.length <= SIGNAL_MAX_MESSAGE_LENGTH) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SIGNAL_MAX_MESSAGE_LENGTH) {
      parts.push(remaining);
      break;
    }

    // Try to split on a newline near the limit
    const chunk = remaining.slice(0, SIGNAL_MAX_MESSAGE_LENGTH);
    let splitAt = chunk.lastIndexOf('\n');
    if (splitAt < SIGNAL_MAX_MESSAGE_LENGTH / 2) {
      // No good newline, try space
      splitAt = chunk.lastIndexOf(' ');
    }
    if (splitAt < SIGNAL_MAX_MESSAGE_LENGTH / 2) {
      // No good split point, hard cut
      splitAt = SIGNAL_MAX_MESSAGE_LENGTH;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}

// ── SignalSender class ───────────────────────────────────────────────

export class SignalSender implements MessageSender {
  readonly platform: MessageSource = 'signal';
  private config: SignalClientConfig;

  constructor(config: SignalClientConfig) {
    this.config = config;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const parts = this.splitText(this.formatText(text));
    for (const part of parts) {
      await signalSendMessage(this.config, chatId, part);
    }
  }

  async sendVoice(chatId: string, audioBuffer: Buffer, ext = 'mp3'): Promise<void> {
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
    };
    const mime = mimeMap[ext] || 'audio/mpeg';
    const b64 = `data:${mime};filename=response.${ext};base64,${audioBuffer.toString('base64')}`;
    await signalPost(this.config, '/send', {
      message: '',
      number: this.config.phoneNumber,
      recipients: [chatId],
      base64_attachments: [b64],
    });
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await this.sendText(chatId, `Could not send file: ${filePath} (not found)`);
      return;
    }
    const b64 = fileToBase64Attachment(filePath);
    await signalPost(this.config, '/send', {
      message: caption || '',
      number: this.config.phoneNumber,
      recipients: [chatId],
      base64_attachments: [b64],
    });
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await this.sendText(chatId, `Could not send photo: ${filePath} (not found)`);
      return;
    }
    const b64 = fileToBase64Attachment(filePath);
    await signalPost(this.config, '/send', {
      message: caption || '',
      number: this.config.phoneNumber,
      recipients: [chatId],
      base64_attachments: [b64],
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    // Signal typing indicators aren't well-supported via the REST API.
    // Best-effort -- some versions of signal-cli-rest-api support it.
    try {
      await fetch(`${this.config.apiUrl}/v1/typing-indicator/${this.config.phoneNumber}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: chatId }),
      });
    } catch {
      // typing indicator is best-effort
    }
  }

  formatText(text: string): string {
    return formatForSignal(text);
  }

  splitText(text: string): string[] {
    return splitSignalMessage(text);
  }
}
