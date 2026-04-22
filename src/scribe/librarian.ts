/**
 * Scribe Librarian -- On-demand memory management + vault sorting.
 *
 * Dispatched via bridge: `node dist/bridge-cli.js send scribe "librarian audit"`
 *
 * Commands:
 *   librarian audit              -- Memory health stats
 *   librarian clean [topic]      -- Deduplicate memories (optionally by topic)
 *   librarian consolidate [proj] -- Targeted consolidation
 *   librarian search [query]     -- FTS5 + vector search across memories
 *   librarian vault-sort         -- Scan agent workspaces, route files to vault
 *   librarian vault-sort dry     -- Preview what vault-sort would do (no writes)
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { logger } from '../logger.js';
import { getMainWriteDb, hasMainWriteDb, isVecAvailable } from './db.js';
import { getOrComputeEmbedding } from './embedding-cache.js';
import type { LibrarianCommand, LibrarianResult } from './types.js';
import { getProjectIndex } from './vault-scanner.js';

const __libFilename = fileURLToPath(import.meta.url);
const __libDirname = path.dirname(__libFilename);
const PROJECT_ROOT = path.resolve(__libDirname, '..', '..');
const VAULT_ROOT = process.env.VAULT_ROOT || '';
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');

// ── Command parser ──────────────────────────────────────────────────

/**
 * Parse a librarian command from a bridge prompt.
 * Returns null if the prompt is not a librarian command.
 */
export function parseLibrarianCommand(prompt: string): LibrarianCommand | null {
  const clean = prompt.trim();

  if (/^librarian\s+audit$/i.test(clean)) {
    return { type: 'audit' };
  }

  const cleanMatch = clean.match(/^librarian\s+clean(?:\s+(.+))?$/i);
  if (cleanMatch) {
    return { type: 'clean', topic: cleanMatch[1]?.trim() || undefined };
  }

  const consolidateMatch = clean.match(/^librarian\s+consolidate(?:\s+(.+))?$/i);
  if (consolidateMatch) {
    return { type: 'consolidate', project: consolidateMatch[1]?.trim() || undefined };
  }

  const searchMatch = clean.match(/^librarian\s+search\s+(.+)$/i);
  if (searchMatch) {
    return { type: 'search', query: searchMatch[1].trim() };
  }

  if (/^librarian\s+vault[\s-]?sort/i.test(clean)) {
    const isDry = /\bdry\b/i.test(clean);
    return { type: 'vault-sort', dryRun: isDry };
  }

  return null;
}

// ── Command executor ────────────────────────────────────────────────

export async function runLibrarianCommand(
  chatId: string,
  command: LibrarianCommand,
): Promise<LibrarianResult> {
  if (!hasMainWriteDb()) {
    return { command: command.type, summary: 'Main write DB not available. Librarian disabled.' };
  }

  switch (command.type) {
    case 'audit':
      return runAudit(chatId);
    case 'clean':
      return runClean(chatId, command.topic);
    case 'consolidate':
      return runConsolidate(chatId, command.project);
    case 'search':
      return runSearch(chatId, command.query);
    case 'vault-sort':
      return runVaultSort(command.dryRun);
    default:
      return { command: 'unknown', summary: 'Unknown librarian command' };
  }
}

// ── Audit ───────────────────────────────────────────────────────────

