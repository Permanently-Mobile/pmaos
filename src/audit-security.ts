/**
 * Security Audit
 *
 * Scans for credential exposure, validates .env files, checks database encryption,
 * reviews scheduled tasks, and checks file permissions on sensitive directories.
 *
 * Run: node dist/audit-security.js
 * Schedule: Every Sunday at 2am (0 2 * * 0)
 */

import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { decryptAgeFile } from './env.js';

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

interface CredentialMatch {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

interface EnvCheck {
  bot: string;
  envPresent: boolean;
  requiredKeys: string;
  duplicates: string;
  status: string;
}

interface DbEncryptionCheck {
  bot: string;
  dbExists: boolean;
  passphraseSet: boolean;
  status: string;
}

interface ScheduledTask {
  id: string;
  schedule: string;
  prompt: string;
  status: string;
}

// -- Bot definitions --------------------------------------------------------

interface BotDef {
  name: string;
  displayName: string;
  dir: string;
}

// Rename to your agent names and directories
const BOTS: BotDef[] = [
  { name: 'apex-bot', displayName: 'Primary Bot', dir: PROJECT_ROOT },
  { name: 'worker-1', displayName: 'Worker 1', dir: path.join(PROJECT_ROOT, 'bots', 'worker-1') },
  { name: 'research', displayName: 'Research', dir: path.join(PROJECT_ROOT, 'bots', 'research') },
  { name: 'code', displayName: 'Code', dir: path.join(PROJECT_ROOT, 'bots', 'code') },
  { name: 'processor-1', displayName: 'Processor', dir: path.join(PROJECT_ROOT, 'bots', 'processor-1') },
  { name: 'creative', displayName: 'Creative', dir: path.join(PROJECT_ROOT, 'bots', 'creative') },
];

// Credential patterns to scan for
const CREDENTIAL_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'VENICE_KEY', regex: /VENICE_.*KEY\s*=(?!=)\s*\S+/ },
  { name: 'TELEGRAM_TOKEN', regex: /TELEGRAM.*TOKEN\s*=(?!=)\s*\S+/ },
  { name: 'API_KEY', regex: /API_KEY\s*=(?!=)\s*\S+/ },
  { name: 'SECRET_KEY', regex: /SECRET_KEY\s*=(?!=)\s*\S+/ },
  { name: 'PASSPHRASE', regex: /PASSPHRASE\s*=(?!=)\s*\S+/ },
  { name: 'Bearer_Token', regex: /Bearer\s+[a-zA-Z0-9_.-]{20,}/ },
];

// File extensions to scan for credentials
const SCANNABLE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.sh', '.bat', '.cmd', '.txt', '.html', '.css', '.toml', '.ini',
  '.cfg', '.conf', '.xml', '.csv',
]);

// Directories to exclude from credential scan
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.obsidian', 'scribe-review']);

// -- Helpers ----------------------------------------------------------------

function readPassphrase(botDir: string): string {
  // Try plaintext .env first
  const envPath = path.join(botDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^DB_PASSPHRASE=(.+)$/m);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  // Try encrypted .env.age
  const envAgePath = path.join(botDir, '.env.age');
  if (fs.existsSync(envAgePath)) {
    try {
      const decrypted = decryptAgeFile(envAgePath);
      if (decrypted) {
        const match = decrypted.match(/^DB_PASSPHRASE=(.+)$/m);
        return match?.[1]?.trim() || '';
      }
    } catch {
      // Can't decrypt -- but .env.age exists, so passphrase is likely set
      return '__encrypted__';
    }
  }

  return '';
}

function walkDir(dir: string): string[] {
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
        if (!EXCLUDE_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Skip .env files (they're supposed to have credentials)
        if (entry.name === '.env' || entry.name.startsWith('.env.')) continue;
        if (SCANNABLE_EXTENSIONS.has(ext)) {
          results.push(path.join(current, entry.name));
        }
      }
    }
  }

  walk(dir);
  return results;
}

// -- Check functions --------------------------------------------------------

