/**
 * Scribe -- vault introspection.
 *
 * Reads the Obsidian vault structure to discover projects,
 * task sections, and existing notes for routing + dedup.
 * Includes VaultIndex for batch-cached read-before-write.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { VaultFileEntry, VaultIndex } from './types.js';

export const VAULT_ROOT = process.env.VAULT_ROOT || '';

// ── Vault index cache (one per pipeline run) ────────────────────────

let cachedIndex: VaultIndex | null = null;
let cachedFileContents: Map<string, string[]> = new Map();
let cachedProjectIndex: Map<string, string> | null = null;

/**
 * Build a complete vault index by scanning all .md files.
 * Extracts section headers, content lines, tasks, projects, and notes.
 * Call once per pipeline run -- results are cached until clearVaultIndex().
 */
export function buildVaultIndex(): VaultIndex {
  const start = Date.now();
  const files: VaultFileEntry[] = [];
  const tasks: string[] = [];
  const completedTasks: string[] = [];
  const existingNotes: string[] = [];
  const recentDailyNotes: string[] = [];

  // Scan vault recursively for .md files
  const scanDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip hidden dirs, Templates, .obsidian
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'Templates') continue;
        scanDir(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.md')) continue;

      try {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        // Extract section headers
        const sections: string[] = [];
        const contentLines: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('## ')) {
            sections.push(trimmed.slice(3).trim());
          }
          if (trimmed.length > 0 && !trimmed.startsWith('---') && !trimmed.startsWith('#')) {
            contentLines.push(trimmed);
          }
        }

        const relativePath = path.relative(VAULT_ROOT, fullPath).replace(/\\/g, '/');
        const name = path.basename(entry.name, '.md');

        files.push({
          path: fullPath,
          relativePath,
          name,
          sections,
          contentLines,
          modifiedAt: stat.mtimeMs,
          sizeBytes: stat.size,
        });

        // Cache content lines for fast dedup lookups
        cachedFileContents.set(fullPath, contentLines);
      } catch {
        // Skip unreadable files
      }
    }
  };

  scanDir(VAULT_ROOT);

  // Extract tasks from Tasks.md
  const tasksFile = files.find(f => f.relativePath === 'Tasks.md');
  if (tasksFile) {
    for (const line of tasksFile.contentLines) {
      const openMatch = line.match(/^- \[ \]\s+(.+)$/);
      if (openMatch) tasks.push(openMatch[1].trim().toLowerCase());

      const doneMatch = line.match(/^- \[x\]\s+(.+)$/i);
      if (doneMatch) completedTasks.push(doneMatch[1].trim().toLowerCase());
    }
  }

  // Extract project names
  const projects = loadKnownProjects();

  // Extract existing note names
  const notesDir = path.join(VAULT_ROOT, 'Notes');
  if (fs.existsSync(notesDir)) {
    try {
      const noteFiles = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
      for (const nf of noteFiles) {
        existingNotes.push(path.basename(nf, '.md'));
      }
    } catch {
      // Skip if unreadable
    }
  }

  // Get recent daily notes (last 7 days)
  const dailyDir = path.join(VAULT_ROOT, 'Daily Notes');
  if (fs.existsSync(dailyDir)) {
    const sevenDaysAgo = Date.now() - (7 * 86400 * 1000);
    try {
      const dailyFiles = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md'));
      for (const df of dailyFiles) {
        const dfPath = path.join(dailyDir, df);
        const stat = fs.statSync(dfPath);
        if (stat.mtimeMs >= sevenDaysAgo) {
          recentDailyNotes.push(path.basename(df, '.md'));
        }
      }
    } catch {
      // Skip if unreadable
    }
  }

  const index: VaultIndex = {
    files,
    tasks,
    completedTasks,
    projects,
    existingNotes,
    recentDailyNotes,
    builtAt: Date.now(),
  };

  cachedIndex = index;

  const elapsed = Date.now() - start;
  logger.info(
    {
      fileCount: files.length,
      taskCount: tasks.length,
      completedCount: completedTasks.length,
      projectCount: projects.length,
      noteCount: existingNotes.length,
      durationMs: elapsed,
    },
    'Vault index built',
  );

  return index;
}

