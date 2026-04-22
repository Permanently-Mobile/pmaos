/**
 * Restart Context -- survives process restarts so the bot can acknowledge
 * completed builds and carry forward session state.
 *
 * Two layers:
 *   Layer 1 (bot-level): JSON file read on startup -> Telegram ack -> delete
 *   Layer 2 (Claude-level): high-salience memory written to DB for next session
 *
 * Write side: called by Claude (via save-restart-context.sh) before restart.
 * Read side: called by index.ts on startup to deliver the ack.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const CONTEXT_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'),
  '..',
  'workspace',
);
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'restart-context.json');

export interface RestartContext {
  /** What was built/changed (internal summary for memory) */
  summary: string;
  /** Message to send to Telegram on startup (user-facing) */
  ackMessage: string;
  /** Timestamp when context was written */
  timestamp: number;
  /** Files that were changed (optional, for audit trail) */
  filesChanged?: string[];
  /** Build status at time of restart */
  buildStatus?: 'clean' | 'warnings' | 'failed';
  /** What phase/state we're in */
  currentPhase?: string;
}

/**
 * Write restart context before triggering a restart.
 * Called by save-restart-context.sh or directly from TypeScript.
 */
export function writeRestartContext(ctx: RestartContext): void {
  try {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2), 'utf-8');
    logger.info({ file: CONTEXT_FILE }, 'Restart context saved');
  } catch (err) {
    logger.error({ err }, 'Failed to write restart context');
  }
}

/**
 * Read pending restart context. Returns null if none exists.
 */
export function readRestartContext(): RestartContext | null {
  try {
    if (!fs.existsSync(CONTEXT_FILE)) return null;
    const raw = fs.readFileSync(CONTEXT_FILE, 'utf-8');
    const ctx = JSON.parse(raw) as RestartContext;
    // Sanity check: ignore context older than 10 minutes (stale)
    if (Date.now() - ctx.timestamp > 10 * 60 * 1000) {
      logger.warn('Restart context is stale (>10min), ignoring');
      clearRestartContext();
      return null;
    }
    return ctx;
  } catch (err) {
    logger.error({ err }, 'Failed to read restart context');
    return null;
  }
}

/**
 * Clear restart context after it's been delivered.
 */
export function clearRestartContext(): void {
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      fs.unlinkSync(CONTEXT_FILE);
      logger.info('Restart context cleared');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to clear restart context');
  }
}
