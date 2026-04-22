#!/usr/bin/env node

/**
 * AI Defense Scan -- Orchestration engine and CLI.
 *
 * Usage:
 *   node dist/wraith/scanner.js --profile quick --verbose
 *   node dist/wraith/scanner.js --modules all --verbose
 *   node dist/wraith/scanner.js --modules prompt-injection,secret-exposure --dry-run
 *   node dist/wraith/scanner.js --modules bridge-exploit --output /tmp/scan-results
 *   node dist/wraith/scanner.js --list-profiles
 *   node dist/wraith/scanner.js --notify direct --verbose
 *   node dist/wraith/scanner.js --list
 *   node dist/wraith/scanner.js --help
 *
 * Exit codes:
 *   0 = clean (no findings)
 *   1 = findings found
 *   2 = critical findings
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { loadScope } from './scope.js';
import { generateReport, writeReportToVault, notifyPrimaryAgent, notifyTelegram } from './report.js';
import type { AttackModule, ScanConfig, ModuleResult, TargetScope, NotifyMode } from './types.js';

// Basic tier module imports
import { promptInjectionModule } from './prompt-injection.js';
import { secretExposureModule } from './secret-exposure.js';
import { bridgeExploitModule } from './bridge-exploit.js';
import { guardrailsModule } from './guardrails.js';

const PRIMARY_BOT = process.env.BOT_NAME || 'primary';
const VAULT_ROOT = process.env.VAULT_ROOT || path.resolve(process.cwd(), '..', 'vault');

// ── Module Registry ─────────────────────────────────────────────────

const MODULE_REGISTRY: Record<string, AttackModule> = {
  'prompt-injection': promptInjectionModule,
  'secret-exposure': secretExposureModule,
  'bridge-exploit': bridgeExploitModule,
  'guardrails': guardrailsModule,
};

// ── CLI Arg Parsing ─────────────────────────────────────────────────

interface ParsedArgs {
  modules: string;
  dryRun: boolean;
  verbose: boolean;
  parallel: boolean;
  output: string;
  list: boolean;
  listProfiles: boolean;
  help: boolean;
  profile: string;
  notify: 'bridge' | 'direct' | 'both';
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    modules: 'all',
    dryRun: false,
    verbose: false,
    parallel: false,
    output: '',
    list: false,
    listProfiles: false,
    help: false,
    profile: '',
    notify: 'both',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--modules' && argv[i + 1]) {
      args.modules = argv[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--parallel') {
      args.parallel = true;
    } else if (arg === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    } else if (arg === '--profile' && argv[i + 1]) {
      args.profile = argv[++i];
    } else if (arg === '--list') {
      args.list = true;
    } else if (arg === '--list-profiles') {
      args.listProfiles = true;
    } else if (arg === '--notify' && argv[i + 1]) {
      const val = argv[++i] as NotifyMode;
      if (['bridge', 'direct', 'both'].includes(val)) {
        args.notify = val;
      } else {
        logger.warn({ value: val }, 'Invalid --notify value, using default "both"');
      }
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

// ── Scan ID Generator ───────────────────────────────────────────────

function generateScanId(): string {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return `SCAN-${parts.join('')}`;
}

// ── Core Scan Runner ────────────────────────────────────────────────

async function runScan(scope: TargetScope, config: ScanConfig): Promise<{ results: ModuleResult[]; scanId: string }> {
  const scanId = generateScanId();
  const startTime = Date.now();

  logger.info({ scanId, modules: config.modules, dryRun: config.dryRun }, 'AI Defense Scan starting');

  // Validate all allowed paths resolve within project root or vault
  const projectRoot = path.resolve(scope.projectRoot);
  const vaultRoot = path.resolve(scope.vaultPath || VAULT_ROOT);

  for (const allowed of scope.allowedPaths) {
    const resolved = path.resolve(allowed);
    const underProject = resolved === projectRoot || resolved.startsWith(projectRoot + path.sep);
    const underVault = resolved === vaultRoot || resolved.startsWith(vaultRoot + path.sep);
    if (!underProject && !underVault) {
      logger.warn({ path: resolved }, 'Scope validation: allowed path outside project root and vault');
    }
  }

  // Resolve module names
  let moduleNames: string[];
  if (config.modules.includes('all')) {
    moduleNames = Object.keys(MODULE_REGISTRY);
  } else {
    moduleNames = config.modules.filter(m => {
      if (!MODULE_REGISTRY[m]) {
        logger.warn({ module: m }, 'Unknown module, skipping');
        return false;
      }
      return true;
    });
  }

  if (moduleNames.length === 0) {
    logger.error('No valid modules to run');
    return { results: [], scanId };
  }

  const results: ModuleResult[] = [];

  if (config.parallel) {
    // Run all modules in parallel
    const promises = moduleNames.map(async (moduleName) => {
      const mod = MODULE_REGISTRY[moduleName];
      logger.info({ module: moduleName }, 'Running module (parallel)');
      try {
        return await mod.run(scope, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ module: moduleName, err: msg }, 'Module crashed');
        return { module: moduleName, findings: [], duration: 0, error: msg };
      }
    });
    const parallelResults = await Promise.all(promises);
    results.push(...parallelResults);
  } else {
    // Run modules sequentially
    for (const moduleName of moduleNames) {
      const mod = MODULE_REGISTRY[moduleName];
      logger.info({ module: moduleName }, 'Running module');
      try {
        const result = await mod.run(scope, config);
        results.push(result);
        logger.info({
          module: moduleName,
          findings: result.findings.length,
          duration: result.duration,
        }, 'Module complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ module: moduleName, err: msg }, 'Module crashed');
        results.push({ module: moduleName, findings: [], duration: 0, error: msg });
      }
    }
  }

  const endTime = Date.now();

  // Generate and write report
  const report = generateReport(results, { startTime, endTime, scanId });

  if (config.outputDir) {
    // Validate --output path is under project root or vault root
    const resolvedOutput = path.resolve(config.outputDir);
    const resolvedProject = path.resolve(scope.projectRoot);
    const resolvedVault = path.resolve(scope.vaultPath || VAULT_ROOT);
    const outputUnderProject = resolvedOutput === resolvedProject || resolvedOutput.startsWith(resolvedProject + path.sep);
    const outputUnderVault = resolvedOutput === resolvedVault || resolvedOutput.startsWith(resolvedVault + path.sep);

    if (!outputUnderProject && !outputUnderVault) {
      logger.error(
        { outputDir: resolvedOutput, projectRoot: resolvedProject, vaultPath: resolvedVault },
        'AI Defense Scan report --output path is outside project root and vault. Refusing to write.',
      );
    } else {
      fs.mkdirSync(config.outputDir, { recursive: true });
      const filepath = path.join(config.outputDir, `${scanId}.md`);
      fs.writeFileSync(filepath, report, 'utf-8');
      logger.info({ filepath }, 'Report written to output directory');
    }
  } else {
    const vaultPath = scope.vaultPath || VAULT_ROOT;
    writeReportToVault(report, vaultPath, scope.projectRoot);
  }

  // Count findings
  const allFindings = results.flatMap(r => r.findings);
  const critical = allFindings.filter(f => f.severity === 'critical').length;
  const high = allFindings.filter(f => f.severity === 'high').length;

  // Notify if critical/high findings (respects --notify mode)
  const notifyMode = config.notify || 'both';
  if (critical > 0 || high > 0) {
    const message = `AI Defense Scan complete: ${critical} CRITICAL, ${high} HIGH, ${allFindings.length} total findings`;
    if (notifyMode === 'direct' || notifyMode === 'both') {
      notifyTelegram(message, scope.projectRoot);
    }
    if (notifyMode === 'bridge' || notifyMode === 'both') {
      notifyPrimaryAgent(results, scope.projectRoot, scanId);
    }
  }

  logger.info({
    scanId,
    totalFindings: allFindings.length,
    critical,
    high,
    duration: endTime - startTime,
  }, 'AI Defense Scan complete');

  return { results, scanId };
}

// ── CLI Commands ────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
AI Defense Scan

Usage:
  node dist/wraith/scanner.js [options]

Options:
  --profile <name>   Use a scan profile (quick).
                     Overrides --modules.
  --modules <list>   Comma-separated modules or "all" (default: all)
  --notify <mode>    Notification mode on critical/high findings:
                       bridge  = notify primary agent via bridge only
                       direct  = notify user directly (Telegram) only
                       both    = notify both (default)
  --dry-run          Log attacks without executing
  --verbose          Verbose output
  --parallel         Run modules in parallel
  --output <dir>     Output directory (default: vault Audits/Security/)
  --list             List available modules
  --list-profiles    List available scan profiles
  --help             Show this help

Exit codes:
  0 = clean (no findings or info-only)
  1 = findings found (medium/low)
  2 = critical or high findings found

Examples:
  node dist/wraith/scanner.js --profile quick --verbose
  node dist/wraith/scanner.js --modules all --verbose
  node dist/wraith/scanner.js --modules prompt-injection,secret-exposure --dry-run
  node dist/wraith/scanner.js --modules bridge-exploit --output /tmp/scan-results
  node dist/wraith/scanner.js --notify direct --verbose
  node dist/wraith/scanner.js --notify bridge --modules all
`);
}

function printModuleList(): void {
  console.log('\nAvailable AI Defense Scan attack modules:\n');
  for (const [name, mod] of Object.entries(MODULE_REGISTRY)) {
    console.log(`  [ACTIVE] ${name} -- ${mod.description}`);
  }
  console.log('');
}

interface ScanProfile {
  description: string;
  modules: string[];
  scopeOverride?: { allowedHosts?: string[] };
}

interface ScanProfilesFile {
  profiles: Record<string, ScanProfile>;
  schedules: Record<string, string>;
}

function loadScanProfiles(): ScanProfilesFile | null {
  // Resolve project root from this file's location (dist/wraith/scanner.js -> project root)
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const profilePath = path.join(path.resolve(thisDir, '..', '..'), 'bots', 'wraith', 'scan-profiles.json');
  // Fallback: resolve from CWD (works when run from project root)
  const altPath = path.resolve(process.cwd(), 'bots', 'wraith', 'scan-profiles.json');

  for (const p of [profilePath, altPath]) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        return JSON.parse(raw) as ScanProfilesFile;
      } catch (err) {
        logger.warn({ path: p, err }, 'Failed to parse scan-profiles.json');
      }
    }
  }
  return null;
}

function printProfileList(): void {
  const profiles = loadScanProfiles();
  if (!profiles) {
    console.log('\nNo scan-profiles.json found.\n');
    return;
  }
  console.log('\nAvailable scan profiles:\n');
  for (const [name, profile] of Object.entries(profiles.profiles)) {
    const count = profile.modules.includes('all')
      ? Object.keys(MODULE_REGISTRY).length
      : profile.modules.length;
    console.log(`  ${name} (${count} modules) -- ${profile.description}`);
  }
  if (Object.keys(profiles.schedules).length > 0) {
    console.log('\nSchedules:');
    for (const [schedule, profileName] of Object.entries(profiles.schedules)) {
      console.log(`  ${schedule} -> ${profileName}`);
    }
  }
  console.log('');
}

// ── Entry Point ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    return;
  }

  if (args.list) {
    printModuleList();
    return;
  }

  if (args.listProfiles) {
    printProfileList();
    return;
  }

  // Load scope
  const scope = loadScope();

  // Profile resolution: override modules and scope from scan-profiles.json
  if (args.profile) {
    const profiles = loadScanProfiles();
    if (!profiles) {
      logger.error({ profile: args.profile }, 'scan-profiles.json not found, cannot resolve --profile');
      process.exitCode = 2;
      return;
    }
    const profile = profiles.profiles[args.profile];
    if (!profile) {
      logger.error({ profile: args.profile, available: Object.keys(profiles.profiles) }, 'Unknown profile name');
      process.exitCode = 2;
      return;
    }
    // Override modules from profile
    args.modules = profile.modules.join(',');
    // Override scope allowedHosts if profile specifies it
    if (profile.scopeOverride?.allowedHosts) {
      scope.allowedHosts = profile.scopeOverride.allowedHosts;
    }
    const moduleCount = profile.modules.includes('all')
      ? Object.keys(MODULE_REGISTRY).length
      : profile.modules.length;
    logger.info(
      { profile: args.profile, moduleCount, scopeOverride: !!profile.scopeOverride },
      `Scan profile "${args.profile}" loaded: ${moduleCount} modules`,
    );
  }

  // Build config
  const modules = args.modules === 'all' ? ['all'] : args.modules.split(',').map(m => m.trim());
  const config: ScanConfig = {
    modules,
    targets: scope,
    dryRun: args.dryRun,
    verbose: args.verbose,
    parallel: args.parallel,
    outputDir: args.output || undefined,
    notify: args.notify,
  };

  // Run scan
  const { results, scanId } = await runScan(scope, config);

  // Print summary
  const allFindings = results.flatMap(r => r.findings);
  const critical = allFindings.filter(f => f.severity === 'critical').length;
  const high = allFindings.filter(f => f.severity === 'high').length;
  const medium = allFindings.filter(f => f.severity === 'medium').length;
  const low = allFindings.filter(f => f.severity === 'low').length;
  const info = allFindings.filter(f => f.severity === 'info').length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`AI Defense Scan Complete: ${scanId}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Duration: ${Math.round(totalDuration / 1000)}s`);
  console.log(`Modules: ${results.length} run, ${results.filter(r => r.error).length} errored`);
  console.log(`Findings: ${allFindings.length} total`);
  console.log(`  CRITICAL: ${critical}`);
  console.log(`  HIGH:     ${high}`);
  console.log(`  MEDIUM:   ${medium}`);
  console.log(`  LOW:      ${low}`);
  console.log(`  INFO:     ${info}`);
  console.log(`${'='.repeat(60)}\n`);

  // Exit codes
  if (critical > 0) {
    process.exitCode = 2;
  } else if (high > 0 || medium > 0 || low > 0) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'AI Defense Scan fatal error');
  process.exitCode = 2;
});
