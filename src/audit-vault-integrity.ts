/**
 * Vault Integrity Audit
 *
 * Checks Obsidian vault structure compliance, orphaned files, project template
 * compliance, git status, and task health.
 *
 * Run: node dist/audit-vault-integrity.js
 * Schedule: Every Wednesday at 10am (0 10 * * 3)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const VAULT_PATH = process.env.VAULT_ROOT || '';
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');
const NOTIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');

function notify(message: string): void {
  try {
    execSync(`bash "${NOTIFY_SCRIPT}" "${message.replace(/"/g, '\\"')}"`, {
      timeout: 10000, windowsHide: true, stdio: 'pipe',
    });
  } catch { /* non-fatal */ }
}

// -- Types ------------------------------------------------------------------

interface StructureCheck {
  item: string;
  expected: string;
  found: boolean;
}

interface ProjectCompliance {
  project: string;
  missingSections: string[];
}

interface TaskSection {
  section: string;
  open: number;
  completed: number;
}

// -- Required vault structure -----------------------------------------------

const REQUIRED_ITEMS: { path: string; type: 'file' | 'dir' }[] = [
  { path: 'Tasks.md', type: 'file' },
  { path: 'Deepdives & Ongoing.md', type: 'file' },
  { path: 'Daily Notes', type: 'dir' },
  { path: 'Notes', type: 'dir' },
  { path: 'Projects', type: 'dir' },
  { path: 'Research Results', type: 'dir' },
  { path: 'Research Results/Reference', type: 'dir' },
  { path: 'Audits', type: 'dir' },
  { path: 'Templates', type: 'dir' },
  { path: 'Disaster Recovery', type: 'dir' },
];

const REQUIRED_PROJECT_SECTIONS = [
  'Status',
  'Objective',
  'Decision Log',
  'Progress Log',
  'Files & References',
  'Notes',
];

// Directories/patterns to exclude from orphan checking
const ORPHAN_EXCLUDE_DIRS = ['Templates', 'Daily Notes', 'Audits', '.obsidian', '.git'];
const ORPHAN_EXCLUDE_FILES = ['Tasks.md', 'Deepdives & Ongoing.md', 'Audit Index.md'];

// -- Helpers ----------------------------------------------------------------

function getAllMdFiles(dir: string, excludeDirs: string[] = []): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.join(current, entry.name));
      }
    }
  }

  walk(dir);
  return results;
}

// -- Check functions --------------------------------------------------------

function checkStructure(): StructureCheck[] {
  const results: StructureCheck[] = [];

  for (const item of REQUIRED_ITEMS) {
    const fullPath = path.join(VAULT_PATH, item.path);
    let found = false;

    try {
      const stat = fs.statSync(fullPath);
      found = item.type === 'dir' ? stat.isDirectory() : stat.isFile();
    } catch {
      found = false;
    }

    results.push({
      item: item.path,
      expected: item.type,
      found,
    });
  }

  // Check that each project folder has a matching main .md file
  const projectsDir = path.join(VAULT_PATH, 'Projects');
  if (fs.existsSync(projectsDir)) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const mainFile = path.join(projectsDir, entry.name, `${entry.name}.md`);
          const found = fs.existsSync(mainFile);
          results.push({
            item: `Projects/${entry.name}/${entry.name}.md`,
            expected: 'file (project main)',
            found,
          });
        }
      }
    } catch {
      // Projects dir not readable
    }
  }

  return results;
}

