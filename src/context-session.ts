/**
 * Shared Context Sessions -- file-based shared state for multi-agent collaboration.
 *
 * Each session is a JSON file at workspace/sessions/{session-id}.json.
 * Agents read/write to these files to share state, decisions, notes, and
 * file references across tasks without needing a database dependency.
 *
 * Flow:
 *   1. The primary bot creates a session before dispatching related tasks
 *   2. Workers receive session_id in their TaskPayload
 *   3. Workers load the session for context before starting work
 *   4. Workers write decisions/notes back when done
 *   5. The primary bot reads the session for a full audit trail
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────

export interface SessionDecision {
  agent: string;
  decision: string;
  reasoning: string;
  timestamp: number;
}

export interface ContextSession {
  id: string;
  created_at: number;
  updated_at: number;
  owner: string;
  participants: string[];
  topic: string;
  state: Record<string, unknown>;
  files: string[];
  decisions: SessionDecision[];
  notes: string[];
  status: 'active' | 'completed' | 'archived';
}

// ── Paths ─────────────────────────────────────────────────────────────

let sessionsDir = '';
let archiveDir = '';

/**
 * Initialize session directories. Must be called before any other function.
 * @param projectRoot  Root of the project-apex project (where workspace/ lives)
 */
export function initSessions(projectRoot: string): void {
  sessionsDir = path.join(projectRoot, 'workspace', 'sessions');
  archiveDir = path.join(sessionsDir, 'archive');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
}

function ensureInit(): void {
  if (!sessionsDir) {
    throw new Error('context-session: call initSessions(projectRoot) before using session functions');
  }
}

