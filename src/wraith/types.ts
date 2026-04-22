/**
 * AI Defense Scan -- Core Type Definitions
 *
 * Types used across all AI Defense Scan security scanner modules.
 *
 * This is a stub module included as an extension point. AI Defense Scan is the
 * autonomous security scanner that tests your deployment for vulnerabilities.
 * Implement or install the full AI Defense Scan module to enable scheduled security scans.
 */

// ── Target Scope ────────────────────────────────────────────────────

export interface TargetScope {
  /** Authorized IPs or hostnames for network testing */
  allowedHosts: string[];
  /** Authorized port numbers for network testing */
  allowedPorts: number[];
  /** Filesystem paths readable during scanning */
  allowedPaths: string[];
  /** Filesystem paths that must never be touched */
  deniedPaths: string[];
  /** Path to bridge.db */
  bridgeDbPath: string;
  /** Path to Obsidian vault */
  vaultPath: string;
  /** Path to project root */
  projectRoot: string;
}

// ── Severity ────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

// ── Findings ────────────────────────────────────────────────────────

export interface Finding {
  /** Unique ID in module-NNN format */
  id: string;
  severity: Severity;
  /** One-line description */
  title: string;
  /** Which attack module produced this finding */
  module: string;
  /** What was tested (file path, endpoint, etc.) */
  target: string;
  /** What was attempted (payload, method, technique) */
  attack: string;
  /** What happened (success, failure, partial) */
  result: string;
  /** Logs, payloads, output proving the finding */
  evidence: string;
  /** How to fix (specific, actionable) */
  remediation: string;
  /** Command to verify fix works */
  retest: string;
  /** Epoch ms */
  timestamp: number;
}

// ── Module Result ───────────────────────────────────────────────────

export interface ModuleResult {
  /** Module name identifier */
  module: string;
  /** All findings from this module run */
  findings: Finding[];
  /** Execution duration in milliseconds */
  duration: number;
  /** Error message if the module crashed */
  error?: string;
}

// ── Scan Config ─────────────────────────────────────────────────────

export type NotifyMode = 'bridge' | 'direct' | 'both';

export interface ScanConfig {
  /** Which modules to run ('all' or specific names) */
  modules: string[];
  /** Target scope restrictions */
  targets: TargetScope;
  /** Log what would be done without executing */
  dryRun: boolean;
  /** Verbose output */
  verbose: boolean;
  /** Run modules in parallel instead of sequential */
  parallel?: boolean;
  /** Output directory override */
  outputDir?: string;
  /** Notification mode: 'bridge' (primary agent), 'direct' (user), or 'both' */
  notify?: NotifyMode;
}

// ── Attack Module Interface ─────────────────────────────────────────

export interface AttackModule {
  /** Module identifier (used in CLI and reports) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Execute the module's scan against the given scope */
  run(scope: TargetScope, config: ScanConfig): Promise<ModuleResult>;
}