function checkProjectCompliance(): ProjectCompliance[] {
  const results: ProjectCompliance[] = [];
  const projectsDir = path.join(VAULT_PATH, 'Projects');

  if (!fs.existsSync(projectsDir)) return results;

  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const mainFile = path.join(projectsDir, entry.name, `${entry.name}.md`);
      if (!fs.existsSync(mainFile)) continue;

      try {
        const content = fs.readFileSync(mainFile, 'utf-8');
        const missing: string[] = [];

        for (const section of REQUIRED_PROJECT_SECTIONS) {
          // Look for ## Section or # Section headers
          const pattern = new RegExp(`^#{1,3}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
          if (!pattern.test(content)) {
            missing.push(section);
          }
        }

        results.push({ project: entry.name, missingSections: missing });
      } catch {
        results.push({ project: entry.name, missingSections: ['(file unreadable)'] });
      }
    }
  } catch {
    // Projects dir not readable
  }

  return results;
}

function findOrphanedFiles(): string[] {
  // Get all .md files excluding audit dirs, templates, daily notes
  const allFiles = getAllMdFiles(VAULT_PATH, ORPHAN_EXCLUDE_DIRS);

  // Read all file contents and extract wikilink targets
  const linkedNames = new Set<string>();

  for (const filePath of allFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Extract wikilink targets: [[target]], [[target|alias]], [[target#heading]]
      const wikilinks = content.matchAll(/\[\[([^\]|#]+)/g);
      for (const match of wikilinks) {
        linkedNames.add(match[1].trim().toLowerCase());
      }

      // Extract markdown link targets: [text](path.md) or [text](path)
      const mdLinks = content.matchAll(/\]\(([^)]+\.md)\)/g);
      for (const match of mdLinks) {
        const target = path.basename(match[1], '.md');
        linkedNames.add(target.toLowerCase());
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Find files not referenced anywhere
  const orphaned: string[] = [];

  for (const filePath of allFiles) {
    const basename = path.basename(filePath, '.md');
    const relPath = path.relative(VAULT_PATH, filePath).replace(/\\/g, '/');

    // Skip excluded files
    if (ORPHAN_EXCLUDE_FILES.includes(path.basename(filePath))) continue;

    // Skip if linked
    if (linkedNames.has(basename.toLowerCase())) continue;

    orphaned.push(relPath);
  }

  return orphaned;
}

function getGitStatus(): string {
  try {
    const output = execSync('git status --porcelain', {
      cwd: VAULT_PATH,
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });

    if (!output.trim()) return 'Clean - no uncommitted changes.';

    const lines = output.trim().split('\n');
    const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
    const untracked = lines.filter(l => l.startsWith('??')).length;
    const added = lines.filter(l => l.startsWith('A ')).length;
    const deleted = lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).length;

    const parts: string[] = [];
    if (modified > 0) parts.push(`${modified} modified`);
    if (untracked > 0) parts.push(`${untracked} untracked`);
    if (added > 0) parts.push(`${added} added`);
    if (deleted > 0) parts.push(`${deleted} deleted`);

    return `${parts.join(', ')} (${lines.length} total changes)`;
  } catch (err) {
    return `Error checking git status: ${err}`;
  }
}

function getTasksHealth(): TaskSection[] {
  const tasksPath = path.join(VAULT_PATH, 'Tasks.md');
  if (!fs.existsSync(tasksPath)) return [];

  try {
    const content = fs.readFileSync(tasksPath, 'utf-8');
    const lines = content.split('\n');
    const sections: TaskSection[] = [];

    let currentSection = '';

    for (const line of lines) {
      // Match section headers like: ## Active -- Project Name
      const sectionMatch = line.match(/^##\s+(.+)/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        sections.push({ section: currentSection, open: 0, completed: 0 });
        continue;
      }

      if (!currentSection || sections.length === 0) continue;

      const current = sections[sections.length - 1];

      if (line.match(/^-\s+\[\s\]/)) {
        current.open++;
      } else if (line.match(/^-\s+\[x\]/i)) {
        current.completed++;
      }
    }

    return sections;
  } catch {
    return [];
  }
}

// -- Main -------------------------------------------------------------------

function run(): void {
  const now = new Date();
  const reportDate = now.toISOString().split('T')[0];

  console.log(`Running vault integrity audit for ${reportDate}...`);

  // Gather data
  const structure = checkStructure();
  const compliance = checkProjectCompliance();
  const orphaned = findOrphanedFiles();
  const gitStatus = getGitStatus();
  const tasks = getTasksHealth();

  // Collect flags
  const allFlags: string[] = [];

  const missingStructure = structure.filter(s => !s.found);
  if (missingStructure.length > 0) {
    for (const s of missingStructure) {
      allFlags.push(`[Structure] Missing: ${s.item} (expected ${s.expected})`);
    }
  }

  const nonCompliant = compliance.filter(c => c.missingSections.length > 0);
  if (nonCompliant.length > 0) {
    for (const c of nonCompliant) {
      allFlags.push(`[Template] ${c.project} missing: ${c.missingSections.join(', ')}`);
    }
  }

  if (orphaned.length > 0) {
    allFlags.push(`[Orphaned] ${orphaned.length} files not linked from anywhere (informational)`);
  }

  if (!gitStatus.startsWith('Clean')) {
    allFlags.push(`[Git] ${gitStatus}`);
  }

  const status = allFlags.some(f => !f.includes('informational')) && allFlags.length > 0 ? 'flagged' : 'clean';

  // -- Generate markdown ----------------------------------------------------

  let md = `---
type: audit
tags: [audit, vault-integrity]
created: ${reportDate}
status: ${status}
---

# Vault Integrity Audit - ${reportDate}

## Structure Check
| Item | Expected | Found | Status |
|------|----------|-------|--------|
`;

  for (const s of structure) {
    md += `| ${s.item} | ${s.expected} | ${s.found ? 'Yes' : 'No'} | ${s.found ? 'OK' : 'MISSING'} |\n`;
  }

  md += `
## Project Template Compliance
| Project | Missing Sections | Status |
|---------|-----------------|--------|
`;

  if (compliance.length === 0) {
    md += `| (no projects found) | - | - |\n`;
  } else {
    for (const c of compliance) {
      const missingStr = c.missingSections.length === 0 ? 'None' : c.missingSections.join(', ');
      const compStatus = c.missingSections.length === 0 ? 'OK' : 'INCOMPLETE';
      md += `| ${c.project} | ${missingStr} | ${compStatus} |\n`;
    }
  }

  md += `
## Orphaned Files
`;

  if (orphaned.length === 0) {
    md += `None found.\n`;
  } else {
    for (const o of orphaned) {
      md += `- ${o}\n`;
    }
  }

  md += `
## Git Status
${gitStatus}
`;

  md += `
## Tasks Summary
| Section | Open | Completed |
|---------|------|-----------|
`;

  if (tasks.length === 0) {
    md += `| (no sections found) | - | - |\n`;
  } else {
    for (const t of tasks) {
      md += `| ${t.section} | ${t.open} | ${t.completed} |\n`;
    }
  }

  md += `
## Flags
`;

  if (allFlags.length === 0) {
    md += `No flags - all clear.\n`;
  } else {
    for (const flag of allFlags) {
      md += `- ${flag}\n`;
    }
  }

  // -- Write to vault -------------------------------------------------------

  const outputPath = path.join(VAULT_PATH, 'Audits', 'Vault Integrity', `${reportDate} - Vault Integrity.md`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md, 'utf-8');

  console.log(`Vault integrity audit written to: ${outputPath}`);

  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "vault integrity audit - ${reportDate}"`, {
      cwd: VAULT_PATH,
      stdio: 'pipe',
      windowsHide: true,
    });
    console.log('Vault commit done.');
  } catch (err) {
    console.error('Vault commit failed (non-fatal):', err);
  }

  console.log('Vault integrity audit complete.');

  if (process.argv.includes('--notify')) {
    if (allFlags.length > 0) {
      notify(`Vault Integrity: ${allFlags.length} flags. ${allFlags.slice(0, 3).join(' | ')}`);
    } else {
      notify('Vault Integrity: all clear.');
    }
  }
}

run();
