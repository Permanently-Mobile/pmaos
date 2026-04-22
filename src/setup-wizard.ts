/**
 * Apex -- First-Run Setup Wizard
 *
 * Interactive CLI that walks new users through creating a .env configuration file.
 * Covers all required and optional settings in 15 steps:
 *
 *   1.  Welcome + overwrite check
 *   2.  License key
 *   3.  Telegram setup (required)
 *   4.  Claude API key (required)
 *   5.  Bot identity
 *   6.  Paths
 *   7.  Voice configuration
 *   8.  Privacy provider (Venice)
 *   9.  Messaging platforms
 *   10. Security (Paladin)
 *   11. Dashboard
 *   12. Database
 *   13. Feature flags
 *   14. Review
 *   15. Write .env + next steps
 *
 * Run: node setup-wizard.mjs
 *
 * Internal automation -- disabled by default in release builds
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';

// ── ANSI color helpers (no external deps) ───────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
};

const bold  = (t: string) => `${C.bold}${t}${C.reset}`;
const dim   = (t: string) => `${C.dim}${t}${C.reset}`;
const red   = (t: string) => `${C.red}${t}${C.reset}`;
const green = (t: string) => `${C.green}${t}${C.reset}`;
const yellow = (t: string) => `${C.yellow}${t}${C.reset}`;
const cyan  = (t: string) => `${C.cyan}${t}${C.reset}`;

// ── Readline helpers ────────────────────────────────────────────────

let rl: readline.Interface;

function initReadline(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Graceful Ctrl+C
  rl.on('close', () => process.exit(0));
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);

    let input = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input.trim());
      } else if (c === '\u007F' || c === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c === '\u0003') {
        // Ctrl+C
        process.exit(0);
      } else {
        input += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function choose(question: string, options: string[], descriptions?: Record<string, string>): Promise<string> {
  console.log(`\n  ${bold(question)}\n`);
  for (let i = 0; i < options.length; i++) {
    const desc = descriptions?.[options[i]] ? `  ${dim('-- ' + descriptions[options[i]])}` : '';
    console.log(`    ${cyan(String(i + 1) + ')')} ${options[i]}${desc}`);
  }
  console.log('');
  while (true) {
    const raw = await ask(`  Choice [1-${options.length}]: `);
    const idx = parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    console.log(red(`  Invalid choice. Enter a number between 1 and ${options.length}.`));
  }
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const raw = await ask(`  ${question} ${hint}: `);
  if (raw === '') return defaultYes;
  return raw.toLowerCase().startsWith('y');
}

async function askNumber(question: string, min: number, max: number, defaultVal?: number): Promise<number> {
  const hint = defaultVal !== undefined ? ` [default: ${defaultVal}]` : '';
  while (true) {
    const raw = await ask(`  ${question} (${min}-${max})${hint}: `);
    if (raw === '' && defaultVal !== undefined) return defaultVal;
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= min && num <= max) return num;
    console.log(red(`  Enter a number between ${min} and ${max}.`));
  }
}

function generateSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 4) + '****';
}

// ── Config accumulator ──────────────────────────────────────────────

interface EnvConfig {
  [key: string]: string;

  // Required
  TELEGRAM_BOT_TOKEN: string;
  ALLOWED_CHAT_ID: string;
  ANTHROPIC_API_KEY: string;

  // Optional (set to empty string if skipped)
  LICENSE_KEY: string;
  WORKFLOW_CHAT_ID: string;
  BOT_NAME: string;
  PROJECT_ROOT: string;
  VAULT_ROOT: string;
  GROQ_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
  VENICE_API_KEY: string;
  DISCORD_TOKEN: string;
  DISCORD_ENABLED: string;
  SIGNAL_API_URL: string;
  SIGNAL_PHONE_NUMBER: string;
  SIGNAL_ALLOWED_NUMBERS: string;
  MATRIX_HOMESERVER_URL: string;
  MATRIX_ACCESS_TOKEN: string;
  MATRIX_ALLOWED_ROOMS: string;
  WHATSAPP_ENABLED: string;
  SLACK_BOT_TOKEN: string;
  PALADIN_PORT: string;
  PALADIN_APPROVAL_TOKEN: string;
  DASHBOARD_TOKEN: string;
  DASHBOARD_PORT: string;
  DASHBOARD_URL: string;
  DB_ENCRYPTION_KEY: string;
  ENABLE_SCHEDULER: string;
  ENABLE_SCRIBE: string;
  ENABLE_INBOX: string;
  ENABLE_VAULT_SYNC: string;
  ENABLE_WORKFLOWS: string;
  ENABLE_DECAY_SWEEP: string;
  ENABLE_DB_BACKUP: string;
}

function emptyConfig(): EnvConfig {
  return {
    TELEGRAM_BOT_TOKEN: '',
    ALLOWED_CHAT_ID: '',
    ANTHROPIC_API_KEY: '',
    LICENSE_KEY: '',
    WORKFLOW_CHAT_ID: '',
    BOT_NAME: 'apex',
    PROJECT_ROOT: '',
    VAULT_ROOT: '',
    GROQ_API_KEY: '',
    ELEVENLABS_API_KEY: '',
    ELEVENLABS_VOICE_ID: '',
    VENICE_API_KEY: '',
    DISCORD_TOKEN: '',
    DISCORD_ENABLED: '',
    SIGNAL_API_URL: '',
    SIGNAL_PHONE_NUMBER: '',
    SIGNAL_ALLOWED_NUMBERS: '',
    MATRIX_HOMESERVER_URL: '',
    MATRIX_ACCESS_TOKEN: '',
    MATRIX_ALLOWED_ROOMS: '',
    WHATSAPP_ENABLED: '',
    SLACK_BOT_TOKEN: '',
    PALADIN_PORT: '3150',
    PALADIN_APPROVAL_TOKEN: '',
    DASHBOARD_TOKEN: '',
    DASHBOARD_PORT: '3210',
    DASHBOARD_URL: '',
    DB_ENCRYPTION_KEY: '',
    ENABLE_SCHEDULER: '',
    ENABLE_SCRIBE: '',
    ENABLE_INBOX: '',
    ENABLE_VAULT_SYNC: '',
    ENABLE_WORKFLOWS: '',
    ENABLE_DECAY_SWEEP: '',
    ENABLE_DB_BACKUP: '',
  };
}

// ── Banner ──────────────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log(cyan('  +======================================================+'));
  console.log(cyan('  |') + bold('     _    ____  _______  __                            ') + cyan('|'));
  console.log(cyan('  |') + bold('    / \\  |  _ \\| ____\\ \\/ /                            ') + cyan('|'));
  console.log(cyan('  |') + bold('   / _ \\ | |_) |  _|  \\  /                             ') + cyan('|'));
  console.log(cyan('  |') + bold('  / ___ \\|  __/| |___ /  \\                             ') + cyan('|'));
  console.log(cyan('  |') + bold(' /_/   \\_\\_|   |_____/_/\\_\\                            ') + cyan('|'));
  console.log(cyan('  |') + '                                                      ' + cyan('|'));
  console.log(cyan('  |') + dim('  Setup Wizard                                        ') + cyan('|'));
  console.log(cyan('  |') + dim('  This wizard creates your .env configuration file.   ') + cyan('|'));
  console.log(cyan('  |') + dim('  You can edit it manually later if needed.            ') + cyan('|'));
  console.log(cyan('  |') + '                                                      ' + cyan('|'));
  console.log(cyan('  +======================================================+'));
  console.log('');
}

// ── Step 1: Welcome ─────────────────────────────────────────────────

async function stepWelcome(envPath: string): Promise<boolean> {
  console.log(bold('  -- Step 1/15: Welcome --\n'));

  if (fs.existsSync(envPath)) {
    console.log(yellow(`  Found existing .env at ${envPath}`));
    const overwrite = await confirm('Overwrite it?', false);
    if (!overwrite) {
      console.log('  Aborted. Existing .env preserved.');
      return false;
    }
    console.log('');
  }

  console.log(dim('  Walk through each section to configure your bot.'));
  console.log(dim('  Required fields are marked. Everything else can be skipped.\n'));
  return true;
}

// ── Step 2: License Key ─────────────────────────────────────────────

async function stepLicense(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 2/15: License Key --\n'));
  console.log(dim('  Optional. Skip for free tier.\n'));

  const key = await ask('  License key (or Enter to skip): ');

  if (!key) {
    console.log(dim('  Skipped. You can add a license key to .env later.\n'));
    return;
  }

  // Basic format check: non-empty is enough
  cfg.LICENSE_KEY = key;
  console.log(green('  License key saved.\n'));
}

// ── Step 3: Telegram Setup ──────────────────────────────────────────

async function stepTelegram(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 3/15: Telegram Setup --') + red(' (required)') + '\n');

  // Bot token
  while (true) {
    console.log(dim('  Get your bot token from @BotFather on Telegram.\n'));
    const token = await askSecret('  Bot token: ');
    if (!token) {
      console.log(red('  Bot token is required.'));
      continue;
    }
    // Telegram tokens look like 123456789:ABCdefGHIjklMNOpqrSTUvwxyz
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      console.log(yellow('  That does not look like a standard Telegram bot token.'));
      const keep = await confirm('Use it anyway?', false);
      if (!keep) continue;
    }
    cfg.TELEGRAM_BOT_TOKEN = token;
    break;
  }

  // Chat ID
  while (true) {
    console.log(dim('\n  Your personal chat ID. Send /start to @userinfobot to find it.\n'));
    const chatId = await ask('  Chat ID: ');
    if (!chatId) {
      console.log(red('  Chat ID is required.'));
      continue;
    }
    cfg.ALLOWED_CHAT_ID = chatId;
    break;
  }

  // Workflow chat ID (optional)
  console.log(dim('\n  Optional: separate group chat for agent results and audits.'));
  console.log(dim('  Keeps your personal chat clean.\n'));
  const workflowId = await ask('  Workflow chat ID (or Enter to skip): ');
  cfg.WORKFLOW_CHAT_ID = workflowId;

  console.log(green('\n  Telegram configured.\n'));
}

// ── Step 4: Claude API Key ──────────────────────────────────────────

async function stepClaude(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 4/15: Claude API Key --') + red(' (required)') + '\n');
  console.log(dim('  Get yours at console.anthropic.com\n'));

  while (true) {
    const key = await askSecret('  Anthropic API key: ');
    if (!key) {
      console.log(red('  API key is required.'));
      continue;
    }
    if (!key.startsWith('sk-ant-')) {
      console.log(yellow('  Key does not start with sk-ant-. Might be invalid.'));
      const keep = await confirm('Use it anyway?', false);
      if (!keep) continue;
    }
    cfg.ANTHROPIC_API_KEY = key;
    break;
  }

  console.log(green('\n  Claude API key saved.\n'));
}

// ── Step 5: Bot Identity ────────────────────────────────────────────

async function stepIdentity(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 5/15: Bot Identity --\n'));
  console.log(dim('  This name determines personality, logs, and primary-bot gating.\n'));

  const name = await ask('  Bot name [apex]: ');
  cfg.BOT_NAME = name || 'apex';
  console.log(`  Bot name: ${green(cfg.BOT_NAME)}\n`);
}

// ── Step 6: Paths ───────────────────────────────────────────────────

async function stepPaths(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 6/15: Paths --\n'));

  // Project root
  const cwd = process.env.APEX_ROOT || process.cwd();
  console.log(`  Detected project root: ${cyan(cwd)}`);
  const useDetected = await confirm('Use this path?', true);

  if (useDetected) {
    cfg.PROJECT_ROOT = cwd;
  } else {
    const custom = await ask('  Project root (absolute path): ');
    cfg.PROJECT_ROOT = custom || cwd;
  }

  // Vault root
  console.log(dim('\n  Optional: Obsidian vault for notes, tasks, and research.'));
  console.log(dim('  Leave blank to skip vault integration.\n'));
  const vault = await ask('  Vault root (or Enter to skip): ');
  cfg.VAULT_ROOT = vault;

  console.log('');
}

// ── Step 7: Voice Configuration ─────────────────────────────────────

async function stepVoice(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 7/15: Voice Configuration --\n'));
  console.log(dim('  Send and receive voice messages via Groq Whisper (STT) and ElevenLabs (TTS).\n'));

  const enable = await confirm('Configure voice?', false);
  if (!enable) {
    console.log(dim('  Skipped. Add keys to .env later to enable voice.\n'));
    return;
  }

  // Groq
  console.log(dim('\n  Groq API key for Whisper speech-to-text.\n'));
  const groq = await askSecret('  Groq API key (or Enter to skip): ');
  cfg.GROQ_API_KEY = groq;

  // ElevenLabs
  console.log(dim('\n  ElevenLabs for text-to-speech.\n'));
  const eleven = await askSecret('  ElevenLabs API key (or Enter to skip): ');
  cfg.ELEVENLABS_API_KEY = eleven;

  if (eleven) {
    const voiceId = await ask('  ElevenLabs Voice ID: ');
    cfg.ELEVENLABS_VOICE_ID = voiceId;
  }

  console.log(green('\n  Voice configuration saved.\n'));
}

// ── Step 8: Privacy Provider ────────────────────────────────────────

async function stepPrivacy(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 8/15: Privacy Provider --\n'));
  console.log(dim('  Venice AI: zero-data-retention provider.'));
  console.log(dim('  Route sensitive queries through Venice instead of Claude.\n'));

  const enable = await confirm('Configure Venice?', false);
  if (!enable) {
    console.log(dim('  Skipped.\n'));
    return;
  }

  const key = await askSecret('  Venice API key: ');
  cfg.VENICE_API_KEY = key;

  if (key) {
    console.log(green('\n  Venice configured.\n'));
  }
}

// ── Step 9: Messaging Platforms ─────────────────────────────────────

async function stepMessaging(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 9/15: Messaging Platforms --\n'));
  console.log(dim('  Telegram is always enabled. These are additional platforms.\n'));

  const enable = await confirm('Configure additional messaging platforms?', false);
  if (!enable) {
    console.log(dim('  Telegram-only setup. You can add platforms to .env later.\n'));
    return;
  }

  // Discord
  if (await confirm('\n  Enable Discord?', false)) {
    const token = await askSecret('  Discord bot token: ');
    if (token) {
      cfg.DISCORD_TOKEN = token;
      cfg.DISCORD_ENABLED = 'true';
      console.log(green('  Discord enabled.'));
    }
  }

  // Signal
  if (await confirm('\n  Enable Signal?', false)) {
    console.log(dim('  Requires signal-cli REST API running in Docker.\n'));
    const apiUrl = await ask('  Signal API URL (e.g. http://localhost:8080): ');
    const phone = await ask('  Signal phone number (e.g. +15551234567): ');
    const allowed = await ask('  Allowed numbers, comma-separated (or Enter for all): ');
    cfg.SIGNAL_API_URL = apiUrl;
    cfg.SIGNAL_PHONE_NUMBER = phone;
    cfg.SIGNAL_ALLOWED_NUMBERS = allowed;
    if (apiUrl && phone) console.log(green('  Signal enabled.'));
  }

  // Matrix
  if (await confirm('\n  Enable Matrix?', false)) {
    const homeserver = await ask('  Matrix homeserver URL (e.g. https://matrix.example.com): ');
    const token = await askSecret('  Matrix access token: ');
    const rooms = await ask('  Allowed room IDs, comma-separated (or Enter for all): ');
    cfg.MATRIX_HOMESERVER_URL = homeserver;
    cfg.MATRIX_ACCESS_TOKEN = token;
    cfg.MATRIX_ALLOWED_ROOMS = rooms;
    if (homeserver && token) console.log(green('  Matrix enabled.'));
  }

  // WhatsApp
  if (await confirm('\n  Enable WhatsApp?', false)) {
    console.log(dim('  Uses whatsapp-web.js. You will scan a QR code at runtime.\n'));
    cfg.WHATSAPP_ENABLED = 'true';
    console.log(green('  WhatsApp enabled.'));
  }

  // Slack
  if (await confirm('\n  Enable Slack?', false)) {
    const token = await askSecret('  Slack bot token: ');
    cfg.SLACK_BOT_TOKEN = token;
    if (token) console.log(green('  Slack enabled.'));
  }

  console.log('');
}

// ── Step 10: Security ───────────────────────────────────────────────

async function stepSecurity(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 10/15: Security --\n'));
  console.log(dim('  Paladin is the policy engine that gates dangerous operations.\n'));

  // Port
  const port = await askNumber('  Paladin port', 1024, 65535, 3150);
  cfg.PALADIN_PORT = String(port);

  // Approval token
  console.log('');
  const autoToken = await confirm('Auto-generate Paladin approval token?', true);
  if (autoToken) {
    cfg.PALADIN_APPROVAL_TOKEN = generateSecret(32);
    console.log(`  Token: ${green(maskSecret(cfg.PALADIN_APPROVAL_TOKEN))}`);
  } else {
    const token = await askSecret('  Paladin approval token: ');
    cfg.PALADIN_APPROVAL_TOKEN = token;
  }

  // Dashboard token
  console.log('');
  const autoDash = await confirm('Auto-generate dashboard token?', true);
  if (autoDash) {
    cfg.DASHBOARD_TOKEN = generateSecret(32);
    console.log(`  Token: ${green(maskSecret(cfg.DASHBOARD_TOKEN))}`);
  } else {
    const token = await askSecret('  Dashboard token: ');
    cfg.DASHBOARD_TOKEN = token;
  }

  console.log('');
}

// ── Step 11: Dashboard ──────────────────────────────────────────────

async function stepDashboard(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 11/15: Dashboard --\n'));

  const port = await askNumber('  Dashboard port', 1024, 65535, 3210);
  cfg.DASHBOARD_PORT = String(port);

  // Auto-detect URL
  const autoUrl = `http://localhost:${port}`;
  console.log(`  Dashboard URL: ${cyan(autoUrl)}`);
  const useAuto = await confirm('Use this URL?', true);

  if (useAuto) {
    cfg.DASHBOARD_URL = autoUrl;
  } else {
    const url = await ask('  Dashboard URL: ');
    cfg.DASHBOARD_URL = url || autoUrl;
  }

  console.log('');
}

// ── Step 12: Database ───────────────────────────────────────────────

async function stepDatabase(cfg: EnvConfig): Promise<void> {
  console.log(bold('\n  -- Step 12/15: Database --\n'));
  console.log(dim('  SQLite database encryption is optional.'));
  console.log(dim('  If set, all databases are encrypted at rest.\n'));

  const encrypt = await confirm('Enable database encryption?', false);
  if (!encrypt) {
    console.log(dim('  Skipped. Databases will be unencrypted.\n'));
    return;
  }

  const autoKey = await confirm('Auto-generate encryption key?', true);
  if (autoKey) {
    cfg.DB_ENCRYPTION_KEY = generateSecret(32);
    console.log(`  Key: ${green(maskSecret(cfg.DB_ENCRYPTION_KEY))}`);
    console.log(yellow('  Save this key somewhere safe. You cannot recover data without it.'));
  } else {
    const key = await askSecret('  Encryption key: ');
    cfg.DB_ENCRYPTION_KEY = key;
  }

  console.log('');
}

// ── Step 13: Feature Flags ──────────────────────────────────────────

interface FeatureFlag {
  key: string;
  label: string;
  desc: string;
}

const FEATURE_FLAGS: FeatureFlag[] = [
  { key: 'ENABLE_SCHEDULER',   label: 'Scheduler',    desc: 'Cron-based task scheduler' },
  { key: 'ENABLE_SCRIBE',      label: 'Scribe',       desc: 'Conversation processor (extracts tasks, decisions, notes)' },
  { key: 'ENABLE_INBOX',       label: 'Inbox',        desc: 'Priority inbox system for notifications' },
  { key: 'ENABLE_VAULT_SYNC',  label: 'Vault Sync',   desc: 'Git polling for Obsidian vault changes' },
  { key: 'ENABLE_WORKFLOWS',   label: 'Workflows',    desc: 'DAG-based automation engine' },
  { key: 'ENABLE_DECAY_SWEEP', label: 'Decay Sweep',  desc: 'Automatic memory decay and cleanup' },
  { key: 'ENABLE_DB_BACKUP',   label: 'DB Backup',    desc: 'Automated database backups' },
];

async function stepFeatureFlags(cfg: EnvConfig): Promise<void> {
  // Internal automation -- disabled by default in release builds
  console.log(bold('\n  -- Step 13/15: Feature Flags --\n'));
  console.log(dim('  Subsystems disabled by default. Enable what you need.\n'));

  for (const f of FEATURE_FLAGS) {
    console.log(`    ${bold(f.label)}: ${dim(f.desc)}`);
  }
  console.log('');

  const enableAll = await confirm('Enable all recommended?', false);

  if (enableAll) {
    for (const f of FEATURE_FLAGS) {
      cfg[f.key] = 'true';
    }
    console.log(green('  All features enabled.\n'));
    return;
  }

  // One-by-one
  for (const f of FEATURE_FLAGS) {
    const on = await confirm(`  Enable ${f.label}?`, false);
    cfg[f.key] = on ? 'true' : '';
  }

  console.log('');
}

// ── Step 14: Review ─────────────────────────────────────────────────

interface ReviewSection {
  title: string;
  items: Array<{ label: string; value: string; secret?: boolean }>;
}

function buildReview(cfg: EnvConfig): ReviewSection[] {
  const sections: ReviewSection[] = [];

  // Required
  sections.push({
    title: 'Required',
    items: [
      { label: 'Telegram Bot Token', value: cfg.TELEGRAM_BOT_TOKEN, secret: true },
      { label: 'Chat ID',            value: cfg.ALLOWED_CHAT_ID },
      { label: 'Anthropic API Key',  value: cfg.ANTHROPIC_API_KEY, secret: true },
    ],
  });

  // Identity & Paths
  sections.push({
    title: 'Identity & Paths',
    items: [
      { label: 'Bot Name',      value: cfg.BOT_NAME },
      { label: 'Project Root',  value: cfg.PROJECT_ROOT },
      { label: 'Vault Root',    value: cfg.VAULT_ROOT || dim('(not set)') },
    ],
  });

  // Optional items only if set
  if (cfg.LICENSE_KEY) {
    sections.push({
      title: 'License',
      items: [{ label: 'License Key', value: cfg.LICENSE_KEY, secret: true }],
    });
  }

  if (cfg.WORKFLOW_CHAT_ID) {
    sections.push({
      title: 'Workflow',
      items: [{ label: 'Workflow Chat ID', value: cfg.WORKFLOW_CHAT_ID }],
    });
  }

  // Voice
  if (cfg.GROQ_API_KEY || cfg.ELEVENLABS_API_KEY) {
    sections.push({
      title: 'Voice',
      items: [
        { label: 'Groq API Key',      value: cfg.GROQ_API_KEY || dim('(not set)'), secret: !!cfg.GROQ_API_KEY },
        { label: 'ElevenLabs Key',     value: cfg.ELEVENLABS_API_KEY || dim('(not set)'), secret: !!cfg.ELEVENLABS_API_KEY },
        { label: 'ElevenLabs Voice',   value: cfg.ELEVENLABS_VOICE_ID || dim('(not set)') },
      ],
    });
  }

  // Privacy
  if (cfg.VENICE_API_KEY) {
    sections.push({
      title: 'Privacy',
      items: [{ label: 'Venice API Key', value: cfg.VENICE_API_KEY, secret: true }],
    });
  }

  // Messaging
  const msgItems: Array<{ label: string; value: string; secret?: boolean }> = [];
  if (cfg.DISCORD_ENABLED === 'true') msgItems.push({ label: 'Discord', value: green('enabled') });
  if (cfg.SIGNAL_API_URL) msgItems.push({ label: 'Signal', value: green('enabled') });
  if (cfg.MATRIX_HOMESERVER_URL) msgItems.push({ label: 'Matrix', value: green('enabled') });
  if (cfg.WHATSAPP_ENABLED === 'true') msgItems.push({ label: 'WhatsApp', value: green('enabled') });
  if (cfg.SLACK_BOT_TOKEN) msgItems.push({ label: 'Slack', value: green('enabled') });
  if (msgItems.length > 0) {
    sections.push({ title: 'Messaging', items: msgItems });
  }

  // Security
  sections.push({
    title: 'Security',
    items: [
      { label: 'Paladin Port',     value: cfg.PALADIN_PORT },
      { label: 'Paladin Token',    value: cfg.PALADIN_APPROVAL_TOKEN || dim('(not set)'), secret: !!cfg.PALADIN_APPROVAL_TOKEN },
      { label: 'Dashboard Token',  value: cfg.DASHBOARD_TOKEN || dim('(not set)'), secret: !!cfg.DASHBOARD_TOKEN },
    ],
  });

  // Dashboard
  sections.push({
    title: 'Dashboard',
    items: [
      { label: 'Port', value: cfg.DASHBOARD_PORT },
      { label: 'URL',  value: cfg.DASHBOARD_URL || dim('(auto)') },
    ],
  });

  // Database
  if (cfg.DB_ENCRYPTION_KEY) {
    sections.push({
      title: 'Database',
      items: [{ label: 'Encryption Key', value: cfg.DB_ENCRYPTION_KEY, secret: true }],
    });
  }

  // Feature flags
  const flagItems: Array<{ label: string; value: string }> = [];
  for (const f of FEATURE_FLAGS) {
    const val = cfg[f.key];
    if (val === 'true') {
      flagItems.push({ label: f.label, value: green('on') });
    }
  }
  const anyOn = flagItems.length > 0;
  sections.push({
    title: 'Feature Flags',
    items: anyOn ? flagItems : [{ label: 'All', value: dim('off') }],
  });

  return sections;
}

async function stepReview(cfg: EnvConfig): Promise<boolean> {
  console.log(bold('\n  -- Step 14/15: Review --\n'));

  const sections = buildReview(cfg);

  for (const section of sections) {
    console.log(`  ${bold(section.title)}`);
    for (const item of section.items) {
      const display = item.secret ? maskSecret(item.value) : item.value;
      console.log(`    ${item.label}: ${display}`);
    }
    console.log('');
  }

  return confirm('Write this configuration?', true);
}

// ── Step 15: Write .env ─────────────────────────────────────────────

function buildEnvFile(cfg: EnvConfig): string {
  const lines: string[] = [];

  lines.push('# -----------------------------------------------------------------------');
  lines.push('# PMAOS -- Environment Configuration');
  lines.push('#');
  lines.push('# Generated by setup wizard');
  lines.push('# -----------------------------------------------------------------------');
  lines.push('');

  // Required
  lines.push('# -- Required ---------------------------------------------------------------');
  lines.push('');
  lines.push('# Anthropic API key (Claude)');
  lines.push(`ANTHROPIC_API_KEY=${cfg.ANTHROPIC_API_KEY}`);
  lines.push('');
  lines.push('# Telegram bot token (from @BotFather)');
  lines.push(`TELEGRAM_BOT_TOKEN=${cfg.TELEGRAM_BOT_TOKEN}`);
  lines.push('');
  lines.push('# Your Telegram chat ID (send /start to @userinfobot to find it)');
  lines.push(`TELEGRAM_CHAT_ID=${cfg.ALLOWED_CHAT_ID}`);
  lines.push('');

  // License
  if (cfg.LICENSE_KEY) {
    lines.push('# -- License ----------------------------------------------------------------');
    lines.push('');
    lines.push(`LICENSE_KEY=${cfg.LICENSE_KEY}`);
    lines.push('');
  }

  // Bot Identity
  lines.push('# -- Bot Identity -----------------------------------------------------------');
  lines.push('');
  lines.push('# Your bot\'s display name (used in logs, dashboard, and personality)');
  lines.push(`BOT_NAME=${cfg.BOT_NAME}`);
  lines.push('');

  // Workflow
  if (cfg.WORKFLOW_CHAT_ID) {
    lines.push('# Workflow group chat ID for agent results and audits');
    lines.push(`WORKFLOW_CHAT_ID=${cfg.WORKFLOW_CHAT_ID}`);
    lines.push('');
  }

  // Paths
  lines.push('# -- Paths ------------------------------------------------------------------');
  lines.push('');
  lines.push('# Absolute path to this project directory');
  lines.push(`PROJECT_ROOT=${cfg.PROJECT_ROOT}`);
  lines.push('');
  if (cfg.VAULT_ROOT) {
    lines.push('# Absolute path to your Obsidian vault');
    lines.push(`VAULT_ROOT=${cfg.VAULT_ROOT}`);
    lines.push('');
  }

  // Voice
  if (cfg.GROQ_API_KEY || cfg.ELEVENLABS_API_KEY) {
    lines.push('# -- Voice ------------------------------------------------------------------');
    lines.push('');
    if (cfg.GROQ_API_KEY) {
      lines.push('# Groq -- fast Whisper speech-to-text');
      lines.push(`GROQ_API_KEY=${cfg.GROQ_API_KEY}`);
      lines.push('');
    }
    if (cfg.ELEVENLABS_API_KEY) {
      lines.push('# ElevenLabs -- high-quality text-to-speech');
      lines.push(`ELEVENLABS_API_KEY=${cfg.ELEVENLABS_API_KEY}`);
      if (cfg.ELEVENLABS_VOICE_ID) {
        lines.push(`ELEVENLABS_VOICE_ID=${cfg.ELEVENLABS_VOICE_ID}`);
      }
      lines.push('');
    }
  }

  // Privacy
  if (cfg.VENICE_API_KEY) {
    lines.push('# -- Privacy ----------------------------------------------------------------');
    lines.push('');
    lines.push('# Venice AI -- zero-data-retention provider for sensitive content');
    lines.push(`VENICE_API_KEY=${cfg.VENICE_API_KEY}`);
    lines.push('');
  }

  // Messaging
  const hasMessaging = cfg.DISCORD_ENABLED === 'true'
    || cfg.SIGNAL_API_URL
    || cfg.MATRIX_HOMESERVER_URL
    || cfg.WHATSAPP_ENABLED === 'true'
    || cfg.SLACK_BOT_TOKEN;

  if (hasMessaging) {
    lines.push('# -- Messaging Channels -----------------------------------------------------');
    lines.push('');

    if (cfg.DISCORD_ENABLED === 'true') {
      lines.push('# Discord');
      lines.push(`DISCORD_TOKEN=${cfg.DISCORD_TOKEN}`);
      lines.push(`DISCORD_ENABLED=${cfg.DISCORD_ENABLED}`);
      lines.push('');
    }

    if (cfg.SIGNAL_API_URL) {
      lines.push('# Signal (requires signal-cli REST API running)');
      lines.push(`SIGNAL_API_URL=${cfg.SIGNAL_API_URL}`);
      lines.push(`SIGNAL_PHONE_NUMBER=${cfg.SIGNAL_PHONE_NUMBER}`);
      if (cfg.SIGNAL_ALLOWED_NUMBERS) {
        lines.push(`SIGNAL_ALLOWED_NUMBERS=${cfg.SIGNAL_ALLOWED_NUMBERS}`);
      }
      lines.push('');
    }

    if (cfg.MATRIX_HOMESERVER_URL) {
      lines.push('# Matrix');
      lines.push(`MATRIX_HOMESERVER_URL=${cfg.MATRIX_HOMESERVER_URL}`);
      lines.push(`MATRIX_ACCESS_TOKEN=${cfg.MATRIX_ACCESS_TOKEN}`);
      if (cfg.MATRIX_ALLOWED_ROOMS) {
        lines.push(`MATRIX_ALLOWED_ROOMS=${cfg.MATRIX_ALLOWED_ROOMS}`);
      }
      lines.push('');
    }

    if (cfg.WHATSAPP_ENABLED === 'true') {
      lines.push('# WhatsApp (uses whatsapp-web.js QR auth at runtime)');
      lines.push(`WHATSAPP_ENABLED=${cfg.WHATSAPP_ENABLED}`);
      lines.push('');
    }

    if (cfg.SLACK_BOT_TOKEN) {
      lines.push('# Slack');
      lines.push(`SLACK_BOT_TOKEN=${cfg.SLACK_BOT_TOKEN}`);
      lines.push('');
    }
  }

  // Security
  lines.push('# -- Security ---------------------------------------------------------------');
  lines.push('');
  lines.push('# Paladin policy engine port');
  lines.push(`PALADIN_PORT=${cfg.PALADIN_PORT}`);
  lines.push('');
  if (cfg.PALADIN_APPROVAL_TOKEN) {
    lines.push('# Token for approval gate authentication');
    lines.push(`PALADIN_APPROVAL_TOKEN=${cfg.PALADIN_APPROVAL_TOKEN}`);
    lines.push('');
  }

  // Dashboard
  lines.push('# -- Dashboard --------------------------------------------------------------');
  lines.push('');
  if (cfg.DASHBOARD_TOKEN) {
    lines.push('# Dashboard auth token');
    lines.push(`DASHBOARD_TOKEN=${cfg.DASHBOARD_TOKEN}`);
    lines.push('');
  }
  lines.push('# Dashboard port');
  lines.push(`DASHBOARD_PORT=${cfg.DASHBOARD_PORT}`);
  lines.push('');
  if (cfg.DASHBOARD_URL) {
    lines.push(`DASHBOARD_URL=${cfg.DASHBOARD_URL}`);
    lines.push('');
  }

  // Database
  if (cfg.DB_ENCRYPTION_KEY) {
    lines.push('# -- Database ---------------------------------------------------------------');
    lines.push('');
    lines.push('# SQLite encryption passphrase');
    lines.push(`DB_ENCRYPTION_KEY=${cfg.DB_ENCRYPTION_KEY}`);
    lines.push('');
  }

  // Feature flags
  const anyFlags = FEATURE_FLAGS.some((f) => cfg[f.key] === 'true');
  if (anyFlags) {
    lines.push('# -- Feature Flags ----------------------------------------------------------');
    lines.push('# Internal automation -- disabled by default in release builds');
    lines.push('');
    for (const f of FEATURE_FLAGS) {
      const val = cfg[f.key];
      if (val === 'true') {
        lines.push(`${f.key}=true`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function stepWrite(cfg: EnvConfig, envPath: string): Promise<void> {
  console.log(bold('\n  -- Step 15/15: Write & Next Steps --\n'));

  const content = buildEnvFile(cfg);
  fs.writeFileSync(envPath, content, 'utf-8');
  console.log(green(`  .env written to ${envPath}`));

  // Offer encryption
  const encryptScript = path.join(cfg.PROJECT_ROOT || '.', 'scripts', 'encrypt-env.sh');
  const canEncrypt = fs.existsSync(encryptScript);

  if (canEncrypt) {
    console.log('');
    const encrypt = await confirm('Encrypt .env with age?', false);
    if (encrypt) {
      console.log(dim(`  Run: bash ${encryptScript}`));
      console.log(dim('  This creates .env.age and removes the plaintext .env.'));
    }
  }

  // Next steps
  console.log(bold('\n  Next steps:\n'));
  console.log(`  1. ${cyan('pm2 start ecosystem.config.cjs')}`);
  console.log(`  2. Send ${cyan('/start')} to your Telegram bot`);
  console.log(`  3. Optional: set up worker bots in ${dim('bots/')} directories`);
  if (canEncrypt) {
    console.log(`  4. Recommended: ${cyan(`bash scripts/encrypt-env.sh`)} to encrypt secrets`);
  }
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const envPath = path.resolve(process.env.APEX_ROOT || process.cwd(), '.env');

  initReadline();
  printBanner();

  // Step 1: Welcome + overwrite check
  const proceed = await stepWelcome(envPath);
  if (!proceed) {
    rl.close();
    return;
  }

  const cfg = emptyConfig();

  // Steps 2-13: Collect config
  await stepLicense(cfg);
  await stepTelegram(cfg);
  await stepClaude(cfg);
  await stepIdentity(cfg);
  await stepPaths(cfg);
  await stepVoice(cfg);
  await stepPrivacy(cfg);
  await stepMessaging(cfg);
  await stepSecurity(cfg);
  await stepDashboard(cfg);
  await stepDatabase(cfg);
  await stepFeatureFlags(cfg);

  // Step 14: Review
  const writeIt = await stepReview(cfg);
  if (!writeIt) {
    console.log(dim('\n  Aborted. No files written.\n'));
    rl.close();
    return;
  }

  // Step 15: Write + next steps
  await stepWrite(cfg, envPath);

  rl.close();
}

main().catch((err) => {
  console.error(red(`Setup wizard error: ${err instanceof Error ? err.message : String(err)}`));
  if (rl) rl.close();
  process.exit(1);
});
