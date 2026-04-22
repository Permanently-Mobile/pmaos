/**
 * Vault Feedback Loop
 *
 * Automatically updates the Obsidian vault when agents complete work.
 * Hooks into the inbox intake flow (called after bridge results are processed).
 *
 * What it does:
 *   - Research agent results -> saves summary as markdown to Research Results/
 *   - Code agent results -> saves build summary to matching project folder (or Research Results/)
 *   - All agent completions -> appends entry to Daily Notes log
 *   - All agent completions -> auto-marks matching tasks done in Tasks.md
 *   - All agent completions -> appends progress log entry to matching project file
 *   - Audit agent results -> already handled by the audit agent (no-op here)
 *   - Processor results -> already handled by processor agent (no-op here)
 *
 * Fire-and-forget: never blocks inbox delivery, logs errors internally.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { ResultPayload } from './bridge.js';
import { logger } from './logger.js';

// ── Config ────────────────────────────────────────────────────────────

const VAULT_ROOT = process.env.VAULT_ROOT || '';
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..');
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');

// Agents that already handle their own vault writes (skip to avoid duplicates)
const SELF_WRITING_AGENTS = new Set(['processor-1', 'auditor']);

const TASKS_PATH = path.join(VAULT_ROOT, 'Tasks.md');
const PROJECTS_DIR = path.join(VAULT_ROOT, 'Projects');

// Code agent variants
const CODE_AGENTS = new Set(['coder-1', 'coder-2', 'coder-3']);

// Words to strip when comparing prompts to tasks/projects (noise reduction)
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'be', 'as',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'shall', 'can', 'need', 'must', 'up', 'out', 'if', 'not', 'no',
  'so', 'too', 'very', 'just', 'about', 'into', 'over', 'after',
]);

// ── Daily Note Helpers ────────────────────────────────────────────────

function todayDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDailyNotePath(): string {
  return path.join(VAULT_ROOT, 'Daily Notes', `${todayDateStr()}.md`);
}

function timeStamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Determine which work session we're in.
 * S1: 00:00-08:00, S2: 08:00-16:00, S3: 16:00-24:00
 */
function currentSession(): string {
  const h = new Date().getHours();
  if (h < 8) return 'S1';
  if (h < 16) return 'S2';
  return 'S3';
}

