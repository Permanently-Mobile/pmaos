/**
 * Scribe -- vault routing engine.
 *
 * Maps classified items to vault file paths and performs writes.
 * Handles deduplication at four layers:
 *   1. Content hash (scribe DB) -- exact match, instant
 *   2. Stem similarity (fast path) -- word/suffix matching
 *   3. Semantic similarity (Venice embeddings) -- for ambiguous stem range
 *   4. Watermark (cross-run protection)
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../logger.js';
import {
  computeContentHash,
  hasContentHash,
  saveContentHash,
  logDedupDecision,
  logDedupPass,
} from './db.js';
import { isSemanticallyDuplicate, findBestVaultMatch, findDuplicateInList } from './semantic-dedup.js';
import type { ClassifiedItem, RouteResult, VaultIndex } from './types.js';
import {
  VAULT_ROOT,
  ensureDailyNote,
  sanitizeFilename,
  appendToSection,
  appendToTableInSection,
  stemSimilarityScoreCached,
  getContentLines,
  getVaultIndex,
  getProjectIndex,
  findTitleMatch,
  findBestSection,
  findNoteMatchForOrphan,
} from './vault-scanner.js';

// ── Constants ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT_LOCAL = path.resolve(__dirname, '..', '..');
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT_LOCAL, 'scripts', 'vault-commit.sh');

/** Stem score at or above this = definite dupe. Skip embedding call. */
const STEM_DEFINITE_THRESHOLD = 0.9;

/** Stem score below this = definitely NOT a dupe. Skip embedding call. */
const STEM_CLEAR_THRESHOLD = 0.4;

// ── Tiered dedup ────────────────────────────────────────────────────

interface TieredDedupResult {
  isDuplicate: boolean;
  method?: 'stem' | 'semantic';
  similarity?: number;
  matchedTo?: string;
}

/**
 * Two-tier dedup: fast stem matching first, semantic embedding fallback.
 *
 * Score >= 0.9 -> definite dupe (stem), skip Venice
 * Score < 0.4  -> not a dupe, skip Venice
 * Score 0.4-0.9 -> ambiguous, call Venice embeddings for semantic check
 *
 * If Venice is unreachable, falls back to old-school 0.6 stem threshold.
 */
async function checkDedupTiered(
  filePath: string,
  content: string,
  category?: string,
): Promise<TieredDedupResult> {
  // Fast path: stem similarity score
  const stemResult = stemSimilarityScoreCached(filePath, content);

  if (stemResult.score >= STEM_DEFINITE_THRESHOLD) {
    logDedupDecision(content, stemResult.bestMatch, stemResult.score, 'stem');
    logger.debug(
      { score: stemResult.score.toFixed(3), method: 'stem', content: content.slice(0, 50) },
      'Dedup: definite stem match',
    );
    return {
      isDuplicate: true,
      method: 'stem',
      similarity: stemResult.score,
      matchedTo: stemResult.bestMatch,
    };
  }

  if (stemResult.score < STEM_CLEAR_THRESHOLD) {
    return { isDuplicate: false };
  }

  // Ambiguous range [0.4, 0.9) -- invoke semantic dedup
  // FIX 5: Use tighter threshold for progress/decision (short sentences, high dupe rate)
  try {
    const lines = getContentLines(filePath);
    const semanticThreshold = (category === 'progress' || category === 'decision') ? 0.70 : undefined;
    const semanticResult = await isSemanticallyDuplicate(content, lines, semanticThreshold);

    if (semanticResult.isDupe) {
      logDedupDecision(content, semanticResult.bestMatch, semanticResult.similarity, 'semantic');
      logger.debug(
        { score: semanticResult.similarity.toFixed(3), method: 'semantic', content: content.slice(0, 50) },
        'Dedup: semantic match in ambiguous range',
      );
      return {
        isDuplicate: true,
        method: 'semantic',
        similarity: semanticResult.similarity,
        matchedTo: semanticResult.bestMatch,
      };
    }

    return { isDuplicate: false };
  } catch (err) {
    // Venice failure -- fall back to old-school stem threshold (0.6)
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), stemScore: stemResult.score },
      'Semantic dedup failed, falling back to stem threshold',
    );

    if (stemResult.score > 0.6) {
      logDedupDecision(content, stemResult.bestMatch, stemResult.score, 'stem');
      return {
        isDuplicate: true,
        method: 'stem',
        similarity: stemResult.score,
        matchedTo: stemResult.bestMatch,
      };
    }

    return { isDuplicate: false };
  }
}

