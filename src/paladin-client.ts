/**
 * Paladin Client -- Library for agents to call the Paladin security engine.
 *
 * Usage:
 *   import { paladinCheck, paladinStatus, isPaladinOnline } from './paladin-client.js';
 *
 *   const result = await paladinCheck({ type: 'bash', command: 'rm -rf /', agent: 'apex-bot', timestamp: Date.now() });
 *   if (result.verdict === 'deny') { ... }
 *
 * Fail-closed design:
 *   - If Paladin is unreachable, returns DENY (never silently allows)
 *   - If connection times out, returns DENY
 *   - If response is malformed, returns DENY
 *
 * Connection management:
 *   - Creates a fresh TCP connection per request (simple, reliable)
 *   - 3-second timeout per request (fast enough for interactive use)
 *   - No connection pooling needed at current scale
 */

import net from 'net';
import { randomUUID } from 'crypto';
import type {
  Operation,
  CheckResult,
  PaladinRequest,
  PaladinResponse,
  PaladinStatus,
} from './paladin-types.js';

// ── Config ──────────────────────────────────────────────────────────

const PALADIN_PORT = parseInt(process.env.PALADIN_PORT || '3150', 10);
const PALADIN_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 3000; // 3 seconds -- fail fast

// ── Core RPC Call ───────────────────────────────────────────────────

/**
 * Send a JSON-RPC request to Paladin and return the response.
 * Throws on timeout, connection failure, or malformed response.
 */
function rpcCall(method: string, params: Record<string, unknown>): Promise<PaladinResponse> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const request: PaladinRequest = {
      jsonrpc: '2.0',
      id,
      method: method as PaladinRequest['method'],
      params,
    };

    const socket = new net.Socket();
    let buffer = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Paladin request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }
    }, REQUEST_TIMEOUT_MS);

    socket.connect(PALADIN_PORT, PALADIN_HOST, () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.destroy();
          try {
            const response = JSON.parse(line) as PaladinResponse;
            resolve(response);
          } catch {
            reject(new Error('Paladin returned malformed JSON'));
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Paladin connection error: ${(err as Error).message}`));
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Paladin connection closed unexpectedly'));
      }
    });
  });
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Check an operation against Paladin's security rules.
 *
 * FAIL-CLOSED: If Paladin is unreachable or errors out, returns DENY.
 * This is the core security guarantee -- operations never slip through
 * because the guard is down.
 */
export async function paladinCheck(op: Operation): Promise<CheckResult> {
  try {
    const response = await rpcCall('check', op as unknown as Record<string, unknown>);

    if (response.error) {
      // Paladin returned an explicit error -- fail closed
      return {
        verdict: 'deny',
        reason: `Paladin error: ${response.error.message}`,
      };
    }

    // Validate the response has the expected shape
    const result = response.result as CheckResult;
    if (!result || !result.verdict) {
      return {
        verdict: 'deny',
        reason: 'Paladin returned malformed result -- fail closed',
      };
    }

    return result;
  } catch (err) {
    // Connection failed, timeout, etc. -- FAIL CLOSED
    return {
      verdict: 'deny',
      reason: `Paladin unreachable: ${(err as Error).message} -- fail closed`,
    };
  }
}

/**
 * Report an approval decision back to Paladin (Phase 3).
 * Used by the Telegram permission relay to resolve pending approvals.
 */
export async function paladinReportApproval(requestId: string, approved: boolean): Promise<boolean> {
  try {
    const response = await rpcCall('reportApproval', { requestId, approved });
    if (response.error) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Paladin's current status (health check + stats).
 */
export async function paladinStatus(): Promise<PaladinStatus | null> {
  try {
    const response = await rpcCall('status', {});
    if (response.error) return null;
    return response.result as PaladinStatus;
  } catch {
    return null;
  }
}

/**
 * Force Paladin to reload its YAML policy from disk.
 */
export async function paladinReloadPolicy(): Promise<boolean> {
  try {
    const response = await rpcCall('reloadPolicy', {});
    if (response.error) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Quick check: is Paladin reachable?
 * Returns true if we get a valid status response, false otherwise.
 */
export async function isPaladinOnline(): Promise<boolean> {
  const status = await paladinStatus();
  return status !== null && status.online === true;
}