/**
 * Get the cached vault index, or build it if not cached.
 */
export function getVaultIndex(): VaultIndex {
  if (cachedIndex) return cachedIndex;
  return buildVaultIndex();
}

/**
 * Clear the cached vault index (call at end of pipeline run).
 */
export function clearVaultIndex(): void {
  cachedIndex = null;
  cachedFileContents.clear();
  cachedProjectIndex = null;
}

/**
 * Check if content exists in a file using the cached index.
 * Falls back to direct file read if not in cache.
 */
export function contentExistsInFileCached(filePath: string, content: string): boolean {
  // Try cached lines first
  const cached = cachedFileContents.get(filePath);
  if (cached) {
    return contentExistsInLines(cached, content);
  }
  // Fall back to direct file read
  return contentExistsInFile(filePath, content);
}

/**
 * Check if content exists in an array of pre-loaded lines.
 * Same three-strategy approach as contentExistsInFile but without file I/O.
 */
function contentExistsInLines(lines: string[], content: string): boolean {
  const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ').trim();

  // Strategy 1: Exact substring match against all lines joined
  const allText = lines.join(' ').toLowerCase().replace(/\s+/g, ' ');
  if (allText.includes(normalizedContent)) return true;

  // Extract signature words from incoming content
  const contentSigWords = extractSignatureWords(content);
  if (contentSigWords.size < 2) return false;

  for (const line of lines) {
    if (line.length < 10) continue;

    const lineWords = new Set(line.toLowerCase().replace(/\s+/g, ' ').split(' '));
    if (lineWords.size < 3) continue;

    // Strategy 2: Jaccard similarity
    const contentWords = new Set(normalizedContent.split(' '));
    const intersection = new Set([...contentWords].filter(w => lineWords.has(w)));
    const union = new Set([...contentWords, ...lineWords]);
    const jaccard = intersection.size / union.size;
    if (jaccard > 0.6) return true;

    // Strategy 3: Signature-word coverage with stem matching
    const lineSigWords = extractSignatureWords(line);
    if (lineSigWords.size < 2) continue;

    const sigMatchCount = countStemMatches(contentSigWords, lineSigWords);
    const incomingCoverage = sigMatchCount / contentSigWords.size;
    if (incomingCoverage >= 0.7 && sigMatchCount >= 2) return true;

    if (lineSigWords.size <= 6) {
      const reverseMatchCount = countStemMatches(lineSigWords, contentSigWords);
      const lineCoverage = reverseMatchCount / lineSigWords.size;
      if (lineCoverage >= 0.6 && reverseMatchCount >= 2) return true;
    }
  }

  return false;
}

/**
 * Build a concise summary of vault contents for the classifier.
 * Gives Venice awareness of what already exists so it can avoid suggesting duplicates.
 */
export function buildVaultContextForClassifier(index: VaultIndex): string {
  const sections: string[] = [];

  // Open tasks (last 30 to keep prompt manageable)
  if (index.tasks.length > 0) {
    const recentTasks = index.tasks.slice(-30);
    sections.push(
      '## Existing Open Tasks (recent)',
      ...recentTasks.map(t => `- ${t}`),
    );
  }

  // Existing notes
  if (index.existingNotes.length > 0) {
    sections.push(
      '',
      '## Existing Notes (filenames)',
      ...index.existingNotes.map(n => `- ${n}`),
    );
  }

  // Recent daily notes
  if (index.recentDailyNotes.length > 0) {
    sections.push(
      '',
      '## Recent Daily Notes',
      ...index.recentDailyNotes.map(d => `- ${d}`),
    );
  }

  return sections.join('\n');
}

