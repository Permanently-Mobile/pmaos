import path from 'path';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_CHAT_ID',
  'WORKFLOW_CHAT_ID',
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'WHATSAPP_ENABLED',
  'SLACK_USER_TOKEN',
  'DISCORD_TOKEN',
  'DISCORD_ENABLED',
  'X_USERNAME',
  'X_PASSWORD',
  'X_EMAIL',
  'CONTEXT_LIMIT',
  'DASHBOARD_PORT',
  'DASHBOARD_TOKEN',
  'DASHBOARD_URL',
  'BOT_NAME',
  'VENICE_API_KEY',
  'PRIMARY_PROVIDER',
  'AVATAR_PORT',
  'FIREFLY_API_URL',
  'FIREFLY_API_TOKEN',
  'FIREFLY_WEBHOOK_SECRET',
  'FIREFLY_BIZ_API_URL',
  'FIREFLY_BIZ_API_TOKEN',
  'MATRIX_HOMESERVER_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_ALLOWED_ROOMS',
  'SIGNAL_API_URL',
  'SIGNAL_PHONE_NUMBER',
  'SIGNAL_ALLOWED_NUMBERS',
]);

export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

// Only respond to this Telegram chat ID. Set this after getting your ID via /chatid.
export const ALLOWED_CHAT_ID =
  process.env.ALLOWED_CHAT_ID || envConfig.ALLOWED_CHAT_ID || '';

// Workflow group chat ID -- receives agent results, audits, and research.
// Keeps the personal chat clean for direct conversation + trade alerts.
export const WORKFLOW_CHAT_ID =
  process.env.WORKFLOW_CHAT_ID || envConfig.WORKFLOW_CHAT_ID || '';

export const WHATSAPP_ENABLED =
  (process.env.WHATSAPP_ENABLED || envConfig.WHATSAPP_ENABLED || '').toLowerCase() === 'true';

export const SLACK_USER_TOKEN =
  process.env.SLACK_USER_TOKEN || envConfig.SLACK_USER_TOKEN || '';

export const DISCORD_TOKEN =
  process.env.DISCORD_TOKEN || envConfig.DISCORD_TOKEN || '';
export const DISCORD_ENABLED =
  (process.env.DISCORD_ENABLED || envConfig.DISCORD_ENABLED || '').toLowerCase() === 'true';

// X (Twitter) -- browser-based automation via Playwright stealth
export const X_USERNAME =
  process.env.X_USERNAME || envConfig.X_USERNAME || '';
export const X_PASSWORD =
  process.env.X_PASSWORD || envConfig.X_PASSWORD || '';
export const X_EMAIL =
  process.env.X_EMAIL || envConfig.X_EMAIL || '';

// Voice — read via readEnvFile, not process.env
export const GROQ_API_KEY = envConfig.GROQ_API_KEY ?? '';
export const ELEVENLABS_API_KEY = envConfig.ELEVENLABS_API_KEY ?? '';
export const ELEVENLABS_VOICE_ID = envConfig.ELEVENLABS_VOICE_ID ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PROJECT_ROOT is the project-apex/ directory — where CLAUDE.md lives.
// The SDK uses this as cwd, which causes Claude Code to load our CLAUDE.md
// and all global skills from ~/.claude/skills/ via settingSources.
// Override with APEX_ROOT env var to run a second bot instance
// (e.g. secondary-bot) from a different directory with its own CLAUDE.md and store/.
export const PROJECT_ROOT = process.env.APEX_ROOT
  ? path.resolve(process.env.APEX_ROOT)
  : path.resolve(__dirname, '..');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

// Telegram limits
export const MAX_MESSAGE_LENGTH = 4096;

// How often to refresh the typing indicator while Claude is thinking (ms).
// Telegram's typing action expires after ~5s, so 4s keeps it continuous.
export const TYPING_REFRESH_MS = 4000;

// Context window limit for the model. Opus 4.6 (1M context) = 1,000,000.
// Override via CONTEXT_LIMIT in .env if using a different model variant.
export const CONTEXT_LIMIT = parseInt(
  process.env.CONTEXT_LIMIT || envConfig.CONTEXT_LIMIT || '1000000',
  10,
);

// Dashboard — web UI for monitoring PMAOS state
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || envConfig.DASHBOARD_PORT || '3141',
  10,
);
export const DASHBOARD_TOKEN =
  process.env.DASHBOARD_TOKEN || envConfig.DASHBOARD_TOKEN || '';
export const DASHBOARD_URL =
  process.env.DASHBOARD_URL || envConfig.DASHBOARD_URL || '';