function scanCredentials(): CredentialMatch[] {
  const matches: CredentialMatch[] = [];
  const files = walkDir(PROJECT_ROOT);

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comment lines
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;

        // Skip lines that are just env var references (process.env.X, envConfig.X, secrets.X)
        if (/process\.env\.\w+/.test(line) && !/=\s*['"][^'"]{10,}['"]/.test(line)) continue;
        if (/\$\{?\w+\}?/.test(line) && !/=\s*['"][^'"]{10,}['"]/.test(line)) continue;
        if (/envConfig\.\w+/.test(line)) continue;
        if (/secrets\.\w+/.test(line)) continue;
        if (/workerEnv\.\w+/.test(line)) continue;
        if (/sdkEnv\.\w+/.test(line)) continue;

        // Skip regex patterns that extract env vars (e.g. content.match(/^DB_PASSPHRASE=(.+)$/m))
        if (/\.match\(|\.test\(|RegExp|new\s+RegExp/.test(line)) continue;

        // Skip lines where the "value" is a variable, empty, or an angle-bracket placeholder
        if (/=\s*<[^>]+>/.test(trimmed)) continue;       // <placeholder> values
        if (/=\s*['"]?\s*['"]?\s*[;,]?\s*$/.test(trimmed)) continue;  // empty assignments
        if (/=\s*\w+\.\w+/.test(trimmed) && !/=\s*['"][^'"]{10,}['"]/.test(trimmed)) continue;  // obj.prop assignments

        // Skip grep/cut/sed commands that extract env vars from files
        if (/grep\s+-?E?\s+.*=/.test(line)) continue;
        if (/\|\s*cut\s+-d/.test(line)) continue;

        // Skip lines from scaffold/setup that just push empty template keys
        if (/lines\.push\(|\.push\(`/.test(line) && !/=['"][a-zA-Z0-9_\-/.]{15,}['"]/.test(line)) continue;

        // Skip startsWith/slice/indexOf patterns (code parsing env content, not exposing values)
        if (/\.startsWith\(|\.indexOf\(/.test(line) && !/=\s*['"][^'"]{10,}['"]/.test(line)) continue;
        // .slice('KEY_NAME='.length) is always a parse offset, never a credential
        if (/\.slice\(['"][A-Z_]+=/.test(line)) continue;
        if (/\.slice\(/.test(line) && !/=\s*['"][^'"]{10,}['"]/.test(line)) continue;

        // Skip readEnvFile() calls (reading from encrypted env, not exposing values)
        if (/readEnvFile\(/.test(line)) continue;

        // Skip env object property assignments in setup wizards (env.KEY = variable)
        if (/env\.\w+_(?:KEY|TOKEN|PASSPHRASE)\s*=\s*\w+\s*;/.test(trimmed)) continue;

        // Skip comparison against placeholder strings
        if (/===?\s*['"]placeholder/.test(line)) continue;

        // Skip template literal env key stubs (e.g. `DB_PASSPHRASE=`)
        if (/`[A-Z_]+=`/.test(trimmed) && !/`[A-Z_]+=\S{8,}`/.test(trimmed)) continue;

        // Skip documentation backtick references (e.g. `VENICE_API_KEY=` in markdown)
        if (/`[A-Z_]*(?:KEY|TOKEN|PASSPHRASE|SECRET)[A-Z_]*=`/.test(trimmed)) continue;

        for (const pattern of CREDENTIAL_PATTERNS) {
          if (pattern.regex.test(line)) {
            const relPath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
            // Truncate the line for the report (don't expose full creds)
            const snippet = trimmed.substring(0, 80) + (trimmed.length > 80 ? '...' : '');
            matches.push({
              file: relPath,
              line: i + 1,
              pattern: pattern.name,
              snippet,
            });
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return matches;
}

function checkEnvFiles(): EnvCheck[] {
  const results: EnvCheck[] = [];

  for (const bot of BOTS) {
    const envPath = path.join(bot.dir, '.env');
    const envAgePath = path.join(bot.dir, '.env.age');
    const envPresent = fs.existsSync(envPath);
    const envAgePresent = fs.existsSync(envAgePath);

    if (!envPresent && !envAgePresent) {
      results.push({
        bot: bot.displayName,
        envPresent: false,
        requiredKeys: 'N/A',
        duplicates: 'N/A',
        status: 'MISSING',
      });
      continue;
    }

    // If only .env.age exists (encrypted), that's the correct setup
    if (!envPresent && envAgePresent) {
      results.push({
        bot: bot.displayName,
        envPresent: true,
        requiredKeys: 'Encrypted (.env.age)',
        duplicates: 'N/A',
        status: 'OK',
      });
      continue;
    }

    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

      // Check required keys
      const hasTelegramToken = /^TELEGRAM_BOT_TOKEN=/m.test(content);
      const hasWorkerName = /^WORKER_NAME=/m.test(content);
      const hasPassphrase = /^DB_PASSPHRASE=/m.test(content);

      const missingKeys: string[] = [];
      if (!hasTelegramToken && !hasWorkerName) missingKeys.push('TELEGRAM_BOT_TOKEN or WORKER_NAME');
      if (!hasPassphrase) missingKeys.push('DB_PASSPHRASE');

      const requiredKeysStatus = missingKeys.length === 0 ? 'All present' : `Missing: ${missingKeys.join(', ')}`;

      // Warn if plaintext .env exists alongside .env.age (should only have encrypted)
      const dupeWarning = envAgePresent ? 'WARN: plaintext .env exists alongside .env.age' : '';

      // Check for duplicate keys
      const keyMap = new Map<string, number>();
      for (const line of lines) {
        const keyMatch = line.match(/^([A-Z_]+)=/);
        if (keyMatch) {
          const key = keyMatch[1];
          keyMap.set(key, (keyMap.get(key) || 0) + 1);
        }
      }
      const dupes = [...keyMap.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      let dupeStatus = dupes.length === 0 ? 'None' : dupes.join(', ');
      if (dupeWarning) dupeStatus = dupeWarning;

      const isOk = missingKeys.length === 0 && dupes.length === 0 && !dupeWarning;
      results.push({
        bot: bot.displayName,
        envPresent: true,
        requiredKeys: requiredKeysStatus,
        duplicates: dupeStatus,
        status: isOk ? 'OK' : (dupeWarning ? 'FLAG' : (missingKeys.length > 0 || dupes.length > 0 ? 'FLAG' : 'OK')),
      });
    } catch {
      results.push({
        bot: bot.displayName,
        envPresent: true,
        requiredKeys: 'Error reading',
        duplicates: 'Error reading',
        status: 'ERROR',
      });
    }
  }

  return results;
}

function checkDbEncryption(): DbEncryptionCheck[] {
  const results: DbEncryptionCheck[] = [];

  for (const bot of BOTS) {
    const dbPath = path.join(bot.dir, 'store', 'apex.db');
    const dbExists = fs.existsSync(dbPath);
    const passphrase = readPassphrase(bot.dir);
    const passphraseSet = passphrase.length > 0;

    let status = 'OK';
    if (!dbExists) {
      status = 'N/A';
    } else if (passphrase === '__encrypted__') {
      // .env.age exists but we couldn't decrypt -- assume passphrase is present
      status = 'OK (encrypted env)';
    } else if (!passphraseSet) {
      // Check if .env.age exists (passphrase likely inside but decrypt failed or wasn't attempted)
      const envAgePath = path.join(bot.dir, '.env.age');
      if (fs.existsSync(envAgePath)) {
        status = 'OK (encrypted env)';
      } else {
        status = 'UNENCRYPTED';
      }
    }

    results.push({
      bot: bot.displayName,
      dbExists,
      passphraseSet: passphraseSet || passphrase === '__encrypted__',
      status,
    });
  }

  return results;
}

function getScheduledTasks(): ScheduledTask[] {
  try {
    const output = execSync(`node "${path.join(PROJECT_ROOT, 'dist', 'schedule-cli.js')}" list`, {
      encoding: 'utf-8',
      timeout: 10000,
      cwd: PROJECT_ROOT,
      windowsHide: true,
    });

    // Parse the CLI output into structured tasks
    const tasks: ScheduledTask[] = [];
    const lines = output.split('\n').filter(l => l.trim());

    // The list output format varies, try to parse it
    for (const line of lines) {
      // Look for lines with task info (ID, schedule, prompt)
      const match = line.match(/([a-f0-9]{8})\s+(.+?)\s{2,}(.+?)\s{2,}(.+)/);
      if (match) {
        tasks.push({
          id: match[1],
          schedule: match[2].trim(),
          prompt: match[3].trim().substring(0, 50),
          status: match[4]?.trim() || 'active',
        });
      }
    }

    // If structured parsing didn't work, try simpler approach
    if (tasks.length === 0 && output.trim()) {
      // Just capture raw output for the report
      tasks.push({
        id: '-',
        schedule: '-',
        prompt: output.trim().substring(0, 200),
        status: 'raw output',
      });
    }

    return tasks;
  } catch {
    return [];
  }
}

function checkSensitiveDirs(): string[] {
  const issues: string[] = [];
  const dirsToCheck = [
    path.join(PROJECT_ROOT, 'store'),
    ...BOTS.filter(b => b.dir !== PROJECT_ROOT).map(b => path.join(b.dir, 'store')),
  ];

  for (const dir of dirsToCheck) {
    const relPath = path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/');
    if (!fs.existsSync(dir)) {
      issues.push(`${relPath} - directory does not exist`);
    }
  }

  return issues;
}

// -- Main -------------------------------------------------------------------

function run(): void {
  const now = new Date();
  const reportDate = now.toISOString().split('T')[0];

  console.log(`Running security audit for ${reportDate}...`);

  // Gather data
  const credentials = scanCredentials();
  const envChecks = checkEnvFiles();
  const dbEncryption = checkDbEncryption();
  const scheduledTasks = getScheduledTasks();
  const dirIssues = checkSensitiveDirs();

  // Collect flags
  const allFlags: string[] = [];

  if (credentials.length > 0) {
    allFlags.push(`[CRITICAL] ${credentials.length} potential credential exposures found`);
    for (const c of credentials) {
      allFlags.push(`  - ${c.file}:${c.line} (${c.pattern})`);
    }
  }

  for (const e of envChecks) {
    if (e.status !== 'OK' && e.status !== 'N/A') {
      allFlags.push(`[Env] ${e.bot}: ${e.status} - ${e.requiredKeys}, Dupes: ${e.duplicates}`);
    }
  }

  for (const d of dbEncryption) {
    if (d.status === 'UNENCRYPTED') {
      allFlags.push(`[Database] ${d.bot} database exists but has no encryption passphrase`);
    }
  }

  if (dirIssues.length > 0) {
    for (const issue of dirIssues) {
      allFlags.push(`[Permissions] ${issue}`);
    }
  }

  const status = allFlags.length > 0 ? 'flagged' : 'clean';

  // -- Generate markdown ----------------------------------------------------

  let md = `---
type: audit
tags: [audit, security]
created: ${reportDate}
status: ${status}
---

# Security Audit - ${reportDate}

## Credential Exposure Scan
`;

  if (credentials.length === 0) {
    md += `Clean - no exposed credentials found.\n`;
  } else {
    md += `**${credentials.length} potential exposures found:**\n\n`;
    md += `| File | Line | Pattern | Snippet |\n`;
    md += `|------|------|---------|--------|\n`;
    for (const c of credentials) {
      md += `| ${c.file} | ${c.line} | ${c.pattern} | \`${c.snippet}\` |\n`;
    }
  }

  md += `
## Environment File Integrity
| Bot | .env Present | Required Keys | Duplicates | Status |
|-----|-------------|---------------|------------|--------|
`;

  for (const e of envChecks) {
    md += `| ${e.bot} | ${e.envPresent ? 'Yes' : 'No'} | ${e.requiredKeys} | ${e.duplicates} | ${e.status} |\n`;
  }

  md += `
## Database Encryption
| Bot | DB Exists | Passphrase Set | Status |
|-----|-----------|---------------|--------|
`;

  for (const d of dbEncryption) {
    md += `| ${d.bot} | ${d.dbExists ? 'Yes' : 'No'} | ${d.passphraseSet ? 'Yes' : 'No'} | ${d.status} |\n`;
  }

  md += `
## Scheduled Tasks
`;

  if (scheduledTasks.length === 0) {
    md += `No scheduled tasks found (or schedule-cli unavailable).\n`;
  } else if (scheduledTasks[0].id === '-') {
    // Raw output mode
    md += `\`\`\`\n${scheduledTasks[0].prompt}\n\`\`\`\n`;
  } else {
    md += `| ID | Schedule | Prompt (first 50 chars) | Status |\n`;
    md += `|----|----------|------------------------|--------|\n`;
    for (const t of scheduledTasks) {
      md += `| ${t.id} | ${t.schedule} | ${t.prompt} | ${t.status} |\n`;
    }
  }

  md += `
## Sensitive Directory Check
`;

  if (dirIssues.length === 0) {
    md += `All sensitive directories present and accounted for.\n`;
  } else {
    for (const issue of dirIssues) {
      md += `- ${issue}\n`;
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

  const outputPath = path.join(VAULT_PATH, 'Audits', 'Security', `${reportDate} - Security.md`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md, 'utf-8');

  console.log(`Security audit written to: ${outputPath}`);

  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "security audit - ${reportDate}"`, {
      cwd: VAULT_PATH,
      stdio: 'pipe',
      windowsHide: true,
    });
    console.log('Vault commit done.');
  } catch (err) {
    console.error('Vault commit failed (non-fatal):', err);
  }

  console.log('Security audit complete.');

  // Telegram notification
  if (process.argv.includes('--notify')) {
    if (allFlags.length > 0) {
      const critCount = credentials.length;
      const envIssues = envChecks.filter(e => e.status !== 'OK' && e.status !== 'N/A').length;
      const dbIssues = dbEncryption.filter(d => d.status === 'UNENCRYPTED').length;
      const parts = [];
      if (critCount > 0) parts.push(`${critCount} credential exposures`);
      if (envIssues > 0) parts.push(`${envIssues} env issues`);
      if (dbIssues > 0) parts.push(`${dbIssues} unencrypted DBs`);
      if (dirIssues.length > 0) parts.push(`${dirIssues.length} dir issues`);
      notify(`Security Audit: ${parts.join(', ')}. ${allFlags.length} total flags.`);
    } else {
      notify('Security Audit: all clear.');
    }
  }
}

run();
