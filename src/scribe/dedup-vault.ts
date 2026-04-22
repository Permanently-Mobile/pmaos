/**
 * Scribe -- vault deduplication script.
 *
 * Scans vault files modified in the last N days and removes semantically
 * duplicate entries using stem-aware signature-word matching.
 *
 * Usage:
 *   node dist/scribe/dedup-vault.js [--dry-run|--execute] [--days N] [--threshold 0.6]
 *
 * Dry run is the default. Pass --execute to actually modify files.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Constants ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_ROOT = process.env.VAULT_ROOT || '';
const PROJECT_ROOT_LOCAL = path.resolve(__dirname, '..', '..');
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT_LOCAL, 'scripts', 'vault-commit.sh');

/** Words that carry no distinguishing signal. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'its', 'our',
  'set', 'add', 'get', 'use', 'run', 'build', 'create', 'make', 'put',
  'new', 'own', 'all', 'each', 'any', 'not', 'but', 'was', 'are', 'has',
  'had', 'been', 'have', 'will', 'can', 'may', 'also', 'just', 'more',
  'setup', 'configure', 'implement', 'complete', 'finish', 'start',
  'ensure', 'including', 'using', 'based', 'about', 'than', 'then',
  'processor', 'note', 'log', 'entry',
]);

// ── Types ───────────────────────────────────────────────────────────

interface DedupOptions {
  dryRun: boolean;
  days: number;
  threshold: number;
}

interface EntryInfo {
  text: string;
  lineIndex: number;
  /** For table rows: just the content columns, not the date. */
  contentForComparison: string;
  signatureWords: Set<string>;
  /** Rough measure of detail: word count of the original text. */
  detailScore: number;
}

interface DuplicatePair {
  kept: EntryInfo;
  removed: EntryInfo;
  overlap: number;
}

interface FileReport {
  filePath: string;
  entriesScanned: number;
  duplicatesFound: DuplicatePair[];
  modified: boolean;
}

interface DedupReport {
  filesScanned: number;
  filesModified: number;
  totalEntriesScanned: number;
  totalDupesFound: number;
  totalDupesRemoved: number;
  fileReports: FileReport[];
  dryRun: boolean;
}

// ── Stemming / signature words (reused from vault-scanner.ts) ───────

/**
 * Simple word stem: strip common English suffixes.
 * Not a full Porter stemmer, just enough for plurals and verb forms.
 */
function simpleStem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of [
    'ments', 'ment', 'tion', 'sion', 'ting', 'ing', 'ness',
    'able', 'ible', 'ies', 'ers', 'ous', 'ive', 'ed', 'ly', 'er', 'es', 's',
  ]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Extract signature words from text: lowercase, strip punctuation,
 * remove stop words and short words, return as a Set.
 */
export function extractSignatureWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Count how many words in setA have a stem match in setB.
 */
function countStemMatches(setA: Set<string>, setB: Set<string>): number {
  let matches = 0;
  const stemsB = new Set([...setB].map(simpleStem));

  for (const word of setA) {
    if (setB.has(word)) {
      matches++;
      continue;
    }
    if (stemsB.has(simpleStem(word))) {
      matches++;
    }
  }
  return matches;
}

/**
 * Compute the bidirectional signature-word overlap between two entries.
 * Returns the max of (A coverage of B) and (B coverage of A),
 * so a short entry that's a subset of a longer one still registers as a dupe.
 */
function computeOverlap(a: EntryInfo, b: EntryInfo): number {
  if (a.signatureWords.size === 0 || b.signatureWords.size === 0) return 0;

  const aMatchesB = countStemMatches(a.signatureWords, b.signatureWords);
  const bMatchesA = countStemMatches(b.signatureWords, a.signatureWords);

  const coverageAtoB = aMatchesB / a.signatureWords.size;
  const coverageBtoA = bMatchesA / b.signatureWords.size;

  return Math.max(coverageAtoB, coverageBtoA);
}

// ── Entry extraction ────────────────────────────────────────────────

/** Patterns that identify different entry types in vault files. */
const TASK_PATTERN = /^- \[[ x]\]\s+(.+)$/i;
const BULLET_PATTERN = /^- (.+)$/;
const TABLE_ROW_PATTERN = /^\|(.+)\|$/;
const TABLE_SEPARATOR = /^\|[\s-:|]+\|$/;

type SectionType = 'progress_log' | 'decision_log' | 'tasks' | 'general';

function detectSectionType(heading: string): SectionType {
  const lower = heading.toLowerCase();
  if (lower.includes('progress log')) return 'progress_log';
  if (lower.includes('decision log')) return 'decision_log';
  if (lower.includes('task') || lower.includes('backlog') || lower.includes('active --')) return 'tasks';
  return 'general';
}

/**
 * Extract content for comparison from a table row.
 * For Progress/Decision log rows (| Date | Content | Source |),
 * we compare by the content column(s) only, not the date.
 */