// Avatar display -- kiosk tablet display for the bot's ghost-in-the-machine face.
// No auth (local network only). Serves Canvas renderer + WebSocket state push.
export const AVATAR_PORT = parseInt(
  process.env.AVATAR_PORT || envConfig.AVATAR_PORT || '3142',
  10,
);

// Bot identity -- used for startup messages and conditional features.
// Defaults to 'apex-bot'. Set BOT_NAME in .env for other bots.
export const BOT_NAME =
  (process.env.BOT_NAME || envConfig.BOT_NAME || 'apex-bot').toLowerCase();

// True only for the primary bot. Used to gate primary-only features:
// trading pulls, bridge polling, backups, etc.
export const IS_PRIMARY_BOT = BOT_NAME === (process.env.PRIMARY_BOT_NAME || 'apex-bot');

// Venice AI -- privacy-first AI provider (zero data retention).
// Used for private queries, image generation, embeddings, TTS, video.
export const VENICE_API_KEY =
  process.env.VENICE_API_KEY || envConfig.VENICE_API_KEY || '';

// Primary AI provider routing.
// When set to 'venice', conversational messages route through Venice first (privacy-first,
// zero data retention). Tool-execution messages fall back to Claude automatically.
// When empty or unset, Claude handles everything (default/current behavior).
export const PRIMARY_PROVIDER =
  (process.env.PRIMARY_PROVIDER || envConfig.PRIMARY_PROVIDER || '') as '' | 'venice';

// Firefly III -- self-hosted personal finance (Docker at localhost:3143).
// Used for bookkeeping, transaction tracking, budgets, and financial reports.
export const FIREFLY_API_URL =
  process.env.FIREFLY_API_URL || envConfig.FIREFLY_API_URL || 'http://localhost:3143';
export const FIREFLY_API_TOKEN =
  process.env.FIREFLY_API_TOKEN || envConfig.FIREFLY_API_TOKEN || '';
export const FIREFLY_WEBHOOK_SECRET =
  process.env.FIREFLY_WEBHOOK_SECRET || envConfig.FIREFLY_WEBHOOK_SECRET || '';

// Firefly III Business -- second instance for company finances.
export const FIREFLY_BIZ_API_URL =
  process.env.FIREFLY_BIZ_API_URL || envConfig.FIREFLY_BIZ_API_URL || 'http://localhost:3144';
export const FIREFLY_BIZ_API_TOKEN =
  process.env.FIREFLY_BIZ_API_TOKEN || envConfig.FIREFLY_BIZ_API_TOKEN || '';

// Matrix (Element/Synapse) -- self-hosted encrypted chat.
// Only active when MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN are set.
export const MATRIX_HOMESERVER_URL =
  process.env.MATRIX_HOMESERVER_URL || envConfig.MATRIX_HOMESERVER_URL || '';
export const MATRIX_ACCESS_TOKEN =
  process.env.MATRIX_ACCESS_TOKEN || envConfig.MATRIX_ACCESS_TOKEN || '';
export const MATRIX_ALLOWED_ROOMS =
  process.env.MATRIX_ALLOWED_ROOMS || envConfig.MATRIX_ALLOWED_ROOMS || '';

// Matrix message limit (65536 bytes per event).
export const MATRIX_MAX_MESSAGE_BYTES = 65536;

// Signal -- via signal-cli-rest-api Docker container.
// Only active when SIGNAL_API_URL and SIGNAL_PHONE_NUMBER are set.
export const SIGNAL_API_URL =
  process.env.SIGNAL_API_URL || envConfig.SIGNAL_API_URL || '';
export const SIGNAL_PHONE_NUMBER =
  process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_ALLOWED_NUMBERS =
  process.env.SIGNAL_ALLOWED_NUMBERS || envConfig.SIGNAL_ALLOWED_NUMBERS || '';

// API usage budgets -- used by the dashboard usage strip.
// Override via env vars to match your plan limits.
export const ANTHROPIC_DAILY_TOKEN_BUDGET = parseInt(
  process.env.ANTHROPIC_DAILY_TOKEN_BUDGET || '1000000',
  10,
);
export const ANTHROPIC_WEEKLY_TOKEN_BUDGET = parseInt(
  process.env.ANTHROPIC_WEEKLY_TOKEN_BUDGET || '5000000',
  10,
);

// Monthly USD budget for Anthropic API spend (across all bots).
export const ANTHROPIC_MONTHLY_BUDGET_USD = parseFloat(
  process.env.ANTHROPIC_MONTHLY_BUDGET_USD || '200',
);
