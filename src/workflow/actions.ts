import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { PROJECT_ROOT } from '../config.js';
import type { ActionContext, ActionHandler } from './types.js';

const logger = pino({ name: 'workflow-actions' });

const VAULT_PATH = process.env.VAULT_ROOT || '';
const VAULT_COMMIT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');

// ── Action Registry ─────────────────────────────────────────────────

const registry = new Map<string, ActionHandler>();

export function registerAction(name: string, handler: ActionHandler): void {
  registry.set(name, handler);
}

export function getAction(name: string): ActionHandler | undefined {
  return registry.get(name);
}

export function listActions(): string[] {
  return [...registry.keys()];
}

// ── Built-in Actions ────────────────────────────────────────────────

// llm-query: Send a prompt to the LLM via runWithFallback
// Params: { prompt: string }
// Returns: LLM response text
registerAction('llm-query', async (params, ctx) => {
  const prompt = String(params.prompt || '');
  if (!prompt) throw new Error('llm-query: missing "prompt" param');

  // Dynamic import to avoid circular deps at module load time
  const { runWithFallback } = await import('../fallback-model.js');
  const result = await runWithFallback(
    prompt,
    undefined, // fresh session per step
    () => {}, // no typing indicator
    undefined,
    undefined,
  );
  const text = result.text ?? '';
  logger.info(
    { stepId: ctx.stepId, responseLen: text.length },
    'llm-query completed',
  );
  return text;
});

/**
 * Resolve a user-supplied relative path within the vault and verify
 * the resolved path does not escape the vault root (path traversal protection).
 */
