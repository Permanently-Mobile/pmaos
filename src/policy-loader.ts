/**
 * Paladin Policy Loader
 *
 * Reads, validates, and hot-reloads the YAML policy config.
 * Falls back to hardcoded defaults if the file is missing or invalid.
 *
 * Usage:
 *   import { initPolicy, getPolicy, onPolicyChange } from './policy-loader.js';
 *   initPolicy();               // load + start file watcher
 *   const p = getPolicy();      // current policy snapshot
 *   onPolicyChange(cb);         // subscribe to reloads
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ApprovalPattern {
  pattern: string;
  reason: string;
  timeout: number;    // seconds
}

export interface PolicyConfig {
  version: string;
  bash: {
    allowedPrefixes: string[];
    blockedPatterns: string[];
  };
  approval: {
    patterns: ApprovalPattern[];
  };
  files: {
    writeAllowed: string[];
    writeDenied: string[];
  };
  rateLimits: {
    bashCommandsPerMinute: number;
    fileWritesPerMinute: number;
    externalApiCallsPerMinute: number;
  };
  injection: {
    thresholds: {
      low: number;
      medium: number;
      high: number;
    };
  };
}

// ── Hardcoded defaults (fallback if YAML missing/invalid) ───────────

const DEFAULT_POLICY: PolicyConfig = {
  version: '1.0',
  bash: {
    allowedPrefixes: [
      'pm2 status', 'pm2 logs', 'pm2 restart', 'pm2 list', 'pm2 jlist', 'pm2 describe',
      'node dist/bridge-cli.js', 'node dist/systems-check.js',
      'node dist/schedule-cli.js', 'node dist/save-restart-context-cli.js',
      'git status', 'git log', 'git diff', 'git branch',
      'cat ', 'ls ', 'type ', 'dir ', 'grep ', 'find ',
      'npx tsc', 'npm run', 'npm test',
    ],
    blockedPatterns: [
      '\\brm\\s', '\\brm\\b.*-rf', '\\bsudo\\b',
      '\\bcurl\\b.*\\|\\s*bash', '\\bwget\\b.*\\|\\s*bash',
      '\\beval\\b', '\\|\\s*sh\\b', '\\|\\s*bash\\b',
      '\\brmdir\\b', '\\bmkfs\\b', '\\bdd\\s+if=',
      '\\bformat\\b', '>\\s*/dev/', '\\bchmod\\b.*777', '\\bchown\\b',
    ],
  },
  approval: {
    patterns: [],
  },
  files: {
    writeAllowed: ['vault:', 'workspace/', 'store/', 'config/'],
    writeDenied: ['.env', '.env.age', 'src/'],
  },
  rateLimits: {
    bashCommandsPerMinute: 30,
    fileWritesPerMinute: 20,
    externalApiCallsPerMinute: 10,
  },
  injection: {
    thresholds: { low: 4, medium: 8, high: 14 },
  },
};

// ── Module state ────────────────────────────────────────────────────

const POLICY_PATH = path.join(PROJECT_ROOT, 'config', 'policy.yaml');
let currentPolicy: PolicyConfig = { ...DEFAULT_POLICY };
let watcher: fs.FSWatcher | null = null;
const changeCallbacks: Array<(policy: PolicyConfig) => void> = [];

// Debounce reload to avoid double-fires from editors
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const RELOAD_DEBOUNCE_MS = 500;

// ── Validation ──────────────────────────────────────────────────────

function validatePolicy(raw: unknown): PolicyConfig | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  // Version check
  if (typeof obj.version !== 'string') return null;

  // Bash section
  const bash = obj.bash as Record<string, unknown> | undefined;
  if (!bash || !Array.isArray(bash.allowedPrefixes) || !Array.isArray(bash.blockedPatterns)) {
    return null;
  }

  // Validate blocked patterns are valid regex
  for (const pat of bash.blockedPatterns) {
    if (typeof pat !== 'string') return null;
    try {
      new RegExp(pat);
    } catch {
      logger.warn({ pattern: pat }, 'Paladin: invalid regex in blockedPatterns, rejecting policy');
      return null;
    }
  }

  // Approval section (optional, default to empty)
  const approval = obj.approval as Record<string, unknown> | undefined;
  const approvalPatterns: ApprovalPattern[] = [];
  if (approval && Array.isArray(approval.patterns)) {
    for (const p of approval.patterns) {
      const item = p as Record<string, unknown>;
      if (typeof item.pattern === 'string' && typeof item.reason === 'string') {
        approvalPatterns.push({
          pattern: item.pattern,
          reason: item.reason,
          timeout: typeof item.timeout === 'number' ? item.timeout : 60,
        });
      }
    }
  }

  // Files section (optional, default to empty)
  const files = obj.files as Record<string, unknown> | undefined;
  const fileRules = {
    writeAllowed: Array.isArray(files?.writeAllowed) ? files.writeAllowed.filter((s: unknown) => typeof s === 'string') as string[] : DEFAULT_POLICY.files.writeAllowed,
    writeDenied: Array.isArray(files?.writeDenied) ? files.writeDenied.filter((s: unknown) => typeof s === 'string') as string[] : DEFAULT_POLICY.files.writeDenied,
  };

  // Rate limits (optional, merge with defaults)
  const rateLimits = obj.rateLimits as Record<string, unknown> | undefined;
  const rateConfig = {
    bashCommandsPerMinute: typeof rateLimits?.bashCommandsPerMinute === 'number' ? rateLimits.bashCommandsPerMinute : DEFAULT_POLICY.rateLimits.bashCommandsPerMinute,
    fileWritesPerMinute: typeof rateLimits?.fileWritesPerMinute === 'number' ? rateLimits.fileWritesPerMinute : DEFAULT_POLICY.rateLimits.fileWritesPerMinute,
    externalApiCallsPerMinute: typeof rateLimits?.externalApiCallsPerMinute === 'number' ? rateLimits.externalApiCallsPerMinute : DEFAULT_POLICY.rateLimits.externalApiCallsPerMinute,
  };

  // Injection thresholds (optional, merge with defaults)
  const injection = obj.injection as Record<string, unknown> | undefined;
  const thresholds = injection?.thresholds as Record<string, unknown> | undefined;
  const injectionConfig = {
    thresholds: {
      low: typeof thresholds?.low === 'number' ? thresholds.low : DEFAULT_POLICY.injection.thresholds.low,
      medium: typeof thresholds?.medium === 'number' ? thresholds.medium : DEFAULT_POLICY.injection.thresholds.medium,
      high: typeof thresholds?.high === 'number' ? thresholds.high : DEFAULT_POLICY.injection.thresholds.high,
    },
  };

  return {
    version: obj.version as string,
    bash: {
      allowedPrefixes: bash.allowedPrefixes.filter((s: unknown) => typeof s === 'string') as string[],
      blockedPatterns: bash.blockedPatterns as string[],
    },
    approval: { patterns: approvalPatterns },
    files: fileRules,
    rateLimits: rateConfig,
    injection: injectionConfig,
  };
}