function runAudit(chatId: string): LibrarianResult {
  const db = getMainWriteDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN sector = 'semantic' THEN 1 ELSE 0 END) as semantic,
      SUM(CASE WHEN sector = 'episodic' THEN 1 ELSE 0 END) as episodic,
      SUM(CASE WHEN tier = 'core' THEN 1 ELSE 0 END) as core,
      SUM(CASE WHEN tier = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN tier = 'archive' THEN 1 ELSE 0 END) as archive,
      AVG(salience) as avgSalience,
      MIN(salience) as minSalience,
      MAX(salience) as maxSalience,
      SUM(CASE WHEN salience < 0.5 THEN 1 ELSE 0 END) as fading,
      SUM(CASE WHEN salience >= 4.0 THEN 1 ELSE 0 END) as highValue
    FROM memories WHERE chat_id = ?
  `).get(chatId) as {
    total: number; semantic: number; episodic: number;
    core: number; active: number; archive: number;
    avgSalience: number | null; minSalience: number | null; maxSalience: number | null;
    fading: number; highValue: number;
  };

  const topicCounts = db.prepare(`
    SELECT topic_key, COUNT(*) as cnt
    FROM memories WHERE chat_id = ?
    GROUP BY topic_key
    ORDER BY cnt DESC
  `).all(chatId) as Array<{ topic_key: string | null; cnt: number }>;

  const embeddingCount = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM memory_embeddings e
    JOIN memories m ON e.memory_id = m.id
    WHERE m.chat_id = ?
  `).get(chatId) as { cnt: number };

  const noEmbedding = stats.total - embeddingCount.cnt;

  const topicLines = topicCounts
    .map(t => `  ${t.topic_key || '(none)'}: ${t.cnt}`)
    .join('\n');

  const summary = [
    `Memory Audit`,
    `Total: ${stats.total} (${stats.semantic} semantic, ${stats.episodic} episodic)`,
    `Tiers: ${stats.core} core, ${stats.active} active, ${stats.archive} archive`,
    `Salience: avg ${(stats.avgSalience ?? 0).toFixed(2)}, range [${(stats.minSalience ?? 0).toFixed(2)}-${(stats.maxSalience ?? 0).toFixed(2)}]`,
    `Health: ${stats.fading} fading (<0.5), ${stats.highValue} high-value (>=4.0)`,
    `Embeddings: ${embeddingCount.cnt} embedded, ${noEmbedding} missing`,
    `Topics:\n${topicLines}`,
  ].join('\n');

  logger.info({ stats: stats.total }, 'Librarian audit complete');
  return { command: 'audit', summary };
}

// ── Clean ───────────────────────────────────────────────────────────

async function runClean(chatId: string, topic?: string): Promise<LibrarianResult> {
  const db = getMainWriteDb();

  let memories: Array<{ id: number; content: string; salience: number }>;

  if (topic) {
    memories = db.prepare(
      `SELECT id, content, salience FROM memories WHERE chat_id = ? AND topic_key = ? ORDER BY created_at`,
    ).all(chatId, topic) as any[];
  } else {
    memories = db.prepare(
      `SELECT id, content, salience FROM memories WHERE chat_id = ? ORDER BY created_at`,
    ).all(chatId) as any[];
  }

  if (memories.length < 2) {
    return { command: 'clean', summary: `Nothing to clean (${memories.length} memories found)` };
  }

  let removed = 0;
  const seen = new Map<number, string>();

  for (const mem of memories) {
    let isDupe = false;
    for (const [existingId, existingContent] of seen) {
      const sim = jaccardSimilarity(mem.content, existingContent);
      if (sim > 0.7) {
        const existing = memories.find(m => m.id === existingId);
        if (existing && existing.salience >= mem.salience) {
          // Delete the lower-salience duplicate
          db.prepare('DELETE FROM memories WHERE id = ?').run(mem.id);
          db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(mem.id);
          try { db.exec(`DELETE FROM vec_memories WHERE memory_id = ${mem.id}`); } catch { /* non-fatal */ }
          removed++;
          isDupe = true;
        }
        break;
      }
    }
    if (!isDupe) {
      seen.set(mem.id, mem.content);
    }
  }

  const scope = topic || 'all topics';
  const summary = `Cleaned ${scope}: removed ${removed} duplicates from ${memories.length} total memories`;
  logger.info({ topic, removed, total: memories.length }, 'Librarian clean complete');
  return { command: 'clean', summary };
}

// ── Consolidate ─────────────────────────────────────────────────────

async function runConsolidate(chatId: string, project?: string): Promise<LibrarianResult> {
  // Targeted clean scoped to project topic
  const result = await runClean(chatId, project ? 'projects' : undefined);
  return { command: 'consolidate', summary: `Consolidation: ${result.summary}` };
}

// ── Search ──────────────────────────────────────────────────────────

