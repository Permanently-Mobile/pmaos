/**
 * Generic headless worker agent.
 *
 * Polls the shared bridge database for tasks, executes them via runAgent(),
 * and writes results back. No Telegram bot, no dashboard, no scheduler.
 *
 * Identity is driven by WORKER_NAME env var (researcher-1, coder-1, etc.).
 * Runs as a PM2 process alongside the primary bot.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runAgent } from './agent.js';
import { createWorkerProvider } from './providers/worker-provider-factory.js';
import {
  initBridge,
  claimNextTask,
  completeTask,
  failTask,
  expireStale,
  hiveLog,
  TaskPayload,
  ResultPayload,
} from './bridge.js';
import {
  initSessions,
  loadSession,
  addNote,
  sessionToContext,
} from './context-session.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { acquireSlot, type SlotHandle } from './process-lock.js';
import {
  initLearning,
  searchLearning,
  storeFeedback,
  storeKnowledge,
} from './learning/index.js';
import { canStudy, runStudySession, type StudyConfig } from './learning/study.js';

const __workerFilename = fileURLToPath(import.meta.url);
const __workerDirname = path.dirname(__workerFilename);

// ── Configuration ─────────────────────────────────────────────────────

// Read worker-specific config from .env (in APEX_ROOT dir)
const workerEnv = readEnvFile(['BRIDGE_MAIN_ROOT', 'WORKER_NAME', 'WORKER_POLL_MS']);

const WORKER_NAME = process.env.WORKER_NAME || workerEnv.WORKER_NAME || 'worker-1';
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_MS || workerEnv.WORKER_POLL_MS || '15000', 10);
const MAIN_ROOT = process.env.BRIDGE_MAIN_ROOT || workerEnv.BRIDGE_MAIN_ROOT || path.resolve(__workerDirname, '..');
const WORKER_ROOT = process.env.APEX_ROOT || path.resolve(__workerDirname, '..');

// Cooldown between tasks (ms). 0 = no cooldown (back-to-back).
// Set via WORKER_COOLDOWN_MS in the worker's .env (e.g. 7200000 for 2 hours).
const workerCooldownEnv = readEnvFile(['WORKER_COOLDOWN_MS', 'WORKER_TASK_TIMEOUT_MIN', 'WORKER_STALE_CLAIMED_MIN']);
const COOLDOWN_MS = parseInt(process.env.WORKER_COOLDOWN_MS || workerCooldownEnv.WORKER_COOLDOWN_MS || '0', 10);

// Per-task timeout: how long a single agent run can take before the worker kills it.
// Default 30 minutes. Deep research tasks need 90+ minutes.
const TASK_TIMEOUT_MIN = parseInt(
  process.env.WORKER_TASK_TIMEOUT_MIN || workerCooldownEnv.WORKER_TASK_TIMEOUT_MIN || '30', 10,
);

// How long a claimed task can sit before expireStale marks it failed (crash recovery).
// Should be >= TASK_TIMEOUT_MIN. Default 180 minutes (3 hours).
const STALE_CLAIMED_MIN = parseInt(
  process.env.WORKER_STALE_CLAIMED_MIN || workerCooldownEnv.WORKER_STALE_CLAIMED_MIN || '180', 10,
);

// Capitalised label for logs/notifications (e.g. "Researcher-1", "Coder-1")
const WORKER_LABEL = WORKER_NAME.charAt(0).toUpperCase() + WORKER_NAME.slice(1);

// Worker provider: 'claude' (default), 'aider', or any registered provider name.
// Set via WORKER_PROVIDER in the worker's .env to use a non-Claude agent backend.
const WORKER_PROVIDER = process.env.WORKER_PROVIDER || 'claude';
const workerProvider = createWorkerProvider(WORKER_PROVIDER);

// ── Init bridge + sessions ────────────────────────────────────────────

initBridge(MAIN_ROOT);
initSessions(MAIN_ROOT);

// Initialize shared learning system (uses bridge.db)
try {
  initLearning(MAIN_ROOT);
  logger.info(`${WORKER_LABEL} learning system initialized`);
} catch (learningErr) {
  logger.warn({ err: learningErr }, `${WORKER_LABEL} learning system init failed (non-fatal)`);
}

hiveLog(WORKER_NAME, 'start', `Worker starting (poll: ${POLL_INTERVAL_MS}ms)`);

// Agent output goes to Obsidian vault (single source of truth)
const VAULT_ROOT = process.env.VAULT_ROOT || '';
const reportsDir = path.join(VAULT_ROOT, 'Agent Workspace', WORKER_LABEL);
fs.mkdirSync(reportsDir, { recursive: true });

// Keep a local fallback copy in case vault is unavailable
const localReportsDir = path.join(WORKER_ROOT, 'store', 'reports');
fs.mkdirSync(localReportsDir, { recursive: true });

// ── Vault recovery queue ────────────────────────────────────────────
// When a vault write fails, the file path is queued here for retry on the next poll cycle.

interface PendingVaultWrite {
  localPath: string;   // path to the local fallback file
  vaultPath: string;   // intended vault destination
  queuedAt: number;    // epoch ms
}

const PENDING_VAULT_WRITES_FILE = path.join(WORKER_ROOT, 'store', 'pending-vault-writes.json');
const VAULT_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // discard entries older than 7 days

function loadPendingVaultWrites(): PendingVaultWrite[] {
  try {
    if (!fs.existsSync(PENDING_VAULT_WRITES_FILE)) return [];
    const raw = fs.readFileSync(PENDING_VAULT_WRITES_FILE, 'utf-8');
    return JSON.parse(raw) as PendingVaultWrite[];
  } catch {
    return [];
  }
}

function savePendingVaultWrites(queue: PendingVaultWrite[]): void {
  try {
    fs.writeFileSync(PENDING_VAULT_WRITES_FILE, JSON.stringify(queue, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err }, `${WORKER_LABEL} failed to save pending vault writes queue`);
  }
}

function enqueueVaultWrite(localPath: string, vaultPath: string): void {
  const queue = loadPendingVaultWrites();
  // Avoid duplicates
  if (queue.some(e => e.localPath === localPath && e.vaultPath === vaultPath)) return;
  queue.push({ localPath, vaultPath, queuedAt: Date.now() });
  savePendingVaultWrites(queue);
  logger.info({ localPath, vaultPath }, `${WORKER_LABEL} queued vault write for retry`);
}

function retryPendingVaultWrites(): void {
  const queue = loadPendingVaultWrites();
  if (queue.length === 0) return;

  const now = Date.now();
  const remaining: PendingVaultWrite[] = [];

  for (const entry of queue) {
    // Discard entries older than 7 days
    if (now - entry.queuedAt > VAULT_RETRY_MAX_AGE_MS) {
      logger.warn({ localPath: entry.localPath }, `${WORKER_LABEL} discarding stale vault write (>7d)`);
      continue;
    }

    // Check if local source still exists
    if (!fs.existsSync(entry.localPath)) {
      logger.warn({ localPath: entry.localPath }, `${WORKER_LABEL} local file gone, dropping from queue`);
      continue;
    }

    // Check if vault file already exists (written by another mechanism)
    if (fs.existsSync(entry.vaultPath)) {
      logger.info({ vaultPath: entry.vaultPath }, `${WORKER_LABEL} vault file already exists, removing from queue`);
      continue;
    }

    // Attempt vault write
    try {
      fs.mkdirSync(path.dirname(entry.vaultPath), { recursive: true });
      const content = fs.readFileSync(entry.localPath, 'utf-8');
      fs.writeFileSync(entry.vaultPath, content, 'utf-8');
      logger.info({ vaultPath: entry.vaultPath }, `${WORKER_LABEL} recovered vault write from queue`);
      // Success -- don't add back to remaining
    } catch (err) {
      // Still failing, keep in queue
      remaining.push(entry);
      logger.warn({ vaultPath: entry.vaultPath, err }, `${WORKER_LABEL} vault write retry failed, keeping in queue`);
    }
  }

  savePendingVaultWrites(remaining);

  const recovered = queue.length - remaining.length;
  if (recovered > 0) {
    logger.info({ recovered, remaining: remaining.length }, `${WORKER_LABEL} vault recovery: ${recovered} recovered`);
  }
}

// ── Learning system config ────────────────────────────────────────────

// Study session interval: default 30 min. Set via WORKER_STUDY_INTERVAL_MS.
const STUDY_INTERVAL_MS = parseInt(
  process.env.WORKER_STUDY_INTERVAL_MS || '1800000', 10,
);

// Worker-specific study config. Agents define their specialties in .env or CLAUDE.md.
const WORKER_SPECIALTIES = (process.env.WORKER_SPECIALTIES || 'general').split(',').map(s => s.trim());
const WORKER_ROLE = process.env.WORKER_ROLE || `A specialized agent (${WORKER_LABEL})`;

let isStudying = false;
let studyFailedUntil = 0; // epoch ms -- cooldown after failure to prevent infinite retry loops

/**
 * Run a study session if the agent is idle and enough time has passed.
 * Uses Venice/Ollama (privacy-first) for the LLM reasoning.
 */