// ── Recursive project index ──────────────────────────────────────────

/**
 * FIX 1: Check if a .md file has `type: project` in its YAML frontmatter.
 * Used to discover project files that don't follow the <dirname>/<dirname>.md convention.
 */
function hasProjectFrontmatter(filePath: string): boolean {
  try {
    // Read only the first 500 bytes to avoid loading large files
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(500);
    const bytesRead = fs.readSync(fd, buf, 0, 500, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf-8', 0, bytesRead);
    const fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;
    return /^type:\s*project$/m.test(fmMatch[1]);
  } catch {
    return false;
  }
}

/**
 * Recursively walk Projects/ and find all directories containing a
 * matching <dirname>.md file. Returns Map<projectName, fullFolderPath>.
 *
 * Handles nested project structures like:
 *   Projects/MyApp/MyApp.md -> 'MyApp'
 *   Projects/MyApp/MyApp Hardware/EVO Migration Plan/EVO Migration Plan.md -> 'EVO Migration Plan'
 *
 * Cached for the duration of a pipeline run (cleared by clearVaultIndex()).
 */
export function buildProjectIndex(): Map<string, string> {
  if (cachedProjectIndex) return cachedProjectIndex;

  const projectsDir = path.join(VAULT_ROOT, 'Projects');
  const index = new Map<string, string>();

  if (!fs.existsSync(projectsDir)) {
    cachedProjectIndex = index;
    return index;
  }

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        const mainFile = path.join(fullPath, `${entry.name}.md`);
        if (fs.existsSync(mainFile)) {
          index.set(entry.name, fullPath);
        }
        // Keep walking deeper regardless
        walk(fullPath);
        continue;
      }

      // FIX 1: Also index .md files with type: project frontmatter
      // Catches projects that don't follow the <dirname>/<dirname>.md convention
      if (entry.name.endsWith('.md')) {
        const name = path.basename(entry.name, '.md');
        if (index.has(name)) continue; // already indexed by directory convention
        if (hasProjectFrontmatter(fullPath)) {
          index.set(name, dir);
        }
      }
    }
  };

  walk(projectsDir);
  cachedProjectIndex = index;

  logger.debug(
    { count: index.size, projects: [...index.keys()] },
    'Project index built (recursive)',
  );

  return index;
}

/**
 * Get the cached project index, or build it if not cached.
 */
export function getProjectIndex(): Map<string, string> {
  return buildProjectIndex();
}

// ── Project discovery ───────────────────────────────────────────────

/**
 * Scan Projects/ directory for known project names (recursive).
 * Returns a flat list of all project names at any depth.
 */
export function loadKnownProjects(): string[] {
  const index = buildProjectIndex();
  return [...index.keys()];
}

// ── Task sections ───────────────────────────────────────────────────

export interface TaskSection {
  name: string;
  projectRef: string;
  startLine: number;
  endLine: number;
}

/**
 * Parse Tasks.md to find Active sections and their line ranges.
 */