async function runSearch(chatId: string, query: string): Promise<LibrarianResult> {
  const db = getMainWriteDb();

  // FTS5 search
  const sanitized = query
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\w\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w: string) => `"${w}"*`)
    .join(' ');

  let ftsResults: Array<{
    id: number; content: string; topic_key: string | null;
    sector: string; salience: number; tier: string;
  }> = [];

  if (sanitized) {
    try {
      ftsResults = db.prepare(
        `SELECT memories.id, memories.content, memories.topic_key,
                memories.sector, memories.salience, memories.tier
         FROM memories
         JOIN memories_fts ON memories.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND memories.chat_id = ?
         ORDER BY rank
         LIMIT 10`,
      ).all(sanitized, chatId) as any[];
    } catch { /* FTS5 might fail on some queries */ }
  }

  // Vector search
  let vecResults: Array<{ id: number; content: string; distance: number }> = [];

  if (isVecAvailable()) {
    try {
      const embedding = await getOrComputeEmbedding(query);
      const blob = Buffer.from(
        embedding.buffer,
        embedding.byteOffset,
        embedding.byteLength,
      );
      const vecHits = db.prepare(
        `SELECT memory_id, distance FROM vec_memories
         WHERE embedding MATCH ? AND k = ? AND chat_id = ?
         ORDER BY distance`,
      ).all(blob, 5, chatId) as Array<{ memory_id: number; distance: number }>;

      for (const hit of vecHits) {
        const mem = db.prepare(
          'SELECT id, content FROM memories WHERE id = ?',
        ).get(hit.memory_id) as { id: number; content: string } | undefined;
        if (mem) {
          vecResults.push({ id: mem.id, content: mem.content, distance: hit.distance });
        }
      }
    } catch { /* embedding might fail */ }
  }

  // Merge and deduplicate results
  const seenIds = new Set<number>();
  const lines: string[] = [];

  for (const r of ftsResults) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      lines.push(`[${r.tier}/${r.sector}] (${r.salience.toFixed(1)}) ${r.content}`);
    }
  }

  for (const r of vecResults) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      const sim = (1 / (1 + r.distance)).toFixed(2);
      lines.push(`[vec:${sim}] ${r.content}`);
    }
  }

  const summary = lines.length > 0
    ? `Found ${lines.length} memories for "${query}":\n${lines.join('\n')}`
    : `No memories found for "${query}"`;

  logger.info({ query, results: lines.length }, 'Librarian search complete');
  return { command: 'search', summary };
}

// ── Vault Sort ─────────────────────────────────────────────────────

/**
 * Agent workspace scan sources and their vault destinations.
 */
interface ScanSource {
  name: string;          // e.g. "researcher-reports"
  agent: string;         // e.g. "researcher-1"
  srcDir: string;        // absolute path to scan
  vaultDir: string;      // vault subdirectory for output
  fileType: 'research' | 'alpha-report' | 'strategy' | 'killed';
}