function sessionPath(sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.json`);
}

function archivedPath(sessionId: string): string {
  return path.join(archiveDir, `${sessionId}.json`);
}

function writeSession(session: ContextSession): void {
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
}

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Create a new shared context session.
 * Returns the session object (also written to disk).
 */
export function createSession(
  owner: string,
  topic: string,
  participants: string[] = [],
): ContextSession {
  ensureInit();

  const now = Math.floor(Date.now() / 1000);
  const id = `${now}-${randomBytes(4).toString('hex')}`;

  // Ensure owner is in participants list
  const allParticipants = Array.from(new Set([owner, ...participants]));

  const session: ContextSession = {
    id,
    created_at: now,
    updated_at: now,
    owner,
    participants: allParticipants,
    topic,
    state: {},
    files: [],
    decisions: [],
    notes: [],
    status: 'active',
  };

  writeSession(session);
  return session;
}

/**
 * Load a session by ID. Returns null if not found.
 * Checks active sessions first, then archive.
 */
export function loadSession(sessionId: string): ContextSession | null {
  ensureInit();

  const active = sessionPath(sessionId);
  if (fs.existsSync(active)) {
    try {
      return JSON.parse(fs.readFileSync(active, 'utf-8')) as ContextSession;
    } catch {
      return null;
    }
  }

  // Check archive
  const archived = archivedPath(sessionId);
  if (fs.existsSync(archived)) {
    try {
      return JSON.parse(fs.readFileSync(archived, 'utf-8')) as ContextSession;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Merge key-value updates into the session's shared state.
 * Adds the agent to participants if not already present.
 */
export function updateState(
  sessionId: string,
  agentName: string,
  updates: Record<string, unknown>,
): void {
  ensureInit();

  const session = loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status === 'archived') throw new Error(`Cannot update archived session: ${sessionId}`);

  session.state = { ...session.state, ...updates };
  session.updated_at = Math.floor(Date.now() / 1000);

  if (!session.participants.includes(agentName)) {
    session.participants.push(agentName);
  }

  writeSession(session);
}

/**
 * Record a decision with reasoning (audit trail).
 */
export function addDecision(
  sessionId: string,
  agentName: string,
  decision: string,
  reasoning: string,
): void {
  ensureInit();

  const session = loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status === 'archived') throw new Error(`Cannot update archived session: ${sessionId}`);

  session.decisions.push({
    agent: agentName,
    decision,
    reasoning,
    timestamp: Math.floor(Date.now() / 1000),
  });
  session.updated_at = Math.floor(Date.now() / 1000);

  if (!session.participants.includes(agentName)) {
    session.participants.push(agentName);
  }

  writeSession(session);
}

/**
 * Add a free-form note from any participant.
 */
export function addNote(
  sessionId: string,
  agentName: string,
  note: string,
): void {
  ensureInit();

  const session = loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status === 'archived') throw new Error(`Cannot update archived session: ${sessionId}`);

  const timestamp = new Date().toISOString();
  session.notes.push(`[${timestamp}] ${agentName}: ${note}`);
  session.updated_at = Math.floor(Date.now() / 1000);

  if (!session.participants.includes(agentName)) {
    session.participants.push(agentName);
  }

  writeSession(session);
}

/**
 * Register a file as relevant to this session.
 */
export function addFile(sessionId: string, filePath: string): void {
  ensureInit();

  const session = loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status === 'archived') throw new Error(`Cannot update archived session: ${sessionId}`);

  if (!session.files.includes(filePath)) {
    session.files.push(filePath);
    session.updated_at = Math.floor(Date.now() / 1000);
    writeSession(session);
  }
}

/**
 * List all active (non-archived, non-completed) sessions.
 * Returns them sorted by updated_at descending (most recent first).
 */
export function listActiveSessions(): ContextSession[] {
  ensureInit();

  const sessions: ContextSession[] = [];

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
        const session = JSON.parse(raw) as ContextSession;
        if (session.status === 'active') {
          sessions.push(session);
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Directory might not exist yet
  }

  return sessions.sort((a, b) => b.updated_at - a.updated_at);
}

/**
 * Mark a session as completed. Keeps the file in the active directory
 * but flags it so it won't show in listActiveSessions().
 */
export function completeSession(sessionId: string): void {
  ensureInit();

  const session = loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.status = 'completed';
  session.updated_at = Math.floor(Date.now() / 1000);
  writeSession(session);
}

/**
 * Archive a session -- moves the file to workspace/sessions/archive/.
 */
export function archiveSession(sessionId: string): void {
  ensureInit();

  const src = sessionPath(sessionId);
  if (!fs.existsSync(src)) throw new Error(`Session file not found: ${sessionId}`);

  const session = loadSession(sessionId);
  if (session) {
    session.status = 'archived';
    session.updated_at = Math.floor(Date.now() / 1000);
    // Write updated status to source before moving
    fs.writeFileSync(src, JSON.stringify(session, null, 2), 'utf-8');
  }

  const dest = archivedPath(sessionId);
  fs.renameSync(src, dest);
}

/**
 * Build a context string from a session for injection into agent prompts.
 * Workers call this to get the shared state before starting a task.
 */
export function sessionToContext(session: ContextSession): string {
  const lines: string[] = [
    `== Shared Context Session: ${session.topic} ==`,
    `Session ID: ${session.id}`,
    `Owner: ${session.owner}`,
    `Participants: ${session.participants.join(', ')}`,
    `Status: ${session.status}`,
    '',
  ];

  // Shared state
  const stateKeys = Object.keys(session.state);
  if (stateKeys.length > 0) {
    lines.push('-- Shared State --');
    for (const key of stateKeys) {
      const val = session.state[key];
      const display = typeof val === 'string' ? val : JSON.stringify(val);
      lines.push(`  ${key}: ${display}`);
    }
    lines.push('');
  }

  // Decisions
  if (session.decisions.length > 0) {
    lines.push('-- Decisions --');
    for (const d of session.decisions) {
      const time = new Date(d.timestamp * 1000).toISOString();
      lines.push(`  [${time}] ${d.agent}: ${d.decision}`);
      if (d.reasoning) lines.push(`    Reasoning: ${d.reasoning}`);
    }
    lines.push('');
  }

  // Notes
  if (session.notes.length > 0) {
    lines.push('-- Notes --');
    for (const n of session.notes) {
      lines.push(`  ${n}`);
    }
    lines.push('');
  }

  // Files
  if (session.files.length > 0) {
    lines.push('-- Relevant Files --');
    for (const f of session.files) {
      lines.push(`  ${f}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
