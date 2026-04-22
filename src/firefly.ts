/**
 * Firefly III -- Personal Finance Integration
 *
 * This is a stub module included as an extension point. The full module
 * integrates with Firefly III (https://www.firefly-iii.org/) for
 * personal and business finance tracking, transaction queries,
 * account balances, and budget monitoring.
 *
 * Implement to enable financial workflow actions and dashboard panels.
 */

// ── Types ───────────────────────────────────────────────────────────

export type FireflyContext = 'personal' | 'business';

export interface FireflyAccount {
  name: string;
  type: string;
  current_balance: string;
  current_balance_date: string;
  currency_code: string;
  currency_symbol: string;
  active: boolean;
  account_role: string | null;
  notes: string | null;
}

export interface FireflyTransactionSplit {
  description: string;
  date: string;
  amount: string;
  type: string;
  source_name: string;
  destination_name: string;
  category_name: string | null;
  budget_name: string | null;
  tags: string[];
  notes: string | null;
  currency_code: string;
}

export interface FireflyTransactionGroup {
  group_title: string | null;
  transactions: FireflyTransactionSplit[];
}

export interface FireflyBudget {
  name: string;
  active: boolean;
  spent: Array<{ sum: string; currency_code: string }>;
}

export type FireflySummary = Record<string, {
  key: string;
  title: string;
  monetary_value: number;
  currency_code: string;
  currency_symbol: string;
  value_parsed: string;
  local_icon: string;
  sub_title: string;
}>;

// ── Client ──────────────────────────────────────────────────────────

/**
 * Get a Firefly III client for the given context.
 * Returns null if Firefly III is not configured.
 *
 * Configure via env vars:
 *   FIREFLY_PERSONAL_URL, FIREFLY_PERSONAL_TOKEN
 *   FIREFLY_BUSINESS_URL, FIREFLY_BUSINESS_TOKEN
 *
 * Stub: always returns null. Implement to connect to your Firefly III instance.
 */
export function getFireflyClient(_context: FireflyContext = 'personal'): FireflyClient | null {
  return null;
}

/**
 * Firefly III API client. Stub class with method signatures.
 * Implement to enable financial data queries.
 */
export class FireflyClient {
  async getAccounts(_type?: string): Promise<FireflyAccount[]> {
    return [];
  }

  async getTransactions(_params?: {
    start?: string;
    end?: string;
    type?: string;
    page?: number;
  }): Promise<FireflyTransactionGroup[]> {
    return [];
  }

  async getSummary(_start: string, _end: string): Promise<FireflySummary | null> {
    return null;
  }

  async getBudgets(_start?: string, _end?: string): Promise<FireflyBudget[]> {
    return [];
  }

  async searchTransactions(_query: string): Promise<FireflyTransactionGroup[]> {
    return [];
  }
}

// ── Formatters ──────────────────────────────────────────────────────

/**
 * Format account list for display (Telegram, dashboard, CLI).
 *
 * Stub: returns placeholder text. Implement to format account balances.
 */
export function formatAccounts(_accounts: FireflyAccount[]): string {
  return 'Firefly III not configured. Install the firefly add-on module.';
}

/**
 * Format transaction list for display.
 *
 * Stub: returns placeholder text. Implement to format transaction history.
 */
export function formatTransactions(_groups: FireflyTransactionGroup[]): string {
  return 'Firefly III not configured. Install the firefly add-on module.';
}

/**
 * Format financial summary (accounts + net worth + budgets) for display.
 *
 * Stub: returns placeholder text. Implement to format financial overview.
 */
export function formatSummary(
  _accounts: FireflyAccount[],
  _summary: FireflySummary | null,
  _budgets: FireflyBudget[],
): string {
  return 'Firefly III not configured. Install the firefly add-on module.';
}