// ── Main router ─────────────────────────────────────────────────────

/**
 * Route a single classified item to the correct vault location.
 */
export async function routeToVault(item: ClassifiedItem): Promise<RouteResult> {
  // Layer 1: Content hash dedup
  const hash = computeContentHash(item.content);
  if (hasContentHash(hash)) {
    return { written: false, path: '', deduplicated: true };
  }

  let result: RouteResult;

  try {
    switch (item.category) {
      case 'task':
        result = await routeTask(item);
        break;
      case 'decision':
        result = await routeDecision(item);
        break;
      case 'progress':
        result = await routeProgress(item);
        break;
      case 'research':
        result = await routeResearch(item);
        break;
      case 'note':
        result = await routeNote(item);
        break;
      case 'daily_log':
        result = await routeDailyLog(item);
        break;
      case 'personal':
        result = await routePersonal(item);
        break;
      case 'financial':
        result = await routeFinancial(item);
        break;
      default:
        result = { written: false, path: '', deduplicated: false, error: `Unknown category: ${item.category}` };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    result = { written: false, path: '', deduplicated: false, error: errMsg };
  }

  // Register hash if written
  if (result.written) {
    saveContentHash(hash, result.path, item.category);
  }

  return result;
}

/**
 * Route all items and commit vault once at the end.
 */
export async function routeAllToVault(items: ClassifiedItem[], dryRun = false): Promise<RouteResult[]> {
  const results: RouteResult[] = [];
  let writtenCount = 0;

  for (const item of items) {
    if (dryRun) {
      // In dry run, just check content hash dedup (no Venice calls)
      const hash = computeContentHash(item.content);
      const isDup = hasContentHash(hash);
      results.push({
        written: false,
        path: getDryRunPath(item),
        deduplicated: isDup,
      });
      continue;
    }

    const result = await routeToVault(item);
    results.push(result);
    if (result.written) writtenCount++;
  }

  // Single vault commit for the whole batch
  if (writtenCount > 0 && !dryRun) {
    commitVault(`scribe: ${writtenCount} items extracted`);
  }

  return results;
}

// ── Bracket prefix normalization (FIX 4) ────────────────────────────

/** Standard bracket prefixes for vault entries. */
const STANDARD_PREFIXES = new Set(['Decision', 'Progress', 'Task', 'Financial']);

/**
 * Strip any existing bracket prefix from content.
 * Matches patterns like [Decision], [Memory Retention], [Payment Provider Selection], etc.
 */
function stripBracketPrefix(content: string): string {
  return content.replace(/^\[[\w\s]+\]\s*/, '');
}

/**
 * Normalize bracket prefixes on content.
 * Strips non-standard prefixes (like [Memory Retention]) and keeps standard ones.
 * For daily_log/personal categories with non-standard prefixes, strips them entirely.
 */
function normalizeBracketPrefix(content: string, category: string): string {
  const bracketMatch = content.match(/^\[([\w\s]+)\]\s*/);
  if (!bracketMatch) return content; // no prefix, leave as-is

  const existingPrefix = bracketMatch[1].trim();
  if (STANDARD_PREFIXES.has(existingPrefix)) return content; // already standard

  // Strip the non-standard prefix
  const stripped = content.replace(/^\[[\w\s]+\]\s*/, '');

  // For categories that normally get a prefix, add the standard one
  const prefixMap: Record<string, string> = {
    decision: '[Decision]',
    progress: '[Progress]',
    task: '[Task]',
    financial: '[Financial]',
  };
  const prefix = prefixMap[category] || '';
  return prefix ? `${prefix} ${stripped}` : stripped;
}

// ── Fuzzy project name resolution ────────────────────────────────────

/**
 * Resolve a Venice-provided project name to an actual vault project folder.
 * Venice sometimes returns shortened names ("Apex" instead of "Apex Core Infrastructure",
 * "Creative" when no matching project exists). This fuzzy matcher handles those cases.
 *
 * Strategy:
 *   1. Exact match (already works)
 *   2. Case-insensitive match
 *   3. Substring match (project name appears within a folder name or vice versa)
 *   4. Word-overlap match (60%+ of significant words match)
 *
 * Returns the corrected project name, or null if no match.
 */
function resolveProjectName(veniceProject: string): string | null {
  const projectIndex = getProjectIndex();
  const projectNames = [...projectIndex.keys()];

  if (projectNames.length === 0) return null;

  const query = veniceProject.toLowerCase().trim();

  // 1. Exact match
  if (projectIndex.has(veniceProject)) return veniceProject;

  // 2. Case-insensitive match
  const ciMatch = projectNames.find(d => d.toLowerCase() === query);
  if (ciMatch) return ciMatch;

  // 3. Substring match (either direction)
  const subMatch = projectNames.find(d => {
    const dLower = d.toLowerCase();
    return dLower.includes(query) || query.includes(dLower);
  });
  if (subMatch) return subMatch;

  // 4. Word-overlap match (60%+ of words in common)
  const queryWords = query.split(/[\s\-]+/).filter(w => w.length >= 3);
  if (queryWords.length === 0) return null;

  let bestMatch: string | null = null;
  let bestOverlap = 0;

  for (const dir of projectNames) {
    const dirWords = dir.toLowerCase().split(/[\s\-]+/).filter(w => w.length >= 3);
    if (dirWords.length === 0) continue;

    const overlap = queryWords.filter(w => dirWords.some(dw => dw.includes(w) || w.includes(dw))).length;
    const score = overlap / Math.max(queryWords.length, 1);
    if (score >= 0.6 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = dir;
    }
  }

  if (bestMatch) {
    logger.info(
      { venice: veniceProject, resolved: bestMatch, overlap: bestOverlap },
      'Fuzzy project name resolved',
    );
  }

  return bestMatch;
}

/**
 * Get the project file path, using fuzzy matching if exact name fails.
 * Returns { path, resolvedName } or null if no match.
 */
function resolveProjectPath(veniceProject: string): { path: string; name: string } | null {
  const projectIndex = getProjectIndex();

  // Try exact first (using index for proper nested path)
  const exactFolder = projectIndex.get(veniceProject);
  if (exactFolder) {
    const exactPath = path.join(exactFolder, `${veniceProject}.md`);
    if (fs.existsSync(exactPath)) return { path: exactPath, name: veniceProject };
  }

  // Fuzzy resolve
  const resolved = resolveProjectName(veniceProject);
  if (!resolved) return null;

  const resolvedFolder = projectIndex.get(resolved);
  if (!resolvedFolder) return null;

  const resolvedPath = path.join(resolvedFolder, `${resolved}.md`);
  if (fs.existsSync(resolvedPath)) return { path: resolvedPath, name: resolved };

  return null;
}

// ── Content-weighted project matching (FIX 2) ───────────────────────

/**
 * Score item content against a project using weighted keywords.
 * Title words (from project folder name) get 3x weight.
 * Objective words (from ## Objective section) get 1x weight.
 * Returns a numeric score (0+). A score of 3 = one title word match.
 */
function scoreContentForProject(
  contentWords: Set<string>,
  projectName: string,
  projectFolderPath: string,
): number {
  let score = 0;

  // Title words: 3x weight
  const titleWords = projectName.toLowerCase()
    .split(/[\s\-]+/)
    .filter(w => w.length >= 3);

  for (const tw of titleWords) {
    if (contentWords.has(tw)) score += 3;
  }

  // Objective words: 1x weight (read from project file)
  const projectFile = path.join(projectFolderPath, `${projectName}.md`);
  if (fs.existsSync(projectFile)) {
    try {
      const fileContent = fs.readFileSync(projectFile, 'utf-8').slice(0, 3000);
      const objMatch = fileContent.match(/##\s*Objective\s*\n([\s\S]*?)(?=\n##)/);
      if (objMatch) {
        const objWords = objMatch[1].toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length >= 3);
        for (const ow of objWords) {
          if (contentWords.has(ow) && !titleWords.includes(ow)) {
            score += 1;
          }
        }
      }
    } catch { /* skip unreadable */ }
  }

  return score;
}

/**
 * FIX 2: Verify Venice's project assignment against item content.
 * Uses weighted keyword scoring: title words get 3x weight over generic matches.
 * If content-based scoring finds a significantly better project match, overrides Venice.
 * Returns the best-matching project name.
 */
function verifyProjectAssignment(veniceProject: string, content: string): string {
  const projectIndex = getProjectIndex();
  if (projectIndex.size === 0) return veniceProject;

  const contentWords = new Set(
    content.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 3),
  );

  let bestMatch = veniceProject;
  let bestScore = 0;

  for (const [name, folderPath] of projectIndex) {
    const score = scoreContentForProject(contentWords, name, folderPath);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = name;
    }
  }

  // Only override if we found a strong match (>= one title word = 3 points)
  // and it differs from Venice's assignment
  if (bestScore >= 3 && bestMatch !== veniceProject) {
    // Also score Venice's project for comparison
    const veniceResolved = resolveProjectName(veniceProject);
    const veniceName = veniceResolved || veniceProject;
    const veniceFolder = projectIndex.get(veniceName);
    const veniceScore = veniceFolder
      ? scoreContentForProject(contentWords, veniceName, veniceFolder)
      : 0;

    if (bestScore > veniceScore) {
      logger.info(
        { venice: veniceProject, override: bestMatch, veniceScore, contentScore: bestScore },
        'Content-weighted scoring overrides Venice project assignment',
      );
      return bestMatch;
    }
  }

  return veniceProject;
}