export function loadTaskSections(): TaskSection[] {
  const tasksPath = path.join(VAULT_ROOT, 'Tasks.md');
  if (!fs.existsSync(tasksPath)) return [];

  const content = fs.readFileSync(tasksPath, 'utf-8');
  const lines = content.split('\n');
  const sections: TaskSection[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^## (?:Active -- |Backlog|Completed)(.*?)(?:\s*\(.*\))?$/);
    if (match) {
      // Close previous section
      if (sections.length > 0) {
        sections[sections.length - 1].endLine = i - 1;
      }
      sections.push({
        name: match[1]?.trim() || lines[i].replace(/^## /, '').trim(),
        projectRef: lines[i],
        startLine: i,
        endLine: lines.length - 1,  // will be corrected by next section
      });
    }
  }

  return sections;
}

// ── Daily notes ─────────────────────────────────────────────────────

/**
 * Ensure a daily note exists. Creates from template if missing.
 * Returns the file path.
 */
export function ensureDailyNote(dateStr: string): string {
  const notePath = path.join(VAULT_ROOT, 'Daily Notes', `${dateStr}.md`);

  if (!fs.existsSync(notePath)) {
    const dir = path.dirname(notePath);
    fs.mkdirSync(dir, { recursive: true });

    const template = [
      '---',
      'type: daily-note',
      `date: ${dateStr}`,
      '---',
      '',
      '## Tasks',
      '',
      '## Notes',
      '',
      '## Log',
      '',
      '## Personal Notes',
      '',
    ].join('\n');

    fs.writeFileSync(notePath, template, 'utf-8');
    logger.info({ path: notePath }, 'Created daily note');
  }

  return notePath;
}

// ── Note checks ─────────────────────────────────────────────────────

/**
 * Check if a note already exists in Notes/.
 */
export function noteExists(topic: string): boolean {
  const notePath = path.join(VAULT_ROOT, 'Notes', `${sanitizeFilename(topic)}.md`);
  return fs.existsSync(notePath);
}

/**
 * Sanitize a string for use as a filename.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// ── Completed task detection ─────────────────────────────────────────

/**
 * Load all completed tasks from Tasks.md.
 * Returns normalized task strings (lowercase, trimmed) for matching.
 */
export function loadCompletedTasks(): string[] {
  const tasksPath = path.join(VAULT_ROOT, 'Tasks.md');
  if (!fs.existsSync(tasksPath)) return [];

  const content = fs.readFileSync(tasksPath, 'utf-8');
  const lines = content.split('\n');
  const completed: string[] = [];

  for (const line of lines) {
    const match = line.match(/^- \[x\]\s+(.+)$/i);
    if (match) {
      completed.push(match[1].trim().toLowerCase());
    }
  }

  logger.info({ count: completed.length }, 'Loaded completed tasks from vault');
  return completed;
}

/**
 * Simple word stem: strip common English suffixes so "calendars" ~ "calendar",
 * "tooling" ~ "tool", "replacements" ~ "replace", etc.
 * Not a full Porter stemmer -- just enough to catch plurals and verb forms.
 */
function simpleStem(word: string): string {
  if (word.length <= 4) return word;
  // Order matters: try longest suffixes first
  for (const suffix of ['ments', 'ment', 'tion', 'sion', 'ting', 'ing', 'ness', 'able', 'ible', 'ies', 'ers', 'ous', 'ive', 'ed', 'ly', 'er', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Count how many words in setA have a stem match in setB.
 * Uses both exact match and stem comparison for flexibility.
 */
function countStemMatches(setA: Set<string>, setB: Set<string>): number {
  let matches = 0;
  const stemsB = new Set([...setB].map(simpleStem));

  for (const word of setA) {
    // Exact match
    if (setB.has(word)) {
      matches++;
      continue;
    }
    // Stem match
    if (stemsB.has(simpleStem(word))) {
      matches++;
    }
  }
  return matches;
}

/** Common verbs/words that don't help distinguish tasks. */
const STOP_WORDS = new Set([
  // Articles, prepositions, pronouns
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'its', 'our',
  'new', 'own', 'all', 'each', 'any', 'has', 'have', 'been', 'will', 'can',
  'not', 'but', 'are', 'was', 'were', 'also', 'when', 'then', 'than', 'more',
  // Generic task verbs (normalizes "Build X" vs "Develop X" vs "Create X")
  'set', 'add', 'get', 'use', 'run', 'build', 'create', 'make', 'put',
  'setup', 'configure', 'implement', 'complete', 'finish', 'start',
  'ensure', 'including', 'using', 'based',
  'script', 'develop', 'wire', 'deploy', 'upgrade', 'install',
  'test', 'verify', 'review', 'fix', 'debug', 'refine',
  'integrate', 'dispatch', 'research', 'investigate', 'evaluate',
  'design', 'plan', 'check', 'update', 'move', 'write',
  'connect', 'migrate', 'transfer', 'scan', 'send', 'launch',
  'enable', 'disable', 'remove', 'delete', 'clean', 'track',
]);

/**
 * Extract "signature words" -- the specific nouns/terms that identify a task.
 * Strips stop words and short words to focus on what makes each task unique.
 */
export function extractSignatureWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Check if a classified "task" item matches an already-completed task in the vault.
 * Uses two strategies:
 * 1. Jaccard similarity on signature words (>= 0.4 threshold)
 * 2. Vault task coverage: if >= 60% of a vault task's signature words appear in the item
 */
export function isTaskAlreadyCompleted(itemContent: string, completedTasks: string[]): boolean {
  const itemWords = extractSignatureWords(itemContent);
  if (itemWords.size === 0) return false;

  for (const task of completedTasks) {
    const taskWords = extractSignatureWords(task);
    if (taskWords.size === 0) continue;

    const intersection = new Set([...itemWords].filter(w => taskWords.has(w)));
    const union = new Set([...itemWords, ...taskWords]);

    // Strategy 1: Jaccard similarity
    const jaccard = intersection.size / union.size;
    if (jaccard >= 0.4) return true;

    // Strategy 2: If most of the vault task's key words appear in the Venice item,
    // it's likely describing the same completed work (even if Venice added extra context)
    if (taskWords.size >= 2 && intersection.size >= 2) {
      const coverage = intersection.size / taskWords.size;
      if (coverage >= 0.6) return true;
    }
  }

  return false;
}

// ── File section operations ─────────────────────────────────────────

/**
 * Append content to a specific markdown section (## heading).
 * Inserts before the next ## heading or at end of file.
 * Uses fuzzy matching: if sectionHeading is a substring of a line or vice versa, it matches.
 */
export function appendToSection(filePath: string, sectionHeading: string, content: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n');

  // Find the section -- use fuzzy match (contains check both ways)
  let sectionStart = -1;
  let insertAt = -1;
  const headingLower = sectionHeading.toLowerCase();

  // Extract the key search term from the heading (e.g., "Home Network Overhaul" from "## Active -- Home Network Overhaul")
  const searchTerm = headingLower
    .replace(/^##\s*/, '')
    .replace(/^active\s*--\s*/, '')
    .trim();

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].trim().toLowerCase();
    // Exact startsWith OR fuzzy: line contains the key term (handles name mismatches like "Home Network" vs "Home Network Overhaul")
    if (lineLower.startsWith(headingLower) || (lineLower.startsWith('## ') && searchTerm.length > 3 && (lineLower.includes(searchTerm) || searchTerm.includes(lineLower.replace(/^##\s*active\s*--\s*/, '').replace(/\s*\(.*$/, '').trim())))) {
      sectionStart = i;
      // Find the end of this section (next ## or EOF)
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(/^##\s/)) {
          insertAt = j;
          break;
        }
      }
      if (insertAt === -1) insertAt = lines.length;
      break;
    }
  }

  if (sectionStart === -1) {
    // Section not found -- DON'T create a new section, just return false
    return false;
  }

  // Insert content before the next section (or at end)
  lines.splice(insertAt, 0, content);

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return true;
}

/**
 * Append a row to a markdown table within a section.
 * Finds the last `|` line in the section and inserts after it.
 */
export function appendToTableInSection(
  filePath: string,
  sectionHeading: string,
  row: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n');

  let inSection = false;
  let lastTableLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(sectionHeading)) {
      inSection = true;
      continue;
    }
    if (inSection && lines[i].match(/^##\s/)) {
      break; // Hit next section
    }
    if (inSection && lines[i].trim().startsWith('|')) {
      lastTableLine = i;
    }
  }

  if (lastTableLine === -1) return false;

  lines.splice(lastTableLine + 1, 0, row);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return true;
}

// ── Stem similarity scoring ──────────────────────────────────────────

export interface StemMatchResult {
  /** Best similarity score across all strategies and lines (0.0 - 1.0). */
  score: number;
  /** The vault line that produced the best score. */
  bestMatch: string;
}

/**
 * Compute a numerical stem similarity score against cached file content.
 * Falls back to direct file read if not in cache.
 * Returns the best score and the line that matched.
 */
export function stemSimilarityScoreCached(filePath: string, content: string): StemMatchResult {
  const cached = cachedFileContents.get(filePath);
  if (cached) {
    return stemSimilarityScoreLines(cached, content);
  }
  if (!fs.existsSync(filePath)) return { score: 0, bestMatch: '' };
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('---') && !l.startsWith('#'));
  return stemSimilarityScoreLines(lines, content);
}

/**
 * Compute stem similarity score against an array of content lines.
 * Uses the same three strategies as contentExistsInFile but returns
 * a numerical score instead of a boolean.
 */
function stemSimilarityScoreLines(lines: string[], content: string): StemMatchResult {
  const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ').trim();
  let bestScore = 0;
  let bestMatch = '';

  // Strategy 1: Exact substring match -> score 1.0
  const allText = lines.join(' ').toLowerCase().replace(/\s+/g, ' ');
  if (allText.includes(normalizedContent)) {
    return { score: 1.0, bestMatch: normalizedContent };
  }

  const contentSigWords = extractSignatureWords(content);
  if (contentSigWords.size < 2) return { score: 0, bestMatch: '' };

  for (const line of lines) {
    if (line.length < 10) continue;

    const lineWords = new Set(line.toLowerCase().replace(/\s+/g, ' ').split(' '));
    if (lineWords.size < 3) continue;

    // Strategy 2: Jaccard similarity (the raw value)
    const contentWords = new Set(normalizedContent.split(' '));
    const intersection = new Set([...contentWords].filter(w => lineWords.has(w)));
    const union = new Set([...contentWords, ...lineWords]);
    const jaccard = intersection.size / union.size;
    if (jaccard > bestScore) {
      bestScore = jaccard;
      bestMatch = line;
    }

    // Strategy 3: Signature-word coverage
    const lineSigWords = extractSignatureWords(line);
    if (lineSigWords.size < 2) continue;

    const sigMatchCount = countStemMatches(contentSigWords, lineSigWords);
    const incomingCoverage = sigMatchCount >= 2 ? sigMatchCount / contentSigWords.size : 0;
    if (incomingCoverage > bestScore) {
      bestScore = incomingCoverage;
      bestMatch = line;
    }

    // Reverse coverage for short lines
    if (lineSigWords.size <= 6) {
      const reverseMatchCount = countStemMatches(lineSigWords, contentSigWords);
      const lineCoverage = reverseMatchCount >= 2 ? reverseMatchCount / lineSigWords.size : 0;
      if (lineCoverage > bestScore) {
        bestScore = lineCoverage;
        bestMatch = line;
      }
    }
  }

  return { score: bestScore, bestMatch };
}

/**
 * Get content lines for a file (from cache or direct read).
 * Used by semantic dedup to get existing vault content for comparison.
 */
export function getContentLines(filePath: string): string[] {
  const cached = cachedFileContents.get(filePath);
  if (cached) return cached;
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('---') && !l.startsWith('#'));
}

// ── Legacy boolean dedup (kept for backwards compatibility) ─────────

/**
 * Check if a string (or very similar) already exists in a file.
 * Uses three strategies:
 *   1. Exact substring match
 *   2. Jaccard similarity (works for similar-length strings)
 *   3. Signature-word coverage (catches short Scribe summaries vs long detailed entries)
 */
export function contentExistsInFile(filePath: string, content: string): boolean {
  if (!fs.existsSync(filePath)) return false;

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedFile = fileContent.toLowerCase().replace(/\s+/g, ' ');

  // Strategy 1: Exact substring match
  if (normalizedFile.includes(normalizedContent)) return true;

  // Extract signature words from incoming content (nouns/terms, no stop words)
  const contentSigWords = extractSignatureWords(content);
  if (contentSigWords.size < 2) return false; // too short to meaningfully match

  const fileLines = fileContent.split('\n');

  for (const line of fileLines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length < 10) continue; // skip short lines

    const lineWords = new Set(trimmedLine.toLowerCase().replace(/\s+/g, ' ').split(' '));
    if (lineWords.size < 3) continue;

    // Strategy 2: Jaccard similarity (good for similar-length strings)
    const contentWords = new Set(normalizedContent.split(' '));
    const intersection = new Set([...contentWords].filter(w => lineWords.has(w)));
    const union = new Set([...contentWords, ...lineWords]);
    const jaccard = intersection.size / union.size;
    if (jaccard > 0.6) return true;

    // Strategy 3: Signature-word coverage with stem matching
    // If most of the incoming item's key words appear in an existing line,
    // it's the same topic even if the line is much longer (detailed description).
    const lineSigWords = extractSignatureWords(trimmedLine);
    if (lineSigWords.size < 2) continue;

    // Use stem-aware matching: "calendar" matches "calendars", "tool" matches "tooling"
    const sigMatchCount = countStemMatches(contentSigWords, lineSigWords);

    // If >= 70% of the incoming content's signature words match this line, it's a dupe.
    const incomingCoverage = sigMatchCount / contentSigWords.size;
    if (incomingCoverage >= 0.7 && sigMatchCount >= 2) return true;

    // Also check reverse: if >= 60% of a short line's sig words match content
    if (lineSigWords.size <= 6) {
      const reverseMatchCount = countStemMatches(lineSigWords, contentSigWords);
      const lineCoverage = reverseMatchCount / lineSigWords.size;
      if (lineCoverage >= 0.6 && reverseMatchCount >= 2) return true;
    }
  }

  return false;
}

// ── Phase 3: Title matching + section-aware merge ────────────────────

export interface TitleMatchResult {
  filePath: string;
  relativePath: string;
  name: string;
  score: number;
  sections: string[];
}

/**
 * Find the best matching vault file by comparing an incoming topic
 * against existing note/project filenames using signature-word stem matching.
 *
 * Zero API calls -- all local computation.
 * Returns the best match above threshold, or null.
 */
export function findTitleMatch(
  topic: string,
  vaultIndex: VaultIndex,
  threshold = 0.5,
): TitleMatchResult | null {
  if (!topic || topic.length < 2) return null;

  const topicNorm = topic.toLowerCase().trim();
  const topicSigWords = extractSignatureWords(topic);

  // Filter candidates: Notes/ and Projects/ only
  const candidates = vaultIndex.files.filter(f =>
    f.relativePath.startsWith('Notes/') || f.relativePath.startsWith('Projects/'),
  );

  let bestMatch: TitleMatchResult | null = null;
  let bestScore = 0;

  for (const file of candidates) {
    const fileNameNorm = file.name.toLowerCase().trim();

    // Fast path: exact normalized match
    if (topicNorm === fileNameNorm) {
      return {
        filePath: file.path,
        relativePath: file.relativePath,
        name: file.name,
        score: 1.0,
        sections: file.sections,
      };
    }

    // Containment check (one contains the other)
    if (topicNorm.includes(fileNameNorm) || fileNameNorm.includes(topicNorm)) {
      const longer = Math.max(topicNorm.length, fileNameNorm.length);
      const shorter = Math.min(topicNorm.length, fileNameNorm.length);
      const containScore = shorter / longer;
      if (containScore > bestScore && containScore >= threshold) {
        bestScore = containScore;
        bestMatch = {
          filePath: file.path,
          relativePath: file.relativePath,
          name: file.name,
          score: containScore,
          sections: file.sections,
        };
      }
    }

    // Signature-word stem matching (bidirectional)
    const fileSigWords = extractSignatureWords(file.name);
    if (fileSigWords.size < 1 || topicSigWords.size < 1) continue;

    const forwardMatches = countStemMatches(topicSigWords, fileSigWords);
    const forwardCoverage = forwardMatches / topicSigWords.size;

    const reverseMatches = countStemMatches(fileSigWords, topicSigWords);
    const reverseCoverage = reverseMatches / fileSigWords.size;

    const score = Math.max(forwardCoverage, reverseCoverage);

    if (score > bestScore && score >= threshold && forwardMatches >= 1) {
      bestScore = score;
      bestMatch = {
        filePath: file.path,
        relativePath: file.relativePath,
        name: file.name,
        score,
        sections: file.sections,
      };
    }
  }

  return bestMatch;
}

/**
 * Find the most relevant ## section in a file for incoming content.
 * Uses signature-word overlap between content and section headings.
 *
 * Returns the section heading string (without ##) to pass to appendToSection(),
 * or null if no section scores above threshold (append at EOF).
 */
export function findBestSection(
  fileEntry: VaultFileEntry,
  content: string,
): string | null {
  if (fileEntry.sections.length === 0) return null;

  const contentSigWords = extractSignatureWords(content);
  if (contentSigWords.size < 2) return null;

  let bestSection: string | null = null;
  let bestScore = 0;
  const sectionThreshold = 0.3;

  for (const section of fileEntry.sections) {
    const sectionSigWords = extractSignatureWords(section);
    if (sectionSigWords.size === 0) continue;

    // Score: how much of the section's identity does the content cover?
    const forwardMatches = countStemMatches(contentSigWords, sectionSigWords);
    const forwardCoverage = forwardMatches / contentSigWords.size;

    const reverseMatches = countStemMatches(sectionSigWords, contentSigWords);
    const reverseCoverage = sectionSigWords.size > 0 ? reverseMatches / sectionSigWords.size : 0;

    const score = Math.max(forwardCoverage, reverseCoverage);

    if (score > bestScore && score >= sectionThreshold) {
      bestScore = score;
      bestSection = section;
    }
  }

  return bestSection;
}

/**
 * For orphan items (decisions/progress without a project), find an existing
 * note file whose title is topically related to the content.
 *
 * Uses signature-word matching against Note filenames.
 * Higher threshold (0.6) since we're matching free-form content against filenames.
 * Returns the match or null.
 */
export function findNoteMatchForOrphan(
  content: string,
  vaultIndex: VaultIndex,
): TitleMatchResult | null {
  const contentSigWords = extractSignatureWords(content);
  if (contentSigWords.size < 2) return null;

  // Only search Notes/ files
  const noteFiles = vaultIndex.files.filter(f => f.relativePath.startsWith('Notes/'));

  let bestMatch: TitleMatchResult | null = null;
  let bestScore = 0;
  const threshold = 0.6;

  for (const file of noteFiles) {
    const fileSigWords = extractSignatureWords(file.name);
    if (fileSigWords.size < 1) continue;

    // How much of the filename's identity appears in the content?
    const reverseMatches = countStemMatches(fileSigWords, contentSigWords);
    const reverseCoverage = reverseMatches / fileSigWords.size;

    // Also check forward: how much of the content's key terms match the filename?
    const forwardMatches = countStemMatches(contentSigWords, fileSigWords);
    const forwardCoverage = forwardMatches / contentSigWords.size;

    const score = Math.max(forwardCoverage, reverseCoverage);

    if (score > bestScore && score >= threshold && reverseMatches >= 1) {
      bestScore = score;
      bestMatch = {
        filePath: file.path,
        relativePath: file.relativePath,
        name: file.name,
        score,
        sections: file.sections,
      };
    }
  }

  return bestMatch;
}
