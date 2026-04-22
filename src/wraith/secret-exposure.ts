/**
 * AI Defense Scan Module: Secret Exposure Scanner
 *
 * Tests whether secrets leak through any channel: source code, logs,
 * databases, git history, .env files, and error handlers.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3-multiple-ciphers';
import { logger } from '../logger.js';
import { readEnvFile, decryptAgeFile } from '../env.js';
import { validatePath } from './scope.js';
import type { TargetScope, ScanConfig, ModuleResult, Finding, Severity } from './types.js';

const MODULE_NAME = 'secret-exposure';

// ── Secret Pattern Library ──────────────────────────────────────────

interface SecretPattern {
  name: string;
  regex: RegExp;
  severity: Severity;
  description: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/, severity: 'critical', description: 'AWS access key' },
  { name: 'aws-secret-key', regex: /[a-zA-Z0-9/+]{40}/, severity: 'high', description: 'AWS secret key candidate' },
  { name: 'github-pat', regex: /ghp_[a-zA-Z0-9]{36}/, severity: 'critical', description: 'GitHub personal access token' },
  { name: 'openai-key', regex: /sk-[a-zA-Z0-9]{48}/, severity: 'critical', description: 'OpenAI API key' },
  { name: 'slack-bot-token', regex: /xoxb-[0-9]{10,13}-[a-zA-Z0-9-]{24}/, severity: 'high', description: 'Slack bot token' },
  { name: 'private-key', regex: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/, severity: 'critical', description: 'Private key block' },
  { name: 'hardcoded-password', regex: /(password|passwd|pwd)\s*[=:]\s*['"][^'"]+['"]/, severity: 'high', description: 'Hardcoded password' },
  { name: 'api-key-assignment', regex: /(api[_-]?key|apikey|secret[_-]?key)\s*[=:]\s*['"][^'"]+['"]/, severity: 'high', description: 'API key assignment' },
  { name: 'hex-token-64', regex: /[0-9a-f]{64}/, severity: 'medium', description: 'Hex token (64 chars)' },
  { name: 'jwt-token', regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*/, severity: 'high', description: 'JWT token' },
  { name: 'telegram-token', regex: /\d{8,12}:[A-Za-z0-9_-]{30,}/, severity: 'critical', description: 'Telegram bot token' },
  { name: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/, severity: 'critical', description: 'Anthropic API key' },
  { name: 'age-secret-key', regex: /AGE-SECRET-KEY-[A-Z0-9]+/, severity: 'critical', description: 'Age encryption secret key' },
  { name: 'env-inline-secret', regex: /(API_KEY|SECRET_KEY|AUTH_TOKEN|DB_PASSPHRASE|PRIVATE_KEY)\s*=\s*\S{8,}/, severity: 'high', description: 'Inline env secret' },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude']);
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.sh', '.py', '.md']);

// ── Source Code Scanner ─────────────────────────────────────────────

function walkDir(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walkDir(fullPath, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SCAN_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function isCommentOrPattern(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) return true;
  if (trimmed.includes('regex') || trimmed.includes('RegExp') || trimmed.includes('pattern')) return true;
  if (trimmed.includes('REDACT') || trimmed.includes('redact') || trimmed.includes('sanitize')) return true;
  if (trimmed.includes('example') || trimmed.includes('EXAMPLE') || trimmed.includes('mock')) return true;
  if (trimmed.includes(': string') || trimmed.includes('interface ') || trimmed.includes('type ')) return true;
  if (trimmed.includes('test') || trimmed.includes('Test') || trimmed.includes('spec')) return true;
  // Regex parsing calls, not secrets
  if (trimmed.includes('.match(') || trimmed.includes('.exec(')) return true;
  // Env file reading, not hardcoding
  if (trimmed.includes('readEnvFile')) return true;
  // Env var references, not hardcoded values
  if (trimmed.includes('process.env.')) return true;
  // Template literals generating .env content (setup scripts)
  if (/`[^`]*\$\{(env\.|process\.env)/.test(trimmed)) return true;
  // SDK env forwarding (secrets.X = ...)
  if (/secrets\.\w+/.test(trimmed)) return true;
  // RegExp literal definitions (contain /^...=/ style patterns)
  if (/\/\^.*=\//.test(trimmed)) return true;
  // Env config object references (not hardcoded secrets)
  if (/\b(?:envConfig|workerEnv|sdkEnv)\.\w+/.test(trimmed)) return true;
  if (/\benv\.[A-Z][A-Z0-9_]+/.test(trimmed)) return true;
  return false;
}

/** Check whether surrounding lines contain AWS-related context */
function hasAwsContext(lines: string[], lineIdx: number): boolean {
  const start = Math.max(0, lineIdx - 5);
  const end = Math.min(lines.length - 1, lineIdx + 5);
  for (let i = start; i <= end; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('aws') || lower.includes('secret_access') || lower.includes('akia')) {
      return true;
    }
  }
  return false;
}

/** Check if a string looks like an env var name (ALL_CAPS_WITH_UNDERSCORES) */
function isEnvVarName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value);
}

