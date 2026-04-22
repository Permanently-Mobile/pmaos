/**
 * Gmail API client -- full Gmail integration using Google OAuth 2.0.
 *
 * All functions return typed results, handle auth errors gracefully,
 * and respect Gmail API quotas (250 quota units/sec).
 *
 * Depends on google-auth.ts for authenticated OAuth2 client.
 */

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';

import { getAuthClient } from './google-auth.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body: string;
  labels: string[];
  attachments: GmailAttachment[];
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  labels: string[];
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

export interface GmailSendOptions {
  cc?: string;
  bcc?: string;
  replyTo?: string;
  html?: boolean;
}

export interface GmailSendResult {
  id: string;
  threadId: string;
  labelIds: string[];
}

// ── Header sanitizer ────────────────────────────────────────────────

/** Strip CR/LF to prevent MIME header injection. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

// ── Rate limiter ─────────────────────────────────────────────────────

let _lastCallMs = 0;
const MIN_INTERVAL_MS = 10; // ~100 calls/sec max, well under 250 units/sec

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastCallMs;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  _lastCallMs = Date.now();
}

// ── Internal helpers ─────────────────────────────────────────────────

async function getGmailClient(): Promise<gmail_v1.Gmail | null> {
  const auth = await getAuthClient();
  if (!auth) {
    logger.warn('Gmail client unavailable -- not authenticated');
    return null;
  }
  return google.gmail({ version: 'v1', auth });
}

function extractHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  if (!headers) return '';
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function decodeBase64Url(encoded: string): string {
  // Gmail uses URL-safe base64
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  // Simple message with body data
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart -- look for text/plain first, then text/html
  if (payload.parts) {
    // Try text/plain
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }

    // Try text/html
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return decodeBase64Url(htmlPart.body.data);
    }

    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];
  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    // Check nested parts
    if (part.parts) {
      const nested = extractAttachments(part);
      attachments.push(...nested);
    }
  }

  return attachments;
}

function parseMessage(msg: gmail_v1.Schema$Message): GmailMessage {
  const headers = msg.payload?.headers;
  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    subject: extractHeader(headers, 'Subject'),
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    date: extractHeader(headers, 'Date'),
    snippet: msg.snippet || '',
    body: extractBody(msg.payload),
    labels: msg.labelIds || [],
    attachments: extractAttachments(msg.payload),
  };
}

function parseMessageSummary(msg: gmail_v1.Schema$Message): GmailMessageSummary {
  const headers = msg.payload?.headers;
  return {
    id: msg.id || '',
    threadId: msg.threadId || '',
    subject: extractHeader(headers, 'Subject'),
    from: extractHeader(headers, 'From'),
    date: extractHeader(headers, 'Date'),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Search/list messages using Gmail query syntax.
 * Query examples: "is:unread", "from:joe@example.com", "subject:invoice newer_than:7d"
 */
export async function listMessages(
  query: string,
  maxResults = 20,
): Promise<GmailMessageSummary[] | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  try {
    await rateLimit();
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) return [];

    // Fetch metadata for each message
    const results: GmailMessageSummary[] = [];
    for (const ref of messageRefs) {
      if (!ref.id) continue;
      await rateLimit();
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: ref.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      results.push(parseMessageSummary(msg.data));
    }

    logger.info({ query, count: results.length }, 'Gmail listMessages completed');
    return results;
  } catch (err) {
    logger.error({ err: String(err), query }, 'Gmail listMessages failed');
    return null;
  }
}

/**
 * Get a full message by ID, including headers, body, and attachment list.
 */
export async function getMessage(id: string): Promise<GmailMessage | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  try {
    await rateLimit();
    const res = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });

    const parsed = parseMessage(res.data);
    logger.info({ id, subject: parsed.subject.slice(0, 60) }, 'Gmail getMessage completed');
    return parsed;
  } catch (err) {
    logger.error({ err: String(err), id }, 'Gmail getMessage failed');
    return null;
  }
}

/**
 * Get the count of unread messages in the inbox.
 */
