/**
 * Skill Supply Chain Canary System
 *
 * Monitors installed Claude Code skills for unauthorized modifications.
 * Creates cryptographic hashes of all skill files at install time,
 * then periodically verifies integrity. Any change triggers an alert.
 *
 * How it works:
 * 1. `registerSkill(skillDir)` - hashes all files, stores in canary DB
 * 2. `verifyAllSkills()` - re-hashes and compares, reports tampering
 * 3. Runs as part of the weekly security audit
 *
 * Protects against:
 * - Skill file modification after install (supply chain attack)
 * - Unauthorized new files added to skill directories
 * - Removed files (skill components deleted)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { logger } from './logger.js';

const PROJECT_ROOT = process.env.APEX_ROOT || process.cwd();
const VAULT_ROOT = process.env.VAULT_ROOT || '';
const SKILLS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills');
const CANARY_DB = path.join(PROJECT_ROOT, 'store', 'skill-canaries.json');

// ── Types ────────────────────────────────────────────────────────────

interface FileHash {
  path: string;      // relative to skill dir
  sha256: string;
  size: number;
  mtime: string;
}

interface SkillCanary {
  name: string;
  registeredAt: string;
  lastVerified: string;
  files: FileHash[];
  overallHash: string;   // hash of all file hashes combined
}

interface CanaryDB {
  version: 1;
  skills: Record<string, SkillCanary>;
}

interface VerifyResult {
  skill: string;
  status: 'ok' | 'tampered' | 'missing' | 'new_skill';
  issues: string[];
}

// ── Database ─────────────────────────────────────────────────────────

function loadDB(): CanaryDB {
  try {
    return JSON.parse(fs.readFileSync(CANARY_DB, 'utf-8'));
  } catch {
    return { version: 1, skills: {} };
  }
}

function saveDB(db: CanaryDB): void {
  const dir = path.dirname(CANARY_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CANARY_DB, JSON.stringify(db, null, 2));
}

// ── Hashing ──────────────────────────────────────────────────────────

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hashDirectory(dirPath: string): FileHash[] {
  const hashes: FileHash[] = [];

  function walk(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip node_modules, .git, __pycache__
        if (['node_modules', '.git', '__pycache__', '.venv'].includes(entry.name)) continue;
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        hashes.push({
          path: relPath,
          sha256: hashFile(fullPath),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }

  walk(dirPath, '');
  return hashes.sort((a, b) => a.path.localeCompare(b.path));
}

function computeOverallHash(files: FileHash[]): string {
  const combined = files.map(f => `${f.path}:${f.sha256}`).join('\n');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Register a skill in the canary system.
 * Call this after a skill passes the scanner and is installed.
 */
export function registerSkill(skillName: string): void {
  const skillDir = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(skillDir)) {
    logger.error(`[canary] Skill directory not found: ${skillDir}`);
    return;
  }

  const db = loadDB();
  const files = hashDirectory(skillDir);
  const overallHash = computeOverallHash(files);

  db.skills[skillName] = {
    name: skillName,
    registeredAt: new Date().toISOString(),
    lastVerified: new Date().toISOString(),
    files,
    overallHash,
  };

  saveDB(db);
  logger.info(`[canary] Registered skill: ${skillName} (${files.length} files, hash: ${overallHash.slice(0, 12)})`);
}

/**
 * Register all currently installed skills.
 * Run once to bootstrap the canary database.
 */
export function registerAllSkills(): number {
  if (!fs.existsSync(SKILLS_DIR)) {
    logger.warn('[canary] Skills directory not found');
    return 0;
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      registerSkill(entry.name);
      count++;
    }
  }

  logger.info(`[canary] Registered ${count} skills`);
  return count;
}

/**
 * Verify integrity of all registered skills.
 * Returns list of results with status and any detected issues.
 */
export function verifyAllSkills(): VerifyResult[] {
  const db = loadDB();
  const results: VerifyResult[] = [];

  // Check registered skills
  for (const [name, canary] of Object.entries(db.skills)) {
    const skillDir = path.join(SKILLS_DIR, name);

    if (!fs.existsSync(skillDir)) {
      results.push({
        skill: name,
        status: 'missing',
        issues: [`Skill directory removed: ${skillDir}`],
      });
      continue;
    }

    const currentFiles = hashDirectory(skillDir);
    const currentHash = computeOverallHash(currentFiles);
    const issues: string[] = [];

    if (currentHash !== canary.overallHash) {
      // Find specific changes
      const registeredMap = new Map(canary.files.map(f => [f.path, f]));
      const currentMap = new Map(currentFiles.map(f => [f.path, f]));

      // Check for modified files
      for (const [filePath, current] of currentMap) {
        const registered = registeredMap.get(filePath);
        if (!registered) {
          issues.push(`NEW file: ${filePath}`);
        } else if (registered.sha256 !== current.sha256) {
          issues.push(`MODIFIED: ${filePath} (hash changed)`);
        }
      }

      // Check for deleted files
      for (const filePath of registeredMap.keys()) {
        if (!currentMap.has(filePath)) {
          issues.push(`DELETED: ${filePath}`);
        }
      }

      results.push({ skill: name, status: 'tampered', issues });
    } else {
      results.push({ skill: name, status: 'ok', issues: [] });
    }

    // Update last verified timestamp
    canary.lastVerified = new Date().toISOString();
  }

  // Check for unregistered skills
  if (fs.existsSync(SKILLS_DIR)) {
    const installed = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const name of installed) {
      if (!db.skills[name]) {
        results.push({
          skill: name,
          status: 'new_skill',
          issues: [`Unregistered skill found: ${name}. Run registerSkill() to baseline it.`],
        });
      }
    }
  }

  saveDB(db);
  return results;
}