function scanSourceFiles(scope: TargetScope, dryRun: boolean): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  if (dryRun) {
    logger.info('DRY RUN: would scan source files for secrets');
    return findings;
  }

  const dirsToScan = [
    path.join(scope.projectRoot, 'src'),
    path.join(scope.projectRoot, 'scripts'),
  ].filter(d => fs.existsSync(d) && validatePath(scope, d));

  for (const dir of dirsToScan) {
    const files = walkDir(dir, 5);
    for (const file of files) {
      // Skip wraith's own files and logger (contains pattern definitions)
      if (file.includes('wraith') && file.includes('secret-exposure')) continue;
      if (file.endsWith('logger.ts') || file.endsWith('logger.js')) continue;
      // Skip test files
      if (file.includes('.test.') || file.includes('.spec.') || file.includes('__test__')) continue;
      // Skip secret-substitution patterns file
      if (file.includes('secret-pattern') || file.includes('secret-substitution')) continue;

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (isCommentOrPattern(line)) continue;

        for (const pattern of SECRET_PATTERNS) {
          const match = pattern.regex.exec(line);
          if (match && match[0].length >= 16) {
            // Fix B: aws-secret-key needs AWS context within 5 lines
            if (pattern.name === 'aws-secret-key' && !hasAwsContext(lines, lineIdx)) continue;
            // Fix C: hardcoded-password skip if value is an env var name
            if (pattern.name === 'hardcoded-password') {
              const valMatch = /(password|passwd|pwd)\s*[=:]\s*['"]([^'"]+)['"]/i.exec(line);
              if (valMatch && isEnvVarName(valMatch[2])) continue;
            }
            counter++;
            findings.push({
              id: `SE-SRC-${String(counter).padStart(3, '0')}`,
              severity: pattern.severity,
              title: `Potential ${pattern.description} in source code`,
              module: MODULE_NAME,
              target: file,
              attack: 'Source code secret scan',
              result: `Pattern "${pattern.name}" matched at line ${lineIdx + 1}`,
              evidence: `File: ${file}:${lineIdx + 1}\nPattern: ${pattern.name}\nMatch: ${match[0].slice(0, 8)}...[REDACTED]\nContext: ${line.trim().slice(0, 100)}`,
              remediation: 'Move secret to .env.age and reference via readEnvFile(). Never hardcode credentials.',
              retest: `grep -n "${pattern.name}" "${file}"`,
              timestamp: Date.now(),
            });
          }
        }
      }
    }
  }

  return findings;
}

// ── .env Validation ─────────────────────────────────────────────────

