/**
 * Vault Sync Watch -- Phase 5 Feature 2.
 *
 * Polls the Obsidian vault git history every 60 seconds, detects new commits,
 * extracts key facts from changed files, and indexes them into the memory
 * system immediately. This closes the gap where vault writes are invisible
 * to memory search until Scribe's nightly batch run.
 *
 * Architecture:
 *   - Polling-based (no file watchers) -- consistent with existing patterns
 *   - Tracks last-checked commit hash to avoid reprocessing
 *   - Venice extraction for fact extraction (lightweight prompt, max 5 facts per file)
 *   - Deduplicates against existing memories (Jaccard + cosine)
 *   - Cross-links via memory_vault_links table (Scribe Librarian Phase 3)
 *   - Fire-and-forget: never blocks, never throws
 */

import { execSync } from 'child_process';
import path from 'path';

import { saveMemoryReturningId, saveEmbedding } from './db.js';
import { logger } from './logger.js';
import { embedText, findDuplicate } from './memory-extract.js';
import { venicePrivateChat, veniceCapabilities } from './venice.js';

// ── Config ────────────────────────────────────────────────────────────

const VAULT_ROOT = process.env.VAULT_ROOT || '';

/** How often to check for new vault commits (ms). Hourly by default -- use triggerVaultSync() for immediate checks. */
const POLL_INTERVAL_MS = 3_600_000;

/** Max facts to extract per changed file. */
const MAX_FACTS_PER_FILE = 5;

/** Max changed files to process per poll cycle. */
const MAX_FILES_PER_CYCLE = 10;

/** Max content chars to send to Venice per file. */
const MAX_CONTENT_CHARS = 2000;

/** Skip files smaller than this (likely empty or trivial). */
const MIN_CONTENT_CHARS = 30;

/** Directories to skip (templates, binary folders, etc). */
const SKIP_DIRS = new Set(['Templates', '.git', '.obsidian', 'Audits/Systems Health']);

/** File extensions to process. */
const VALID_EXTENSIONS = new Set(['.md']);

// ── State ─────────────────────────────────────────────────────────────

let lastCheckedCommit: string | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let activeChatId: string | null = null;

// ── Venice Prompt ─────────────────────────────────────────────────────

const VAULT_EXTRACT_PROMPT = `You are a memory extraction system. Given content from an Obsidian vault note, extract the key facts worth remembering. These are structured notes, not conversation -- extract decisions, preferences, project states, and important information.

Rules:
- Extract discrete, standalone facts. Each should make sense without the rest of the file.
- Write as concise third-person statements (e.g. "The user decided to use pfSense", "Project X is in Phase 2").
- Skip boilerplate: YAML frontmatter, template sections, empty checkboxes, headers with no content.
- Classify each fact: topic (preferences, family, projects, crypto, tools, personal, general), sector (semantic or episodic).
- Rate importance 1-10: 1=trivial, 5=useful, 10=core identity/critical.
- Return valid JSON array only. No explanation, no markdown fencing.
- If nothing worth remembering, return: []
- Maximum ${MAX_FACTS_PER_FILE} facts.

Format: [{"fact": "...", "topic": "...", "sector": "semantic|episodic", "importance": 1-10}]`;

// ── Path Utilities ────────────────────────────────────────────────────

/**
 * Check if a file path is within the vault and should be processed.
 */
function shouldProcessFile(filePath: string): boolean {
  if (!VALID_EXTENSIONS.has(path.extname(filePath))) return false;

  for (const skip of SKIP_DIRS) {
    if (filePath.startsWith(skip + '/') || filePath === skip) return false;
  }

  return true;
}

/**
 * Derive a topic_key from the vault file path.
 */
function deriveTopicKey(filePath: string): string {
  if (filePath.startsWith('Projects/')) return 'projects';
  if (filePath.startsWith('Tasks')) return 'projects';
  if (filePath.startsWith('Deepdives')) return 'projects';
  if (filePath.startsWith('Notes/')) return 'general';
  if (filePath.startsWith('Daily Notes/')) return 'general';
  if (filePath.startsWith('Research Results/')) return 'general';
  if (filePath.startsWith('Audits/')) return 'tools';
  if (filePath.startsWith('Disaster Recovery/')) return 'tools';
  return 'general';
}

