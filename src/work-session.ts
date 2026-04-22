/**
 * Work Session Manager — Ephemeral subprocess isolation for heavy tasks.
 *
 * Spawns isolated Node processes that run Claude SDK queries independently.
 * The main process stays responsive. Sessions have token budgets, time
 * limits, and hard kill capability (Windows process tree kill via taskkill).
 *
 * Unlike bridge-based persistent PM2 agent processes, work sessions
 * are ephemeral — spawned on demand, killed when done. No bridge queue overhead.
 */

import { ChildProcess, fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { logger } from './logger.js';
import { PROJECT_ROOT } from './config.js';

// ── Types ────────────────────────────────────────────────────────────

export interface WorkSessionOptions {
  /** Max USD to spend on this session. Default $2.00, max $10.00 */
  budgetUsd?: number;
  /** Max minutes before auto-kill. Default 15, max 60 */
  timeoutMinutes?: number;
  /** Human-readable label for this session */
  label?: string;
  /** Send Telegram notifications on start/complete/fail. Default true */
  notify?: boolean;
}

export interface WorkSessionHandle {
  id: string;
  pid: number;
  label: string;
  startedAt: number;
  options: WorkSessionOptions;
  dir: string;
}

export interface WorkSessionStatus {
  id: string;
  pid: number;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'killed' | 'budget_exceeded' | 'timed_out';
  label: string;
  startedAt: number;
  updatedAt: number;
  tokensUsed: number;
  outputTokens: number;
  costUsd: number;
  stage: string;
  error?: string;
  result?: string;
}

// ── State ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(PROJECT_ROOT, 'workspace', 'work-sessions');
const activeSessions = new Map<string, { handle: WorkSessionHandle; child: ChildProcess; timeoutHandle: ReturnType<typeof setTimeout> }>();

let notifyFn: ((text: string) => Promise<void>) | null = null;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Wire up Telegram notification function. Called once from index.ts on startup.
 */
export function setWorkSessionNotify(fn: (text: string) => Promise<void>): void {
  notifyFn = fn;
}

/**
 * Spawn an isolated work session for a heavy task.
 */
export function spawnWorkSession(task: string, opts: WorkSessionOptions = {}): WorkSessionHandle {
  // Enforce limits
  const budgetUsd = Math.min(opts.budgetUsd ?? 2.0, 10.0);
  const timeoutMinutes = Math.min(opts.timeoutMinutes ?? 15, 60);
  const label = opts.label ?? 'Work Session';
  const notify = opts.notify !== false;

  // Create session directory
  const timestamp = Date.now();
  const hex = Math.random().toString(16).slice(2, 6);
  const id = `ws-${timestamp}-${hex}`;
  const sessionDir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Write task file
  fs.writeFileSync(path.join(sessionDir, 'task.txt'), task, 'utf-8');

  // Write options file
  const optionsData = { budgetUsd, timeoutMinutes, label };
  fs.writeFileSync(path.join(sessionDir, 'options.json'), JSON.stringify(optionsData, null, 2), 'utf-8');

  // Write initial status
  const initialStatus: WorkSessionStatus = {
    id,
    pid: 0,
    status: 'starting',
    label,
    startedAt: timestamp,
    updatedAt: timestamp,
    tokensUsed: 0,
    outputTokens: 0,
    costUsd: 0,
    stage: 'Initializing...',
  };
  writeStatus(sessionDir, initialStatus);

  // Fork the runner as a separate Node process
  const runnerScript = path.join(__dirname, 'work-session-runner.js');
  const forkEnv = { ...process.env } as Record<string, string | undefined>;
  forkEnv.WORK_SESSION_ID = id;
  forkEnv.WORK_SESSION_DIR = sessionDir;
  forkEnv.WORK_SESSION_BUDGET_USD = String(budgetUsd);
  forkEnv.WORK_SESSION_TIMEOUT_MIN = String(timeoutMinutes);
  // Prevent "cannot launch inside another session" error
  delete forkEnv.CLAUDECODE;
  delete forkEnv.CLAUDE_CODE_ENTRYPOINT;

  const child = fork(runnerScript, [sessionDir], {
    cwd: PROJECT_ROOT,
    env: forkEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    silent: true, // redirect stdout/stderr to parent
    detached: true, // survive parent exit (critical for CLI use)
  });

  // Unref so parent (CLI) can exit without killing the child
  // The main process keeps the ref via the activeSessions Map
  child.unref();

  const pid = child.pid ?? 0;

  // Update status with real PID
  initialStatus.pid = pid;
  initialStatus.status = 'running';
  initialStatus.stage = 'Agent starting...';
  writeStatus(sessionDir, initialStatus);

  const handle: WorkSessionHandle = {
    id,
    pid,
    label,
    startedAt: timestamp,
    options: { budgetUsd, timeoutMinutes, label, notify },
    dir: sessionDir,
  };

  // Time budget enforcement — hard kill after timeout
  const timeoutHandle = setTimeout(() => {
    logger.warn({ id, timeoutMinutes }, 'Work session timed out, killing');
    killSessionProcess(id, 'timed_out');
  }, timeoutMinutes * 60 * 1000);

  activeSessions.set(id, { handle, child, timeoutHandle });

  // Listen for IPC status updates from runner
  child.on('message', (msg: unknown) => {
    const update = msg as Partial<WorkSessionStatus>;
    if (update && typeof update === 'object') {
      try {
        const current = readStatus(sessionDir);
        if (current) {
          const merged = { ...current, ...update, updatedAt: Date.now() };
          writeStatus(sessionDir, merged);
        }
      } catch { /* ignore partial updates */ }
    }
  });

  // Handle process exit
  child.on('exit', (code, signal) => {
    clearTimeout(timeoutHandle);
    activeSessions.delete(id);

    const status = readStatus(sessionDir);
    if (status && status.status === 'running') {
      // Unexpected exit — mark as failed
      status.status = 'failed';
      status.error = `Process exited unexpectedly (code=${code}, signal=${signal})`;
      status.updatedAt = Date.now();
      writeStatus(sessionDir, status);

      if (notify && notifyFn) {
        notifyFn(`Work session "${label}" failed unexpectedly (exit code ${code})`).catch(() => {});
      }
    } else if (status?.status === 'completed' && notify && notifyFn) {
      const costStr = status.costUsd > 0 ? ` ($${status.costUsd.toFixed(3)})` : '';
      notifyFn(`Work session "${label}" completed${costStr}`).catch(() => {});
    } else if (status && ['killed', 'timed_out', 'budget_exceeded'].includes(status.status) && notify && notifyFn) {
      notifyFn(`Work session "${label}" stopped: ${status.status}${status.error ? ' — ' + status.error : ''}`).catch(() => {});
    }

    logger.info({ id, code, signal, finalStatus: status?.status }, 'Work session process exited');
  });

  // Log stderr for debugging
  child.stderr?.on('data', (data: Buffer) => {
    logger.debug({ id, stderr: data.toString().slice(0, 500) }, 'Work session stderr');
  });

  logger.info({ id, pid, label, budgetUsd, timeoutMinutes }, 'Work session spawned');

  if (notify && notifyFn) {
    notifyFn(`Work session "${label}" started (budget: $${budgetUsd}, timeout: ${timeoutMinutes}m)`).catch(() => {});
  }

  return handle;
}

/**
 * Get real-time status of a work session.
 */
export function getSessionStatus(id: string): WorkSessionStatus | null {
  const sessionDir = path.join(SESSIONS_DIR, id);
  return readStatus(sessionDir);
}

/**
 * Get the result output of a completed work session.
 */
export function getSessionResult(id: string): string | null {
  const resultPath = path.join(SESSIONS_DIR, id, 'result.md');
  try {
    return fs.readFileSync(resultPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Hard kill a work session. Kills the entire process tree on Windows.
 */
export function killSession(id: string): boolean {
  return killSessionProcess(id, 'killed');
}

/**
 * List all active (running) work sessions.
 */
export function listActiveSessions(): WorkSessionStatus[] {
  const results: WorkSessionStatus[] = [];

  for (const [id] of activeSessions) {
    const status = getSessionStatus(id);
    if (status) results.push(status);
  }

  return results;
}

/**
 * List all work sessions (active + recent completed).
 */
export function listAllSessions(limit = 10): WorkSessionStatus[] {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const dirs = fs.readdirSync(SESSIONS_DIR)
      .filter(d => d.startsWith('ws-'))
      .sort()
      .reverse()
      .slice(0, limit);

    return dirs
      .map(d => readStatus(path.join(SESSIONS_DIR, d)))
      .filter((s): s is WorkSessionStatus => s !== null);
  } catch {
    return [];
  }
}

/**
 * Reap stale sessions — kill sessions past their timeout, clean up zombies.
 * Called on a 60s interval from index.ts.
 * Also scans filesystem for detached sessions (spawned via CLI) that this
 * process doesn't have in its activeSessions Map.
 */
export function reapStaleSessions(): void {
  const now = Date.now();

  // Check in-memory tracked sessions
  for (const [id, session] of activeSessions) {
    const elapsed = now - session.handle.startedAt;
    const timeoutMs = (session.handle.options.timeoutMinutes ?? 15) * 60 * 1000;

    // Kill if past timeout (safety net for timer failures)
    if (elapsed > timeoutMs + 30_000) {
      logger.warn({ id, elapsedMin: Math.round(elapsed / 60000) }, 'Reaper killing stale work session');
      killSessionProcess(id, 'timed_out');
    }

    // Check if PID is still alive
    if (session.handle.pid > 0) {
      try {
        process.kill(session.handle.pid, 0); // signal 0 = check if alive
      } catch {
        // Process is dead but we didn't catch the exit event
        logger.warn({ id }, 'Work session process is dead, cleaning up');
        clearTimeout(session.timeoutHandle);
        activeSessions.delete(id);

        const status = readStatus(session.handle.dir);
        if (status && status.status === 'running') {
          status.status = 'failed';
          status.error = 'Process disappeared (crash or OOM)';
          status.updatedAt = Date.now();
          writeStatus(session.handle.dir, status);
        }
      }
    }
  }

  // Scan filesystem for detached sessions (CLI-spawned) not in our Map
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith('ws-'));
    for (const dir of dirs) {
      if (activeSessions.has(dir)) continue; // already tracked

      const sessionDir = path.join(SESSIONS_DIR, dir);
      const status = readStatus(sessionDir);
      if (!status || status.status !== 'running') continue;

      // Check if the process is still alive
      if (status.pid > 0) {
        try {
          process.kill(status.pid, 0);
        } catch {
          // Dead process, mark as failed
          status.status = 'failed';
          status.error = 'Process disappeared (crash or detached parent exit)';
          status.updatedAt = now;
          writeStatus(sessionDir, status);
          logger.warn({ id: dir, pid: status.pid }, 'Reaper cleaned up orphaned work session');
          continue;
        }
      }

      // Check timeout based on options.json
      try {
        const opts = JSON.parse(fs.readFileSync(path.join(sessionDir, 'options.json'), 'utf-8'));
        const timeoutMs = (opts.timeoutMinutes ?? 15) * 60 * 1000;
        const elapsed = now - status.startedAt;
        if (elapsed > timeoutMs + 30_000) {
          logger.warn({ id: dir, elapsedMin: Math.round(elapsed / 60000) }, 'Reaper killing stale detached session');
          // Hard kill via taskkill
          if (status.pid > 0) {
            try {
              if (process.platform === 'win32') {
                execSync(`taskkill /PID ${status.pid} /T /F`, { windowsHide: true, timeout: 5000 });
              } else {
                process.kill(status.pid, 'SIGKILL');
              }
            } catch { /* already dead */ }
          }
          status.status = 'timed_out';
          status.error = `Timed out after ${opts.timeoutMinutes} minutes (reaper)`;
          status.updatedAt = now;
          writeStatus(sessionDir, status);
        }
      } catch { /* ignore missing options */ }
    }
  } catch (err) {
    logger.debug({ err }, 'Reaper filesystem scan error');
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

function killSessionProcess(id: string, reason: 'killed' | 'timed_out'): boolean {
  const session = activeSessions.get(id);
  if (!session) return false;

  const { handle, child, timeoutHandle } = session;
  clearTimeout(timeoutHandle);

  // Update status before killing
  const status = readStatus(handle.dir);
  if (status) {
    status.status = reason;
    status.error = reason === 'timed_out'
      ? `Timed out after ${handle.options.timeoutMinutes} minutes`
      : 'Killed by user or system';
    status.updatedAt = Date.now();
    writeStatus(handle.dir, status);
  }

  // Kill the entire process tree (Windows needs taskkill for child processes)
  if (handle.pid > 0) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${handle.pid} /T /F`, {
          windowsHide: true,
          timeout: 5000,
        });
      } else {
        // Unix: kill process group
        try { process.kill(-handle.pid, 'SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { process.kill(-handle.pid, 'SIGKILL'); } catch { /* ignore */ }
        }, 3000);
      }
    } catch (err) {
      // Process may already be dead
      logger.debug({ id, err }, 'Kill command completed (process may already be dead)');
    }
  }

  // Fallback: disconnect IPC
  try { child.disconnect(); } catch { /* ignore */ }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }

  activeSessions.delete(id);
  logger.info({ id, reason }, 'Work session killed');
  return true;
}

function writeStatus(sessionDir: string, status: WorkSessionStatus): void {
  try {
    fs.writeFileSync(
      path.join(sessionDir, 'status.json'),
      JSON.stringify(status, null, 2),
      'utf-8',
    );
  } catch (err) {
    logger.error({ err, sessionDir }, 'Failed to write work session status');
  }
}

function readStatus(sessionDir: string): WorkSessionStatus | null {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, 'status.json'), 'utf-8');
    return JSON.parse(raw) as WorkSessionStatus;
  } catch {
    return null;
  }
}
