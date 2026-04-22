/**
 * Cross-process concurrency gate for Claude Code instances.
 *
 * Problem: Multiple PM2 workers (researcher, coder, etc.) can
 * all spawn Claude Code subprocesses simultaneously, each eating 500MB-1GB
 * of RAM. On a 20GB machine, 4+ concurrent instances cause OOM.
 *
 * Solution: File-based slot system. Workers must acquire a slot before
 * calling runAgent(). If all slots are taken, they wait and retry.
 * The primary bot bypasses this entirely -- the user's messages always
 * get immediate response.
 *
 * Slot files live in store/.claude-slot-N.lock and contain JSON metadata
 * for debugging. Stale locks (dead PIDs) are automatically reclaimed.
 *
 * Configure via MAX_CLAUDE_SLOTS env var (default: 2).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

const __lockFilename = fileURLToPath(import.meta.url);
const __lockDirname = path.dirname(__lockFilename);

// ── Configuration ────────────────────────────────────────────────────

const MAX_SLOTS = parseInt(process.env.MAX_CLAUDE_SLOTS || '2', 10);
const RETRY_INTERVAL_MS = 5_000;   // check every 5s when waiting
const MAX_WAIT_MS = 600_000;       // 10 min max wait before giving up
const STALE_THRESHOLD_MS = 120 * 60 * 1000; // 2 hours -- force-reclaim even if PID is alive

interface SlotMeta {
  pid: number;
  worker: string;
  claimedAt: number;  // epoch ms
}

// ── Helpers ──────────────────────────────────────────────────────────

let storeDir: string | null = null;

function getStoreDir(): string {
  if (storeDir) return storeDir;
  // Resolve from APEX_ROOT or fall back to ../store relative to this file
  const root = process.env.APEX_ROOT || process.env.BRIDGE_MAIN_ROOT;
  if (root) {
    storeDir = path.join(path.resolve(root), 'store');
  } else {
    storeDir = path.resolve(__lockDirname, '..', 'store');
  }
  fs.mkdirSync(storeDir, { recursive: true });
  return storeDir;
}

function slotPath(index: number): string {
  return path.join(getStoreDir(), `.claude-slot-${index}.lock`);
}

/**
 * Check if a process is still running by sending signal 0.
 * Returns false if the PID is dead or inaccessible.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read slot metadata. Returns null if slot is free or file is unreadable.
 */
function readSlot(index: number): SlotMeta | null {
  try {
    const raw = fs.readFileSync(slotPath(index), 'utf-8');
    return JSON.parse(raw) as SlotMeta;
  } catch {
    return null;
  }
}

/**
 * Try to claim a specific slot using exclusive file creation.
 * Returns true if claimed, false if already taken.
 */
function tryClaimSlot(index: number, workerName: string): boolean {
  const meta: SlotMeta = {
    pid: process.pid,
    worker: workerName,
    claimedAt: Date.now(),
  };

  try {
    // 'wx' = write exclusive -- fails if file already exists
    fs.writeFileSync(slotPath(index), JSON.stringify(meta), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a slot is stale (dead PID or exceeded time threshold) and reclaim it.
 */
function tryReclaimStale(index: number, workerName: string): boolean {
  const existing = readSlot(index);
  if (!existing) {
    // File might have been deleted between check and read -- try claiming
    return tryClaimSlot(index, workerName);
  }

  const age = Date.now() - existing.claimedAt;
  const pidDead = !isPidAlive(existing.pid);
  const overTimeLimit = age > STALE_THRESHOLD_MS;

  if (pidDead || overTimeLimit) {
    logger.warn(
      { slot: index, stalePid: existing.pid, staleWorker: existing.worker, ageMin: Math.round(age / 60000), pidDead },
      'Reclaiming stale Claude slot',
    );
    // Delete and re-create atomically
    try {
      fs.unlinkSync(slotPath(index));
    } catch { /* already gone */ }
    return tryClaimSlot(index, workerName);
  }

  return false;
}

// ── Public API ───────────────────────────────────────────────────────

export interface SlotHandle {
  slotIndex: number;
  release: () => void;
}

/**
 * Acquire a Claude execution slot. Blocks (with polling) until a slot
 * is available or MAX_WAIT_MS is exceeded.
 *
 * @param workerName  Identity of the calling worker (for logging/debugging)
 * @returns A handle with a release() function to call when done
 * @throws If no slot becomes available within MAX_WAIT_MS
 */
export async function acquireSlot(workerName: string): Promise<SlotHandle> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let logged = false;

  while (Date.now() < deadline) {
    // Try each slot in order
    for (let i = 0; i < MAX_SLOTS; i++) {
      // Fast path: slot file doesn't exist, claim it
      if (tryClaimSlot(i, workerName)) {
        if (logged) {
          logger.info({ slot: i, worker: workerName }, 'Claude slot acquired after wait');
        } else {
          logger.info({ slot: i, worker: workerName }, 'Claude slot acquired');
        }
        return {
          slotIndex: i,
          release: () => releaseSlot(i, workerName),
        };
      }

      // Slow path: check if existing lock is stale
      if (tryReclaimStale(i, workerName)) {
        logger.info({ slot: i, worker: workerName }, 'Claude slot acquired (reclaimed stale)');
        return {
          slotIndex: i,
          release: () => releaseSlot(i, workerName),
        };
      }
    }

    // All slots taken -- log once and wait
    if (!logged) {
      const holders = [];
      for (let i = 0; i < MAX_SLOTS; i++) {
        const meta = readSlot(i);
        if (meta) holders.push(`slot${i}=${meta.worker}(pid:${meta.pid})`);
      }
      logger.info(
        { worker: workerName, maxSlots: MAX_SLOTS, holders: holders.join(', ') },
        'All Claude slots occupied, waiting...',
      );
      logged = true;
    }

    await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  throw new Error(`[process-lock] ${workerName} timed out waiting for Claude slot (${MAX_WAIT_MS / 1000}s)`);
}

/**
 * Release a Claude execution slot.
 */
function releaseSlot(index: number, workerName: string): void {
  try {
    // Verify we still own this slot before deleting (safety check)
    const meta = readSlot(index);
    if (meta && meta.pid === process.pid) {
      fs.unlinkSync(slotPath(index));
      logger.info({ slot: index, worker: workerName }, 'Claude slot released');
    } else if (meta) {
      logger.warn(
        { slot: index, worker: workerName, actualPid: meta.pid, ourPid: process.pid },
        'Slot owned by different PID, skipping release',
      );
    }
    // If meta is null, file was already deleted (timeout handler, crash recovery, etc.)
  } catch {
    // File already gone -- that's fine
  }
}

/**
 * Get current slot status (for debugging / dashboard).
 */
export function getSlotStatus(): Array<{ slot: number; free: boolean; worker?: string; pid?: number; ageMin?: number }> {
  const status = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const meta = readSlot(i);
    if (meta) {
      status.push({
        slot: i,
        free: false,
        worker: meta.worker,
        pid: meta.pid,
        ageMin: Math.round((Date.now() - meta.claimedAt) / 60000),
      });
    } else {
      status.push({ slot: i, free: true });
    }
  }
  return status;
}

/**
 * Force-release all slots (emergency reset).
 * Only call this from a CLI tool or manual intervention.
 */
export function forceReleaseAll(): number {
  let released = 0;
  for (let i = 0; i < MAX_SLOTS; i++) {
    try {
      fs.unlinkSync(slotPath(i));
      released++;
    } catch {
      // already free
    }
  }
  return released;
}
