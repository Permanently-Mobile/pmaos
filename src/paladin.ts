/**
 * Paladin -- Out-of-Process Security Engine
 *
 * Runs as an independent PM2 process on localhost:3150.
 * All tool operations pass through Paladin before execution.
 *
 * Architecture:
 *   1. Prime Directives (hardcoded, immutable) run FIRST
 *   2. YAML policy rules run second (hot-reloadable)
 *   3. Fail-closed: any error = deny
 *
 * Protocol: Newline-delimited JSON-RPC 2.0 over TCP.
 *
 * Methods:
 *   check           -- evaluate an operation against all rules
 *   reportApproval  -- report back an approval/denial decision (Phase 3)
 *   status          -- health check + stats
 *   reloadPolicy    -- force YAML policy reload
 */

import net from 'net';
import { randomUUID } from 'crypto';
import { PRIME_DIRECTIVES } from './prime-directives.js';
import { initPolicy, getPolicy, reloadPolicy as reloadPolicyFromDisk } from './policy-loader.js';
import type {
  Operation,
  CheckResult,
  PaladinRequest,
  PaladinResponse,
  PaladinStatus,
  Verdict,
} from './paladin-types.js';

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PALADIN_PORT || '3150', 10);
const HOST = '127.0.0.1'; // localhost only, never exposed

// ── State ───────────────────────────────────────────────────────────

const startTime = Date.now();
let checksTotal = 0;
let checksDenied = 0;
let checksApproved = 0;

// Pending approvals (Phase 3 prep) -- keyed by requestId
const pendingApprovals = new Map<string, {
  operation: Operation;
  resolve: (verdict: Verdict) => void;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
}>();

// Rate limiting state -- sliding window per agent
const rateBuckets = new Map<string, { bash: number[]; files: number[]; api: number[] }>();

// ── Logging (standalone, no pino dep for Paladin process) ───────────

function log(level: string, msg: string, data?: Record<string, unknown>): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ── Rate Limiter ────────────────────────────────────────────────────

function checkRateLimit(op: Operation): CheckResult | null {
  const policy = getPolicy();
  const agent = op.agent || 'unknown';
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  if (!rateBuckets.has(agent)) {
    rateBuckets.set(agent, { bash: [], files: [], api: [] });
  }
  const bucket = rateBuckets.get(agent)!;

  // Clean expired entries
  bucket.bash = bucket.bash.filter(t => now - t < windowMs);
  bucket.files = bucket.files.filter(t => now - t < windowMs);
  bucket.api = bucket.api.filter(t => now - t < windowMs);

  if (op.type === 'bash') {
    if (bucket.bash.length >= policy.rateLimits.bashCommandsPerMinute) {
      return { verdict: 'deny', reason: `Rate limit exceeded: ${bucket.bash.length}/${policy.rateLimits.bashCommandsPerMinute} bash commands/min for agent ${agent}` };
    }
    bucket.bash.push(now);
  }

  if (op.type === 'writeFile') {
    if (bucket.files.length >= policy.rateLimits.fileWritesPerMinute) {
      return { verdict: 'deny', reason: `Rate limit exceeded: ${bucket.files.length}/${policy.rateLimits.fileWritesPerMinute} file writes/min for agent ${agent}` };
    }
    bucket.files.push(now);
  }

  if (op.type === 'apiCall') {
    if (bucket.api.length >= policy.rateLimits.externalApiCallsPerMinute) {
      return { verdict: 'deny', reason: `Rate limit exceeded: ${bucket.api.length}/${policy.rateLimits.externalApiCallsPerMinute} API calls/min for agent ${agent}` };
    }
    bucket.api.push(now);
  }

  return null;
}

// ── Policy Checks (YAML-based) ─────────────────────────────────────

function checkPolicyRules(op: Operation): CheckResult | null {
  const policy = getPolicy();

  // Check approval patterns (needs_approval triggers)
  if (op.type === 'bash' && op.command) {
    for (const ap of policy.approval.patterns) {
      try {
        const regex = new RegExp(ap.pattern, 'i');
        if (regex.test(op.command)) {
          return {
            verdict: 'needs_approval',
            reason: ap.reason,
            requestId: randomUUID(),
          };
        }
      } catch {
        // Invalid regex in policy -- skip it, don't crash
      }
    }
  }

  // Check file write restrictions
  if (op.type === 'writeFile' && op.filePath) {
    const normalized = op.filePath.replace(/\\/g, '/');

    // Check denied paths first (deny takes priority)
    for (const denied of policy.files.writeDenied) {
      if (normalized.includes(denied)) {
        // But allow if also in the allowed list (more specific wins)
        const isAllowed = policy.files.writeAllowed.some(a => normalized.includes(a));
        if (!isAllowed) {
          return { verdict: 'deny', reason: `File write to restricted path: ${denied}` };
        }
      }
    }
  }

  return null;
}

// ── Core Check Engine ───────────────────────────────────────────────

