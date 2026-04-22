/**
 * AI Defense Scan -- Findings Report Generator
 *
 * Generates vault-format markdown reports from scan results.
 * Report path: <vault>/Audits/Security/YYYY-MM-DD - AI Defense Scan.md
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../logger.js';
import { sendTask } from '../bridge.js';
import type { ModuleResult, Finding, Severity } from './types.js';
import { redactSecrets } from './utils.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Generate a vault-format markdown report from scan results.
 *
 * @param proofMode - When true, evidence fields are NOT redacted (raw output).
 */
export function generateReport(results: ModuleResult[], config: { startTime: number; endTime: number; scanId: string }, proofMode = false): string {
  const lines: string[] = [];
  const dateStr = formatDate(config.startTime);

  // Collect all findings and sort by severity
  const allFindings: Finding[] = [];
  for (const mod of results) {
    allFindings.push(...mod.findings);
  }
  allFindings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Count by severity
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of allFindings) {
    bySeverity[f.severity]++;
  }

  const totalDuration = config.endTime - config.startTime;

  // Header
  lines.push(`# AI Defense Scan -- ${dateStr}`);
  lines.push('');
  lines.push(`**Scan ID:** ${config.scanId}`);
  lines.push(`**Duration:** ${formatDuration(totalDuration)}`);
  lines.push(`**Modules Run:** ${results.length}`);
  lines.push(`**Total Findings:** ${allFindings.length}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  for (const sev of severities) {
    lines.push(`| ${sev.toUpperCase()} | ${bySeverity[sev]} |`);
  }
  lines.push('');

  // Risk assessment
  if (bySeverity.critical > 0) {
    lines.push('**Overall Risk: CRITICAL** -- Immediate attention required.');
  } else if (bySeverity.high > 0) {
    lines.push('**Overall Risk: HIGH** -- Remediation recommended before release.');
  } else if (bySeverity.medium > 0) {
    lines.push('**Overall Risk: MEDIUM** -- Address before production deployment.');
  } else if (bySeverity.low > 0) {
    lines.push('**Overall Risk: LOW** -- Minor issues, address when convenient.');
  } else {
    lines.push('**Overall Risk: CLEAN** -- No actionable findings.');
  }
  lines.push('');

  // Findings
  if (allFindings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    for (const finding of allFindings) {
      lines.push(`### [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push('');
      lines.push(`**Module:** ${finding.module}`);
      lines.push(`**Target:** ${finding.target}`);
      lines.push(`**Attack:** ${finding.attack}`);
      lines.push(`**Result:** ${finding.result}`);
      lines.push(`**Evidence:** ${redactSecrets(finding.evidence, proofMode)}`);
      lines.push(`**Remediation:** ${finding.remediation}`);
      lines.push(`**Retest:** \`${finding.retest}\``);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  } else {
    lines.push('## Findings');
    lines.push('');
    lines.push('No findings discovered.');
    lines.push('');
  }

  // Modules table
  lines.push('## Module Results');
  lines.push('');
  lines.push('| Module | Findings | Duration | Error |');
  lines.push('|--------|----------|----------|-------|');
  for (const mod of results) {
    const errDisplay = mod.error ? mod.error.slice(0, 60) : 'none';
    const durDisplay = `${(mod.duration / 1000).toFixed(1)}s`;
    lines.push(`| ${mod.module} | ${mod.findings.length} | ${durDisplay} | ${errDisplay} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Write the report to the vault and commit.
 */
export function writeReportToVault(
  report: string,
  vaultPath: string,
  projectRoot: string,
): string {
  // Validate vaultPath is actually under the expected vault directory
  const resolvedVault = path.resolve(vaultPath);
  const expectedVault = path.resolve(process.env.VAULT_ROOT || path.resolve(process.cwd(), '..', 'vault'));
  const isUnderExpectedVault = resolvedVault === expectedVault || resolvedVault.startsWith(expectedVault + path.sep);
  if (!isUnderExpectedVault) {
    logger.error(
      { vaultPath: resolvedVault, expectedVault },
      'AI Defense Scan report vaultPath is outside expected vault directory. Refusing to write.',
    );
    return '';
  }

  const auditDir = path.join(vaultPath, 'Audits', 'Security');
  const now = new Date();
  const dateStr = formatDate(now.getTime());
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  let filename = `${dateStr} - AI Defense Scan (${hh}-${mm}).md`;
  let filepath = path.join(auditDir, filename);

  // If that file already exists, append a counter
  let counter = 2;
  while (fs.existsSync(filepath)) {
    filename = `${dateStr} - AI Defense Scan (${hh}-${mm})-${counter}.md`;
    filepath = path.join(auditDir, filename);
    counter++;
  }

  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(filepath, report, 'utf-8');
  logger.info({ filepath }, 'AI Defense Scan report written to vault');

  // Vault commit
  const commitScript = path.join(projectRoot, 'scripts', 'vault-commit.sh');
  if (fs.existsSync(commitScript)) {
    try {
      execSync(`bash "${commitScript}" "ai defense scan - ${dateStr}"`, {
        cwd: vaultPath,
        stdio: 'pipe',
        timeout: 15000,
      });
      logger.info('Vault commit completed for security scan');
    } catch (err) {
      logger.warn({ err }, 'Vault commit failed (non-fatal)');
    }
  }

  return filepath;
}

/**
 * Send findings summary to primary agent via bridge.
 */
export function notifyPrimaryAgent(
  results: ModuleResult[],
  projectRoot: string,
  scanId: string,
): void {
  const PRIMARY_BOT = process.env.BOT_NAME || 'primary';
  const allFindings = results.flatMap(r => r.findings);
  const critical = allFindings.filter(f => f.severity === 'critical').length;
  const high = allFindings.filter(f => f.severity === 'high').length;

  if (critical === 0 && high === 0 && allFindings.length === 0) return;

  const summary = [
    `AI Defense Scan ${scanId} complete.`,
    `Findings: ${allFindings.length} total`,
    `  CRITICAL: ${critical}`,
    `  HIGH: ${high}`,
    critical > 0 ? 'IMMEDIATE ATTENTION REQUIRED.' : '',
  ].filter(Boolean).join('\n');

  try {
    // Import dynamically to avoid circular deps at module level
    sendTask('wraith', PRIMARY_BOT, { prompt: summary }, critical > 0 ? 3 : 2, 60);
    logger.info('Sent findings summary to primary bot via bridge');
  } catch (err) {
    logger.warn({ err }, 'Failed to send bridge notification to primary bot');
  }
}

/**
 * Trigger notify.sh for critical/high findings.
 */
/** Safely escape a string for shell single-quote wrapping. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function notifyTelegram(message: string, projectRoot: string): void {
  const notifyScript = path.join(projectRoot, 'scripts', 'notify.sh');
  if (!fs.existsSync(notifyScript)) return;

  try {
    execSync(`bash "${notifyScript}" ${shellEscape(message)}`, {
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch {
    logger.warn('Telegram notification failed (non-fatal)');
  }
}