// ── Vault Write Helpers ───────────────────────────────────────────────

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendToFile(filePath: string, content: string): void {
  ensureDir(filePath);
  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function vaultCommit(msg: string): void {
  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "${msg}"`, {
      cwd: VAULT_ROOT,
      stdio: 'pipe',
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    // Non-fatal -- vault commit can fail if nothing changed
  }
}

// ── Fuzzy Matching Helpers ────────────────────────────────────────────

/**
 * Extract meaningful keywords from a string, lowercased, stop words removed.
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Calculate keyword overlap ratio between two strings.
 * Returns 0-1 representing the fraction of taskKeywords found in sourceKeywords.
 */
function keywordOverlap(sourceText: string, taskText: string): number {
  const sourceKw = extractKeywords(sourceText);
  const taskKw = extractKeywords(taskText);
  if (taskKw.size === 0) return 0;
  let matches = 0;
  for (const word of taskKw) {
    if (sourceKw.has(word)) matches++;
  }
  return matches / taskKw.size;
}

/**
 * Check if source text contains the task description as a near-exact substring.
 * Normalizes both to lowercase alphanumeric for comparison.
 */
function substringMatch(sourceText: string, taskText: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const src = normalize(sourceText);
  const task = normalize(taskText);
  // Require at least 15 chars to avoid trivial matches
  return task.length >= 15 && src.includes(task);
}

/**
 * Find the best-matching project folder for a given prompt/title.
 * Returns the folder name or null if no good match.
 */
function findMatchingProject(prompt: string, title: string): string | null {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return null;
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const combined = `${prompt} ${title}`.toLowerCase();

    // First pass: exact project name as substring in prompt/title
    for (const folder of folders) {
      if (combined.includes(folder.toLowerCase())) {
        return folder;
      }
    }

    // Second pass: keyword overlap (need >60% of project name words in prompt)
    let bestFolder: string | null = null;
    let bestScore = 0;
    for (const folder of folders) {
      const score = keywordOverlap(combined, folder);
      if (score > bestScore && score >= 0.6) {
        bestScore = score;
        bestFolder = folder;
      }
    }
    return bestFolder;
  } catch {
    return null;
  }
}

// ── Task Auto-Completion ─────────────────────────────────────────────

/**
 * Auto-mark matching open tasks as done in Tasks.md.
 * Uses fuzzy matching between agent prompt/title and task descriptions.
 * Only marks with high confidence (>80% keyword overlap or substring match).
 * NEVER removes tasks -- only checks them off.
 */
function autoMarkTasksDone(prompt: string, title: string, agent: string): void {
  try {
    if (!fs.existsSync(TASKS_PATH)) return;

    const content = fs.readFileSync(TASKS_PATH, 'utf-8');
    const lines = content.split('\n');
    const combined = `${prompt} ${title}`;
    const markedTasks: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Only match unchecked tasks
      const match = line.match(/^(\s*- \[ \] )(.+)$/);
      if (!match) continue;

      const taskDesc = match[2];

      // Check substring match (task description found in prompt/title, or vice versa)
      const isSubstring = substringMatch(combined, taskDesc) || substringMatch(taskDesc, combined);

      // Check keyword overlap
      const overlap = keywordOverlap(combined, taskDesc);

      if (isSubstring || overlap >= 0.8) {
        lines[i] = line.replace('- [ ] ', '- [x] ');
        markedTasks.push(taskDesc.slice(0, 80));
      }
    }

    if (markedTasks.length > 0) {
      fs.writeFileSync(TASKS_PATH, lines.join('\n'), 'utf-8');
      logger.info(
        { agent, count: markedTasks.length, tasks: markedTasks },
        'Vault feedback: auto-marked tasks done in Tasks.md',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Vault feedback: autoMarkTasksDone failed (non-fatal)');
  }
}

// ── Project Progress Log ─────────────────────────────────────────────

/**
 * Append an entry to a project's Progress Log table.
 * Detects the existing table format and appends a matching row.
 */
function appendProjectProgressLog(
  projectFolder: string,
  action: string,
  result: string,
  agent: string,
): void {
  try {
    const mainFile = path.join(PROJECTS_DIR, projectFolder, `${projectFolder}.md`);
    if (!fs.existsSync(mainFile)) return;

    const content = fs.readFileSync(mainFile, 'utf-8');
    const progressIdx = content.indexOf('## Progress Log');
    if (progressIdx === -1) return;

    // Find the end of the progress log table (next ## section or EOF)
    const afterProgress = content.indexOf('\n## ', progressIdx + 15);
    const tableEnd = afterProgress === -1 ? content.length : afterProgress;

    // Find the last row of the table (last line with a | before the next section)
    const tableSection = content.slice(progressIdx, tableEnd);
    const tableLines = tableSection.split('\n');
    let lastPipeIdx = -1;
    for (let i = tableLines.length - 1; i >= 0; i--) {
      if (tableLines[i].trim().startsWith('|') && tableLines[i].includes('|')) {
        lastPipeIdx = i;
        break;
      }
    }

    if (lastPipeIdx === -1) return; // No table rows found

    // Build the new row matching the standard format: | Date | Action | Result |
    const cleanAction = `${agent.charAt(0).toUpperCase() + agent.slice(1)}: ${action.slice(0, 120)}`;
    const cleanResult = result.slice(0, 150);
    const newRow = `| ${todayDateStr()} | ${cleanAction} | ${cleanResult} |`;

    // Insert after the last table row
    tableLines.splice(lastPipeIdx + 1, 0, newRow);
    const updatedTable = tableLines.join('\n');
    const updated = content.slice(0, progressIdx) + updatedTable + content.slice(tableEnd);

    fs.writeFileSync(mainFile, updated, 'utf-8');
    logger.info(
      { project: projectFolder, agent },
      'Vault feedback: appended progress log entry',
    );
  } catch (err) {
    logger.warn({ err, project: projectFolder }, 'Vault feedback: appendProjectProgressLog failed (non-fatal)');
  }
}

// ── Code Agent Build Result Routing ──────────────────────────────────

/**
 * Save code agent build results to the matching project folder, or Research Results/ as fallback.
 */
function handleCodeAgentResult(prompt: string, title: string, payload: ResultPayload): void {
  try {
    // Derive a clean title slug for the filename
    const slug = (title || prompt)
      .slice(0, 60)
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const filename = `Build - ${slug || 'Result'}.md`;

    // Try to match to a project folder
    const projectFolder = findMatchingProject(prompt, title);

    let destPath: string;
    if (projectFolder) {
      destPath = path.join(PROJECTS_DIR, projectFolder, filename);
    } else {
      destPath = path.join(VAULT_ROOT, 'Research Results', filename);
    }

    // Skip if already exists
    if (fs.existsSync(destPath)) {
      logger.debug({ destPath }, 'Vault feedback: Build result file already exists, skipping');
      return;
    }

    const content = `---
type: build-result
agent: coder
created: ${todayDateStr()}
status: review
tags: [build-result, auto-saved]
---

# ${slug || 'Build Result'}

${payload.summary}

---
*Auto-saved by vault feedback loop on ${todayDateStr()} at ${timeStamp()}*
`;

    ensureDir(destPath);
    fs.writeFileSync(destPath, content, 'utf-8');
    logger.info(
      { destPath, project: projectFolder || 'none' },
      'Vault feedback: Code agent result saved',
    );
  } catch (err) {
    logger.warn({ err }, 'Vault feedback: handleCodeAgentResult failed (non-fatal)');
  }
}

// ── Feedback Handlers ─────────────────────────────────────────────────

/**
 * Extract a clean, descriptive title from research content.
 * Priority: first # heading in content > first bold text > first sentence > prompt slug
 */
function extractResearchTitle(summary: string, prompt: string): string {
  // 1. Try to extract first # heading (H1 or H2) from the summary
  const headingMatch = summary.match(/^#{1,2}\s+(.+)$/m);
  if (headingMatch) {
    const heading = headingMatch[1].trim();
    if (heading.length >= 8 && heading.length <= 120) return heading;
  }

  // 2. Try bold text at the START of a line (**Title**)
  const boldLineMatch = summary.match(/^\*\*(.{8,80}?)\*\*/m);
  if (boldLineMatch) {
    const bold = boldLineMatch[1].trim();
    // Skip generic/conversational bold phrases
    if (!/^(video|report|summary|result|note|done|task|here|the|quick|a |this)/i.test(bold)) return bold;
  }

  // 3. Try "Report:", "Deep Dive:", "Analysis:" label patterns
  const labelMatch = summary.match(/(?:Report|Deep Dive|Analysis|Research|Overview):\s*(.{8,120})/i);
  if (labelMatch) {
    const label = labelMatch[1].trim().split('\n')[0];
    if (label.length >= 8) return label.slice(0, 120);
  }

  // 4. Try first meaningful line of the summary (skip empty lines, timestamps, metadata)
  const lines = summary.split('\n').filter(l => {
    const t = l.trim();
    return t.length > 20
      && !t.startsWith('---')
      && !t.startsWith('*Auto-saved')
      && !t.startsWith('#')
      && !/^(done|report saved|here|quick rundown|the video|about|so )/i.test(t);
  });
  if (lines.length > 0) {
    const first = lines[0].replace(/^[*_>\-\s]+/, '').trim();
    if (first.length >= 20 && first.length <= 120) return first;
  }

  // 5. Fall back to cleaned prompt
  const cleaned = prompt
    .replace(/^(DEEP DIVE:|RESEARCH:|PRIORITY[^:]*:|deep dive|deepdive|research|look into|investigate)\s*/i, '')
    .trim();
  return cleaned.slice(0, 100) || 'Research Report';
}

/**
 * Sanitize a title string into a safe filename.
 * Keeps readability: allows letters, numbers, spaces, hyphens, apostrophes.
 */
function titleToFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, '')   // Remove filesystem-illegal chars
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .trim()
    .slice(0, 80);                  // Cap at 80 chars (enough for readability)
}

/**
 * Get the full research content -- prefer the report file over truncated summary.
 */
function getFullResearchContent(payload: ResultPayload): string {
  if (payload.report_path) {
    try {
      if (fs.existsSync(payload.report_path)) {
        return fs.readFileSync(payload.report_path, 'utf-8');
      }
    } catch {
      // Fall through to summary
    }
  }
  return payload.summary || '';
}

/**
 * Save research agent results to the vault.
 * Extracts a real title from the content, uses full report when available,
 * routes to project folders when a match exists.
 */
function handleResearchResult(prompt: string, payload: ResultPayload): void {
  const fullContent = getFullResearchContent(payload);
  if (!fullContent || fullContent.trim().length < 50) {
    logger.debug('Vault feedback: Research result too short or empty, skipping vault save');
    return;
  }

  // Skip non-results: agent saying "I can't do this", "no video", dispatch confirmations, etc.
  const lowerContent = fullContent.toLowerCase().slice(0, 300);
  const NON_RESULT_PATTERNS = [
    'no video in this session',
    'no completed research results',
    'drop the video file',
    'drop the url here',
    "i don't have it",
    "i don't have that",
    'nothing carried over from earlier',
    'fresh context',
    'research dispatched',
    'research queued',
    'queued the full research',
    'results will hit telegram',
    'dispatched to research',
  ];
  if (NON_RESULT_PATTERNS.some(p => lowerContent.includes(p))) {
    logger.debug('Vault feedback: Research result is a non-result (dispatch ack or failure), skipping');
    return;
  }

  // FIX 1: Stub detection -- skip brief summaries when the full report is already filed elsewhere.
  // The bot sends a conversational summary to Telegram; vault-feedback should NOT file these as separate documents.
  const STUB_PATTERNS = [
    'full report saved to',
    'report saved to',
    'report is written and committed',
    'report at research results/',
    'saved to research results/',
  ];
  if (STUB_PATTERNS.some(p => lowerContent.includes(p))) {
    logger.debug('Vault feedback: Skipping stub message (full report already filed elsewhere)');
    return;
  }

  // Extract a meaningful title from the content
  const title = extractResearchTitle(fullContent, prompt);
  const filename = titleToFilename(title);

  // Check if this belongs to an active project
  const projectFolder = findMatchingProject(prompt, title);
  let destDir: string;
  if (projectFolder) {
    destDir = path.join(PROJECTS_DIR, projectFolder);
  } else {
    destDir = path.join(VAULT_ROOT, 'Research Results');
  }

  const destPath = path.join(destDir, `${filename}.md`);

  // Only create if it doesn't already exist
  if (fs.existsSync(destPath)) {
    logger.debug({ destPath }, 'Vault feedback: Research result file already exists, skipping');
    return;
  }

  // Build tags from content context
  const tags = ['research', 'auto-filed'];
  if (projectFolder) tags.push(projectFolder.toLowerCase().replace(/\s+/g, '-'));

  const fileContent = `---
type: research
tags: [${tags.join(', ')}]
created: ${todayDateStr()}
status: review
source: researcher
${projectFolder ? `project: ${projectFolder}\n` : ''}---

# ${title}

${fullContent}

---
*Auto-filed by vault feedback on ${todayDateStr()} at ${timeStamp()}*
`;

  ensureDir(destPath);
  fs.writeFileSync(destPath, fileContent, 'utf-8');
  logger.info(
    { destPath, title, project: projectFolder || 'none' },
    'Vault feedback: Research result filed to vault',
  );
}

/**
 * Append an entry to today's daily note log.
 */
function logToDailyNote(agent: string, title: string, status: string): void {
  const dailyPath = getDailyNotePath();
  const entry = `\n- [${timeStamp()}] ${currentSession()}: ${agent} -- ${title} (${status})`;

  if (!fs.existsSync(dailyPath)) {
    // Don't create a daily note just for a log entry -- it'll be created by /today
    return;
  }

  // Find the Log section and append there
  const content = fs.readFileSync(dailyPath, 'utf-8');
  const logIdx = content.indexOf('## Log');
  if (logIdx === -1) {
    // No Log section -- append to end
    appendToFile(dailyPath, entry);
  } else {
    // Find the next section after Log (## Something)
    const afterLog = content.indexOf('\n## ', logIdx + 6);
    if (afterLog === -1) {
      // Log is the last section -- append to end
      appendToFile(dailyPath, entry);
    } else {
      // Insert before the next section
      const updated = content.slice(0, afterLog) + entry + content.slice(afterLog);
      fs.writeFileSync(dailyPath, updated, 'utf-8');
    }
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────

export interface VaultFeedbackInput {
  agent: string;
  prompt: string;
  payload: ResultPayload;
  msgType: string;  // 'result' or 'error'
  title: string;
}

/**
 * Process an agent completion and update the vault accordingly.
 * Called from inbox.ts after intaking a bridge result.
 * Fire-and-forget: never throws.
 */
export function processVaultFeedback(input: VaultFeedbackInput): void {
  try {
    const { agent, prompt, payload, msgType, title } = input;

    // Skip agents that handle their own vault writes
    if (SELF_WRITING_AGENTS.has(agent)) return;

    const status = msgType === 'error' ? 'failed' : (payload.status || 'success');

    // 1. Log all completions to daily note
    logToDailyNote(
      agent.charAt(0).toUpperCase() + agent.slice(1),
      title,
      status,
    );

    // 2. Agent-specific vault updates
    if (agent === 'researcher-1' || agent === 'researcher-2') {
      if (msgType !== 'error' && payload.summary) {
        handleResearchResult(prompt, payload);
      }
    }

    if (CODE_AGENTS.has(agent)) {
      if (msgType !== 'error' && payload.summary) {
        handleCodeAgentResult(prompt, title, payload);
      }
    }

    // 3. Auto-mark matching tasks done (only on success)
    if (status !== 'failed') {
      autoMarkTasksDone(prompt, title, agent);
    }

    // 4. Auto-update project progress log (only on success)
    if (status !== 'failed') {
      const projectFolder = findMatchingProject(prompt, title);
      if (projectFolder) {
        const actionSummary = title || prompt.slice(0, 100);
        const resultSummary = status === 'success'
          ? (payload.summary || '').split('\n')[0].slice(0, 150) || 'Completed'
          : `Partial: ${(payload.summary || '').split('\n')[0].slice(0, 120) || 'See result'}`;
        appendProjectProgressLog(projectFolder, actionSummary, resultSummary, agent);
      }
    }

    // 5. Vault commit (batched -- only if we actually wrote something)
    vaultCommit(`auto: ${agent} ${status} - ${title.slice(0, 60)}`);

    logger.debug({ agent, status }, 'Vault feedback processed');
  } catch (err) {
    logger.warn({ err }, 'Vault feedback failed (non-fatal)');
  }
}
