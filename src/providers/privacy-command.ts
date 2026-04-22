/**
 * /privacy Command Handler -- Phase 2: Privacy Routing Layer
 *
 * User-facing command to view and control privacy settings.
 * Returns formatted text for Telegram display.
 *
 * Commands:
 *   /privacy or /privacy status   -- show current status
 *   /privacy full                 -- enable full privacy mode
 *   /privacy content              -- default content analysis mode
 *   /privacy keywords             -- legacy keyword-only mode
 *   /privacy off                  -- disable privacy routing
 *   /privacy stats                -- show audit statistics
 *   /privacy audit [n]            -- show last N audit entries
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import type { ProviderRouter } from './router.js';
import type { PrivacyLevel, AuditStats } from './types.js';
import { getProviderEmoji } from './provider-indicator.js';

// ── Time constants ───────────────────────────────────────────────────────

const ONE_DAY_S = 86400;
const SEVEN_DAYS_S = 604800;

// ── Level descriptions ───────────────────────────────────────────────────

const LEVEL_DESCRIPTIONS: Record<PrivacyLevel, string> = {
  off: 'Disabled -- no privacy routing, all data goes to active provider as-is',
  keywords: 'Keywords only -- routes to Venice when you say "private", "use venice", etc.',
  content: 'Content analysis -- scans for PII, financial, crypto, medical data and routes sensitive content to Venice',
  full: 'Full protection -- content analysis + blocks high-sensitivity messages from all providers',
};

// ── Main handler ─────────────────────────────────────────────────────────

/**
 * Handle a /privacy command and return formatted text for Telegram.
 *
 * @param args - The arguments after "/privacy" (e.g. "status", "full", "stats")
 * @param chatId - The chat ID for per-chat settings
 * @param router - The ProviderRouter instance
 * @returns Formatted response text
 */
export function handlePrivacyCommand(
  args: string,
  chatId: string,
  router: ProviderRouter,
): string {
  const trimmed = args.trim().toLowerCase();

  // No args or "status" -- show status
  if (!trimmed || trimmed === 'status') {
    return handleStatus(chatId, router);
  }

  // Set privacy level
  if (trimmed === 'full' || trimmed === 'content' || trimmed === 'keywords' || trimmed === 'off') {
    return handleSetLevel(chatId, trimmed as PrivacyLevel, router);
  }

  // Stats
  if (trimmed === 'stats') {
    return handleStats(chatId, router);
  }

  // Audit entries
  if (trimmed.startsWith('audit')) {
    const countStr = trimmed.replace('audit', '').trim();
    const count = parseInt(countStr, 10) || 10;
    return handleAudit(chatId, count, router);
  }

  // Unknown subcommand
  return [
    'Usage:',
    '  /privacy -- show current status',
    '  /privacy full -- content analysis + block high sensitivity',
    '  /privacy content -- content analysis (default)',
    '  /privacy keywords -- keyword-only detection',
    '  /privacy off -- disable privacy routing',
    '  /privacy stats -- show audit statistics',
    '  /privacy audit [n] -- show last N audit entries',
  ].join('\n');
}

// ── Subcommand handlers ──────────────────────────────────────────────────

function handleStatus(chatId: string, router: ProviderRouter): string {
  const level = router.getPrivacyLevel(chatId);
  const providers = router.listProviders();
  const veniceAvailable = providers.includes('venice');
  const ollamaAvailable = providers.includes('ollama');

  // Build fallback order display
  const fallbackOrder = ['venice', 'ollama', 'openrouter']
    .filter(p => providers.includes(p))
    .map(p => {
      const emoji = getProviderEmoji(p);
      return emoji ? `${emoji} ${p}` : p;
    })
    .join(' > ');

  const lines = [
    'Privacy Routing Status',
    '',
    `Level: ${level}`,
    LEVEL_DESCRIPTIONS[level],
    '',
    `Venice: ${veniceAvailable ? 'available' : 'not configured'}`,
    `Ollama: ${ollamaAvailable ? 'available' : 'not configured'}`,
    `Fallback order: ${fallbackOrder || '(none)'}`,
  ];

  // Add recent stats summary
  const now = Math.floor(Date.now() / 1000);
  const stats24h = router.getPrivacyStats(chatId, now - ONE_DAY_S);
  if (stats24h.totalRequests > 0) {
    lines.push('');
    lines.push(`Last 24h: ${stats24h.totalRequests} requests, ${stats24h.privacyRouted} privacy-routed, ${stats24h.blocked} blocked`);
  }

  return lines.join('\n');
}

function handleSetLevel(chatId: string, level: PrivacyLevel, router: ProviderRouter): string {
  router.setPrivacyLevel(chatId, level);
  return `Privacy level set to: ${level}\n${LEVEL_DESCRIPTIONS[level]}`;
}

function handleStats(chatId: string, router: ProviderRouter): string {
  const now = Math.floor(Date.now() / 1000);

  const stats24h = router.getPrivacyStats(chatId, now - ONE_DAY_S);
  const stats7d = router.getPrivacyStats(chatId, now - SEVEN_DAYS_S);
  const statsAll = router.getPrivacyStats(chatId);

  const lines = [
    'Privacy Audit Stats',
    '',
    'Last 24 hours:',
    formatStats(stats24h),
    '',
    'Last 7 days:',
    formatStats(stats7d),
    '',
    'All time:',
    formatStats(statsAll),
  ];

  // Top categories across all time
  if (statsAll.topCategories.length > 0) {
    lines.push('');
    lines.push('Top sensitivity categories:');
    for (const cat of statsAll.topCategories.slice(0, 5)) {
      lines.push(`  ${cat.category}: ${cat.count}`);
    }
  }

  return lines.join('\n');
}

function handleAudit(chatId: string, count: number, router: ProviderRouter): string {
  const auditLogger = router.getAuditLogger();
  if (!auditLogger) {
    return 'Audit logger not available (database not initialized).';
  }

  const entries = auditLogger.getEntries(chatId, Math.min(count, 50));
  if (entries.length === 0) {
    return 'No audit entries found.';
  }

  const lines = [`Last ${entries.length} audit entries:`, ''];

  for (const entry of entries) {
    const date = new Date(entry.timestamp * 1000);
    const timeStr = date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const categories = (() => {
      try { return JSON.parse(entry.categories).join(', '); }
      catch { return entry.categories; }
    })();

    lines.push(
      `${timeStr} | ${entry.actualRoute} | score: ${entry.sensitivityScore.toFixed(2)} | ${categories || 'none'} | ${entry.wasSanitized ? 'sanitized' : 'raw'}`,
    );
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatStats(stats: AuditStats): string {
  if (stats.totalRequests === 0) return '  No data';

  return [
    `  Total: ${stats.totalRequests}`,
    `  Privacy-routed: ${stats.privacyRouted}`,
    `  Standard: ${stats.standardRouted}`,
    `  Blocked: ${stats.blocked}`,
    `  Avg sensitivity: ${stats.averageSensitivityScore.toFixed(2)}`,
  ].join('\n');
}
