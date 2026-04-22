/**
 * Scribe -- PM2 worker entry point.
 *
 * Polls the bridge for on-demand tasks and runs a nightly batch
 * at 3 AM. Follows the exact same pattern as worker.ts.
 *
 * Does NOT use runAgent() -- the processor is a TypeScript pipeline,
 * not a Claude Code agent. Much lighter and cheaper.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initBridge,
  claimNextTask,
  completeTask,
  failTask,
  expireStale,
  type TaskPayload,
  type ResultPayload,
} from './bridge.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { initScribeDb, initMainWriteDb } from './scribe/db.js';
import { runScribePipeline } from './scribe/index.js';
import { parseLibrarianCommand, runLibrarianCommand, runAutoSort } from './scribe/librarian.js';
import type { ScribeOptions, ScribeRunResult } from './scribe/types.js';

const __workerFilename = fileURLToPath(import.meta.url);
const __workerDirname = path.dirname(__workerFilename);

// ── Configuration ───────────────────────────────────────────────────

const workerEnv = readEnvFile(['BRIDGE_MAIN_ROOT', 'WORKER_NAME', 'WORKER_POLL_MS']);

const WORKER_NAME = process.env.WORKER_NAME || workerEnv.WORKER_NAME || 'processor-1';
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_MS || workerEnv.WORKER_POLL_MS || '30000', 10);
const MAIN_ROOT = process.env.BRIDGE_MAIN_ROOT || workerEnv.BRIDGE_MAIN_ROOT || path.resolve(__workerDirname, '..');
const NOTIFY_SCRIPT = path.join(MAIN_ROOT, 'scripts', 'notify.sh');
const WORKER_ROOT = process.env.APEX_ROOT || path.resolve(__workerDirname, '..');
const NIGHTLY_HOUR = 3;  // 3 AM
const AUTO_SORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const VAULT_SORT_ENABLED = (process.env.SCRIBE_VAULT_SORT_ENABLED || 'true').toLowerCase() === 'true';
const LIBRARIAN_ENABLED = (process.env.SCRIBE_LIBRARIAN_ENABLED || 'true').toLowerCase() === 'true';

// Read ALLOWED_CHAT_ID from main .env for librarian commands
const mainEnvPath = path.join(MAIN_ROOT, '.env');
let LIBRARIAN_CHAT_ID = process.env.CHAT_ID || process.env.ALLOWED_CHAT_ID || '';
if (!LIBRARIAN_CHAT_ID && fs.existsSync(mainEnvPath)) {
  try {
    const mainEnvContent = fs.readFileSync(mainEnvPath, 'utf-8');
    const chatMatch = mainEnvContent.match(/ALLOWED_CHAT_ID=(.+)/);
    if (chatMatch) LIBRARIAN_CHAT_ID = chatMatch[1].trim();
  } catch { /* non-fatal */ }
}

// ── Init ────────────────────────────────────────────────────────────

initBridge(MAIN_ROOT);
initScribeDb(MAIN_ROOT, path.join(WORKER_ROOT, 'store'));
initMainWriteDb(MAIN_ROOT);

// Initialize shared learning system (for feedback tracking and knowledge sharing)
try {
  const { initLearning } = await import('./learning/index.js');
  initLearning(MAIN_ROOT);
  logger.info('Scribe learning system initialized');
} catch (learningErr) {
  logger.warn({ err: learningErr }, 'Scribe learning system init failed (non-fatal)');
}

// ── Processing state ────────────────────────────────────────────────

let isProcessing = false;
let lastNightlyDate = '';

// ── Notify ──────────────────────────────────────────────────────────

function notify(_message: string): void {
  // Telegram notifications disabled -- Scribe runs silently.
  // Re-enable by uncommenting the spawnSync below.
  // try {
  //   spawnSync('bash', [NOTIFY_SCRIPT, _message], {
  //     timeout: 10000,
  //     stdio: 'ignore',
  //     windowsHide: true,
  //   });
  // } catch {
  //   // best-effort
  // }
}

// ── Command parsing ─────────────────────────────────────────────────