function getScanSources(): ScanSource[] {
  const agentWs = path.join(VAULT_ROOT, 'Agent Workspace');

  return [
    // Researcher reports: Agent Workspace -> Research Results (or matching project folder)
    {
      name: 'researcher-reports',
      agent: 'researcher-1',
      srcDir: path.join(agentWs, 'Researcher'),
      vaultDir: path.join(VAULT_ROOT, 'Research Results'),
      fileType: 'research',
    },
    // Alpha reports: Agent Workspace -> Crypto Strategy Pipeline
    {
      name: 'optimizer-reports',
      agent: 'optimizer-1',
      srcDir: path.join(agentWs, 'Optimizer', 'optimizer-reports'),
      vaultDir: path.join(VAULT_ROOT, 'Projects', 'Crypto Strategy Pipeline', 'Alpha Reports'),
      fileType: 'alpha-report',
    },
    {
      name: 'optimizer-promoted',
      agent: 'optimizer-1',
      srcDir: path.join(agentWs, 'Optimizer', 'promoted'),
      vaultDir: path.join(VAULT_ROOT, 'Projects', 'Crypto Strategy Pipeline', 'Strategies'),
      fileType: 'strategy',
    },
    {
      name: 'optimizer-killed',
      agent: 'optimizer-1',
      srcDir: path.join(agentWs, 'Optimizer', 'archive', 'killed'),
      vaultDir: path.join(VAULT_ROOT, 'Projects', 'Crypto Strategy Pipeline', 'Killed'),
      fileType: 'killed',
    },
    // Coder output: Agent Workspace -> stays in workspace (code artifacts, not vault-routable)
    {
      name: 'coder-output',
      agent: 'coder-1',
      srcDir: path.join(agentWs, 'Coder'),
      vaultDir: path.join(agentWs, 'Coder'),  // Coder files stay in workspace
      fileType: 'research',
    },
    // FIX 8: Local fallback dirs where reports get stuck when vault writes fail
    {
      name: 'local-fallback-reports',
      agent: 'researcher-1',
      srcDir: path.join(PROJECT_ROOT, 'store', 'reports'),
      vaultDir: path.join(VAULT_ROOT, 'Research Results'),
      fileType: 'research',
    },
    {
      name: 'researcher-local-reports',
      agent: 'researcher-1',
      srcDir: path.join(PROJECT_ROOT, 'bots', 'researcher-1', 'store', 'reports'),
      vaultDir: path.join(VAULT_ROOT, 'Research Results'),
      fileType: 'research',
    },
    // FIX: The primary bot saves inline research to workspace/reports/ -- Scribe needs to scan it
    {
      name: 'primary-workspace-reports',
      agent: process.env.BOT_NAME || 'apex-bot',
      srcDir: path.join(PROJECT_ROOT, 'workspace', 'reports'),
      vaultDir: path.join(VAULT_ROOT, 'Research Results'),
      fileType: 'research',
    },
  ];
}

/**
 * Determine a descriptive filename from file content.
 * Tries: YAML strategy_name, first H1, or first non-empty line.
 */
function extractTitle(content: string, originalName: string): string {
  // Check YAML frontmatter for strategy_name
  const yamlMatch = content.match(/^---[\s\S]*?strategy_name:\s*"?([^"\n]+)"?[\s\S]*?---/);
  if (yamlMatch) return yamlMatch[1].trim();

  // Check for a H1 heading (skip generic ones like "Report" or "Summary")
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    const h1 = h1Match[1].trim();
    if (!/^(Report|Summary|Research|Results?)$/i.test(h1) && h1.length >= 5) {
      return h1;
    }
  }

  // Check YAML title field
  const titleMatch = content.match(/^---[\s\S]*?title:\s*"?([^"\n]+)"?[\s\S]*?---/);
  if (titleMatch) return titleMatch[1].trim();

  // FIX 9: Check for first bold line (**Title**)
  const boldMatch = content.match(/^\*\*(.{5,80}?)\*\*/m);
  if (boldMatch) {
    const bold = boldMatch[1].trim();
    if (!/^(report|summary|result|note|done|video|here|the|quick)/i.test(bold)) {
      return bold;
    }
  }

  // FIX 9: Try first non-empty content line that's descriptive (> 20 chars)
  // This catches hash-named files in store/reports/ that have no headings
  const contentLines = content.split('\n')
    .filter(l => {
      const t = l.trim();
      return t.length > 20
        && !t.startsWith('---')
        && !t.startsWith('#')
        && !t.startsWith('*Auto-')
        && !t.startsWith('type:')
        && !t.startsWith('tags:')
        && !t.startsWith('created:')
        && !t.startsWith('status:')
        && !t.startsWith('source:');
    });
  if (contentLines.length > 0) {
    const firstLine = contentLines[0].replace(/^[*_>\-\s]+/, '').trim();
    if (firstLine.length >= 20 && firstLine.length <= 120) {
      return firstLine;
    }
  }

  // Fall back to original filename (minus extension and date prefix)
  const base = originalName.replace(/\.md$/, '');
  const noDate = base.replace(/^\d{4}-\d{2}-\d{2}-?/, '');
  return noDate || base;
}

/**
 * Check if a file with the same content already exists in the vault destination.
 * Uses filename matching (exact or date-stripped slug match).
 */