// ── Per-category routers ────────────────────────────────────────────

async function routeTask(item: ClassifiedItem): Promise<RouteResult> {
  const tasksPath = path.join(VAULT_ROOT, 'Tasks.md');
  if (!fs.existsSync(tasksPath)) {
    return { written: false, path: tasksPath, deduplicated: false, error: 'Tasks.md not found' };
  }

  const taskLine = `- [ ] ${item.content}`;

  // Phase 2: Pre-check against ALL open tasks via semantic embeddings (catches paraphrases)
  try {
    const vaultIndex = getVaultIndex();
    if (vaultIndex && vaultIndex.tasks.length > 0) {
      const taskDedup = await findDuplicateInList(item.content, vaultIndex.tasks, 0.75);
      if (taskDedup.isDupe) {
        logDedupDecision(item.content, taskDedup.bestMatch, taskDedup.similarity, 'task-list');
        logger.debug(
          { similarity: taskDedup.similarity.toFixed(3), matchedTo: taskDedup.bestMatch.slice(0, 60) },
          'Task dedup: semantic match against open task list',
        );
        return { written: false, path: tasksPath, deduplicated: true };
      }
      // Log near-misses for audit
      if (taskDedup.similarity > 0.5) {
        logDedupPass(item.content, taskDedup.bestMatch, taskDedup.similarity, 'task-list');
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Task list semantic pre-check failed (non-fatal)');
  }

  // Layer 2+3: tiered dedup (stem fast-path + semantic fallback against Tasks.md file)
  const dedup = await checkDedupTiered(tasksPath, item.content, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: tasksPath, deduplicated: true };
  }

  // Find the right section (with fuzzy project name resolution + content weighting)
  if (item.project) {
    const verified = verifyProjectAssignment(item.project, item.content);
    const resolved = resolveProjectName(verified);
    const projectName = resolved || verified;
    const sectionPattern = `## Active -- ${projectName}`;
    if (appendToSection(tasksPath, sectionPattern, taskLine)) {
      logger.info({ task: item.content, project: projectName }, 'Routed task to project section');
      return { written: true, path: tasksPath, deduplicated: false };
    }
  }

  // Fallback to Backlog
  if (appendToSection(tasksPath, '## Backlog', taskLine)) {
    logger.info({ task: item.content }, 'Routed task to Backlog');
    return { written: true, path: tasksPath, deduplicated: false };
  }

  // Last resort: append at end
  fs.appendFileSync(tasksPath, `\n${taskLine}\n`, 'utf-8');
  return { written: true, path: tasksPath, deduplicated: false };
}

async function routeDecision(item: ClassifiedItem): Promise<RouteResult> {
  if (!item.project) {
    // Phase 3: Try matching orphan decision to an existing note before daily log
    const vaultIndex = getVaultIndex();
    const noteMatch = findNoteMatchForOrphan(item.content, vaultIndex);
    if (noteMatch) {
      const dedup = await checkDedupTiered(noteMatch.filePath, item.content, item.category);
      if (dedup.isDuplicate) {
        return { written: false, path: noteMatch.filePath, deduplicated: true };
      }
      const date = formatDate(item.timestamp);
      const line = `- **${date}** [Decision]: ${item.content} *(Scribe)*`;
      const matchedEntry = vaultIndex.files.find(f => f.path === noteMatch.filePath);
      const section = matchedEntry ? findBestSection(matchedEntry, item.content) : null;
      if (section) {
        appendToSection(noteMatch.filePath, `## ${section}`, line);
      } else {
        fs.appendFileSync(noteMatch.filePath, `\n${line}\n`, 'utf-8');
      }
      logger.info(
        { decision: item.content.slice(0, 60), matchedNote: noteMatch.relativePath },
        'Orphan decision merged into existing note',
      );
      return { written: true, path: noteMatch.filePath, deduplicated: false };
    }
    // No match -- fall through to daily log
    // FIX 4: Strip any non-standard bracket prefix before adding [Decision]
    return routeDailyLog({
      ...item,
      content: `[Decision] ${stripBracketPrefix(item.content)}`,
    });
  }

  // FIX 2: Verify project assignment against content keywords
  const verifiedProject = verifyProjectAssignment(item.project, item.content);
  const resolved = resolveProjectPath(verifiedProject);
  if (!resolved) {
    // Fall through to daily log instead of silently failing
    logger.warn({ project: verifiedProject }, 'Project not found (even fuzzy), routing decision to daily log');
    return routeDailyLog({
      ...item,
      content: `[Decision] ${stripBracketPrefix(item.content)} (project: ${verifiedProject})`,
    });
  }

  // Layer 2+3: tiered dedup
  const dedup = await checkDedupTiered(resolved.path, item.content, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: resolved.path, deduplicated: true };
  }

  const date = formatDate(item.timestamp);
  const row = `| ${date} | ${item.content} | (Scribe) |`;

  if (appendToTableInSection(resolved.path, '## Decision Log', row)) {
    logger.info({ decision: item.content, project: resolved.name }, 'Routed decision to project');
    return { written: true, path: resolved.path, deduplicated: false };
  }

  // If no table found, append as a bullet under Decision Log
  appendToSection(resolved.path, '## Decision Log', `- **${date}**: ${item.content} *(Scribe)*`);
  return { written: true, path: resolved.path, deduplicated: false };
}