// ── Load / Reload ───────────────────────────────────────────────────

function loadFromDisk(): PolicyConfig {
  try {
    if (!fs.existsSync(POLICY_PATH)) {
      logger.info('Paladin: policy.yaml not found, using hardcoded defaults');
      return { ...DEFAULT_POLICY };
    }

    const raw = yaml.load(fs.readFileSync(POLICY_PATH, 'utf-8'));
    const validated = validatePolicy(raw);

    if (!validated) {
      logger.warn('Paladin: policy.yaml failed validation, using hardcoded defaults');
      return { ...DEFAULT_POLICY };
    }

    logger.info({ version: validated.version, prefixes: validated.bash.allowedPrefixes.length, blocked: validated.bash.blockedPatterns.length }, 'Paladin: policy loaded from YAML');
    return validated;
  } catch (err) {
    logger.error({ err }, 'Paladin: failed to load policy.yaml, using defaults');
    return { ...DEFAULT_POLICY };
  }
}

function reload(): void {
  const newPolicy = loadFromDisk();
  currentPolicy = newPolicy;
  for (const cb of changeCallbacks) {
    try {
      cb(newPolicy);
    } catch (err) {
      logger.error({ err }, 'Paladin: policy change callback error');
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize the policy loader: read YAML + start file watcher.
 * Safe to call multiple times (idempotent).
 */
export function initPolicy(): void {
  currentPolicy = loadFromDisk();

  // Start file watcher if not already running
  if (!watcher && fs.existsSync(path.dirname(POLICY_PATH))) {
    try {
      watcher = fs.watch(POLICY_PATH, () => {
        // Debounce: editors often fire multiple events
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          logger.info('Paladin: policy.yaml changed, reloading');
          reload();
        }, RELOAD_DEBOUNCE_MS);
      });

      watcher.on('error', (err) => {
        logger.warn({ err }, 'Paladin: file watcher error (non-fatal)');
      });
    } catch {
      // File watcher not critical -- policy still works, just won't hot-reload
      logger.warn('Paladin: could not start file watcher for policy.yaml');
    }
  }
}

/**
 * Get the current policy config (snapshot).
 * Always returns a valid policy -- defaults if YAML is missing/invalid.
 */
export function getPolicy(): PolicyConfig {
  return currentPolicy;
}

/**
 * Get the hardcoded default policy (for reference/fallback).
 */
export function getDefaultPolicy(): PolicyConfig {
  return { ...DEFAULT_POLICY };
}

/**
 * Subscribe to policy change events (fired on hot-reload).
 */
export function onPolicyChange(callback: (policy: PolicyConfig) => void): void {
  changeCallbacks.push(callback);
}

/**
 * Force a policy reload from disk.
 */
export function reloadPolicy(): void {
  reload();
}

/**
 * Build the full list of allowed bash prefixes, including
 * dynamic PROJECT_ROOT-based paths that can't be in YAML.
 */
export function getResolvedBashPrefixes(): string[] {
  const policy = getPolicy();
  const dynamicPrefixes = [
    `node ${path.join(PROJECT_ROOT, 'dist', 'bridge-cli.js')}`,
    `node ${path.join(PROJECT_ROOT, 'dist', 'systems-check.js')}`,
    `node ${path.join(PROJECT_ROOT, 'dist', 'schedule-cli.js')}`,
    `node ${path.join(PROJECT_ROOT, 'dist', 'save-restart-context-cli.js')}`,
    `bash ${path.join(PROJECT_ROOT, 'scripts')}`,
  ];
  return [...policy.bash.allowedPrefixes, ...dynamicPrefixes];
}

/**
 * Build compiled RegExp array from policy blocked patterns.
 */
export function getCompiledBlockedPatterns(): RegExp[] {
  const policy = getPolicy();
  return policy.bash.blockedPatterns.map(p => new RegExp(p));
}

/**
 * Stop the file watcher (for clean shutdown).
 */
export function stopPolicyWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}