function validateEnvFiles(scope: TargetScope, dryRun: boolean): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  if (dryRun) {
    logger.info('DRY RUN: would validate .env files');
    return findings;
  }

  const envFiles: string[] = [];
  function findEnvFiles(dir: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === '.env') {
        envFiles.push(fullPath);
      } else if (entry.isDirectory()) {
        findEnvFiles(fullPath, depth + 1);
      }
    }
  }

  findEnvFiles(scope.projectRoot, 0);

  for (const envFile of envFiles) {
    const agePath = envFile + '.age';
    const hasAgeVersion = fs.existsSync(agePath);

    if (!hasAgeVersion) {
      counter++;
      findings.push({
        id: `SE-ENV-${String(counter).padStart(3, '0')}`,
        severity: 'high',
        title: `Plaintext .env without .env.age: ${path.relative(scope.projectRoot, envFile)}`,
        module: MODULE_NAME,
        target: envFile,
        attack: '.env encryption validation',
        result: 'Plaintext .env file found without encrypted .env.age version',
        evidence: `File: ${envFile}\nExpected encrypted: ${agePath}\nNo encrypted counterpart found`,
        remediation: 'Encrypt .env with age and remove plaintext version. Add .env to .gitignore.',
        retest: `test -f "${agePath}" && echo "PASS" || echo "FAIL"`,
        timestamp: Date.now(),
      });
    } else {
      counter++;
      findings.push({
        id: `SE-ENV-${String(counter).padStart(3, '0')}`,
        severity: 'medium',
        title: `Plaintext .env coexists with .env.age: ${path.relative(scope.projectRoot, envFile)}`,
        module: MODULE_NAME,
        target: envFile,
        attack: '.env encryption validation',
        result: 'Both .env and .env.age exist. Plaintext .env may contain current secrets.',
        evidence: `Plaintext: ${envFile}\nEncrypted: ${agePath}`,
        remediation: 'Remove plaintext .env after verifying .env.age is authoritative. Add .env to .gitignore.',
        retest: `ls -la "${envFile}" "${agePath}"`,
        timestamp: Date.now(),
      });
    }
  }

  // Check .gitignore
  const gitignorePath = path.join(scope.projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.env')) {
      counter++;
      findings.push({
        id: `SE-ENV-${String(counter).padStart(3, '0')}`,
        severity: 'high',
        title: '.env not in .gitignore',
        module: MODULE_NAME,
        target: gitignorePath,
        attack: '.gitignore validation',
        result: '.env files are not excluded from git tracking',
        evidence: `File: ${gitignorePath}\nMissing pattern: .env`,
        remediation: 'Add .env to .gitignore to prevent accidental commits of plaintext secrets',
        retest: `grep ".env" "${gitignorePath}"`,
        timestamp: Date.now(),
      });
    }
  }

  return findings;
}

// ── Log File Scanner ────────────────────────────────────────────────