// ── Git Operations ────────────────────────────────────────────────────

/**
 * Get the current HEAD commit hash of the vault repo.
 */
function getVaultHead(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: VAULT_ROOT,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get list of changed files between two commits (or since a timeframe).
 * Returns relative paths within the vault.
 */
function getChangedFiles(sinceCommit: string, untilCommit: string): string[] {
  try {
    const output = execSync(
      `git diff --name-only --diff-filter=AMR ${sinceCommit} ${untilCommit}`,
      {
        cwd: VAULT_ROOT,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      },
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the content of a file at a specific commit.
 */
function getFileContent(filePath: string, commit: string): string | null {
  try {
    return execSync(`git show ${commit}:"${filePath}"`, {
      cwd: VAULT_ROOT,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * Get recent commits since a reference point.
 * Returns an array of commit hashes (newest first).
 */
function getRecentCommits(sinceCommit: string, limit = 20): string[] {
  try {
    const output = execSync(
      `git log --format=%H ${sinceCommit}..HEAD --max-count=${limit}`,
      {
        cwd: VAULT_ROOT,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      },
    ).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ── Core Sync Logic ──────────────────────────────────────────────────

/**
 * Check for new vault commits and index any new content into memory.
 * Fire-and-forget: never throws, logs errors internally.
 * Returns count of new memories saved.
 */
export async function checkVaultChanges(chatId: string): Promise<number> {
  try {
    const { configured } = veniceCapabilities();
    if (!configured) return 0;

    const currentHead = getVaultHead();
    if (!currentHead) return 0;

    // First run: just record the current HEAD, don't process history
    if (!lastCheckedCommit) {
      lastCheckedCommit = currentHead;
      logger.debug('Vault sync initialized at commit %s', currentHead.slice(0, 8));
      return 0;
    }

    // No new commits since last check
    if (currentHead === lastCheckedCommit) return 0;

    // Get changed files between last check and current HEAD
    const changedFiles = getChangedFiles(lastCheckedCommit, currentHead);
    if (changedFiles.length === 0) {
      lastCheckedCommit = currentHead;
      return 0;
    }

    // Filter to processable files
    const filesToProcess = changedFiles
      .filter(shouldProcessFile)
      .slice(0, MAX_FILES_PER_CYCLE);

    if (filesToProcess.length === 0) {
      lastCheckedCommit = currentHead;
      return 0;
    }

    logger.info(
      { files: filesToProcess.length, from: lastCheckedCommit.slice(0, 8), to: currentHead.slice(0, 8) },
      'Vault sync: processing changed files',
    );

    let totalSaved = 0;

    for (const filePath of filesToProcess) {
      try {
        const content = getFileContent(filePath, currentHead);
        if (!content || content.length < MIN_CONTENT_CHARS) continue;

        // Trim content for Venice (strip YAML frontmatter, cap length)
        const trimmed = stripFrontmatter(content).slice(0, MAX_CONTENT_CHARS);
        if (trimmed.length < MIN_CONTENT_CHARS) continue;

        const saved = await extractAndSaveVaultFacts(
          chatId,
          filePath,
          trimmed,
        );
        totalSaved += saved;
      } catch (fileErr) {
        logger.warn({ err: fileErr, file: filePath }, 'Vault sync: file processing failed (continuing)');
      }
    }

    // Update checkpoint
    lastCheckedCommit = currentHead;

    if (totalSaved > 0) {
      logger.info({ totalSaved, files: filesToProcess.length }, 'Vault sync complete');
    }

    return totalSaved;
  } catch (err) {
    logger.error({ err }, 'Vault sync check failed (non-fatal)');
    return 0;
  }
}

/**
 * Extract facts from a single vault file and save to memory.
 */
async function extractAndSaveVaultFacts(
  chatId: string,
  filePath: string,
  content: string,
): Promise<number> {
  const topicKey = deriveTopicKey(filePath);

  // Extract facts via Venice
  const raw = await venicePrivateChat(
    `File: ${filePath}\n\n${content}`,
    VAULT_EXTRACT_PROMPT,
  );

  const cleaned = raw.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '');
  let parsed: unknown[];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return 0;
  }

  if (!Array.isArray(parsed)) return 0;

  let saved = 0;
  const validTopics = new Set(['preferences', 'family', 'projects', 'crypto', 'tools', 'personal', 'general']);

  for (const item of parsed.slice(0, MAX_FACTS_PER_FILE)) {
    const rec = item as Record<string, unknown>;
    if (typeof rec.fact !== 'string' || rec.fact.length < 4) continue;

    const fact = (rec.fact as string).slice(0, 500);
    const topic = typeof rec.topic === 'string' && validTopics.has(rec.topic)
      ? rec.topic : topicKey;
    const sector = rec.sector === 'episodic' ? 'episodic' as const : 'semantic' as const;
    const importance = typeof rec.importance === 'number'
      ? Math.max(1, Math.min(10, Math.round(rec.importance))) : 5;

    // Generate embedding for dedup + search
    const embedding = await embedText(fact);

    // Dedup against existing memories
    const dupId = await findDuplicate(chatId, fact, embedding);
    if (dupId) continue; // Already know this

    // Save with moderate salience (vault writes are intentional)
    const salience = Math.min(5.0, 2.5 + importance / 5);
    const memId = saveMemoryReturningId(chatId, fact, sector, topic, salience);
    saved++;

    if (embedding) {
      saveEmbedding(memId, embedding, 'text-embedding-bge-m3', chatId);
    }

    // Cross-link to vault file via Scribe's memory_vault_links
    try {
      const fullPath = path.join(VAULT_ROOT, filePath).replace(/\\/g, '/');
      crossLinkMemory(memId, fullPath, topic);
    } catch {
      // Cross-linking is best-effort (scribe db may not be available)
    }

    logger.debug({ memId, fact: fact.slice(0, 60), file: filePath }, 'Vault sync: fact saved');
  }

  return saved;
}

/**
 * Cross-link a memory to its vault source file.
 * Uses Scribe's memory_vault_links table if available.
 * Best-effort: silently fails if scribe DB is not accessible.
 */
function crossLinkMemory(memoryId: number, vaultPath: string, category: string): void {
  try {
    // Dynamic import to avoid hard dependency on scribe DB
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const scribeDb = require('./scribe/db.js');
    if (typeof scribeDb.saveMemoryVaultLink === 'function') {
      scribeDb.saveMemoryVaultLink(memoryId, vaultPath, category);
    }
  } catch {
    // Scribe DB not available -- that's fine
  }
}

/**
 * Strip YAML frontmatter from markdown content.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 3).trim();
}

// ── Lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the vault sync polling loop.
 * Call once during bot startup.
 */
export function initVaultSync(chatId: string): void {
  // Internal automation -- disabled by default in release builds
  if (process.env.ENABLE_VAULT_SYNC !== 'true') {
    logger.info('Vault sync disabled (set ENABLE_VAULT_SYNC=true to enable)');
    return;
  }

  if (pollInterval) {
    logger.warn('Vault sync already initialized');
    return;
  }

  activeChatId = chatId;

  // Initialize by recording current HEAD
  lastCheckedCommit = getVaultHead();

  pollInterval = setInterval(() => {
    if (activeChatId) {
      checkVaultChanges(activeChatId).catch((err) => {
        logger.error({ err }, 'Vault sync poll failed (non-fatal)');
      });
    }
  }, POLL_INTERVAL_MS);

  logger.info(
    { commit: lastCheckedCommit?.slice(0, 8), interval: POLL_INTERVAL_MS },
    'Vault sync started',
  );
}

/**
 * Stop the vault sync polling loop.
 */
export function stopVaultSync(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    activeChatId = null;
    logger.info('Vault sync stopped');
  }
}

/**
 * Trigger an immediate vault sync check outside the hourly poll.
 * Use after explicit vault writes (vault-commit.sh, Scribe runs, etc.)
 * to index new content without waiting for the next hourly cycle.
 * Fire-and-forget: logs internally, never throws.
 */
export async function triggerVaultSync(): Promise<number> {
  if (!activeChatId) {
    logger.warn('triggerVaultSync called but vault sync not initialized');
    return 0;
  }
  logger.debug('Vault sync triggered manually');
  return checkVaultChanges(activeChatId);
}
