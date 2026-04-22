/**
 * Matrix MessageSender adapter.
 *
 * Wraps matrix-bot-sdk calls behind the unified MessageSender interface.
 * Follows the same pattern as TelegramSender -- the Matrix equivalent.
 */

import fs from 'fs';
import path from 'path';
import { MatrixClient } from 'matrix-bot-sdk';
import type { MessageSender, MessageSource } from './message-interface.js';
import { MATRIX_MAX_MESSAGE_BYTES } from './config.js';

// ── Markdown -> Matrix HTML conversion ──────────────────────────────

/**
 * Convert Markdown to Matrix-flavored HTML.
 *
 * Matrix supports a wider HTML subset than Telegram:
 * <b>, <i>, <s>, <u>, <code>, <pre>, <a>, <blockquote>, <ol>, <ul>, <li>,
 * <h1>-<h6>, <p>, <br>, <hr>, <table>, <thead>, <tbody>, <tr>, <th>, <td>.
 *
 * This converts Claude's Markdown output into clean HTML that renders
 * well in Element and other Matrix clients.
 */
export function formatForMatrix(text: string): string {
  // 1. Extract and protect code blocks before any other processing
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.trim()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // 2. Escape HTML entities in the remaining text
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 3. Inline code (after block extraction)
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    inlineCodes.push(`<code>${escaped}</code>`);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  // 4. Headings -> proper HTML headings (Matrix supports h1-h6)
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = hashes.length;
    return `<h${level}>${content}</h${level}>`;
  });

  // 5. Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '<hr>');

  // 6. Blockquotes (lines starting with >)
  result = result.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  // Merge adjacent blockquotes into one
  result = result.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // 7. Checkboxes
  result = result.replace(/^(\s*)-\s+\[x\]\s*/gim, '$1\u2713 ');
  result = result.replace(/^(\s*)-\s+\[\s\]\s*/gm, '$1\u2610 ');

  // 8. Bold **text** and __text__
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  result = result.replace(/__([^_\n]+)__/g, '<b>$1</b>');

  // 9. Italic *text* and _text_ (single, not inside words)
  result = result.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<i>$1</i>');

  // 10. Strikethrough ~~text~~
  result = result.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // 11. Links [text](url)
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // 12. Restore code blocks and inline code
  result = result.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[parseInt(i)]);

  // 13. Collapse 3+ consecutive blank lines down to 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

// ── Message splitting ───────────────────────────────────────────────

/**
 * Split a long response into Matrix-safe chunks.
 *
 * Matrix has a 65536-byte limit per event. We measure in bytes (UTF-8)
 * and split on newlines where possible. Preserves HTML tag integrity
 * across chunk boundaries -- same approach as the Telegram splitter.
 */
export function splitMatrixMessage(text: string): string[] {
  const maxBytes = MATRIX_MAX_MESSAGE_BYTES;
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return [text];

  const MATRIX_TAGS = ['pre', 'code', 'b', 'i', 's', 'a', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const parts: string[] = [];
  let remaining = text;
  let carryoverTags: string[] = [];

  while (remaining.length > 0) {
    const prefix = carryoverTags.map(t => `<${t}>`).join('');
    const prefixBytes = Buffer.byteLength(prefix, 'utf-8');
    const available = maxBytes - prefixBytes;

    if (prefixBytes + Buffer.byteLength(remaining, 'utf-8') <= maxBytes) {
      parts.push(prefix + remaining);
      break;
    }

    // Find the character count that fits within the byte budget.
    // Start from a conservative estimate and walk forward.
    let charLimit = Math.min(remaining.length, available);
    while (Buffer.byteLength(remaining.slice(0, charLimit), 'utf-8') > available && charLimit > 0) {
      charLimit--;
    }

    const chunk = remaining.slice(0, charLimit);
    let splitAt = chunk.lastIndexOf('\n');
    if (splitAt < charLimit / 2) splitAt = charLimit;

    let piece = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).trimStart();

    // Determine which tags are open (unclosed) in this piece
    const openTags: string[] = [...carryoverTags];
    for (const tag of MATRIX_TAGS) {
      const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
      const closeRe = new RegExp(`</${tag}>`, 'gi');
      const opens = (piece.match(openRe) || []).length;
      const closes = (piece.match(closeRe) || []).length;
      const carriedIn = carryoverTags.includes(tag) ? 1 : 0;
      const netOpen = carriedIn + opens - closes;
      const idx = openTags.indexOf(tag);
      if (netOpen > 0 && idx === -1) openTags.push(tag);
      else if (netOpen <= 0 && idx !== -1) openTags.splice(idx, 1);
    }

    const closeSuffix = [...openTags].reverse().map(t => `</${t}>`).join('');
    parts.push(prefix + piece + closeSuffix);
    carryoverTags = [...openTags];
  }

  return parts;
}

// ── MIME type helper ────────────────────────────────────────────────

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

// ── MatrixSender class ──────────────────────────────────────────────

export class MatrixSender implements MessageSender {
  readonly platform: MessageSource = 'matrix';
  private client: MatrixClient;

  constructor(client: MatrixClient) {
    this.client = client;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const parts = this.splitText(this.formatText(text));
    for (const part of parts) {
      // Send as m.text with formatted_body for HTML rendering
      await this.client.sendMessage(chatId, {
        msgtype: 'm.text',
        body: stripHtml(part),
        format: 'org.matrix.custom.html',
        formatted_body: part,
      });
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
    const mxcUrl = await this.client.uploadContent(audioBuffer, mime, `response.${ext}`);
    await this.client.sendMessage(chatId, {
      msgtype: 'm.audio',
      body: `response.${ext}`,
      url: mxcUrl,
      info: {
        mimetype: mime,
        size: audioBuffer.length,
      },
    });
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await this.sendText(chatId, `Could not send file: ${filePath} (not found)`);
      return;
    }
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const mime = mimeFromPath(filePath);
    const mxcUrl = await this.client.uploadContent(data, mime, filename);
    await this.client.sendMessage(chatId, {
      msgtype: 'm.file',
      body: caption || filename,
      url: mxcUrl,
      filename,
      info: {
        mimetype: mime,
        size: data.length,
      },
    });
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await this.sendText(chatId, `Could not send photo: ${filePath} (not found)`);
      return;
    }
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const mime = mimeFromPath(filePath);
    const mxcUrl = await this.client.uploadContent(data, mime, filename);
    await this.client.sendMessage(chatId, {
      msgtype: 'm.image',
      body: caption || filename,
      url: mxcUrl,
      info: {
        mimetype: mime,
        size: data.length,
      },
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.client.setTyping(chatId, true, 4000);
    } catch {
      // typing indicator is best-effort
    }
  }

  formatText(text: string): string {
    return formatForMatrix(text);
  }

  splitText(text: string): string[] {
    return splitMatrixMessage(text);
  }
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a MatrixClient instance from homeserver URL and access token.
 * This is the Matrix equivalent of passing Grammy's Api to TelegramSender.
 */
export function createMatrixClient(homeserverUrl: string, accessToken: string): MatrixClient {
  return new MatrixClient(homeserverUrl, accessToken);
}

// ── Utility ─────────────────────────────────────────────────────────

/** Strip HTML tags for the plaintext `body` field required by Matrix spec. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
