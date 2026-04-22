/**
 * Session Boundary Detector
 *
 * Tracks work session transitions (S1 -> S2 -> S3 -> S1) and fires
 * registered callbacks at boundaries. Used by the reflect engine to
 * trigger end-of-session analysis.
 *
 * Session windows (EST / local machine time):
 *   S1: 00:00 - 08:00 (overnight)
 *   S2: 08:00 - 16:00 (daytime)
 *   S3: 16:00 - 24:00 (evening)
 *
 * Polling-based: checked every 60s by the scheduler interval.
 * NOT a separate setInterval -- piggybacks on existing scheduler tick.
 */

import { logger } from './logger.js';

export type SessionId = 'S1' | 'S2' | 'S3';
export type SessionBoundaryCallback = (from: SessionId, to: SessionId) => void | Promise<void>;

let lastKnownSession: SessionId | null = null;
const callbacks: SessionBoundaryCallback[] = [];

/**
 * Determine the current work session based on hour of day.
 */
export function getCurrentSession(): SessionId {
  const h = new Date().getHours();
  if (h < 8) return 'S1';
  if (h < 16) return 'S2';
  return 'S3';
}

/**
 * Register a callback that fires when the session changes.
 * Callbacks receive (fromSession, toSession).
 */
export function onSessionBoundary(cb: SessionBoundaryCallback): void {
  callbacks.push(cb);
}

/**
 * Call every 60s (piggybacked on scheduler interval).
 * Detects session transitions and fires registered callbacks.
 * Never throws -- all callback errors are caught and logged.
 */
export function checkSessionBoundary(): void {
  const current = getCurrentSession();

  if (lastKnownSession === null) {
    // First check -- record baseline, don't fire
    lastKnownSession = current;
    return;
  }

  if (current !== lastKnownSession) {
    const from = lastKnownSession;
    lastKnownSession = current;

    logger.info({ from, to: current }, 'Session boundary detected');

    for (const cb of callbacks) {
      try {
        const result = cb(from, current);
        // Handle async callbacks without blocking
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            logger.error({ err, from, to: current }, 'Session boundary callback failed (async)');
          });
        }
      } catch (err) {
        logger.error({ err, from, to: current }, 'Session boundary callback failed');
      }
    }
  }
}