async function routeProgress(item: ClassifiedItem): Promise<RouteResult> {
  if (!item.project) {
    // Phase 3: Try matching orphan progress to an existing note before daily log
    const vaultIndex = getVaultIndex();
    const noteMatch = findNoteMatchForOrphan(item.content, vaultIndex);
    if (noteMatch) {
      const dedup = await checkDedupTiered(noteMatch.filePath, item.content, item.category);
      if (dedup.isDuplicate) {
        return { written: false, path: noteMatch.filePath, deduplicated: true };
      }
      const date = formatDate(item.timestamp);
      const line = `- **${date}** [Progress]: ${item.content} *(Scribe)*`;
      const matchedEntry = vaultIndex.files.find(f => f.path === noteMatch.filePath);
      const section = matchedEntry ? findBestSection(matchedEntry, item.content) : null;
      if (section) {
        appendToSection(noteMatch.filePath, `## ${section}`, line);
      } else {
        fs.appendFileSync(noteMatch.filePath, `\n${line}\n`, 'utf-8');
      }
      logger.info(
        { progress: item.content.slice(0, 60), matchedNote: noteMatch.relativePath },
        'Orphan progress merged into existing note',
      );
      return { written: true, path: noteMatch.filePath, deduplicated: false };
    }
    // No match -- fall through to daily log
    // FIX 4: Strip any non-standard bracket prefix before adding [Progress]
    return routeDailyLog({
      ...item,
      content: `[Progress] ${stripBracketPrefix(item.content)}`,
    });
  }

  const resolved = resolveProjectPath(item.project);
  if (!resolved) {
    logger.warn({ project: item.project }, 'Project not found (even fuzzy), routing progress to daily log');
    return routeDailyLog({
      ...item,
      content: `[Progress] ${stripBracketPrefix(item.content)} (project: ${item.project})`,
    });
  }

  const dedup = await checkDedupTiered(resolved.path, item.content, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: resolved.path, deduplicated: true };
  }

  const date = formatDate(item.timestamp);
  const row = `| ${date} | ${item.content} | (Scribe) |`;

  if (appendToTableInSection(resolved.path, '## Progress Log', row)) {
    logger.info({ progress: item.content, project: resolved.name }, 'Routed progress to project');
    return { written: true, path: resolved.path, deduplicated: false };
  }

  appendToSection(resolved.path, '## Progress Log', `- **${date}**: ${item.content} *(Scribe)*`);
  return { written: true, path: resolved.path, deduplicated: false };
}