function alreadyInVault(filename: string, vaultDir: string): boolean {
  if (!fs.existsSync(vaultDir)) return false;
  const existing = fs.readdirSync(vaultDir).filter(f => f.endsWith('.md'));

  // Exact match
  if (existing.includes(filename)) return true;

  // Slug match (strip date prefix, compare slugs)
  const slug = filename.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').toLowerCase();
  for (const ex of existing) {
    const exSlug = ex.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').toLowerCase();
    if (slug && exSlug === slug) return true;
  }

  return false;
}

/**
 * Ensure YAML frontmatter exists on a file's content. Adds if missing.
 */
function ensureFrontmatter(
  content: string,
  fileType: string,
  agent: string,
): string {
  if (content.trimStart().startsWith('---')) return content;

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const frontmatter = [
    '---',
    `type: ${fileType}`,
    `source: ${agent}`,
    `created: ${today}`,
    `status: ${fileType === 'killed' ? 'killed' : 'complete'}`,
    `tags: [scribe-sorted, ${agent}]`,
    '---',
    '',
  ].join('\n');

  return frontmatter + content;
}

/**
 * Sanitize a title into a safe filename.
 */
function sanitizeForFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '-');
}

// ── Frontmatter helpers ────────────────────────────────────────────

/** Local fallback scan source names (for FIX 10 marking logic). */
const LOCAL_FALLBACK_SOURCES = new Set(['local-fallback-reports', 'researcher-local-reports']);

/**
 * Check if a workspace file has already been routed (status: routed in YAML).
 * Also checks for .routed marker files used by local fallback dirs.
 */
function isAlreadyRouted(content: string): boolean {
  const match = content.match(/^---[\s\S]*?status:\s*(\S+)[\s\S]*?---/);
  return match?.[1] === 'routed';
}

/**
 * Check if a local fallback file has been marked as routed via the .routed/ subfolder.
 */
function isLocalFileRouted(srcDir: string, filename: string): boolean {
  const routedDir = path.join(srcDir, '.routed');
  return fs.existsSync(path.join(routedDir, filename));
}

/**
 * Mark a local fallback file as routed by moving it to .routed/ subfolder.
 * Does NOT delete the original -- keeps as backup.
 */
function markLocalFileRouted(srcPath: string, srcDir: string, filename: string): void {
  const routedDir = path.join(srcDir, '.routed');
  fs.mkdirSync(routedDir, { recursive: true });
  const routedPath = path.join(routedDir, filename);
  try {
    // Copy to .routed/ subfolder (keep original in case of issues)
    const content = fs.readFileSync(srcPath, 'utf-8');
    fs.writeFileSync(routedPath, content, 'utf-8');
    // Remove original so it doesn't get re-scanned
    fs.unlinkSync(srcPath);
    logger.debug({ srcPath, routedPath }, 'Marked local fallback file as routed');
  } catch (err) {
    logger.warn({ srcPath, err }, 'Failed to mark local fallback file as routed');
  }
}

/**
 * Update a workspace file's frontmatter after routing:
 * - status: pending/complete -> routed
 * - Adds destination field with the vault path
 */
function markSourceAsRouted(srcPath: string, content: string, destination: string): void {
  let updated = content;

  if (/^---[\s\S]*?---/.test(updated)) {
    // Update status to routed
    updated = updated.replace(
      /^(---[\s\S]*?status:\s*)\S+([\s\S]*?---)/,
      `$1routed$2`,
    );
    // Add destination field if not present
    if (!updated.match(/^---[\s\S]*?destination:/)) {
      const relDest = path.relative(VAULT_ROOT, destination);
      updated = updated.replace(/^(---\n)/, `$1destination: ${relDest}\n`);
    }
  }

  fs.writeFileSync(srcPath, updated, 'utf-8');
}

// ── Project matching for research routing ──────────────────────────

/**
 * Find a matching project folder for a research file.
 * Checks if any active project name appears in the file title or content.
 * Uses the recursive project index to find projects at any nesting depth.
 * Returns the project folder path or null.
 */