export async function getUnreadCount(): Promise<number | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  try {
    await rateLimit();
    const res = await gmail.users.labels.get({
      userId: 'me',
      id: 'INBOX',
    });

    const count = res.data.messagesUnread || 0;
    logger.info({ unread: count }, 'Gmail unread count');
    return count;
  } catch (err) {
    logger.error({ err: String(err) }, 'Gmail getUnreadCount failed');
    return null;
  }
}

/**
 * Archive a message (remove INBOX label).
 */
export async function archiveMessage(id: string): Promise<boolean> {
  const gmail = await getGmailClient();
  if (!gmail) return false;

  try {
    await rateLimit();
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        removeLabelIds: ['INBOX'],
      },
    });

    logger.info({ id }, 'Gmail message archived');
    return true;
  } catch (err) {
    logger.error({ err: String(err), id }, 'Gmail archiveMessage failed');
    return false;
  }
}

/**
 * Move a message to trash.
 */
export async function trashMessage(id: string): Promise<boolean> {
  const gmail = await getGmailClient();
  if (!gmail) return false;

  try {
    await rateLimit();
    await gmail.users.messages.trash({
      userId: 'me',
      id,
    });

    logger.info({ id }, 'Gmail message trashed');
    return true;
  } catch (err) {
    logger.error({ err: String(err), id }, 'Gmail trashMessage failed');
    return false;
  }
}

/**
 * Mark a message as read.
 */
export async function markRead(id: string): Promise<boolean> {
  const gmail = await getGmailClient();
  if (!gmail) return false;

  try {
    await rateLimit();
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });

    logger.info({ id }, 'Gmail message marked read');
    return true;
  } catch (err) {
    logger.error({ err: String(err), id }, 'Gmail markRead failed');
    return false;
  }
}

/**
 * Mark a message as unread.
 */
export async function markUnread(id: string): Promise<boolean> {
  const gmail = await getGmailClient();
  if (!gmail) return false;

  try {
    await rateLimit();
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        addLabelIds: ['UNREAD'],
      },
    });

    logger.info({ id }, 'Gmail message marked unread');
    return true;
  } catch (err) {
    logger.error({ err: String(err), id }, 'Gmail markUnread failed');
    return false;
  }
}

/**
 * Add a label to a message.
 */
export async function addLabel(id: string, label: string): Promise<boolean> {
  const gmail = await getGmailClient();
  if (!gmail) return false;

  try {
    // Resolve label name to ID
    const labelId = await resolveLabelId(gmail, label);
    if (!labelId) {
      logger.warn({ label }, 'Gmail label not found');
      return false;
    }

    await rateLimit();
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        addLabelIds: [labelId],
      },
    });

    logger.info({ id, label }, 'Gmail label added');
    return true;
  } catch (err) {
    logger.error({ err: String(err), id, label }, 'Gmail addLabel failed');
    return false;
  }
}

/**
 * Remove a label from a message.
 */
export async function removeLabel(id: string, label: string): Promise<boolean> {
  const gmail = await getGmailClient();
  if (!gmail) return false;

  try {
    const labelId = await resolveLabelId(gmail, label);
    if (!labelId) {
      logger.warn({ label }, 'Gmail label not found');
      return false;
    }

    await rateLimit();
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: {
        removeLabelIds: [labelId],
      },
    });

    logger.info({ id, label }, 'Gmail label removed');
    return true;
  } catch (err) {
    logger.error({ err: String(err), id, label }, 'Gmail removeLabel failed');
    return false;
  }
}

