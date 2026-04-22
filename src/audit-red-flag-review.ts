/**
 * Weekly Red Flag Review
 *
 * Reads all audit results from the past 7 days, extracts any flags, and
 * writes a summary to today's Daily Note (Log section).
 *
 * Run: node dist/audit-red-flag-review.js
 * Schedule: Every Monday at 10am (0 10 * * 1)
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

const AUDIT_SUBFOLDERS = ['API Usage', 'Service Health', 'Vault Integrity', 'Security', 'Bridge Health', 'Pipeline Health', 'Network Config'];

// -- Types ------------------------------------------------------------------

interface AuditFlag {
  auditType: string;
  auditDate: string;
  flags: string[];
}

// -- Helpers ----------------------------------------------------------------

function parseDate(dateStr: string): Date | null {
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const d = new Date(match[1] + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function isWithinLastDays(dateStr: string, days: number): boolean {
  const d = parseDate(dateStr);
  if (!d) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return d >= cutoff;
}

function extractFlags(content: string): string[] {
  // Find the ## Flags section and extract its content
  const flagsMatch = content.match(/^## Flags\s*\n([\s\S]*?)(?=^## |\Z)/m);
  if (!flagsMatch) return [];

  const flagsSection = flagsMatch[1].trim();

  // Check for "all clear" variants
  if (/no flags|all clear/i.test(flagsSection)) return [];

  // Extract bullet points
  const flags: string[] = [];
  const lines = flagsSection.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && trimmed.length > 2) {
      flags.push(trimmed.substring(2));
    }
  }

  return flags;
}

function getRecentAudits(): AuditFlag[] {
  const results: AuditFlag[] = [];

  for (const subfolder of AUDIT_SUBFOLDERS) {
    const dirPath = path.join(VAULT_PATH, 'Audits', subfolder);
    if (!fs.existsSync(dirPath)) continue;

    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));

      for (const file of files) {
        // Extract date from filename: "2026-03-06 - Service Health.md"
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;

        const auditDate = dateMatch[1];
        if (!isWithinLastDays(auditDate, 7)) continue;

        try {
          const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const flags = extractFlags(content);

          if (flags.length > 0) {
            results.push({
              auditType: subfolder,
              auditDate,
              flags,
            });
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return results;
}

function countRecentAudits(): number {
  let count = 0;

  for (const subfolder of AUDIT_SUBFOLDERS) {
    const dirPath = path.join(VAULT_PATH, 'Audits', subfolder);
    if (!fs.existsSync(dirPath)) continue;

    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && isWithinLastDays(dateMatch[1], 7)) {
          count++;
        }
      }
    } catch {
      // Skip
    }
  }

  return count;
}

function ensureDailyNote(dateStr: string): string {
  const notePath = path.join(VAULT_PATH, 'Daily Notes', `${dateStr}.md`);

  if (fs.existsSync(notePath)) return notePath;

  // Create from template structure
  const dayName = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  const template = `---
type: daily-note
date: ${dateStr}
---

# ${dateStr} - ${dayName}

## Tasks
- [ ]

## Notes

## Log

## Personal Notes
`;

  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, template, 'utf-8');
  return notePath;
}

function appendToLogSection(notePath: string, content: string): void {
  const existing = fs.readFileSync(notePath, 'utf-8');

  // Idempotency: skip if a Red Flag Review already exists in this file
  if (existing.includes('### Red Flag Review')) {
    console.log('Red Flag Review already present in daily note, skipping duplicate append');
    return;
  }

  // Find the ## Log section
  const logIndex = existing.indexOf('## Log');
  if (logIndex === -1) {
    // No Log section found, append at end
    fs.writeFileSync(notePath, existing + '\n## Log\n' + content + '\n', 'utf-8');
    return;
  }

  // Find the end of the Log section (next ## heading or end of file)
  const afterLog = existing.substring(logIndex + '## Log'.length);
  const nextSectionMatch = afterLog.match(/\n## /);

  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    // Insert before the next section
    const insertPoint = logIndex + '## Log'.length + nextSectionMatch.index;
    const before = existing.substring(0, insertPoint);
    const after = existing.substring(insertPoint);
    fs.writeFileSync(notePath, before + '\n' + content + '\n' + after, 'utf-8');
  } else {
    // No next section, append to end of Log
    const insertPoint = logIndex + '## Log'.length;
    const before = existing.substring(0, insertPoint);
    const after = existing.substring(insertPoint);
    fs.writeFileSync(notePath, before + after + '\n' + content + '\n', 'utf-8');
  }
}

// -- Main -------------------------------------------------------------------

function run(): void {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const reportDate = `${y}-${m}-${d}`;

  console.log(`Running red flag review for ${reportDate}...`);

  const totalAudits = countRecentAudits();
  const flaggedAudits = getRecentAudits();

  // Build the review content
  let review = `\n### Red Flag Review\nReviewed ${totalAudits} audits from the past 7 days.\n\n`;

  if (flaggedAudits.length === 0) {
    review += `All clear - no red flags this week.\n`;
  } else {
    review += `Flags found:\n`;
    for (const audit of flaggedAudits) {
      for (const flag of audit.flags) {
        review += `- [${audit.auditType} ${audit.auditDate}] ${flag}\n`;
      }
    }
  }

  // Write to today's Daily Note
  const notePath = ensureDailyNote(reportDate);
  appendToLogSection(notePath, review);

  console.log(`Red flag review appended to: ${notePath}`);

  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "weekly red flag review - ${reportDate}"`, {
      cwd: VAULT_PATH,
      stdio: 'pipe',
      windowsHide: true,
    });
    console.log('Vault commit done.');
  } catch (err) {
    console.error('Vault commit failed (non-fatal):', err);
  }

  console.log('Red flag review complete.');

  if (process.argv.includes('--notify')) {
    const totalFlags = flaggedAudits.reduce((sum, a) => sum + a.flags.length, 0);
    if (totalFlags > 0) {
      const auditTypes = flaggedAudits.map(a => a.auditType).join(', ');
      notify(`Red Flag Review: ${totalFlags} flags across ${flaggedAudits.length} audits (${auditTypes}). Check daily note.`);
    } else {
      notify(`Red Flag Review: ${totalAudits} audits reviewed. All clear.`);
    }
  }
}

run();