function findMatchingProject(title: string, content: string): string | null {
  const projectIndex = getProjectIndex();
  if (projectIndex.size === 0) return null;

  const titleLower = title.toLowerCase();
  // Only check first 2000 chars of content for performance
  const contentSample = content.slice(0, 2000).toLowerCase();

  for (const [project, folderPath] of projectIndex) {
    const projLower = project.toLowerCase();
    // Skip very short project names (too many false matches)
    if (projLower.length < 4) continue;

    // Check title first (stronger signal)
    if (titleLower.includes(projLower)) {
      return folderPath;
    }

    // Check content keywords (require word boundary-ish match)
    const projWords = projLower.split(/[\s-]+/).filter(w => w.length >= 4);
    const matchCount = projWords.filter(w => contentSample.includes(w)).length;
    if (projWords.length > 0 && matchCount >= Math.ceil(projWords.length * 0.6)) {
      return folderPath;
    }
  }

  return null;
}

// ── Vault Sort (enhanced) ──────────────────────────────────────────

/**
 * Scan all agent workspaces and sort unsorted files into the vault.
 * Enhanced with: project matching, frontmatter updates, skip-already-routed.
 */
async function runVaultSort(dryRun?: boolean): Promise<LibrarianResult> {
  const sources = getScanSources();
  const actions: string[] = [];
  let copied = 0;
  let skipped = 0;
  let renamed = 0;
  let projectMatched = 0;
  let errors = 0;

  for (const src of sources) {
    if (!fs.existsSync(src.srcDir)) {
      continue; // silent skip for auto-sort (no log noise)
    }

    // Ensure vault destination exists
    if (!dryRun) {
      fs.mkdirSync(src.vaultDir, { recursive: true });
    }

    const files = fs.readdirSync(src.srcDir)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep' && !f.startsWith('.'));

    const isLocalFallback = LOCAL_FALLBACK_SOURCES.has(src.name);

    for (const file of files) {
      try {
        const srcPath = path.join(src.srcDir, file);
        const content = fs.readFileSync(srcPath, 'utf-8');

        // Skip files already marked as routed (YAML frontmatter or .routed/ subfolder)
        if (isAlreadyRouted(content)) {
          skipped++;
          continue;
        }
        if (isLocalFallback && isLocalFileRouted(src.srcDir, file)) {
          skipped++;
          continue;
        }

        // Determine effective destination (project matching for research files)
        let effectiveVaultDir = src.vaultDir;
        if (src.fileType === 'research' && src.srcDir !== src.vaultDir) {
          const title = extractTitle(content, file);
          const matchedProject = findMatchingProject(title, content);
          if (matchedProject) {
            effectiveVaultDir = matchedProject;
            projectMatched++;
          }
        }

        // Check if already in vault destination
        if (alreadyInVault(file, effectiveVaultDir)) {
          // Mark source as routed so we don't re-check next cycle
          if (!dryRun) {
            if (isLocalFallback) {
              markLocalFileRouted(srcPath, src.srcDir, file);
            } else {
              const destPath = path.join(effectiveVaultDir, file);
              markSourceAsRouted(srcPath, content, destPath);
            }
          }
          skipped++;
          continue;
        }

        // Determine target filename
        let targetName = file;
        const isUUID = /^researcher-[a-f0-9]{16}\.md$/i.test(file) ||
                       /^[a-f0-9-]{32,}\.md$/i.test(file) ||
                       /^\d{4}-\d{2}-\d{2}\s*-\s*\w+-[a-f0-9]{16}\.md$/i.test(file);
        if (isUUID) {
          const title = extractTitle(content, file);
          const today = new Date().toISOString().split('T')[0];
          targetName = `${today} - ${sanitizeForFilename(title)}.md`;
          renamed++;
        }

        // Check again with new name
        if (targetName !== file && alreadyInVault(targetName, effectiveVaultDir)) {
          if (!dryRun) {
            if (isLocalFallback) {
              markLocalFileRouted(srcPath, src.srcDir, file);
            } else {
              const destPath = path.join(effectiveVaultDir, targetName);
              markSourceAsRouted(srcPath, content, destPath);
            }
          }
          skipped++;
          continue;
        }

        const destPath = path.join(effectiveVaultDir, targetName);

        if (dryRun) {
          const action = isUUID ? `[rename+copy]` : `[copy]`;
          const destLabel = effectiveVaultDir !== src.vaultDir
            ? `${path.relative(VAULT_ROOT, destPath)} (project match)`
            : path.relative(VAULT_ROOT, destPath);
          actions.push(`${action} ${src.agent}/${file} -> ${destLabel}`);
          copied++;
        } else {
          // Ensure destination dir exists
          fs.mkdirSync(effectiveVaultDir, { recursive: true });

          // Add frontmatter if missing, then write to destination
          const finalContent = ensureFrontmatter(content, src.fileType, src.agent);
          fs.writeFileSync(destPath, finalContent, 'utf-8');

          // Mark source file as routed (use .routed/ subfolder for local fallback files)
          if (isLocalFallback) {
            markLocalFileRouted(srcPath, src.srcDir, file);
          } else {
            markSourceAsRouted(srcPath, content, destPath);
          }

          actions.push(`[sorted] ${src.agent}/${file} -> ${path.relative(VAULT_ROOT, destPath)}`);
          copied++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        actions.push(`[error] ${src.name}/${file}: ${errMsg}`);
        errors++;
      }
    }
  }

  // Commit vault if we wrote anything
  if (copied > 0 && !dryRun) {
    vaultCommit(`scribe: vault-sort ${copied} files`);
    logToDaily(`vault-sort: ${copied} files sorted, ${skipped} skipped, ${projectMatched} project-matched`);
  }

  const mode = dryRun ? 'DRY RUN' : 'LIVE';
  const summary = [
    `Vault Sort (${mode})`,
    `Sorted: ${copied} files`,
    `Skipped (already routed/in vault): ${skipped}`,
    `Renamed (UUID -> title): ${renamed}`,
    `Project-matched: ${projectMatched}`,
    `Errors: ${errors}`,
    '',
    ...actions,
  ].join('\n');

  logger.info({ copied, skipped, renamed, projectMatched, errors, dryRun }, 'Vault sort complete');
  return { command: 'vault-sort', summary };
}

// ── Archive stale routed files ──────────────────────────────────────

const STALE_DAYS = 7;

/**
 * Move workspace files that have been routed and are older than STALE_DAYS
 * to Agent Workspace/.archive/ to keep workspace clean.
 */
function runArchiveStale(): { archived: number; errors: number } {
  const agentWs = path.join(VAULT_ROOT, 'Agent Workspace');
  const archiveDir = path.join(agentWs, '.archive');
  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let archived = 0;
  let archiveErrors = 0;

  // Scan each agent folder (skip .archive, Shared, Scribe)
  const skipDirs = new Set(['.archive', 'Shared', 'Scribe']);
  let agentDirs: fs.Dirent[];
  try {
    agentDirs = fs.readdirSync(agentWs, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !skipDirs.has(d.name));
  } catch { return { archived: 0, errors: 0 }; }

  for (const agentDir of agentDirs) {
    const agentPath = path.join(agentWs, agentDir.name);
    walkMdFiles(agentPath, (filePath) => {
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs < staleMs) return; // too fresh

        const content = fs.readFileSync(filePath, 'utf-8');
        if (!isAlreadyRouted(content)) return; // not routed yet, leave it

        // Move to archive preserving relative path
        const relPath = path.relative(agentWs, filePath);
        const archivePath = path.join(archiveDir, relPath);
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.renameSync(filePath, archivePath);
        archived++;
      } catch (err) {
        archiveErrors++;
        logger.warn({ file: filePath, err }, 'Archive move failed');
      }
    });
  }

  if (archived > 0) {
    vaultCommit(`scribe: archived ${archived} stale workspace files`);
    logToDaily(`archive: ${archived} stale routed files moved to .archive/`);
    logger.info({ archived }, 'Archive stale complete');
  }

  return { archived, errors: archiveErrors };
}