async function maybeRunStudySession(): Promise<void> {
  if (isStudying || isProcessing) return;

  // Only study if enabled (opt-out via WORKER_STUDY_ENABLED=false)
  if (process.env.WORKER_STUDY_ENABLED === 'false') return;

  // Respect failure cooldown -- prevents infinite retry loops when DB has issues
  if (Date.now() < studyFailedUntil) return;

  try {
    if (!canStudy(WORKER_NAME, STUDY_INTERVAL_MS)) return;

    isStudying = true;
    logger.info(`${WORKER_LABEL} starting idle study session`);
    hiveLog(WORKER_NAME, 'study', 'Starting idle study session');

    const result = await runStudySession({
      agent: WORKER_NAME,
      specialties: WORKER_SPECIALTIES,
      roleDescription: WORKER_ROLE,
      intervalMs: STUDY_INTERVAL_MS,
    });

    logger.info({
      topic: result.topic,
      tokensUsed: result.tokensUsed,
      knowledgeId: result.knowledgeId,
    }, `${WORKER_LABEL} study session complete`);
    hiveLog(WORKER_NAME, 'study_complete', `Topic: ${result.topic}, tokens: ${result.tokensUsed}`);

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, `${WORKER_LABEL} study session failed (non-fatal)`);
    // On failure, wait the full study interval before retrying.
    // This prevents infinite loops where DB errors cause immediate retries burning tokens.
    studyFailedUntil = Date.now() + STUDY_INTERVAL_MS;
    logger.info({ cooldownMs: STUDY_INTERVAL_MS }, `${WORKER_LABEL} study cooldown set after failure`);
  } finally {
    isStudying = false;
  }
}