function scanLogFiles(scope: TargetScope, dryRun: boolean): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  if (dryRun) {
    logger.info('DRY RUN: would scan log files for secrets');
    return findings;
  }

  const logDirs = [
    path.join(process.env.HOME || '/home/user', '.pm2', 'logs'),
  ];

  for (const logDir of logDirs) {
    if (!fs.existsSync(logDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log') || f.endsWith('.out') || f.endsWith('.err'))
        .map(f => path.join(logDir, f));
    } catch {
      continue;
    }

    for (const file of files) {
      let content: string;
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(512 * 1024);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        content = buf.toString('utf-8', 0, bytesRead);
      } catch {
        continue;
      }

      const logLines = content.split('\n');
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.regex.exec(content);
        if (match && !match[0].includes('REDACTED') && match[0].length >= 16) {
          const lineNum = content.slice(0, match.index).split('\n').length;
          // aws-secret-key: require AWS context in surrounding lines
          if (pattern.name === 'aws-secret-key') {
            if (!hasAwsContext(logLines, lineNum - 1)) continue;
          }
          counter++;
          findings.push({
            id: `SE-LOG-${String(counter).padStart(3, '0')}`,
            severity: pattern.severity,
            title: `Potential ${pattern.description} leaked in log file`,
            module: MODULE_NAME,
            target: file,
            attack: 'Log file secret scan',
            result: `Pattern "${pattern.name}" found in log output`,
            evidence: `File: ${file}:~${lineNum}\nPattern: ${pattern.name}\nMatch prefix: ${match[0].slice(0, 8)}...[REDACTED]`,
            remediation: 'Ensure logger sanitization covers this pattern. Check src/logger.ts REDACT_PATTERNS.',
            retest: `grep -c "${pattern.name}" "${file}"`,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  return findings;
}

// ── Git History Scanner ─────────────────────────────────────────────

function scanGitHistory(scope: TargetScope, dryRun: boolean): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  if (dryRun) {
    logger.info('DRY RUN: would scan git history for secrets');
    return findings;
  }

  const searchTerms = ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PRIVATE_KEY', 'PASSPHRASE', 'sk-ant-', 'ghp_', 'AKIA'];

  for (const term of searchTerms) {
    try {
      const result = execSync(
        `git log --oneline --all -S "${term}" --diff-filter=D -- "*.ts" "*.js" "*.env" "*.json" 2>/dev/null | head -20`,
        { cwd: scope.projectRoot, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      if (result.trim()) {
        const lines = result.trim().split('\n');
        counter++;
        findings.push({
          id: `SE-GIT-${String(counter).padStart(3, '0')}`,
          severity: 'high',
          title: `Secret pattern "${term}" found in deleted git history`,
          module: MODULE_NAME,
          target: `${scope.projectRoot}/.git`,
          attack: 'Git history secret scan',
          result: `Found ${lines.length} commit(s) where "${term}" was removed from tracked files`,
          evidence: `Search term: ${term}\nCommits: ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? `\n...and ${lines.length - 5} more` : ''}`,
          remediation: 'Rotate affected credentials. Consider git-filter-repo to purge history before GitHub release.',
          retest: `git log --oneline --all -S "${term}" --diff-filter=D`,
          timestamp: Date.now(),
        });
      }
    } catch {
      // git command failed, skip
    }
  }

  return findings;
}

// ── Database Scanner ────────────────────────────────────────────────

function scanDatabases(scope: TargetScope, dryRun: boolean): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  if (dryRun) {
    logger.info('DRY RUN: would scan databases for secrets');
    return findings;
  }

  if (!fs.existsSync(scope.bridgeDbPath)) {
    logger.info('Bridge DB not found, skipping database scan');
    return findings;
  }

  // Get passphrase
  let passphrase = '';
  const envAgePath = path.join(scope.projectRoot, '.env.age');
  const envPath = path.join(scope.projectRoot, '.env');

  const decrypted = decryptAgeFile(envAgePath);
  if (decrypted) {
    const match = /DB_PASSPHRASE=(.+)/m.exec(decrypted);
    if (match) passphrase = match[1].trim();
  }
  if (!passphrase) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const match = /DB_PASSPHRASE=(.+)/m.exec(envContent);
      if (match) passphrase = match[1].trim();
    } catch { /* skip */ }
  }
  if (!passphrase) {
    const envVals = readEnvFile(['DB_PASSPHRASE']);
    passphrase = envVals.DB_PASSPHRASE || '';
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(scope.bridgeDbPath, { readonly: true });
    if (passphrase) {
      db.pragma(`key='${passphrase}'`);
    }
    db.pragma('journal_mode = WAL');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;

    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string; type: string }>;
      const textColumns = columns.filter(c => c.type.toLowerCase().includes('text') || c.type === '');

      for (const col of textColumns) {
        try {
          const rows = db.prepare(
            `SELECT "${col.name}" FROM "${table.name}" WHERE "${col.name}" IS NOT NULL LIMIT 500`
          ).all() as Array<Record<string, unknown>>;

          for (const row of rows) {
            const value = String(row[col.name] || '');
            if (value.length < 10) continue;

            for (const pattern of SECRET_PATTERNS) {
              const match = pattern.regex.exec(value);
              if (match && !match[0].includes('REDACTED') && !match[0].includes('[WRAITH-TEST]') && match[0].length >= 16) {
                // aws-secret-key: require AWS context in the cell value
                if (pattern.name === 'aws-secret-key') {
                  const lower = value.toLowerCase();
                  if (!lower.includes('aws') && !lower.includes('secret_access') && !lower.includes('akia')) continue;
                }
                // hardcoded-password: skip env var name values in DB payloads
                if (pattern.name === 'hardcoded-password') {
                  const valMatch = /(password|passwd|pwd)\s*[=:]\s*['"]([^'"]+)['"]/i.exec(value);
                  if (valMatch && isEnvVarName(valMatch[2])) continue;
                }
                counter++;
                findings.push({
                  id: `SE-DB-${String(counter).padStart(3, '0')}`,
                  severity: pattern.severity,
                  title: `Potential ${pattern.description} stored in database`,
                  module: MODULE_NAME,
                  target: `${scope.bridgeDbPath} -> ${table.name}.${col.name}`,
                  attack: 'Database content secret scan',
                  result: `Pattern "${pattern.name}" found in table ${table.name}, column ${col.name}`,
                  evidence: `Database: ${scope.bridgeDbPath}\nTable: ${table.name}\nColumn: ${col.name}\nPattern: ${pattern.name}\nMatch prefix: ${match[0].slice(0, 8)}...[REDACTED]`,
                  remediation: 'Sanitize data before storing in bridge DB. Secrets should never appear in task payloads.',
                  retest: 'node dist/wraith/scanner.js --modules secret-exposure',
                  timestamp: Date.now(),
                });
                break; // One finding per column per pattern is enough
              }
            }
          }
        } catch {
          // Column query failed
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to scan bridge database');
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  return findings;
}

// ── Error Handler Leak Check ────────────────────────────────────────

function checkErrorHandlerLeaks(scope: TargetScope, dryRun: boolean): Finding[] {
  const findings: Finding[] = [];
  let counter = 0;

  if (dryRun) {
    logger.info('DRY RUN: would check error handlers for secret leaks');
    return findings;
  }

  const srcDir = path.join(scope.projectRoot, 'src');
  if (!fs.existsSync(srcDir) || !validatePath(scope, srcDir)) return findings;

  const dangerousPatterns = [
    { regex: /process\.env\b/, name: 'process.env reference' },
    { regex: /JSON\.stringify\(err/, name: 'JSON.stringify(err)' },
  ];

  const files = walkDir(srcDir, 4);
  for (const file of files) {
    if (file.includes('wraith')) continue;

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    // Find catch blocks
    const catchBlocks = content.match(/catch\s*\([^)]*\)\s*\{[^}]{0,500}\}/gs) || [];
    for (const block of catchBlocks) {
      for (const dp of dangerousPatterns) {
        if (dp.regex.test(block)) {
          counter++;
          findings.push({
            id: `SE-ERR-${String(counter).padStart(3, '0')}`,
            severity: 'medium',
            title: `Error handler may leak sensitive data via ${dp.name}`,
            module: MODULE_NAME,
            target: file,
            attack: 'Error handler leak analysis',
            result: `Catch block references ${dp.name} which may expose secrets in error output`,
            evidence: `File: ${file}\nPattern: ${dp.name}\nBlock preview: ${block.slice(0, 150)}...`,
            remediation: 'Ensure error handlers sanitize output before logging. Use logger.ts sanitization.',
            retest: `grep -n "${dp.regex.source}" "${file}"`,
            timestamp: Date.now(),
          });
          break;
        }
      }
    }
  }

  return findings;
}

// ── Module Entry Point ──────────────────────────────────────────────

export const secretExposureModule = {
  name: MODULE_NAME,
  description: 'Scans for API keys, tokens, credentials in code, logs, databases, git history, and .env files',

  async run(scope: TargetScope, config: ScanConfig): Promise<ModuleResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];

    logger.info({ dryRun: config.dryRun }, 'AI Defense Scan secret-exposure module starting');

    try {
      logger.info('Scanning source files for secrets...');
      findings.push(...scanSourceFiles(scope, config.dryRun));

      logger.info('Validating .env file encryption posture...');
      findings.push(...validateEnvFiles(scope, config.dryRun));

      logger.info('Scanning log files for leaked credentials...');
      findings.push(...scanLogFiles(scope, config.dryRun));

      logger.info('Scanning git history for removed secrets...');
      findings.push(...scanGitHistory(scope, config.dryRun));

      logger.info('Scanning databases for secret exposure...');
      findings.push(...scanDatabases(scope, config.dryRun));

      logger.info('Checking error handlers for secret leaks...');
      findings.push(...checkErrorHandlerLeaks(scope, config.dryRun));

      const duration = Date.now() - startTime;
      logger.info({ findingCount: findings.length, duration }, 'Secret exposure module complete');

      return { module: MODULE_NAME, findings, duration };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Secret exposure module error');
      return { module: MODULE_NAME, findings, duration: Date.now() - startTime, error: msg };
    }
  },
};