function parseScribeCommand(prompt: string): ScribeOptions {
  const options: ScribeOptions = {};

  // "process last N days"
  const daysMatch = prompt.match(/last\s+(\d+)\s+days?/i);
  if (daysMatch) {
    options.lookbackDays = parseInt(daysMatch[1], 10);
  }

  // "dry run"
  if (/dry\s*run/i.test(prompt)) {
    options.dryRun = true;
  }

  // "from id N" or "after id N"
  const idMatch = prompt.match(/(?:from|after)\s+(?:id\s+)?(\d+)/i);
  if (idMatch) {
    options.afterMessageId = parseInt(idMatch[1], 10);
  }

  return options;
}

function formatRunSummary(result: ScribeRunResult): string {
  const lines = [
    `Scribe run complete (${(result.durationMs / 1000).toFixed(1)}s)`,
    `Threads: ${result.threadsProcessed}`,
    `Classified: ${result.itemsClassified}`,
    `Written to vault: ${result.itemsWritten}`,
    `Deduplicated: ${result.itemsDeduplicated}`,
    `Skipped: ${result.itemsSkipped}`,
  ];
  if (result.memoriesCreated > 0 || result.memoriesUpdated > 0) {
    lines.push(`Memories: ${result.memoriesCreated} created, ${result.memoriesUpdated} updated`);
  }
  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.length}`);
    lines.push(result.errors.slice(0, 3).join('; '));
  }
  return lines.join('\n');
}

// ── Bridge polling ──────────────────────────────────────────────────

async function pollAndProcess(): Promise<void> {
  if (isProcessing) return;

  // Expire stale messages
  const expired = expireStale(30);
  if (expired > 0) {
    logger.info({ expired }, 'Expired stale bridge messages');
  }

  const msg = claimNextTask(WORKER_NAME);
  if (!msg) return;

  isProcessing = true;
  let payload: TaskPayload;

  try {
    payload = JSON.parse(msg.payload) as TaskPayload;
  } catch {
    logger.error({ msgId: msg.id }, 'Invalid task payload JSON');
    failTask(msg.id, 'Invalid task payload');
    isProcessing = false;
    return;
  }

  const promptPreview = payload.prompt.slice(0, 80);
  logger.info({ msgId: msg.id, prompt: promptPreview }, 'Claimed scribe task');
  notify(`Scribe started: ${payload.prompt.slice(0, 60)}...`);

  // Timeout watchdog
  const timeoutMs = (payload.timeout_minutes || 10) * 60 * 1000;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.error({ msgId: msg.id }, 'Scribe task timed out');
    failTask(msg.id, `Timed out after ${payload.timeout_minutes || 10} minutes`);
    notify(`Scribe TIMED OUT: ${payload.prompt.slice(0, 40)}...`);
    isProcessing = false;
  }, timeoutMs);

  try {
    // Check for librarian command first
    const libCmd = parseLibrarianCommand(payload.prompt);

    if (libCmd && !LIBRARIAN_ENABLED) {
      // Librarian disabled -- reject gracefully
      if (timedOut) return;
      clearTimeout(timeoutHandle);
      const resultPayload: ResultPayload = {
        summary: 'Librarian commands are temporarily disabled (hybrid mode). The primary bot handles vault routing manually.',
        tokens_used: 0,
        cost_usd: 0,
      };
      completeTask(msg.id, resultPayload);
      logger.info({ msgId: msg.id, command: libCmd.type }, 'Librarian command rejected (disabled)');
    } else if (libCmd) {
      // Librarian command -- needs the owner's chatId for memory queries
      const libChatId = LIBRARIAN_CHAT_ID;
      const libResult = await runLibrarianCommand(libChatId, libCmd);

      if (timedOut) return;
      clearTimeout(timeoutHandle);

      const resultPayload: ResultPayload = {
        summary: libResult.summary,
        tokens_used: 0,
        cost_usd: 0,
      };

      completeTask(msg.id, resultPayload);
      logger.info({ msgId: msg.id, command: libResult.command }, 'Librarian command completed');
      notify(`Librarian ${libResult.command}: done`);

    } else {
      // Standard Scribe pipeline
      const options = parseScribeCommand(payload.prompt);
      const result = await runScribePipeline(options, 'bridge', msg.id);

      if (timedOut) return;
      clearTimeout(timeoutHandle);

      const summary = formatRunSummary(result);

      const resultPayload: ResultPayload = {
        summary,
        tokens_used: 0,
        cost_usd: 0,
      };

      completeTask(msg.id, resultPayload);
      logger.info({ msgId: msg.id, written: result.itemsWritten }, 'Scribe task completed');
      notify(`Scribe done: ${result.itemsWritten} items written to vault`);

      // Store task feedback in learning system
      try {
        const { storeFeedback } = await import('./learning/index.js');
        storeFeedback({
          agent: process.env.WORKER_NAME || 'processor-1',
          task_id: msg.id,
          task_summary: `Processed ${result.threadsProcessed} threads, wrote ${result.itemsWritten} items`,
          score: result.itemsWritten > 0 ? 4 : 2,
          comments: `Classified: ${result.itemsClassified}, Deduped: ${result.itemsDeduplicated}, Skipped: ${result.itemsSkipped}`,
          lessons_learned: null,
        });
      } catch { /* non-fatal */ }
    }

  } catch (err) {
    if (timedOut) return;
    clearTimeout(timeoutHandle);

    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ msgId: msg.id, err: errMsg }, 'Scribe task failed');
    failTask(msg.id, errMsg);
    notify(`Scribe FAILED: ${errMsg.slice(0, 60)}`);
  } finally {
    if (!timedOut) {
      isProcessing = false;
    }
  }
}

// ── Nightly batch ───────────────────────────────────────────────────

async function checkNightlyRun(): Promise<void> {
  if (isProcessing) return;

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // Only run once per day at the nightly hour
  if (now.getHours() !== NIGHTLY_HOUR) return;
  if (lastNightlyDate === todayStr) return;

  lastNightlyDate = todayStr;
  isProcessing = true;

  logger.info('Starting nightly Scribe run');
  notify('Scribe nightly batch starting...');

  try {
    const result = await runScribePipeline(undefined, 'scheduled', 'nightly-3am');
    const summary = formatRunSummary(result);
    logger.info({ result: summary }, 'Nightly Scribe run complete');

    if (result.itemsWritten > 0) {
      notify(`Scribe nightly: ${result.itemsWritten} items written to vault`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg }, 'Nightly Scribe run failed');
    notify(`Scribe nightly FAILED: ${errMsg.slice(0, 60)}`);
  } finally {
    isProcessing = false;
  }
}

// ── Auto vault-sort ──────────────────────────────────────────────

let isAutoSorting = false;

async function runAutoSortCycle(): Promise<void> {
  // Don't run if disabled, bridge processing, or nightly is active
  if (!VAULT_SORT_ENABLED || isProcessing || isAutoSorting) return;

  isAutoSorting = true;
  try {
    const { sorted, archived, recovered } = await runAutoSort();
    if (sorted > 0 || archived > 0 || recovered > 0) {
      logger.info({ sorted, archived, recovered }, 'Auto-sort cycle: work done');
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, 'Auto-sort cycle failed');
  } finally {
    isAutoSorting = false;
  }
}

// ── Main loop ───────────────────────────────────────────────────────

// Internal automation -- disabled by default in release builds
if (process.env.ENABLE_SCRIBE !== 'true') {
  logger.info('Scribe worker disabled (set ENABLE_SCRIBE=true to enable). Process will idle.');
  // Keep process alive but don't start any polling loops
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
} else {

logger.info(
  { worker: WORKER_NAME, pollMs: POLL_INTERVAL_MS, autoSortMs: AUTO_SORT_INTERVAL_MS, mainRoot: MAIN_ROOT, workerRoot: WORKER_ROOT, vaultSort: VAULT_SORT_ENABLED, librarian: LIBRARIAN_ENABLED },
  'Scribe worker starting',
);

// Poll bridge for on-demand tasks
const pollInterval = setInterval(() => void pollAndProcess(), POLL_INTERVAL_MS);

// Check nightly schedule every minute
const nightlyInterval = setInterval(() => void checkNightlyRun(), 60_000);

// Auto vault-sort every 5 minutes (watches Agent Workspace, routes to vault)
const autoSortInterval = setInterval(() => void runAutoSortCycle(), AUTO_SORT_INTERVAL_MS);

// Immediate first poll
void pollAndProcess();

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(): void {
  logger.info('Scribe worker shutting down');
  clearInterval(pollInterval);
  clearInterval(nightlyInterval);
  clearInterval(autoSortInterval);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Scribe unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Scribe uncaught exception');
  clearInterval(pollInterval);
  clearInterval(nightlyInterval);
  clearInterval(autoSortInterval);
  process.exit(1);
});

} // end ENABLE_SCRIBE gate