function tableRowContent(row: string): string {
  const cells = row.split('|').map(c => c.trim()).filter(Boolean);
  if (cells.length < 2) return row;

  // Skip first column if it looks like a date (YYYY-MM-DD)
  const first = cells[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
    // Return everything except date and last column (usually source marker)
    return cells.slice(1, cells.length > 2 ? -1 : undefined).join(' ');
  }
  return cells.join(' ');
}

/**
 * Parse a single vault file into sections, then extract entries from each.
 */
function extractEntries(lines: string[]): EntryInfo[] {
  const entries: EntryInfo[] = [];
  let currentSection: SectionType = 'general';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track section context
    if (trimmed.startsWith('## ')) {
      currentSection = detectSectionType(trimmed);
      continue;
    }

    // Skip YAML frontmatter
    if (trimmed === '---') continue;
    // Skip empty lines, headings, table separators
    if (trimmed === '' || trimmed.startsWith('#') || TABLE_SEPARATOR.test(trimmed)) continue;
    // Skip table headers (first row right after a heading or separator)
    if (TABLE_ROW_PATTERN.test(trimmed) && i > 0 && TABLE_SEPARATOR.test(lines[i - 1]?.trim() || '')) continue;

    let contentForComparison = '';
    let text = trimmed;

    // Table rows in log sections
    if (TABLE_ROW_PATTERN.test(trimmed) && (currentSection === 'progress_log' || currentSection === 'decision_log')) {
      contentForComparison = tableRowContent(trimmed);
      text = trimmed;
    }
    // Task items
    else if (TASK_PATTERN.test(trimmed)) {
      const match = trimmed.match(TASK_PATTERN);
      contentForComparison = match ? match[1] : trimmed;
      text = trimmed;
    }
    // Bullet points
    else if (BULLET_PATTERN.test(trimmed)) {
      const match = trimmed.match(BULLET_PATTERN);
      contentForComparison = match ? match[1] : trimmed;
      text = trimmed;
    }
    // General table rows
    else if (TABLE_ROW_PATTERN.test(trimmed)) {
      contentForComparison = tableRowContent(trimmed);
      text = trimmed;
    }
    // Skip anything else (prose paragraphs, YAML fields, etc.)
    else {
      continue;
    }

    const sigWords = extractSignatureWords(contentForComparison || text);
    // Need at least 2 signature words to meaningfully compare
    if (sigWords.size < 2) continue;

    entries.push({
      text,
      lineIndex: i,
      contentForComparison: contentForComparison || text,
      signatureWords: sigWords,
      detailScore: text.split(/\s+/).length,
    });
  }

  return entries;
}

// ── Dedup logic ─────────────────────────────────────────────────────

/**
 * Find duplicate pairs among a list of entries.
 * For each pair above the threshold, marks the less detailed one for removal.
 */
function findDuplicates(entries: EntryInfo[], threshold: number): DuplicatePair[] {
  const duplicates: DuplicatePair[] = [];
  const removedIndices = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (removedIndices.has(i)) continue;

    for (let j = i + 1; j < entries.length; j++) {
      if (removedIndices.has(j)) continue;

      const overlap = computeOverlap(entries[i], entries[j]);
      if (overlap >= threshold) {
        // Keep the more detailed entry (higher word count).
        // On tie, keep the earlier one (lower line index).
        const keepI = entries[i].detailScore >= entries[j].detailScore;
        const kept = keepI ? entries[i] : entries[j];
        const removed = keepI ? entries[j] : entries[i];
        const removedIdx = keepI ? j : i;

        removedIndices.add(removedIdx);
        duplicates.push({ kept, removed, overlap });

        // If we removed entry i, stop comparing it
        if (!keepI) break;
      }
    }
  }

  return duplicates;
}

// ── File scanning ───────────────────────────────────────────────────

/**
 * Collect all .md files modified in the last N days under VAULT_ROOT.
 * Skips Templates/ and .obsidian/ directories.
 */