async function routeResearch(item: ClassifiedItem): Promise<RouteResult> {
  const deepdivePath = path.join(VAULT_ROOT, 'Deepdives & Ongoing.md');
  if (!fs.existsSync(deepdivePath)) {
    return { written: false, path: deepdivePath, deduplicated: false, error: 'Deepdives & Ongoing.md not found' };
  }

  // Phase 2: Cross-vault semantic check for research topics
  try {
    const vaultIndex = getVaultIndex();
    if (vaultIndex) {
      const vaultMatch = await findBestVaultMatch(item.content, vaultIndex, deepdivePath);
      if (vaultMatch) {
        logDedupDecision(item.content, vaultMatch.matchedLine, vaultMatch.similarity, 'cross-vault');
        logger.info(
          {
            research: item.content.slice(0, 60),
            matchedFile: vaultMatch.relativePath,
            similarity: vaultMatch.similarity.toFixed(3),
          },
          'Research skipped: content already covered in vault',
        );
        return { written: false, path: vaultMatch.filePath, deduplicated: true };
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cross-vault research check failed (non-fatal)');
  }

  // Layer 2+3: tiered dedup (covers both Queued and Ongoing sections)
  const dedup = await checkDedupTiered(deepdivePath, item.content, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: deepdivePath, deduplicated: true };
  }

  const researchLine = `- [ ] ${item.content}`;

  // Route to the Queued section, not blind append
  if (appendToSection(deepdivePath, '## Queued Deepdives', researchLine)) {
    logger.info({ research: item.content }, 'Routed research topic to Queued Deepdives');
    return { written: true, path: deepdivePath, deduplicated: false };
  }

  // Fallback: append at end if section not found (shouldn't happen)
  fs.appendFileSync(deepdivePath, `\n${researchLine}\n`, 'utf-8');
  logger.info({ research: item.content }, 'Routed research topic to Deepdives (fallback append)');
  return { written: true, path: deepdivePath, deduplicated: false };
}

/** Word count threshold: notes with fewer words go to daily log, not standalone files. */
const THIN_NOTE_WORD_THRESHOLD = 12;
/** Character threshold: notes shorter than this go to daily log. */
const THIN_NOTE_CHAR_THRESHOLD = 80;

async function routeNote(item: ClassifiedItem): Promise<RouteResult> {
  // Thin note gate: very short notes go to daily log instead of creating standalone files.
  // This prevents Scribe from spawning one-liner orphan files like "Alpha Agent Phases.md"
  // with a single bullet point. The info is better captured as a daily log entry.
  const wordCount = item.content.trim().split(/\s+/).length;
  if (wordCount < THIN_NOTE_WORD_THRESHOLD || item.content.length < THIN_NOTE_CHAR_THRESHOLD) {
    logger.info(
      { words: wordCount, chars: item.content.length, topic: item.topic },
      'Thin note redirected to daily log (too short for standalone file)',
    );
    return routeDailyLog({
      ...item,
      content: item.topic ? `[${item.topic}] ${item.content}` : item.content,
    });
  }

  const topic = item.topic || 'Scribe Notes';
  const filename = sanitizeFilename(topic);
  let targetPath = path.join(VAULT_ROOT, 'Notes', `${filename}.md`);

  // Ensure Notes/ directory exists
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const vaultIndex = getVaultIndex();

  // Phase 3: Title-aware matching -- redirect to existing file if topic matches
  const titleMatch = findTitleMatch(topic, vaultIndex);
  if (titleMatch && titleMatch.filePath !== targetPath) {
    targetPath = titleMatch.filePath;
    logger.info(
      { topic, matchedFile: titleMatch.relativePath, score: titleMatch.score.toFixed(3) },
      'Note topic matched existing file by title',
    );
  }

  // Phase 2: Cross-vault semantic check BEFORE creating any new file.
  // Only runs if target file doesn't exist (title match would have redirected to existing)
  if (!fs.existsSync(targetPath)) {
    try {
      const vaultMatch = await findBestVaultMatch(item.content, vaultIndex, targetPath);
      if (vaultMatch) {
        if (vaultMatch.relativePath.startsWith('Projects/')) {
          logDedupDecision(item.content, vaultMatch.matchedLine, vaultMatch.similarity, 'cross-vault');
          logger.info(
            { note: item.content.slice(0, 60), matchedFile: vaultMatch.relativePath, similarity: vaultMatch.similarity.toFixed(3) },
            'Note skipped: content already in project file',
          );
          return { written: false, path: vaultMatch.filePath, deduplicated: true };
        }

        if (vaultMatch.relativePath.startsWith('Notes/')) {
          // Phase 3: Section-aware append instead of blind EOF
          logDedupDecision(item.content, vaultMatch.matchedLine, vaultMatch.similarity, 'cross-vault');
          const matchedEntry = vaultIndex.files.find(f => f.path === vaultMatch.filePath);
          const bestSection = matchedEntry ? findBestSection(matchedEntry, item.content) : null;
          if (bestSection) {
            appendToSection(vaultMatch.filePath, `## ${bestSection}`, `- ${item.content}`);
          } else {
            fs.appendFileSync(vaultMatch.filePath, `- ${item.content}\n`, 'utf-8');
          }
          logger.info(
            { note: item.content.slice(0, 60), redirectedTo: vaultMatch.relativePath, section: bestSection || 'EOF', similarity: vaultMatch.similarity.toFixed(3) },
            'Note redirected: appended to existing note',
          );
          return { written: true, path: vaultMatch.filePath, deduplicated: false };
        }

        // Match in Deepdives/Tasks -- skip
        logDedupDecision(item.content, vaultMatch.matchedLine, vaultMatch.similarity, 'cross-vault');
        logger.info(
          { note: item.content.slice(0, 60), matchedFile: vaultMatch.relativePath, similarity: vaultMatch.similarity.toFixed(3) },
          'Note skipped: content covered by existing vault file',
        );
        return { written: false, path: vaultMatch.filePath, deduplicated: true };
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cross-vault note check failed (non-fatal)');
    }
  }

  // Standard tiered dedup (stem + semantic against the target file itself)
  const dedup = await checkDedupTiered(targetPath, item.content, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: targetPath, deduplicated: true };
  }

  if (!fs.existsSync(targetPath)) {
    // Create new note with frontmatter
    const date = formatDate(item.timestamp);
    const frontmatter = [
      '---',
      'type: note',
      `tags: [scribe, ${topic.toLowerCase().replace(/\s+/g, '-')}]`,
      `created: ${date}`,
      'status: active',
      '---',
      '',
      `# ${topic}`,
      '',
      `- ${item.content}`,
      '',
    ].join('\n');
    fs.writeFileSync(targetPath, frontmatter, 'utf-8');
  } else {
    // Phase 3: Section-aware append to existing file
    const fileEntry = vaultIndex.files.find(f => f.path === targetPath);
    const bestSection = fileEntry ? findBestSection(fileEntry, item.content) : null;
    if (bestSection) {
      appendToSection(targetPath, `## ${bestSection}`, `- ${item.content}`);
    } else {
      fs.appendFileSync(targetPath, `- ${item.content}\n`, 'utf-8');
    }
  }

  logger.info({ note: item.content, topic, path: targetPath }, 'Routed note');
  return { written: true, path: targetPath, deduplicated: false };
}

async function routeDailyLog(item: ClassifiedItem): Promise<RouteResult> {
  const date = formatDate(item.timestamp);
  const notePath = ensureDailyNote(date);

  // FIX 4: Normalize bracket prefixes (strip non-standard ones like [Memory Retention])
  const normalizedContent = normalizeBracketPrefix(item.content, item.category);

  const dedup = await checkDedupTiered(notePath, normalizedContent, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: notePath, deduplicated: true };
  }

  // FIX 7: Cross-day dedup -- check against last 7 days of daily notes
  try {
    const vaultIndex = getVaultIndex();
    if (vaultIndex && vaultIndex.recentDailyNotes.length > 0) {
      for (const dailyName of vaultIndex.recentDailyNotes) {
        const dailyPath = path.join(VAULT_ROOT, 'Daily Notes', `${dailyName}.md`);
        if (dailyPath === notePath) continue; // skip today (already checked above)
        if (!fs.existsSync(dailyPath)) continue;
        const crossDayDedup = await checkDedupTiered(dailyPath, normalizedContent, item.category);
        if (crossDayDedup.isDuplicate) {
          logger.debug(
            { content: normalizedContent.slice(0, 60), crossDay: dailyName },
            'Cross-day dedup: duplicate found in previous daily note',
          );
          return { written: false, path: notePath, deduplicated: true };
        }
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cross-day dedup check failed (non-fatal)');
  }

  // Determine the right section based on category
  const section = item.category === 'financial' ? '## Log' : '## Log';
  const prefix = item.category === 'financial' ? '[Financial] ' : '';
  const logLine = `- ${prefix}${normalizedContent}`;

  if (appendToSection(notePath, section, logLine)) {
    logger.info({ content: normalizedContent.slice(0, 60), date }, 'Routed daily log entry');
    return { written: true, path: notePath, deduplicated: false };
  }

  // Fallback: append at end
  fs.appendFileSync(notePath, `\n${logLine}\n`, 'utf-8');
  logger.info({ content: normalizedContent.slice(0, 60), date }, 'Routed daily log entry (appended)');
  return { written: true, path: notePath, deduplicated: false };
}

// ── Personal Notes Router ────────────────────────────────────────────

async function routePersonal(item: ClassifiedItem): Promise<RouteResult> {
  const date = formatDate(item.timestamp);
  const notePath = ensureDailyNote(date);

  const normalizedContent = normalizeBracketPrefix(item.content, item.category);

  const dedup = await checkDedupTiered(notePath, normalizedContent, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: notePath, deduplicated: true };
  }

  const logLine = `- ${normalizedContent}`;

  if (appendToSection(notePath, '## Personal Notes', logLine)) {
    logger.info({ content: normalizedContent.slice(0, 60), date }, 'Routed personal note');
    return { written: true, path: notePath, deduplicated: false };
  }

  // Fallback: append to Log section
  if (appendToSection(notePath, '## Log', logLine)) {
    logger.info({ content: normalizedContent.slice(0, 60), date }, 'Routed personal note to Log (fallback)');
    return { written: true, path: notePath, deduplicated: false };
  }

  fs.appendFileSync(notePath, `\n${logLine}\n`, 'utf-8');
  return { written: true, path: notePath, deduplicated: false };
}

// ── Financial Router ─────────────────────────────────────────────────

async function routeFinancial(item: ClassifiedItem): Promise<RouteResult> {
  const date = formatDate(item.timestamp);
  const notePath = ensureDailyNote(date);

  const normalizedContent = normalizeBracketPrefix(item.content, item.category);

  const dedup = await checkDedupTiered(notePath, normalizedContent, item.category);
  if (dedup.isDuplicate) {
    return { written: false, path: notePath, deduplicated: true };
  }

  const logLine = `- [Financial] ${normalizedContent}`;

  if (appendToSection(notePath, '## Log', logLine)) {
    logger.info({ content: normalizedContent.slice(0, 60), date }, 'Routed financial entry');
    return { written: true, path: notePath, deduplicated: false };
  }

  fs.appendFileSync(notePath, `\n${logLine}\n`, 'utf-8');
  return { written: true, path: notePath, deduplicated: false };
}

// ── Utility Functions ────────────────────────────────────────────────

function formatDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDryRunPath(item: ClassifiedItem): string {
  switch (item.category) {
    case 'task':
      return path.join(VAULT_ROOT, 'Tasks.md');
    case 'decision':
    case 'progress': {
      if (item.project) {
        const resolved = resolveProjectName(item.project);
        const projName = resolved || item.project;
        return path.join(VAULT_ROOT, 'Projects', projName, `${projName}.md`);
      }
      return path.join(VAULT_ROOT, 'Daily Notes', `${formatDate(item.timestamp)}.md`);
    }
    case 'research':
      return path.join(VAULT_ROOT, 'Deepdives & Ongoing.md');
    case 'note':
      return path.join(VAULT_ROOT, 'Notes', `${sanitizeFilename(item.topic || 'untitled')}.md`);
    case 'daily_log':
    case 'personal':
    case 'financial':
      return path.join(VAULT_ROOT, 'Daily Notes', `${formatDate(item.timestamp)}.md`);
    default:
      return '';
  }
}

function commitVault(message: string): void {
  try {
    spawnSync('bash', [VAULT_COMMIT_SCRIPT, message], {
      cwd: VAULT_ROOT,
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Vault commit failed (non-fatal)');
  }
}