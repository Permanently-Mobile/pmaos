/**
 * Kiosk Conversation Logger
 *
 * Logs kiosk voice exchanges as timestamped text to daily files
 * in the Obsidian vault. Auto-commits after each write.
 *
 * Files: <vault>/Kiosk Logs/YYYY-MM-DD.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_PATH = process.env.VAULT_ROOT || '';
const KIOSK_LOG_DIR = path.join(VAULT_PATH, 'Kiosk Logs');
const PROJECT_ROOT_LOCAL = path.resolve(__dirname, '..');
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT_LOCAL, 'scripts', 'vault-commit.sh');

function ensureLogDir(): void {
  if (!fs.existsSync(KIOSK_LOG_DIR)) {
    fs.mkdirSync(KIOSK_LOG_DIR, { recursive: true });
  }
}

function todayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function dayHeader(date: string): string {
  const d = new Date(date + 'T00:00:00');
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  return `---\ntype: kiosk-log\ncreated: ${date}\n---\n\n# Kiosk Log - ${date} (${day})\n\n`;
}

/**
 * End-of-day flush: write full chat history snapshot to vault before clearing.
 * Called by the client at 12:01 AM before localStorage is wiped.
 * Safety net in case any per-message logs were missed.
 * @param sourceDate - The date the messages belong to (YYYY-MM-DD). If omitted, uses today.
 */
export function flushChatToVault(messages: Array<{ s: string; t: string; ts: number }>, sourceDate?: string): void {
  try {
    ensureLogDir();
    const date = sourceDate || todayDate();
    const logFile = path.join(KIOSK_LOG_DIR, `${date}.md`);

    // Create file with header if new
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, dayHeader(date));
    }

    // Append flush marker + all messages
    let flush = `\n## End-of-Day Chat Flush (${timestamp()})\n\n`;
    for (const msg of messages) {
      const when = new Date(msg.ts);
      const h = String(when.getHours()).padStart(2, '0');
      const m = String(when.getMinutes()).padStart(2, '0');
      const label = msg.s === 'user' ? 'User (kiosk)' : msg.s === 'bot' ? 'Bot' : msg.s;
      flush += `[${h}:${m}] **${label}:** ${msg.t}\n`;
    }
    flush += '\n---\n\n';
    fs.appendFileSync(logFile, flush);

    logger.info({ date, count: messages.length }, 'End-of-day chat flushed to vault');

    // Commit
    try {
      execSync(`bash "${VAULT_COMMIT_SCRIPT}" "kiosk flush: ${date}"`, {
        timeout: 10_000,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      logger.warn('Kiosk flush vault commit failed (non-critical)');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to flush chat to vault');
  }
}

/**
 * Append a kiosk conversation exchange to today's log file.
 * Creates the file with frontmatter if it doesn't exist.
 * Auto-commits to vault git after writing.
 */
export function logKioskExchange(userText: string, responseText: string): void {
  try {
    ensureLogDir();
    const date = todayDate();
    const logFile = path.join(KIOSK_LOG_DIR, `${date}.md`);
    const ts = timestamp();

    // Create file with header if new
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, dayHeader(date));
    }

    // Append the exchange
    const entry = `**[${ts}] User (kiosk):** ${userText}\n**[${ts}] Bot:** ${responseText}\n\n---\n\n`;
    fs.appendFileSync(logFile, entry);

    logger.info({ date, ts }, 'Kiosk exchange logged to vault');

    // Auto-commit (fire and forget)
    try {
      execSync(`bash "${VAULT_COMMIT_SCRIPT}" "kiosk log: ${date}"`, {
        timeout: 10_000,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Non-critical -- log but don't fail
      logger.warn('Kiosk log vault commit failed (non-critical)');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to log kiosk exchange');
  }
}
