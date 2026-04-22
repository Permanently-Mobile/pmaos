/**
 * Paladin Types -- Shared types for the Paladin security engine.
 *
 * Used by both the Paladin server (paladin.ts) and client (paladin-client.ts).
 */

// ── Operation types ─────────────────────────────────────────────────

export type OperationType = 'bash' | 'readFile' | 'writeFile' | 'searchFiles' | 'apiCall';

export interface Operation {
  type: OperationType;
  command?: string;       // bash command string
  filePath?: string;      // file path for read/write ops
  content?: string;       // content for write ops (truncated for logging)
  endpoint?: string;      // API endpoint for external calls
  agent: string;          // which agent is requesting (apex-bot, fallback, etc.)
  timestamp: number;      // epoch ms
}

// ── Verdicts ────────────────────────────────────────────────────────

export type Verdict = 'allow' | 'deny' | 'needs_approval';

export interface CheckResult {
  verdict: Verdict;
  reason?: string;
  directiveId?: string;   // which prime directive triggered (if any)
  requestId?: string;     // for needs_approval, use this to report back
}

// ── JSON-RPC protocol ───────────────────────────────────────────────

export interface PaladinRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'check' | 'reportApproval' | 'status' | 'reloadPolicy';
  params: Record<string, unknown>;
}

export interface PaladinResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

// ── Status ──────────────────────────────────────────────────────────

export interface PaladinStatus {
  online: boolean;
  uptime: number;         // seconds
  policyVersion: string;
  checksTotal: number;
  checksDenied: number;
  checksApproved: number;
  primeDirectiveCount: number;
}