/**
 * Recursively walk a directory for .md files.
 */
function walkMdFiles(dir: string, callback: (filePath: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      walkMdFiles(fullPath, callback);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      callback(fullPath);
    }
  }
}

// ── Local report recovery ────────────────────────────────────────────

/**
 * Scan local fallback report directories for researcher reports that never
 * reached the vault. Copy them to Agent Workspace/Researcher/ so the normal
 * vault-sort pipeline can route them.
 *
 * Skips files that:
 *   - Are not .md files
 *   - Already exist in the vault workspace (by filename)
 *   - Are bridge response summaries (start with "Done." or "Got everything")
 */
function recoverLocalReports(): { recovered: number; skipped: number } {
  const agentResearcherDir = path.join(VAULT_ROOT, 'Agent Workspace', 'Researcher');

  // Two directories where reports can get stuck
  const localDirs = [
    path.join(PROJECT_ROOT, 'store', 'reports'),
    path.join(PROJECT_ROOT, 'bots', 'researcher-1', 'store', 'reports'),
  ];

  let recovered = 0;
  let skipped = 0;

  for (const dir of localDirs) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch { continue; }

    for (const file of files) {
      const srcPath = path.join(dir, file);

      try {
        const content = fs.readFileSync(srcPath, 'utf-8');

        // Skip bridge response messages (not full reports)
        const firstLine = content.trimStart().split('\n')[0]?.trim() || '';
        if (/^(Done\.|Got everything)/i.test(firstLine)) {
          skipped++;
          continue;
        }

        // Skip if already in vault workspace (exact filename match)
        const destPath = path.join(agentResearcherDir, file);
        if (fs.existsSync(destPath)) {
          skipped++;
          continue;
        }

        // Skip if already routed (check vault workspace for content with status: routed)
        if (isAlreadyRouted(content)) {
          skipped++;
          continue;
        }

        // Copy to Agent Workspace/Researcher/
        fs.mkdirSync(agentResearcherDir, { recursive: true });
        fs.writeFileSync(destPath, content, 'utf-8');
        recovered++;
        logger.info({ src: srcPath, dest: destPath }, 'Recovered local report to vault workspace');
      } catch (err) {
        logger.warn({ file: srcPath, err }, 'Failed to recover local report');
      }
    }
  }

  if (recovered > 0) {
    vaultCommit(`processor: recovered ${recovered} local reports to Agent Workspace/Researcher`);
    logToDaily(`report-recovery: ${recovered} local reports copied to Agent Workspace/Researcher/`);
    logger.info({ recovered, skipped }, 'Local report recovery complete');
  }

  return { recovered, skipped };
}