function getRecentFiles(days: number): string[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results: string[] = [];

  function walk(dir: string): void {
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
        walk(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.md')) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoff) {
          results.push(fullPath);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  walk(VAULT_ROOT);
  return results;
}

// ── Core dedup pipeline ─────────────────────────────────────────────

/**
 * Process a single file: extract entries, find dupes, optionally remove them.
 */
function processFile(filePath: string, options: DedupOptions): FileReport {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const entries = extractEntries(lines);
  const duplicates = findDuplicates(entries, options.threshold);

  const report: FileReport = {
    filePath,
    entriesScanned: entries.length,
    duplicatesFound: duplicates,
    modified: false,
  };

  if (duplicates.length === 0 || options.dryRun) {
    return report;
  }

  // Remove duplicate lines (work from bottom up to preserve indices)
  const linesToRemove = new Set(duplicates.map(d => d.removed.lineIndex));
  const newLines = lines.filter((_, idx) => !linesToRemove.has(idx));

  // Clean up any resulting double-blank-lines
  const cleaned: string[] = [];
  for (const line of newLines) {
    if (line.trim() === '' && cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
      continue;
    }
    cleaned.push(line);
  }

  fs.writeFileSync(filePath, cleaned.join('\n'), 'utf-8');
  report.modified = true;

  return report;
}

/**
 * Run the full dedup pipeline across recently modified vault files.
 */
export function runDedup(options: DedupOptions): DedupReport {
  const files = getRecentFiles(options.days);

  const report: DedupReport = {
    filesScanned: files.length,
    filesModified: 0,
    totalEntriesScanned: 0,
    totalDupesFound: 0,
    totalDupesRemoved: 0,
    fileReports: [],
    dryRun: options.dryRun,
  };

  for (const filePath of files) {
    const fileReport = processFile(filePath, options);
    report.fileReports.push(fileReport);
    report.totalEntriesScanned += fileReport.entriesScanned;
    report.totalDupesFound += fileReport.duplicatesFound.length;

    if (fileReport.modified) {
      report.filesModified++;
      report.totalDupesRemoved += fileReport.duplicatesFound.length;
    }
  }

  // Single vault commit for all changes
  if (report.filesModified > 0 && !options.dryRun) {
    try {
      execSync(`bash "${VAULT_COMMIT_SCRIPT}" "scribe dedup cleanup: ${report.totalDupesRemoved} entries removed"`, {
        timeout: 15000,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Non-fatal
    }
  }

  return report;
}

// ── Report formatting ───────────────────────────────────────────────

function formatReport(report: DedupReport): string {
  const lines: string[] = [];
  const mode = report.dryRun ? 'DRY RUN' : 'EXECUTE';

  lines.push(`\n=== Scribe Vault Dedup [${mode}] ===\n`);
  lines.push(`Files scanned:    ${report.filesScanned}`);
  lines.push(`Entries scanned:  ${report.totalEntriesScanned}`);
  lines.push(`Duplicates found: ${report.totalDupesFound}`);

  if (!report.dryRun) {
    lines.push(`Duplicates removed: ${report.totalDupesRemoved}`);
    lines.push(`Files modified:     ${report.filesModified}`);
  }

  // Per-file details (only files with dupes)
  const filesWithDupes = report.fileReports.filter(f => f.duplicatesFound.length > 0);

  if (filesWithDupes.length > 0) {
    lines.push('\n--- Duplicate Details ---\n');

    for (const fr of filesWithDupes) {
      const relPath = path.relative(VAULT_ROOT, fr.filePath);
      lines.push(`File: ${relPath} (${fr.entriesScanned} entries, ${fr.duplicatesFound.length} dupes)`);

      for (const dup of fr.duplicatesFound) {
        lines.push(`  REMOVED (line ${dup.removed.lineIndex + 1}, overlap ${(dup.overlap * 100).toFixed(0)}%):`);
        lines.push(`    ${truncate(dup.removed.text, 120)}`);
        lines.push(`  KEPT    (line ${dup.kept.lineIndex + 1}):`);
        lines.push(`    ${truncate(dup.kept.text, 120)}`);
        lines.push('');
      }
    }
  } else {
    lines.push('\nNo duplicates found. Vault is clean.');
  }

  lines.push('=== Done ===\n');
  return lines.join('\n');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

// ── CLI entry point ─────────────────────────────────────────────────

function parseArgs(argv: string[]): DedupOptions {
  const options: DedupOptions = {
    dryRun: true,
    days: 1,
    threshold: 0.6,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--execute':
        options.dryRun = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--days': {
        const val = parseInt(argv[++i], 10);
        if (!isNaN(val) && val > 0) options.days = val;
        break;
      }
      case '--threshold': {
        const val = parseFloat(argv[++i]);
        if (!isNaN(val) && val > 0 && val <= 1) options.threshold = val;
        break;
      }
    }
  }

  return options;
}

// Only run CLI when executed directly (not imported)
const isMainModule = process.argv[1]?.replace(/\\/g, '/').endsWith('scribe/dedup-vault.js');

if (isMainModule) {
  const options = parseArgs(process.argv.slice(2));

  console.log(`Scribe Vault Dedup`);
  console.log(`  Mode:      ${options.dryRun ? 'DRY RUN (use --execute to apply)' : 'EXECUTE'}`);
  console.log(`  Days:      ${options.days}`);
  console.log(`  Threshold: ${options.threshold}`);
  console.log('');

  const report = runDedup(options);
  console.log(formatReport(report));

  // Exit with code 0 = clean, 1 = dupes found (useful for CI/scripting)
  process.exit(report.totalDupesFound > 0 && options.dryRun ? 1 : 0);
}