/**
 * Generate a report for vault/Telegram.
 */
export function generateCanaryReport(): { vaultReport: string; telegramSummary: string } {
  const results = verifyAllSkills();
  const date = new Date().toISOString().slice(0, 10);

  const tampered = results.filter(r => r.status === 'tampered');
  const missing = results.filter(r => r.status === 'missing');
  const newSkills = results.filter(r => r.status === 'new_skill');
  const ok = results.filter(r => r.status === 'ok');

  const lines: string[] = [];
  lines.push(`# Skill Integrity Report - ${date}`);
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| OK | ${ok.length} |`);
  lines.push(`| Tampered | ${tampered.length} |`);
  lines.push(`| Missing | ${missing.length} |`);
  lines.push(`| Unregistered | ${newSkills.length} |`);
  lines.push('');

  if (tampered.length > 0) {
    lines.push('## !! TAMPERED SKILLS');
    for (const r of tampered) {
      lines.push(`### ${r.skill}`);
      for (const issue of r.issues) {
        lines.push(`- ${issue}`);
      }
      lines.push('');
    }
  }

  if (missing.length > 0) {
    lines.push('## Missing Skills');
    for (const r of missing) {
      lines.push(`- ${r.skill}: ${r.issues.join(', ')}`);
    }
    lines.push('');
  }

  if (newSkills.length > 0) {
    lines.push('## Unregistered Skills');
    for (const r of newSkills) {
      lines.push(`- ${r.skill}: ${r.issues.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Verified Skills');
  for (const r of ok) {
    lines.push(`- ${r.skill}: OK`);
  }

  const vaultReport = lines.join('\n');

  // Telegram summary
  const tgLines: string[] = [];
  tgLines.push(`Skill Integrity Check - ${date}`);
  if (tampered.length > 0) {
    tgLines.push(`!! ${tampered.length} TAMPERED skill(s):`);
    for (const r of tampered) {
      tgLines.push(`  ${r.skill}: ${r.issues.length} change(s)`);
    }
  }
  if (missing.length > 0) tgLines.push(`${missing.length} missing skill(s)`);
  if (newSkills.length > 0) tgLines.push(`${newSkills.length} unregistered skill(s)`);
  tgLines.push(`${ok.length}/${results.length} skills verified OK`);

  return { vaultReport, telegramSummary: tgLines.join('\n') };
}

// ── Standalone ───────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('skill-canary.js')) {
  const cmd = process.argv[2];

  if (cmd === 'register') {
    const count = registerAllSkills();
    console.log(`Registered ${count} skills in canary system`);
  } else if (cmd === 'register-one') {
    const skillName = process.argv[3];
    if (!skillName) { console.log('Usage: node dist/skill-canary.js register-one <name>'); process.exit(1); }
    registerSkill(skillName);
    console.log(`Registered skill: ${skillName}`);
  } else if (cmd === 'verify') {
    const { vaultReport, telegramSummary } = generateCanaryReport();

    // Save report
    const date = new Date().toISOString().slice(0, 10);
    const reportDir = path.join(VAULT_ROOT, 'Audits', 'Security');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, `${date} - Skill Integrity.md`), vaultReport);

    console.log(telegramSummary);

    // Vault commit
    try {
      execSync(
        `bash "${path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh')}" "skill integrity check ${date}"`,
        { stdio: 'pipe', windowsHide: true },
      );
    } catch { /* non-fatal */ }

    // Notify if tampering found
    if (telegramSummary.includes('TAMPERED')) {
      try {
        execSync(
          `bash "${path.join(PROJECT_ROOT, 'scripts', 'notify.sh')}" "${telegramSummary.replace(/"/g, '\\"')}"`,
          { stdio: 'pipe', windowsHide: true },
        );
      } catch { /* non-fatal */ }
    }
  } else {
    console.log('Usage: node dist/skill-canary.js <register|verify>');
  }
}
