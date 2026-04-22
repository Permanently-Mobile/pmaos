/**
 * Scribe -- Telegram conversation note-taker.
 * Shared type definitions.
 */

// ── Classification ──────────────────────────────────────────────────

/** Categories mapped directly to vault routing rules. */
export type ScribeCategory =
  | 'task'        // -> Tasks.md (sectioned by project)
  | 'decision'    // -> Projects/<name>/<name>.md Decision Log
  | 'progress'    // -> Projects/<name>/<name>.md Progress Log
  | 'research'    // -> Deepdives & Ongoing.md
  | 'note'        // -> Notes/<topic>.md
  | 'daily_log'   // -> Daily Notes/YYYY-MM-DD.md Log section
  | 'personal'    // -> Daily Notes/YYYY-MM-DD.md Personal Notes
  | 'financial'   // -> Daily Notes/YYYY-MM-DD.md with [Financial] prefix
  | 'skip';       // Not worth capturing

export interface ClassifiedItem {
  category: ScribeCategory;
  content: string;
  project?: string;
  topic?: string;
  confidence: number;          // 0-1
  sourceMessageIds: number[];  // conversation_log.id references
  timestamp: number;           // unix seconds
  threadId: string;
}

// ── Threading ───────────────────────────────────────────────────────

export interface ThreadMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export interface ConversationThread {
  id: string;
  messages: ThreadMessage[];
  startTime: number;
  endTime: number;
  topicSummary: string;
}

// ── Pipeline ────────────────────────────────────────────────────────

export interface ScribeRunResult {
  threadsProcessed: number;
  itemsClassified: number;
  itemsWritten: number;
  itemsSkipped: number;
  itemsDeduplicated: number;
  memoriesCreated: number;
  memoriesUpdated: number;
  errors: string[];
  durationMs: number;
}

export interface ScribeOptions {
  lookbackDays?: number;
  afterMessageId?: number;
  dryRun?: boolean;
  skipMemoryWrite?: boolean;
}

// -- Librarian types ---------------------------------------------------------

export interface MemoryWriteResult {
  created: number;
  updated: number;
  deduplicated: number;
  embedded: number;
  errors: string[];
}

export type LibrarianCommand =
  | { type: 'audit' }
  | { type: 'clean'; topic?: string }
  | { type: 'consolidate'; project?: string }
  | { type: 'search'; query: string }
  | { type: 'vault-sort'; dryRun?: boolean };

export interface LibrarianResult {
  command: string;
  summary: string;
  details?: string;
}

// ── Route result ────────────────────────────────────────────────────

export interface RouteResult {
  written: boolean;
  path: string;
  deduplicated: boolean;
  error?: string;
}

// ── Vault index (read-before-write) ─────────────────────────────────

export interface VaultFileEntry {
  path: string;             // full absolute path
  relativePath: string;     // path relative to vault root
  name: string;             // filename without extension
  sections: string[];       // ## heading names found in file
  contentLines: string[];   // all non-empty lines (cached for dedup)
  modifiedAt: number;       // file mtime in ms
  sizeBytes: number;        // file size
}

export interface VaultIndex {
  files: VaultFileEntry[];
  tasks: string[];           // all open tasks (- [ ] lines) from Tasks.md
  completedTasks: string[];  // all completed tasks (- [x] lines)
  projects: string[];        // project folder names
  existingNotes: string[];   // note filenames in Notes/
  recentDailyNotes: string[];// daily note filenames from last 7 days
  builtAt: number;           // when this index was created (ms)
}
