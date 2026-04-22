/**
 * Weekly API Usage Audit
 *
 * Reads token_usage from each bot's encrypted DB for the past 7 days.
 * Aggregates per bot: input/output tokens, cache reads, cost, turns, compactions.
 * Generates a markdown report saved to the Obsidian vault.
 *
 * Run: node dist/audit-api-usage.js
 * Schedule: Weekly (e.g. every Monday)
 */

import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readEnvFile } from './env.js';

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

const DB_PASSPHRASE = readEnvFile(['DB_PASSPHRASE']).DB_PASSPHRASE || '';
if (!DB_PASSPHRASE) {
  console.error('[audit-api-usage] FATAL: DB_PASSPHRASE not found in .env');
  process.exit(1);
}

// -- Types ------------------------------------------------------------------

interface BotDef {
  name: string;
  displayName: string;
  dbPath: string;
}

interface BotUsage {
  displayName: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReads: number;
  costUsd: number;
  compactions: number;
  flags: string[];
  error?: string;
}

interface DailyEntry {
  date: string;
  turns: number;
  cost: number;
}

// -- Bot definitions --------------------------------------------------------

// Rename to your agent names
const BOTS: BotDef[] = [
  { name: 'apex-bot', displayName: 'Primary Bot', dbPath: path.join(PROJECT_ROOT, 'store', 'apex.db') },
  { name: 'worker-1', displayName: 'Worker 1', dbPath: path.join(PROJECT_ROOT, 'bots', 'worker-1', 'store', 'apex.db') },
  { name: 'worker-2', displayName: 'Worker 2', dbPath: path.join(PROJECT_ROOT, 'bots', 'worker-2', 'store', 'apex.db') },
  { name: 'worker-3', displayName: 'Worker 3', dbPath: path.join(PROJECT_ROOT, 'bots', 'worker-3', 'store', 'apex.db') },
];

// Rename to your headless worker agent names
const UNTRACKED_BOTS = ['Research', 'Code', 'Scribe', 'Creative'];

// ── Billing mode config ──────────────────────────────────────────────
// 'max'  = Claude MAX subscription ($100 or $200/mo fixed -- track API overage + session health)
// 'api'  = Pay-per-token Anthropic API billing (track actual dollar costs against budget)
type BillingMode = 'max' | 'api';
const BILLING_MODE: BillingMode = (process.env.BILLING_MODE as BillingMode) || 'api';

// MAX plan tiers (monthly cost -- usage is "unlimited" within rate limits)
const MAX_PLAN_TIERS = {
  pro:  { name: 'Pro',  monthlyUsd: 100 },
  max5: { name: 'Max (5x)', monthlyUsd: 200 },
};
const ACTIVE_MAX_TIER = MAX_PLAN_TIERS.max5; // Change to match your actual plan

// API billing thresholds
const API_DAILY_COST_THRESHOLD = 80.0;    // Flag if daily avg exceeds this
const API_WEEKLY_COST_THRESHOLD = 500.0;  // Flag if weekly total exceeds this

// MAX billing thresholds (track session health since cost is fixed)
const MAX_COMPACTION_THRESHOLD = 15;       // Flag if compactions exceed this per week
const MAX_TURNS_THRESHOLD = 1500;          // Flag if turns exceed this per week (rate limit risk)

// Anthropic API rates (approximate, for comparison calculations)
const API_RATES = {
  inputPerMTok: 3.0,    // $/MTok input (Sonnet)
  outputPerMTok: 15.0,  // $/MTok output (Sonnet)
  cacheReadPerMTok: 0.30, // $/MTok cache read (Sonnet)
};

// -- Helpers ----------------------------------------------------------------

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// -- Data gathering ---------------------------------------------------------