function evaluateOperation(op: Operation): CheckResult {
  checksTotal++;

  // Layer 1: Prime Directives (hardcoded, immutable, run FIRST)
  for (const directive of PRIME_DIRECTIVES) {
    try {
      const result = directive.check(op);
      if (result) {
        if (result.verdict === 'deny') checksDenied++;
        log('warn', `Prime directive triggered: ${directive.id}`, {
          verdict: result.verdict,
          reason: result.reason,
          agent: op.agent,
          opType: op.type,
        });
        return result;
      }
    } catch (err) {
      // Prime directive crashed -- FAIL CLOSED
      checksDenied++;
      log('error', `Prime directive ${directive.id} threw error -- DENYING`, {
        err: String(err),
        agent: op.agent,
      });
      return {
        verdict: 'deny',
        reason: `Security check error in ${directive.id} -- fail closed`,
        directiveId: directive.id,
      };
    }
  }

  // Layer 2: Rate limiting
  const rateResult = checkRateLimit(op);
  if (rateResult) {
    if (rateResult.verdict === 'deny') checksDenied++;
    log('warn', 'Rate limit triggered', { reason: rateResult.reason, agent: op.agent });
    return rateResult;
  }

  // Layer 3: YAML policy rules (configurable, hot-reloadable)
  try {
    const policyResult = checkPolicyRules(op);
    if (policyResult) {
      if (policyResult.verdict === 'deny') checksDenied++;
      log('info', 'Policy rule triggered', {
        verdict: policyResult.verdict,
        reason: policyResult.reason,
        agent: op.agent,
      });
      return policyResult;
    }
  } catch (err) {
    // Policy check crashed -- FAIL CLOSED
    checksDenied++;
    log('error', 'Policy check threw error -- DENYING', { err: String(err), agent: op.agent });
    return { verdict: 'deny', reason: 'Policy check error -- fail closed' };
  }

  // All checks passed
  checksApproved++;
  return { verdict: 'allow' };
}

// ── JSON-RPC Handler ────────────────────────────────────────────────

function handleRequest(req: PaladinRequest): PaladinResponse {
  const { id, method, params } = req;

  try {
    switch (method) {
      case 'check': {
        const op = params as unknown as Operation;
        if (!op || !op.type || !op.agent) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: operation requires type and agent' },
          };
        }
        // Ensure timestamp
        if (!op.timestamp) op.timestamp = Date.now();

        const result = evaluateOperation(op);
        return { jsonrpc: '2.0', id, result };
      }

      case 'reportApproval': {
        const { requestId, approved } = params as { requestId: string; approved: boolean };
        const pending = pendingApprovals.get(requestId);
        if (!pending) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32001, message: `No pending approval with id: ${requestId}` },
          };
        }

        clearTimeout(pending.timeout);
        pendingApprovals.delete(requestId);
        pending.resolve(approved ? 'allow' : 'deny');

        log('info', `Approval resolved: ${requestId} -> ${approved ? 'allow' : 'deny'}`, {
          agent: pending.operation.agent,
        });

        return { jsonrpc: '2.0', id, result: { acknowledged: true } };
      }

      case 'status': {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const policy = getPolicy();
        const status: PaladinStatus = {
          online: true,
          uptime,
          policyVersion: policy.version,
          checksTotal,
          checksDenied,
          checksApproved,
          primeDirectiveCount: PRIME_DIRECTIVES.length,
        };
        return { jsonrpc: '2.0', id, result: status };
      }

      case 'reloadPolicy': {
        reloadPolicyFromDisk();
        const policy = getPolicy();
        log('info', 'Policy force-reloaded via RPC', { version: policy.version });
        return { jsonrpc: '2.0', id, result: { reloaded: true, version: policy.version } };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown method: ${method}` },
        };
    }
  } catch (err) {
    // Any unhandled error -- fail closed, return error response
    log('error', 'Unhandled error in request handler', { err: String(err), method });
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Internal error' },
    };
  }
}

// ── TCP Server ──────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();

    // Process newline-delimited JSON messages
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const req = JSON.parse(line) as PaladinRequest;
        const resp = handleRequest(req);
        socket.write(JSON.stringify(resp) + '\n');
      } catch (err) {
        // Malformed JSON -- return parse error
        const errorResp: PaladinResponse = {
          jsonrpc: '2.0',
          id: 'unknown',
          error: { code: -32700, message: 'Parse error: invalid JSON' },
        };
        socket.write(JSON.stringify(errorResp) + '\n');
      }
    }
  });

  socket.on('error', (err) => {
    // Client disconnect -- normal, don't crash
    if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
    log('warn', 'Socket error', { err: String(err) });
  });
});

server.on('error', (err) => {
  log('error', 'Server error', { err: String(err) });
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    log('error', `Port ${PORT} is already in use. Is another Paladin instance running?`);
    process.exit(1);
  }
});

// ── Startup ─────────────────────────────────────────────────────────

log('info', 'Paladin initializing...');
initPolicy();

server.listen(PORT, HOST, () => {
  log('info', `Paladin security engine online`, {
    host: HOST,
    port: PORT,
    primeDirectives: PRIME_DIRECTIVES.length,
    policyVersion: getPolicy().version,
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('info', 'Paladin shutting down (SIGINT)');
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', 'Paladin shutting down (SIGTERM)');
  server.close();
  process.exit(0);
});

// Uncaught errors -- log but don't crash (PM2 will restart anyway)
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception in Paladin', { err: String(err), stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection in Paladin', { reason: String(reason) });
});