// ── Processing state ──────────────────────────────────────────────────

let isProcessing = false;
let cooldownUntil = 0; // epoch ms -- skip claiming until this time
let heartbeatCounter = 0;
const HEARTBEAT_EVERY_N = Math.max(1, Math.ceil(60000 / POLL_INTERVAL_MS)); // ~every 60s

/**
 * Poll the bridge for tasks, claim one, and execute it.
 */
async function pollAndProcess(): Promise<void> {
  // Periodic heartbeat to hive mind (~every 60s)
  if (++heartbeatCounter >= HEARTBEAT_EVERY_N) {
    heartbeatCounter = 0;
    hiveLog(WORKER_NAME, 'heartbeat');
  }

  if (isProcessing) {
    // Even while processing a task, attempt vault recovery on each cycle
    retryPendingVaultWrites();
    return;
  }

  // Retry pending vault writes each poll cycle (before claiming new work)
  retryPendingVaultWrites();

  // Respect cooldown between tasks
  if (COOLDOWN_MS > 0 && Date.now() < cooldownUntil) {
    return; // still cooling down, check again next poll
  }

  // Expire stale messages first
  const expired = expireStale(STALE_CLAIMED_MIN);
  if (expired > 0) {
    logger.info({ expired }, 'Expired stale bridge messages');
  }

  const msg = claimNextTask(WORKER_NAME);
  if (!msg) {
    // No tasks available -- run idle study session if enough time has passed
    void maybeRunStudySession();
    return;
  }

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
  logger.info({ msgId: msg.id, prompt: promptPreview, sessionId: payload.session_id }, `${WORKER_LABEL} claimed task`);

  // ── Load shared context session (if linked) ──
  let sessionContext = '';
  if (payload.session_id) {
    try {
      const session = loadSession(payload.session_id);
      if (session) {
        sessionContext = sessionToContext(session);
        logger.info({ sessionId: payload.session_id, topic: session.topic }, `${WORKER_LABEL} loaded context session`);
      } else {
        logger.warn({ sessionId: payload.session_id }, `${WORKER_LABEL} session_id provided but session not found`);
      }
    } catch (sessErr) {
      logger.warn({ sessionId: payload.session_id, err: sessErr }, `${WORKER_LABEL} failed to load session context`);
    }
  }

  // ── Inject relevant knowledge from learning system ──
  let learningContext = '';
  try {
    const hits = searchLearning(payload.prompt.slice(0, 500), {
      agent: WORKER_NAME,
      includeShared: true,
      limit: 5,
    });
    if (hits.length > 0) {
      const entries = hits.map(h => `- ${h.text.slice(0, 300)}`).join('\n');
      learningContext = `\n\n## Relevant Knowledge (from past learning)\n${entries}\n`;
      logger.info({ hits: hits.length }, `${WORKER_LABEL} injected ${hits.length} learning hits`);
    }
  } catch (searchErr) {
    logger.warn({ err: searchErr }, `${WORKER_LABEL} learning search failed (non-fatal)`);
  }

  // Build the full prompt: session context + learning context + original prompt
  const parts: string[] = [];
  if (sessionContext) parts.push(sessionContext);
  if (learningContext) parts.push(learningContext);
  parts.push(payload.prompt);
  const fullPrompt = parts.join('\n\n---\n\n');

  // Timeout watchdog -- respect per-task override, then worker-level config, then 30m default
  const effectiveTimeout = payload.timeout_minutes || TASK_TIMEOUT_MIN;
  const timeoutMs = effectiveTimeout * 60 * 1000;
  let timedOut = false;

  // Acquire a Claude execution slot before spawning the subprocess.
  // This prevents RAM overload from too many concurrent Claude instances.
  // The primary bot (bot.ts) bypasses this -- the user's messages always get priority.
  let slot: SlotHandle | null = null;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.error({ msgId: msg.id, timeoutMin: effectiveTimeout }, `${WORKER_LABEL} task timed out`);
    failTask(msg.id, `Timed out after ${effectiveTimeout} minutes`);
    // Release Claude slot on timeout so other workers aren't blocked
    if (slot) {
      slot.release();
      slot = null;
    }
    isProcessing = false;
  }, timeoutMs);
  try {
    slot = await acquireSlot(WORKER_NAME);
  } catch (lockErr) {
    clearTimeout(timeoutHandle);
    const lockMsg = lockErr instanceof Error ? lockErr.message : String(lockErr);
    logger.error({ msgId: msg.id, err: lockMsg }, `${WORKER_LABEL} failed to acquire Claude slot`);
    failTask(msg.id, `Slot acquisition failed: ${lockMsg}`);
    isProcessing = false;
    return;
  }

  try {
    // Run via the configured worker provider (claude, aider, etc.)
    // For claude: uses runAgent() internally with full SDK integration
    // For aider/others: uses their own execution logic
    const result = WORKER_PROVIDER === 'claude'
      ? await runAgent(
          fullPrompt,
          undefined,    // no session -- each task is standalone
          () => {},      // no typing indicator
          undefined,    // no progress callback
          timeoutMs,    // pass worker timeout to agent's internal Promise.race
          undefined,    // model -- use default
          WORKER_ROOT,  // cwd -- worker's bot dir so Claude reads the correct CLAUDE.md
        )
      : await workerProvider.execute(
          fullPrompt,
          undefined,    // no resume token -- each task is standalone
          () => {},      // no typing indicator
          undefined,    // no progress callback
          timeoutMs,
          undefined,    // model -- use default
          WORKER_ROOT,  // cwd
        );

    if (timedOut) return; // timeout handler already cleaned up
    clearTimeout(timeoutHandle);

    const summary = result.text?.trim() || `${WORKER_LABEL} completed with no output.`;

    // Save long reports to vault (primary) + local backup
    let reportPath: string | undefined;
    if (summary.length > 2000) {
      const today = new Date().toISOString().split('T')[0];
      const filename = `${today} - ${WORKER_NAME}-${msg.id}.md`;
      reportPath = path.join(reportsDir, filename);
      try {
        fs.writeFileSync(reportPath, summary, 'utf-8');
        logger.info({ reportPath }, `${WORKER_LABEL} report saved to vault`);
      } catch (vaultErr) {
        // Fallback to local if vault write fails
        const intendedVaultPath = reportPath!;
        reportPath = path.join(localReportsDir, filename);
        fs.writeFileSync(reportPath, summary, 'utf-8');
        logger.warn({ reportPath, err: vaultErr }, `${WORKER_LABEL} vault write failed, saved locally`);
        // Queue for retry on next poll cycle
        enqueueVaultWrite(reportPath, intendedVaultPath);
      }
      // Always keep a local backup copy
      const localCopy = path.join(localReportsDir, filename);
      if (localCopy !== reportPath) {
        try { fs.writeFileSync(localCopy, summary, 'utf-8'); } catch { /* non-fatal */ }
      }
    }

    // Normalize usage extraction across AgentResult and ProviderResult shapes
    const usageTokens = result.usage?.inputTokens;
    const usageCost = 'totalCostUsd' in (result.usage ?? {})
      ? (result.usage as { totalCostUsd?: number })?.totalCostUsd
      : (result.usage as { costUsd?: number | null })?.costUsd ?? undefined;

    const resultPayload: ResultPayload = {
      summary: summary.length > 3000 ? summary.slice(0, 3000) + '\n\n[Full report saved to file]' : summary,
      report_path: reportPath,
      tokens_used: usageTokens,
      cost_usd: usageCost,
      status: 'success',
      artifacts: reportPath ? [reportPath] : undefined,
    };

    // ── Write completion note back to session (if linked) ──
    if (payload.session_id) {
      try {
        const noteText = summary.length > 500
          ? `Task ${msg.id} completed. Summary (truncated): ${summary.slice(0, 500)}...`
          : `Task ${msg.id} completed. Summary: ${summary}`;
        addNote(payload.session_id, WORKER_NAME, noteText);
        logger.info({ sessionId: payload.session_id }, `${WORKER_LABEL} wrote completion note to session`);
      } catch (sessErr) {
        logger.warn({ sessionId: payload.session_id, err: sessErr }, `${WORKER_LABEL} failed to write session note`);
      }
    }

    // ── Store task completion feedback in learning system ──
    try {
      storeFeedback({
        agent: WORKER_NAME,
        task_id: msg.id,
        task_summary: payload.prompt.slice(0, 200),
        score: 3, // Default neutral score; updated by the primary bot's audit or client rating
        comments: summary.length > 500 ? 'Long report generated' : 'Task completed',
        lessons_learned: null,
      });
      logger.info({ msgId: msg.id }, `${WORKER_LABEL} stored task feedback`);
    } catch (fbErr) {
      logger.warn({ err: fbErr }, `${WORKER_LABEL} failed to store feedback (non-fatal)`);
    }

    completeTask(msg.id, resultPayload);
    logger.info({ msgId: msg.id, cost: usageCost }, `${WORKER_LABEL} task completed`);

  } catch (err) {
    if (timedOut) return;
    clearTimeout(timeoutHandle);

    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ msgId: msg.id, err: errMsg }, `${WORKER_LABEL} task failed`);
    failTask(msg.id, errMsg);
  } finally {
    // Always release the Claude slot (even on timeout or error)
    if (slot) {
      slot.release();
      slot = null;
    }
    if (!timedOut) {
      isProcessing = false;
      // Start cooldown timer before claiming next task
      if (COOLDOWN_MS > 0) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        const cooldownMins = Math.round(COOLDOWN_MS / 60000);
        logger.info({ cooldownMinutes: cooldownMins }, `${WORKER_LABEL} cooling down before next task`);
      }
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────

logger.info(
  {
    worker: WORKER_NAME,
    pollMs: POLL_INTERVAL_MS,
    cooldownMs: COOLDOWN_MS,
    mainRoot: MAIN_ROOT,
    workerRoot: WORKER_ROOT,
  },
  `${WORKER_LABEL} worker starting`,
);

// Poll on interval
const pollInterval = setInterval(() => void pollAndProcess(), POLL_INTERVAL_MS);

// Also do an immediate first poll
void pollAndProcess();

// Graceful shutdown
function shutdown(): void {
  logger.info(`${WORKER_LABEL} worker shutting down`);
  clearInterval(pollInterval);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Worker unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Worker uncaught exception');
  clearInterval(pollInterval);
  process.exit(1);
});