// ── Auto-sort (combined vault-sort + archive) ───────────────────────

/**
 * Run vault-sort + archive in one call. Used by the auto-poll timer.
 * Returns silently if nothing to do (no log noise on quiet cycles).
 */
export async function runAutoSort(): Promise<{ sorted: number; archived: number; recovered: number }> {
  // Step 1: Recover any reports stuck in local fallback dirs -> Agent Workspace/Researcher/
  const { recovered } = recoverLocalReports();

  // Step 2: Normal vault-sort (routes Agent Workspace -> final vault locations)
  const sortResult = await runVaultSort(false);
  const sortedMatch = sortResult.summary.match(/Sorted:\s*(\d+)/);
  const sorted = sortedMatch ? parseInt(sortedMatch[1], 10) : 0;

  // Step 3: Archive stale routed files
  const { archived } = runArchiveStale();

  if (sorted > 0 || archived > 0 || recovered > 0) {
    logger.info({ sorted, archived, recovered }, 'Auto-sort cycle complete');
  }

  return { sorted, archived, recovered };
}

// ── Shared utilities ────────────────────────────────────────────────

function vaultCommit(message: string): void {
  try {
    spawnSync('bash', [VAULT_COMMIT_SCRIPT, message], {
      timeout: 15000,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* non-fatal */ }
}

function logToDaily(entry: string): void {
  try {
    const _now = new Date();
    const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
    const dailyPath = path.join(VAULT_ROOT, 'Daily Notes', `${today}.md`);
    if (fs.existsSync(dailyPath)) {
      fs.appendFileSync(dailyPath, `\n- [Scribe] ${entry}\n`, 'utf-8');
    }
  } catch { /* non-fatal */ }
}

// ── Helpers ─────────────────────────────────────────────────────────

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