function getBotUsage(bot: BotDef, sevenDaysAgo: number): BotUsage {
  const result: BotUsage = {
    displayName: bot.displayName,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReads: 0,
    costUsd: 0,
    compactions: 0,
    flags: [],
  };

  if (!fs.existsSync(bot.dbPath)) {
    result.error = 'DB not found';
    return result;
  }

  try {
    const db = new Database(bot.dbPath, { readonly: true });
    // DBs use default cipher (not sqlcipher).
    db.pragma(`key='${DB_PASSPHRASE}'`);

    // Verify token_usage table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'",
    ).get();

    if (!tableCheck) {
      db.close();
      result.error = 'No token_usage table';
      return result;
    }

    const row = db.prepare(`
      SELECT
        COUNT(*)              as turns,
        COALESCE(SUM(input_tokens), 0)  as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read), 0)    as cache_reads,
        COALESCE(SUM(cost_usd), 0)      as cost_usd,
        COALESCE(SUM(did_compact), 0)   as compactions
      FROM token_usage
      WHERE created_at >= ?
    `).get(sevenDaysAgo) as {
      turns: number;
      input_tokens: number;
      output_tokens: number;
      cache_reads: number;
      cost_usd: number;
      compactions: number;
    };

    result.turns = row.turns;
    result.inputTokens = row.input_tokens;
    result.outputTokens = row.output_tokens;
    result.cacheReads = row.cache_reads;
    result.costUsd = row.cost_usd;
    result.compactions = row.compactions;

    db.close();

    // Flag checks (billing-mode-aware)
    if (BILLING_MODE === 'api') {
      const dailyAvg = result.costUsd / 7;
      if (dailyAvg > API_DAILY_COST_THRESHOLD) {
        result.flags.push(`Daily avg ${formatCost(dailyAvg)} exceeds ${formatCost(API_DAILY_COST_THRESHOLD)}/day budget`);
      }
      if (result.costUsd > API_WEEKLY_COST_THRESHOLD) {
        result.flags.push(`Weekly total ${formatCost(result.costUsd)} exceeds ${formatCost(API_WEEKLY_COST_THRESHOLD)}/week budget`);
      }
    } else {
      // MAX mode: flag session health issues, not costs
      if (result.compactions > MAX_COMPACTION_THRESHOLD) {
        result.flags.push(`${result.compactions} compactions this week (threshold: ${MAX_COMPACTION_THRESHOLD}) -- sessions running long`);
      }
      if (result.turns > MAX_TURNS_THRESHOLD) {
        result.flags.push(`${result.turns} turns this week (threshold: ${MAX_TURNS_THRESHOLD}) -- rate limit risk`);
      }
    }

  } catch (err) {
    result.error = `DB error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return result;
}

function getDailyBreakdown(bot: BotDef, sevenDaysAgo: number): DailyEntry[] {
  if (!fs.existsSync(bot.dbPath)) return [];

  try {
    const db = new Database(bot.dbPath, { readonly: true });
    // DBs use default cipher (not sqlcipher).
    db.pragma(`key='${DB_PASSPHRASE}'`);

    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'",
    ).get();

    if (!tableCheck) {
      db.close();
      return [];
    }

    const rows = db.prepare(`
      SELECT
        date(created_at, 'unixepoch') as date,
        COUNT(*) as turns,
        COALESCE(SUM(cost_usd), 0) as cost
      FROM token_usage
      WHERE created_at >= ?
      GROUP BY date(created_at, 'unixepoch')
      ORDER BY date ASC
    `).all(sevenDaysAgo) as DailyEntry[];

    db.close();
    return rows;
  } catch (err) {
    console.error(`Failed to get daily breakdown for ${bot.displayName}:`, err);
    return [];
  }
}

// -- Main -------------------------------------------------------------------

function run(): void {
  const now = new Date();
  const reportDate = now.toISOString().split('T')[0];
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

  console.log(`Running API usage audit for ${reportDate}...`);

  // Gather per-bot usage
  const botUsages: BotUsage[] = [];
  for (const bot of BOTS) {
    const usage = getBotUsage(bot, sevenDaysAgo);
    botUsages.push(usage);
  }

  // Totals
  const totalCost = botUsages.reduce((sum, b) => sum + b.costUsd, 0);
  const totalTurns = botUsages.reduce((sum, b) => sum + b.turns, 0);
  const totalCompactions = botUsages.reduce((sum, b) => sum + b.compactions, 0);
  const dailyAvg = totalCost / 7;

  // Find top spender for daily breakdown
  let topSpender = BOTS[0];
  let topCost = 0;
  for (let i = 0; i < BOTS.length; i++) {
    if (botUsages[i].costUsd > topCost) {
      topCost = botUsages[i].costUsd;
      topSpender = BOTS[i];
    }
  }

  const dailyBreakdown = getDailyBreakdown(topSpender, sevenDaysAgo);

  // Collect all flags
  const allFlags: string[] = [];
  for (const usage of botUsages) {
    for (const flag of usage.flags) {
      allFlags.push(`[${usage.displayName}] ${flag}`);
    }
    if (usage.error) {
      allFlags.push(`[${usage.displayName}] ${usage.error}`);
    }
  }

  const status = allFlags.length > 0 ? 'flagged' : 'clean';

  // -- Generate markdown ----------------------------------------------------

  let md = `---
type: audit
tags: [audit, api-usage]
created: ${reportDate}
status: ${status}
---

# Weekly API Usage Report - ${reportDate}

## Summary
- Billing mode: ${BILLING_MODE === 'api' ? 'API (pay-per-token)' : `MAX ${ACTIVE_MAX_TIER.name} (${formatCost(ACTIVE_MAX_TIER.monthlyUsd)}/mo)`}
- Total tracked spend: ${formatCost(totalCost)} (7 days)
- Daily average: ${formatCost(dailyAvg)}
- Turns tracked: ${totalTurns}
- Compactions: ${totalCompactions}

## Per-Bot Breakdown
| Bot | Turns | Input Tokens | Output Tokens | Cache Reads | Cost | Flags |
|-----|-------|-------------|---------------|-------------|------|-------|
`;

  for (const usage of botUsages) {
    const flagStr = usage.error
      ? usage.error
      : usage.flags.length > 0
        ? usage.flags.join('; ')
        : '-';
    md += `| ${usage.displayName} | ${usage.turns} | ${formatTokens(usage.inputTokens)} | ${formatTokens(usage.outputTokens)} | ${formatTokens(usage.cacheReads)} | ${formatCost(usage.costUsd)} | ${flagStr} |\n`;
  }

  md += `
## Daily Trend (${topSpender.displayName})
| Date | Turns | Cost |
|------|-------|------|
`;

  if (dailyBreakdown.length === 0) {
    md += `| (no data) | - | - |\n`;
  } else {
    for (const day of dailyBreakdown) {
      md += `| ${day.date} | ${day.turns} | ${formatCost(day.cost)} |\n`;
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

  // -- Billing comparison section --
  const totalInput = botUsages.reduce((s, b) => s + b.inputTokens, 0);
  const totalOutput = botUsages.reduce((s, b) => s + b.outputTokens, 0);
  const totalCache = botUsages.reduce((s, b) => s + b.cacheReads, 0);

  // Estimate what API billing would cost (for MAX users) or what MAX would cost (for API users)
  const estimatedApiCost = (totalInput / 1_000_000) * API_RATES.inputPerMTok
    + (totalOutput / 1_000_000) * API_RATES.outputPerMTok
    + (totalCache / 1_000_000) * API_RATES.cacheReadPerMTok;
  const maxWeeklyCost = ACTIVE_MAX_TIER.monthlyUsd / 4.33; // Approximate weekly cost of MAX

  md += `
## Billing Comparison
| Metric | Value |
|--------|-------|
| Current billing mode | ${BILLING_MODE.toUpperCase()} |
`;

  if (BILLING_MODE === 'api') {
    md += `| Actual API spend (7d) | ${formatCost(totalCost)} |
| Projected monthly | ${formatCost(totalCost * 4.33)} |
| MAX ${ACTIVE_MAX_TIER.name} plan cost | ${formatCost(ACTIVE_MAX_TIER.monthlyUsd)}/mo (${formatCost(maxWeeklyCost)}/wk) |
| Savings if on MAX | ${totalCost > maxWeeklyCost ? formatCost(totalCost - maxWeeklyCost) + '/wk saved' : 'N/A -- API is cheaper'} |
| Recommendation | ${totalCost * 4.33 > ACTIVE_MAX_TIER.monthlyUsd ? '**Switch to MAX** -- API spend exceeds MAX plan cost' : 'Stay on API -- usage is below MAX plan cost'} |
`;
  } else {
    md += `| MAX plan cost | ${formatCost(ACTIVE_MAX_TIER.monthlyUsd)}/mo (${ACTIVE_MAX_TIER.name}) |
| Estimated API equivalent (7d) | ${formatCost(estimatedApiCost)} |
| Projected API monthly | ${formatCost(estimatedApiCost * 4.33)} |
| MAX savings vs API | ${estimatedApiCost > maxWeeklyCost ? formatCost(estimatedApiCost - maxWeeklyCost) + '/wk saved on MAX' : 'API would be cheaper by ' + formatCost(maxWeeklyCost - estimatedApiCost) + '/wk'} |
`;
  }

  md += `
## Untracked Bots
- ${UNTRACKED_BOTS.join(', ')} (headless workers -- check Anthropic billing dashboard)

## Notes
- Data source: local token_usage tables (PMAOS tracked)
- Billing mode: ${BILLING_MODE === 'api' ? 'Pay-per-token API billing' : `MAX ${ACTIVE_MAX_TIER.name} subscription (${formatCost(ACTIVE_MAX_TIER.monthlyUsd)}/mo)`}
- Does not include Venice API costs (separate billing)
- Set BILLING_MODE env var to 'max' or 'api' to change thresholds
`;

  // -- Write to vault -------------------------------------------------------

  const outputPath = path.join(VAULT_PATH, 'Audits', 'API Usage', `${reportDate} - API Usage.md`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md, 'utf-8');

  console.log(`API usage audit written to: ${outputPath}`);

  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "api usage audit - ${reportDate}"`, {
      cwd: VAULT_PATH,
      stdio: 'pipe',
      windowsHide: true,
    });
    console.log('Vault commit done.');
  } catch (err) {
    console.error('Vault commit failed (non-fatal):', err);
  }

  console.log('API usage audit complete.');

  if (process.argv.includes('--notify')) {
    const topBot = botUsages.length > 0
      ? botUsages.reduce((a, b) => a.costUsd > b.costUsd ? a : b)
      : null;
    const summary = topBot
      ? `API Usage: ${formatCost(totalCost)} (7d). Top: ${topBot.displayName} ${formatCost(topBot.costUsd)}.`
      : `API Usage: ${formatCost(totalCost)} (7d).`;
    notify(summary);
  }
}

run();