/**
 * Send a new email.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: GmailSendOptions,
): Promise<GmailSendResult | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  try {
    const contentType = options?.html ? 'text/html' : 'text/plain';
    const headers = [
      `To: ${sanitizeHeader(to)}`,
      `Subject: ${sanitizeHeader(subject)}`,
      `Content-Type: ${contentType}; charset=utf-8`,
      'MIME-Version: 1.0',
    ];

    if (options?.cc) headers.push(`Cc: ${sanitizeHeader(options.cc)}`);
    if (options?.bcc) headers.push(`Bcc: ${sanitizeHeader(options.bcc)}`);
    if (options?.replyTo) headers.push(`Reply-To: ${sanitizeHeader(options.replyTo)}`);

    const rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
    const encoded = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await rateLimit();
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encoded,
      },
    });

    const result: GmailSendResult = {
      id: res.data.id || '',
      threadId: res.data.threadId || '',
      labelIds: res.data.labelIds || [],
    };

    logger.info({ to, subject: subject.slice(0, 60), id: result.id }, 'Gmail email sent');
    return result;
  } catch (err) {
    logger.error({ err: String(err), to, subject }, 'Gmail sendEmail failed');
    return null;
  }
}

/**
 * Reply to an existing message in its thread.
 */
export async function replyToMessage(id: string, body: string): Promise<GmailSendResult | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  try {
    // Get the original message for thread context
    await rateLimit();
    const original = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Message-ID'],
    });

    const origHeaders = original.data.payload?.headers || [];
    const origFrom = sanitizeHeader(extractHeader(origHeaders, 'From'));
    const origSubject = sanitizeHeader(extractHeader(origHeaders, 'Subject'));
    const origMessageId = sanitizeHeader(extractHeader(origHeaders, 'Message-ID'));
    const threadId = original.data.threadId || '';

    // Build reply subject
    const replySubject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

    const headers = [
      `To: ${origFrom}`,
      `Subject: ${replySubject}`,
      `Content-Type: text/plain; charset=utf-8`,
      'MIME-Version: 1.0',
    ];

    if (origMessageId) {
      headers.push(`In-Reply-To: ${origMessageId}`);
      headers.push(`References: ${origMessageId}`);
    }

    const rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
    const encoded = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await rateLimit();
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encoded,
        threadId,
      },
    });

    const result: GmailSendResult = {
      id: res.data.id || '',
      threadId: res.data.threadId || '',
      labelIds: res.data.labelIds || [],
    };

    logger.info({ originalId: id, replyId: result.id, to: origFrom }, 'Gmail reply sent');
    return result;
  } catch (err) {
    logger.error({ err: String(err), id }, 'Gmail replyToMessage failed');
    return null;
  }
}

/**
 * List all Gmail labels.
 */
export async function getLabels(): Promise<GmailLabel[] | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;

  try {
    await rateLimit();
    const res = await gmail.users.labels.list({
      userId: 'me',
    });

    const labels = (res.data.labels || []).map(l => ({
      id: l.id || '',
      name: l.name || '',
      type: l.type || '',
      messagesTotal: l.messagesTotal || 0,
      messagesUnread: l.messagesUnread || 0,
    }));

    logger.info({ count: labels.length }, 'Gmail labels listed');
    return labels;
  } catch (err) {
    logger.error({ err: String(err) }, 'Gmail getLabels failed');
    return null;
  }
}

// ── Internal: label name resolution ──────────────────────────────────

let _labelCache: Map<string, string> | null = null;
let _labelCacheTime = 0;
const LABEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function resolveLabelId(gmail: gmail_v1.Gmail, nameOrId: string): Promise<string | null> {
  // If it looks like a label ID already (e.g. "INBOX", "UNREAD", "Label_123"), try it directly
  if (/^(INBOX|SENT|TRASH|DRAFT|SPAM|UNREAD|STARRED|IMPORTANT|CATEGORY_\w+|Label_\d+)$/.test(nameOrId)) {
    return nameOrId;
  }

  // Refresh cache if stale
  const now = Date.now();
  if (!_labelCache || now - _labelCacheTime > LABEL_CACHE_TTL_MS) {
    await rateLimit();
    const res = await gmail.users.labels.list({ userId: 'me' });
    _labelCache = new Map();
    for (const label of res.data.labels || []) {
      if (label.name && label.id) {
        _labelCache.set(label.name.toLowerCase(), label.id);
      }
    }
    _labelCacheTime = now;
  }

  return _labelCache.get(nameOrId.toLowerCase()) || null;
}