function resolveVaultPath(relativePath: string): string {
  const resolved = path.resolve(VAULT_PATH, relativePath);
  const normalizedVault = path.resolve(VAULT_PATH);
  if (!resolved.startsWith(normalizedVault + path.sep) && resolved !== normalizedVault) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

// vault-read: Read a file from the Obsidian vault
// Params: { file: string (relative to vault root) }
// Returns: File content as string
registerAction('vault-read', async (params) => {
  const file = String(params.file || '');
  if (!file) throw new Error('vault-read: missing "file" param');
  const fullPath = resolveVaultPath(file);
  if (!fs.existsSync(fullPath)) throw new Error(`vault-read: file not found: ${file}`);
  return fs.readFileSync(fullPath, 'utf-8');
});

// vault-write: Write/append to a file in the Obsidian vault
// Params: { file: string, content: string, append?: boolean, commit?: string }
// Returns: written file path
registerAction('vault-write', async (params) => {
  const file = String(params.file || '');
  const content = String(params.content || '');
  if (!file) throw new Error('vault-write: missing "file" param');

  const fullPath = resolveVaultPath(file);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (params.append) {
    fs.appendFileSync(fullPath, content, 'utf-8');
  } else {
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  // Auto-commit if commit message provided
  const commitMsg = params.commit ? String(params.commit) : `workflow: updated ${file}`;
  try {
    execSync(`bash "${VAULT_COMMIT}" "${commitMsg}"`, {
      cwd: VAULT_PATH,
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch {
    // Non-fatal -- file is written even if commit fails
  }
  return fullPath;
});

// telegram-send: Send a message to Telegram via the context sender
// Params: { message: string }
// Returns: "sent"
// Note: ctx.send uses parse_mode:'HTML'. Strip markdown artifacts that break HTML parsing.
registerAction('telegram-send', async (params, ctx) => {
  let message = String(params.message || '');
  if (!message) throw new Error('telegram-send: missing "message" param');
  // Escape HTML special chars so LLM output doesn't break Telegram's HTML parser
  message = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Telegram max message length is 4096 chars
  if (message.length > 4000) {
    message = message.slice(0, 3997) + '...';
  }
  await ctx.send(message);
  return 'sent';
});

// systems-check: Run the core systems check
// Params: {} (none)
// Returns: systems check output
registerAction('systems-check', async () => {
  const scriptPath = path.join(PROJECT_ROOT, 'dist', 'systems-check.js');
  const output = execSync(`node "${scriptPath}"`, {
    timeout: 30000,
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
  });
  return output;
});

// bridge-send: Dispatch a task to an agent via the inter-agent bridge
// Params: { to: string, prompt: string, ttl?: number, priority?: number }
// Returns: task ID
registerAction('bridge-send', async (params) => {
  const to = String(params.to || '');
  const prompt = String(params.prompt || '');
  if (!to || !prompt) throw new Error('bridge-send: missing "to" or "prompt" param');

  const { sendTask } = await import('../bridge.js');
  const taskId = sendTask(
    'workflow',
    to,
    { prompt, timeout_minutes: Number(params.timeout_minutes) || 30 },
    Number(params.priority) || 0,
    Number(params.ttl) || 60,
  );
  return taskId;
});

// shell: Execute a bash command (allowlisted commands only)
// Params: { command: string, timeout_s?: number }
// Returns: stdout

/** Allowlisted command prefixes for the workflow shell action. */
const SHELL_ALLOWLIST: RegExp[] = [
  /^git\s/,
  /^npm\s/,
  /^node\s/,
  /^npx\s/,
  /^bash\s+.*vault-commit/,
  /^bash\s+.*systems-check/,
  /^bash\s+.*restart\.sh/,
  /^node\s+.*systems-check\.js/,
  /^node\s+.*bridge-cli\.js/,
  /^node\s+.*schedule-cli\.js/,
  /^pm2\s+(status|list|jlist|logs|describe)\b/,
  /^ls\b/,
  /^cat\b/,
  /^echo\b/,
  /^date\b/,
  /^pwd\b/,
  /^wc\b/,
  /^sqlite3\b/,
  /^python3?\s/,
];

/** Blocked patterns that override the allowlist. */
const SHELL_BLOCKLIST: RegExp[] = [
  /rm\s+(-rf|--recursive)/i,
  /curl\s.*https?:\/\/(?!localhost|127\.0\.0\.1)/i,
  /wget\s/i,
  /\beval\b/,
  /bash\s+-c\s.*\|.*(?:curl|wget|nc|ncat)/i,
  /cat\s+.*\.(env|pem|key|age|secret)/i,
  />(>)?\s*\/etc\//,
  /\|\s*(nc|ncat|netcat)\b/,
  /mkfifo/i,
];

function isShellCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  // Check blocklist first -- overrides allowlist
  for (const pattern of SHELL_BLOCKLIST) {
    if (pattern.test(trimmed)) return false;
  }
  // Check allowlist
  for (const pattern of SHELL_ALLOWLIST) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

registerAction('shell', async (params) => {
  const command = String(params.command || '');
  if (!command) throw new Error('shell: missing "command" param');

  if (!isShellCommandAllowed(command)) {
    logger.warn({ command }, 'shell: blocked command (not in allowlist)');
    throw new Error(`shell: command not allowed: ${command.slice(0, 80)}`);
  }

  const timeoutMs = (Number(params.timeout_s) || 30) * 1000;
  const output = execSync(command, {
    timeout: timeoutMs,
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
  });
  return output.trim();
});

// webhook-call: Make an HTTP request to an external URL
// Params: { url: string, method?: string, headers?: object, body?: string }
// Returns: response body
registerAction('webhook-call', async (params) => {
  const url = String(params.url || '');
  if (!url) throw new Error('webhook-call: missing "url" param');

  const method = String(params.method || 'POST').toUpperCase();
  const headers: Record<string, string> = {};
  if (params.headers && typeof params.headers === 'object') {
    for (const [k, v] of Object.entries(params.headers)) {
      headers[k] = String(v);
    }
  }

  const fetchOpts: RequestInit = { method, headers };
  if (params.body) {
    fetchOpts.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  if (!res.ok) throw new Error(`webhook-call: ${res.status} ${text.slice(0, 200)}`);
  return text;
});

// delay: Wait for a specified number of seconds
// Params: { seconds: number }
// Returns: "waited Ns"
registerAction('delay', async (params) => {
  const seconds = Number(params.seconds) || 5;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return `waited ${seconds}s`;
});

// condition: Evaluate a simple condition on previous outputs
// Params: { check: string } -- "truthy" check on stringified outputs
// Returns: boolean
registerAction('condition', async (params, ctx) => {
  const check = String(params.check || '');
  if (!check) throw new Error('condition: missing "check" param');

  // Simple: check if a dependency output contains a keyword
  // Format: "step_id contains keyword" or "step_id exists"
  const parts = check.split(/\s+/);
  if (parts.length >= 3 && parts[1] === 'contains') {
    const stepOutput = String(ctx.outputs[parts[0]] ?? '');
    const keyword = parts.slice(2).join(' ');
    return stepOutput.toLowerCase().includes(keyword.toLowerCase());
  }
  if (parts.length === 2 && parts[1] === 'exists') {
    return ctx.outputs[parts[0]] !== undefined && ctx.outputs[parts[0]] !== null;
  }

  // Fallback: check if the string is a truthy step output reference
  const val = ctx.outputs[check];
  return val !== undefined && val !== null && val !== '' && val !== false;
});

// log: Write a message to the workflow logger (useful for debugging workflows)
// Params: { message: string, level?: string }
// Returns: "logged"
registerAction('log', async (params) => {
  const message = String(params.message || '');
  const level = String(params.level || 'info');
  if (level === 'warn') {
    logger.warn({ workflow: true }, message);
  } else if (level === 'error') {
    logger.error({ workflow: true }, message);
  } else {
    logger.info({ workflow: true }, message);
  }
  return 'logged';
});

// browser: Playwright browser operations (Track 5a)
// Params: { op: string, url?: string, selector?: string, value?: string, ... }
// Returns: operation result (page info, text, screenshot path, etc.)
registerAction('browser', async (params, ctx) => {
  // Lazy import so Playwright doesn't load unless a workflow actually needs it
  const {
    browserGoto,
    browserScreenshot,
    browserText,
    browserClick,
    browserFill,
    browserClose,
    browserSaveSession,
    browserLoadSession,
  } = await import('../browser.js');

  const op = String(params.op || 'screenshot');

  switch (op) {
    case 'goto': {
      const url = String(params.url || '');
      if (!url) throw new Error('browser goto: missing "url" param');
      const result = await browserGoto(url, {
        stealth: params.stealth === true || params.stealth === 'true',
        waitUntil: params.waitUntil as 'load' | 'domcontentloaded' | 'networkidle' | undefined,
      });
      return `${result.title} (${result.url}) [${result.status}]`;
    }

    case 'screenshot': {
      const filePath = await browserScreenshot({
        fullPage: params.fullPage === true || params.fullPage === 'true',
        selector: params.selector ? String(params.selector) : undefined,
      });
      return filePath;
    }

    case 'text': {
      const text = await browserText(params.selector ? String(params.selector) : undefined);
      // Truncate for workflow output (avoid bloating step outputs)
      return text.length > 5000 ? text.slice(0, 4997) + '...' : text;
    }

    case 'click': {
      const selector = String(params.selector || '');
      if (!selector) throw new Error('browser click: missing "selector" param');
      await browserClick(selector);
      return `clicked ${selector}`;
    }

    case 'fill': {
      const selector = String(params.selector || '');
      const value = String(params.value || '');
      if (!selector) throw new Error('browser fill: missing "selector" param');
      await browserFill(selector, value);
      return `filled ${selector}`;
    }

    case 'save-session': {
      const domain = String(params.domain || '');
      if (!domain) throw new Error('browser save-session: missing "domain" param');
      const id = await browserSaveSession(domain, params.label ? String(params.label) : undefined);
      return `session saved: ${id}`;
    }

    case 'load-session': {
      const target = String(params.domain || params.id || '');
      if (!target) throw new Error('browser load-session: missing "domain" or "id" param');
      const loaded = await browserLoadSession(target);
      return loaded ? 'session loaded' : 'no session found';
    }

    case 'close': {
      await browserClose();
      return 'browser closed';
    }

    default:
      throw new Error(`browser: unknown op "${op}". Use: goto, screenshot, text, click, fill, save-session, load-session, close`);
  }
});

// ── Firefly III Actions ──────────────────────────────────────────────

// firefly-get-transactions: Pull recent transactions from Firefly III
// Params: { days?: number, type?: string, search?: string, context?: 'personal' | 'business' }
registerAction('firefly-get-transactions', async (params) => {
  const { getFireflyClient, formatTransactions } = await import('../firefly.js');
  const context = (params.context === 'business' ? 'business' : 'personal') as 'personal' | 'business';
  const client = getFireflyClient(context);
  if (!client) throw new Error(`Firefly III (${context}) not configured`);

  if (params.search) {
    const results = await client.searchTransactions(String(params.search));
    return formatTransactions(results);
  }

  const days = Number(params.days) || 7;
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
  const transactions = await client.getTransactions({
    start,
    end,
    type: params.type ? String(params.type) : undefined,
  });
  return formatTransactions(transactions);
});

// firefly-get-summary: Account balances, net worth, budget overview
// Params: { days?: number, context?: 'personal' | 'business' }
registerAction('firefly-get-summary', async (params) => {
  const { getFireflyClient, formatSummary } = await import('../firefly.js');
  const context = (params.context === 'business' ? 'business' : 'personal') as 'personal' | 'business';
  const client = getFireflyClient(context);
  if (!client) throw new Error(`Firefly III (${context}) not configured`);

  const days = Number(params.days) || 30;
  const end = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];

  const [accounts, summary, budgets] = await Promise.all([
    client.getAccounts('asset'),
    client.getSummary(start, end),
    client.getBudgets(start, end),
  ]);

  return formatSummary(accounts, summary, budgets);
});

// firefly-get-accounts: List active accounts with balances
// Params: { type?: string, context?: 'personal' | 'business' } (asset, expense, revenue, liability)
registerAction('firefly-get-accounts', async (params) => {
  const { getFireflyClient, formatAccounts } = await import('../firefly.js');
  const context = (params.context === 'business' ? 'business' : 'personal') as 'personal' | 'business';
  const client = getFireflyClient(context);
  if (!client) throw new Error(`Firefly III (${context}) not configured`);

  const accounts = await client.getAccounts(
    params.type ? String(params.type) : 'asset',
  );
  return formatAccounts(accounts);
});
