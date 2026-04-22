/**
 * AI Defense Scan -- Target Scope Management
 *
 * Manages what AI Defense Scan is allowed to touch. Hard enforcement --
 * every module call goes through scope validation before execution.
 */

import fs from 'fs';
import path from 'path';
import type { TargetScope } from './types.js';
import { logger } from '../logger.js';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const VAULT_ROOT = process.env.VAULT_ROOT || path.join(PROJECT_ROOT, '..', 'vault');

function generatePortRange(start: number, end: number): number[] {
  const ports: number[] = [];
  for (let p = start; p <= end; p++) {
    ports.push(p);
  }
  return ports;
}

const DEFAULT_SCOPE: TargetScope = {
  allowedHosts: ['127.0.0.1', 'localhost', '::1'],
  allowedPorts: generatePortRange(3000, 3200),
  allowedPaths: [
    path.join(PROJECT_ROOT, 'src/'),
    path.join(PROJECT_ROOT, 'dist/'),
    path.join(PROJECT_ROOT, 'scripts/'),
    path.join(VAULT_ROOT, '/'),
    path.join(PROJECT_ROOT, 'bots/'),
    path.join(PROJECT_ROOT, 'CLAUDE.md'),
    path.join(PROJECT_ROOT, '.claude/'),
    path.join(PROJECT_ROOT, 'council/'),
    path.join(PROJECT_ROOT, 'release/'),
  ],
  deniedPaths: [
    path.join(PROJECT_ROOT, '.env'),
    path.join(PROJECT_ROOT, '.env.age'),
    path.join(PROJECT_ROOT, 'store/'),
  ],
  bridgeDbPath: path.join(PROJECT_ROOT, 'store', 'bridge.db'),
  vaultPath: VAULT_ROOT,
  projectRoot: PROJECT_ROOT,
};

export function loadScope(wraithRoot?: string): TargetScope {
  const scopePaths = [
    wraithRoot ? path.join(wraithRoot, 'scope.json') : '',
    path.join(process.cwd(), 'scope.json'),
    path.join(PROJECT_ROOT, 'bots', 'wraith', 'scope.json'),
  ].filter(Boolean);

  for (const scopePath of scopePaths) {
    if (fs.existsSync(scopePath)) {
      try {
        const raw = fs.readFileSync(scopePath, 'utf-8');
        const custom = JSON.parse(raw) as Partial<TargetScope>;
        const merged: TargetScope = {
          allowedHosts: custom.allowedHosts ?? DEFAULT_SCOPE.allowedHosts,
          allowedPorts: custom.allowedPorts ?? DEFAULT_SCOPE.allowedPorts,
          allowedPaths: custom.allowedPaths ?? DEFAULT_SCOPE.allowedPaths,
          deniedPaths: custom.deniedPaths ?? DEFAULT_SCOPE.deniedPaths,
          bridgeDbPath: custom.bridgeDbPath ?? DEFAULT_SCOPE.bridgeDbPath,
          vaultPath: custom.vaultPath ?? DEFAULT_SCOPE.vaultPath,
          projectRoot: custom.projectRoot ?? DEFAULT_SCOPE.projectRoot,
        };
        logger.info({ scopePath }, 'Scanner loaded custom scope');
        return merged;
      } catch (err) {
        logger.warn({ scopePath, err }, 'Scanner failed to load custom scope, using defaults');
      }
    }
  }

  logger.info('Scanner using default scope (internal testing)');
  return { ...DEFAULT_SCOPE };
}

export function validateTarget(scope: TargetScope, host: string, port: number): boolean {
  const hostAllowed = scope.allowedHosts.includes(host);
  const portAllowed = scope.allowedPorts.includes(port);
  if (!hostAllowed) {
    logger.warn({ host }, 'Scanner scope violation: host not in allowedHosts');
    return false;
  }
  if (!portAllowed) {
    logger.warn({ port }, 'Scanner scope violation: port not in allowedPorts');
    return false;
  }
  return true;
}

export function validatePath(scope: TargetScope, filepath: string): boolean {
  const normalized = path.resolve(filepath);
  for (const denied of scope.deniedPaths) {
    const normalizedDenied = path.resolve(denied);
    if (normalized === normalizedDenied || normalized.startsWith(normalizedDenied + path.sep)) {
      logger.warn({ filepath: normalized, deniedPath: denied }, 'Scanner scope: path denied');
      return false;
    }
  }
  for (const allowed of scope.allowedPaths) {
    const normalizedAllowed = path.resolve(allowed);
    if (normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed)) {
      return true;
    }
  }
  logger.warn({ filepath: normalized }, 'Scanner scope: path not in allowedPaths');
  return false;
}

export function isInScope(
  scope: TargetScope,
  target: { host?: string; port?: number; filepath?: string },
): boolean {
  if (target.host !== undefined && target.port !== undefined) {
    return validateTarget(scope, target.host, target.port);
  }
  if (target.filepath !== undefined) {
    return validatePath(scope, target.filepath);
  }
  logger.warn({ target }, 'Scanner scope check: no valid target provided');
  return false;
}

export function getDefaultScope(): TargetScope {
  return { ...DEFAULT_SCOPE };
}
