/**
 * Avatar Display Server
 *
 * Standalone Hono HTTPS + WebSocket server for the kiosk tablet display.
 * Token-based auth on all API endpoints. Static display page and health exempt.
 * Uses HTTPS with self-signed cert for secure context (mic access).
 * Falls back to HTTP if certs are missing.
 *
 * Port: AVATAR_PORT (default 3142)
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';

import { execSync } from 'child_process';
import { AVATAR_PORT, PROJECT_ROOT, ALLOWED_CHAT_ID, DASHBOARD_PORT } from './config.js';
import { logger } from './logger.js';
import { addClient, getAvatarState, getAvatarClientCount, getAudioBuffer, AVATAR_VERSION, startAvatarHeartbeat } from './avatar-state.js';
import { getAvatarDisplayHtml } from './avatar-display-html.js';
import { handleKioskVoice, handleKioskText } from './kiosk-handler.js';
import { flushChatToVault } from './kiosk-log.js';
import { saveKioskChatMsg, getKioskChatMsgs, clearKioskChatDate, pruneKioskChat, getDashboardMemoryStats, getDefaultChatId, getSession, getSessionTokenUsage, getAllScheduledTasks } from './db.js';
import { CronExpressionParser } from 'cron-parser';
import { getCalendarPageHtml } from './calendar-page.js';
import { getVaultBrowserPageHtml } from './vault-browser-page.js';
import { getRouter } from './fallback-model.js';
import { MODEL_REGISTRY, lookupModel } from './providers/index.js';
import { paladinStatus, paladinReloadPolicy } from './paladin-client.js';
import Database from 'better-sqlite3-multiple-ciphers';

const AVATAR_DATA_DIR = path.join(PROJECT_ROOT, 'workspace', 'avatar_data');
const FACE_IMAGE_PATH = path.join(PROJECT_ROOT, 'workspace', 'ghost_renders', 'bot_face_display.jpg');
const VAULT_PATH = process.env.VAULT_ROOT;
if (!VAULT_PATH) {
  console.error('[avatar-server] VAULT_ROOT environment variable is required. Set it in ecosystem.config.cjs or .env');
}
const TASKS_PATH = VAULT_PATH ? path.join(VAULT_PATH, 'Tasks.md') : '';

function getDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ALLOWED_DATA_FILES = [
  'edge_grid.json',
  'edge_weight.json',
  'face_mask.json',
  'brightness.json',
  'meta.json',
];

// Auth token for avatar server API endpoints.
// Read from env or generate a random token at startup.
const AVATAR_AUTH_TOKEN = process.env.AVATAR_AUTH_TOKEN || randomBytes(32).toString('hex');
if (!process.env.AVATAR_AUTH_TOKEN) {
  logger.info({ token: AVATAR_AUTH_TOKEN }, 'Generated random AVATAR_AUTH_TOKEN (set AVATAR_AUTH_TOKEN env to use a fixed token)');
}

function validateAvatarToken(headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const token = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  return token === AVATAR_AUTH_TOKEN;
}

export function startAvatarServer(): ServerType {
  const app = new Hono();

  // Auth middleware -- exempt static display page, static assets, and health check
  app.use('*', async (c, next) => {
    const p = c.req.path;
    // Exempt: display page, static data files, face image, audio, health/status
    if (
      p === '/' ||
      p.startsWith('/data/') ||
      p === '/face.jpg' ||
      p.startsWith('/audio/') ||
      p === '/status'
    ) {
      return next();
    }
    // All other endpoints require Bearer token
    if (!validateAvatarToken(c.req.header('Authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // Main display page -- no-store so browser always fetches fresh HTML
  app.get('/', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.html(getAvatarDisplayHtml({ dashboardPort: DASHBOARD_PORT, contentBoardPort: parseInt(process.env.CONTENT_BOARD_PORT || '3210', 10) }));
  });

  // Pre-computed face data (JSON) -- short cache, client uses cache-busting params
  app.get('/data/:filename', (c) => {
    const filename = c.req.param('filename');
    if (!ALLOWED_DATA_FILES.includes(filename)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const filePath = path.join(AVATAR_DATA_DIR, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      c.header('Content-Type', 'application/json');
      c.header('Cache-Control', 'no-cache');
      return c.body(content);
    } catch {
      return c.json(
        { error: 'Data not pre-computed. Run avatar_precompute.py first.' },
        404,
      );
    }
  });

  // Face image (pre-rendered, compressed JPEG)
  app.get('/face.jpg', (c) => {
    try {
      const data = fs.readFileSync(FACE_IMAGE_PATH);
      c.header('Content-Type', 'image/jpeg');
      c.header('Cache-Control', 'no-cache');
      return c.body(data);
    } catch {
      return c.json({ error: 'Face image not found' }, 404);
    }
  });

  // Audio playback endpoint -- serves cached TTS buffers to kiosk client
  app.get('/audio/:id', (c) => {
    const id = c.req.param('id');
    const buffer = getAudioBuffer(id);
    if (!buffer) {
      return c.json({ error: 'Audio not found or expired' }, 404);
    }
    return new Response(buffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': buffer.length.toString(),
      },
    });
  });

  // Kiosk voice input endpoint -- receives mic audio, processes through Claude
  app.post('/kiosk/voice', async (c) => {
    try {
      const body = await c.req.arrayBuffer();
      const audioBuffer = Buffer.from(body);
      if (audioBuffer.length < 100) {
        return c.json({ error: 'Audio too short' }, 400);
      }
      logger.info({ bytes: audioBuffer.length }, 'Kiosk voice received');
      // Fire and forget -- response goes through WebSocket
      handleKioskVoice(audioBuffer).catch((err) => {
        logger.error({ err }, 'Kiosk voice handler error');
      });
      return c.json({ ok: true, received: audioBuffer.length });
    } catch (err) {
      logger.error({ err }, 'Kiosk voice endpoint error');
      return c.json({ error: 'Failed to process voice' }, 500);
    }
  });

  // Kiosk text input endpoint -- receives typed text, processes through Claude
  app.post('/kiosk/text', async (c) => {
    try {
      const body = await c.req.json<{ text?: string }>();
      const text = body?.text?.trim();
      if (!text) {
        return c.json({ error: 'Empty text' }, 400);
      }
      logger.info({ chars: text.length }, 'Kiosk text received');
      handleKioskText(text).catch((err) => {
        logger.error({ err }, 'Kiosk text handler error');
      });
      return c.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Kiosk text endpoint error');
      return c.json({ error: 'Failed to process text' }, 500);
    }
  });

  // Server-side chat message store (SQLite-backed, survives restarts)
  app.get('/kiosk/chat-messages', (c) => {
    const today = getDateStr();
    const msgs = getKioskChatMsgs(today);
    c.header('Cache-Control', 'no-store');
    return c.json({ messages: msgs, date: today });
  });

  app.post('/kiosk/chat-messages', async (c) => {
    try {
      const body = await c.req.json<{ sender?: string; text?: string; ts?: number }>();
      const today = getDateStr();
      saveKioskChatMsg(today, body.sender || 'unknown', body.text || '', body.ts || Date.now());
      // Prune old dates (keep 2 days max)
      pruneKioskChat(2);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 400);
    }
  });

  // End-of-day chat flush -- saves all messages to vault before midnight clear
  // Internal automation -- disabled by default in release builds
  app.post('/kiosk/flush', async (c) => {
    if (process.env.ENABLE_KIOSK_FLUSH !== 'true') {
      return c.json({ ok: true, flushed: 0, disabled: true });
    }
    try {
      const body = await c.req.json<{ messages?: Array<{ sender?: string; text?: string; ts: number }>; date?: string }>();
      const messages = body?.messages;
      if (!messages || messages.length === 0) {
        return c.json({ ok: true, flushed: 0 });
      }
      const normalized = messages.map((m) => ({
        s: m.sender || 'unknown',
        t: m.text || '',
        ts: m.ts,
      }));
      // Use the source date from the client (the day the messages belong to)
      flushChatToVault(normalized, body?.date);
      // Clear the flushed date from SQLite (yesterday's data)
      if (body?.date) {
        clearKioskChatDate(body.date);
      }
      logger.info({ count: normalized.length }, 'Kiosk chat flushed to vault');
      return c.json({ ok: true, flushed: normalized.length });
    } catch (err) {
      logger.error({ err }, 'Kiosk flush endpoint error');
      return c.json({ error: 'Flush failed' }, 500);
    }
  });

  // ── Kiosk model selection endpoints ─────────────────────────────

  // Available models grouped for the kiosk dropdowns
  app.get('/kiosk/models', (c) => {
    const chatModels = MODEL_REGISTRY.filter(m => m.capabilities.includes('chat'));
    const coderModels = MODEL_REGISTRY.filter(
      m => m.capabilities.includes('tools') || m.capabilities.includes('code-gen'),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({
      chat: chatModels.map(m => ({ id: m.id, alias: m.alias, provider: m.provider })),
      coder: coderModels.map(m => ({ id: m.id, alias: m.alias, provider: m.provider })),
    });
  });

  // Get current model overrides for the kiosk
  app.get('/kiosk/model', (c) => {
    const chatId = ALLOWED_CHAT_ID || 'default';
    const router = getRouter();
    const chatOverride = router.getModelOverride(chatId);
    const coderOverride = router.getCoderOverride(chatId);
    const chatEntry = chatOverride ? lookupModel(chatOverride) : undefined;
    const coderEntry = coderOverride ? lookupModel(coderOverride) : undefined;
    c.header('Cache-Control', 'no-store');
    return c.json({
      chat: chatEntry ? { id: chatEntry.id, alias: chatEntry.alias, provider: chatEntry.provider } : null,
      coder: coderEntry ? { id: coderEntry.id, alias: coderEntry.alias, provider: coderEntry.provider } : null,
    });
  });

  // Set model override from kiosk dropdown
  app.post('/kiosk/model', async (c) => {
    try {
      const body = await c.req.json<{ type?: string; model?: string }>();
      const chatId = ALLOWED_CHAT_ID || 'default';
      const router = getRouter();
      const type = body?.type || 'chat';
      const model = body?.model?.trim();

      if (!model || model === 'auto') {
        if (type === 'coder') {
          router.clearCoderOverride(chatId);
        } else {
          router.clearModelOverride(chatId);
        }
        logger.info({ type, chatId }, 'Kiosk model override cleared');
        return c.json({ ok: true, model: null, message: `${type} model reset to auto` });
      }

      if (type === 'coder') {
        const entry = router.setCoderOverride(chatId, model);
        if (!entry) return c.json({ ok: false, error: `Unknown model: ${model}` }, 400);
        return c.json({ ok: true, model: entry.alias, provider: entry.provider });
      } else {
        const entry = router.setModelOverride(chatId, model);
        if (!entry) return c.json({ ok: false, error: `Unknown model: ${model}` }, 400);
        return c.json({ ok: true, model: entry.alias, provider: entry.provider });
      }
    } catch (err) {
      logger.error({ err }, 'Kiosk model endpoint error');
      return c.json({ error: 'Failed to set model' }, 500);
    }
  });

  // Session stats endpoint (memory count + context window for kiosk display)
  app.get('/kiosk/stats', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const chatId = getDefaultChatId();
      const CONTEXT_LIMIT = 200000;

      // Memory stats
      let totalMemories = 0;
      if (chatId) {
        const memStats = getDashboardMemoryStats(chatId);
        totalMemories = memStats.total;
      }

      // Context window stats
      let contextPct = 0;
      let contextTokens = 0;
      let turns = 0;
      let compactions = 0;
      if (chatId) {
        const sessionId = getSession(chatId);
        // sessionId is '' after /newchat (cleared) -- getSessionTokenUsage handles that gracefully
        if (sessionId) {
          const usage = getSessionTokenUsage(sessionId);
          if (usage) {
            contextTokens = usage.lastContextTokens || usage.lastCacheRead || 0;
            contextPct = Math.min(100, Math.round((contextTokens / CONTEXT_LIMIT) * 100));
            turns = usage.turns;
            compactions = usage.compactions;
          }
        }
      }

      return c.json({
        totalMemories,
        contextPct,
        contextTokens,
        contextLimit: CONTEXT_LIMIT,
        turns,
        compactions,
      });
    } catch (err) {
      logger.error({ err }, 'kiosk/stats failed');
      return c.json({ totalMemories: 0, contextPct: 0, contextTokens: 0, contextLimit: 200000, turns: 0, compactions: 0 });
    }
  });

  // ── Layer 3: Kiosk Emergency Panel endpoints ─────────────────

  // Paladin status -- health, uptime, counters
  app.get('/kiosk/paladin', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const status = await paladinStatus();
      if (!status) return c.json({ online: false });
      return c.json({ ...status, online: true });
    } catch {
      return c.json({ online: false });
    }
  });

  // Paladin policy reload
  app.post('/kiosk/paladin/reload', async (c) => {
    try {
      const ok = await paladinReloadPolicy();
      return c.json({ ok });
    } catch (err) {
      logger.error({ err }, 'Paladin reload error');
      return c.json({ ok: false, error: 'Reload failed' }, 500);
    }
  });

  // Fleet status -- pm2 process list
  app.get('/kiosk/fleet', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const raw = execSync('pm2 jlist', { timeout: 10000, encoding: 'utf-8', windowsHide: true });
      const procs = JSON.parse(raw);
      const agents = procs.map((p: any) => ({
        name: p.name,
        status: p.pm2_env?.status || 'unknown',
        uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
        pid: p.pid,
        restarts: p.pm2_env?.restart_time || 0,
        memory: p.monit?.memory || 0,
        cpu: p.monit?.cpu || 0,
      }));
      return c.json({ agents, total: agents.length, online: agents.filter((a: any) => a.status === 'online').length });
    } catch (err) {
      logger.error({ err }, 'Fleet status error');
      return c.json({ agents: [], total: 0, online: 0, error: 'Failed to read fleet' });
    }
  });

  // Fleet restart -- restart a specific pm2 process (validated against known names)
  app.post('/kiosk/fleet/restart', async (c) => {
    try {
      const body = await c.req.json<{ name?: string }>();
      const name = body?.name?.trim();
      if (!name) return c.json({ ok: false, error: 'Missing name' }, 400);

      // Validate name exists in pm2 (prevent injection)
      const raw = execSync('pm2 jlist', { timeout: 10000, encoding: 'utf-8', windowsHide: true });
      const procs = JSON.parse(raw);
      const known = procs.map((p: any) => p.name);
      if (!known.includes(name)) {
        return c.json({ ok: false, error: `Unknown process: ${name}` }, 400);
      }

      execSync(`pm2 restart "${name}"`, { timeout: 15000, encoding: 'utf-8', windowsHide: true });
      logger.info({ name }, 'Fleet: restarted process from kiosk');
      return c.json({ ok: true, restarted: name });
    } catch (err) {
      logger.error({ err }, 'Fleet restart error');
      return c.json({ ok: false, error: 'Restart failed' }, 500);
    }
  });

  // Systems check -- runs the diagnostic script
  app.post('/kiosk/systems-check', async (c) => {
    try {
      const scriptPath = path.join(PROJECT_ROOT, 'dist', 'systems-check.js');
      const output = execSync(`node "${scriptPath}"`, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        windowsHide: true,
      });
      return c.json({ ok: true, output });
    } catch (err: any) {
      // systems-check may exit non-zero but still produce output
      const output = err?.stdout || err?.message || 'Systems check failed';
      return c.json({ ok: false, output });
    }
  });

  // Trading Plugin status -- Scout, Alpha, Crypto bots
  app.get('/kiosk/trading-status', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      // 1. Get pm2 status for trading processes
      const raw = execSync('pm2 jlist', { timeout: 10000, encoding: 'utf-8', windowsHide: true });
      const procs = JSON.parse(raw);
      // Rename to your trading bot agent names
      const tradingNames = ['strategy-1', 'optimizer-1', 'trader-1', 'trader-2', 'trader-3'];
      const tradingProcs: Array<{
        name: string; status: string; uptime: number; restarts: number; memory: number;
      }> = [];

      for (const p of procs) {
        if (tradingNames.includes(p.name)) {
          tradingProcs.push({
            name: p.name,
            status: p.pm2_env?.status || 'unknown',
            uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
            restarts: p.pm2_env?.restart_time || 0,
            memory: p.monit?.memory || 0,
          });
        }
      }

      // 2. Alpha last report
      let alphaLastReport: string | null = null;
      const reportsDir = path.join(PROJECT_ROOT, 'bots', 'optimizer-1', 'workspace', 'reports');
      try {
        const files = fs.readdirSync(reportsDir).filter((f: string) => f.endsWith('.md')).sort().reverse();
        if (files.length > 0) alphaLastReport = files[0].replace('.md', '');
      } catch { /* no reports dir */ }

      // 3. Scout intake count
      let scoutIntake = 0;
      const intakeDir = path.join(PROJECT_ROOT, 'bots', 'strategy-1', 'workspace', 'intake');
      try {
        if (fs.existsSync(intakeDir)) {
          scoutIntake = fs.readdirSync(intakeDir).filter((f: string) => f.endsWith('.md')).length;
        }
      } catch { /* no intake dir */ }

      // 4. Crypto bot open positions (read from their DBs)
      // Rename to your trading bot agent names
      const cryptoBots = ['trader-1', 'trader-2', 'trader-3'];
      const positions: Array<{
        bot: string; pair: string; side: string; entry: number; pnl: number; pnlPct: number;
      }> = [];
      let todayPnl = 0;
      let todayTrades = 0;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTs = todayStart.getTime();

      for (const botName of cryptoBots) {
        const botDir = path.join(PROJECT_ROOT, 'bots', botName);
        const dbPath = path.join(botDir, 'store', 'apex.db');
        if (!fs.existsSync(dbPath)) continue;

        try {
          const db = new Database(dbPath, { readonly: true });

          // Read passphrase
          const envPath = path.join(botDir, '.env');
          if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf-8');
            for (const line of envContent.split('\n')) {
              if (line.trim().startsWith('DB_PASSPHRASE=')) {
                const pass = line.trim().split('=')[1];
                if (pass) {
                  // DBs use default cipher (not sqlcipher).
                  db.pragma(`key='${pass}'`);
                }
                break;
              }
            }
          }
          db.pragma('journal_mode = WAL');

          // Check table exists
          const table = db.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='trading_positions'`,
          ).get();

          if (table) {
            // Open positions
            const openPos = db.prepare(
              `SELECT pair, side, entry_price, pnl_usd, pnl_pct FROM trading_positions WHERE status = 'open'`,
            ).all() as Array<{ pair: string; side: string; entry_price: number; pnl_usd: number; pnl_pct: number }>;

            for (const p of openPos) {
              positions.push({
                bot: botName, pair: p.pair, side: p.side,
                entry: p.entry_price, pnl: p.pnl_usd || 0, pnlPct: p.pnl_pct || 0,
              });
            }

            // Today's closed trades
            const closed = db.prepare(
              `SELECT pnl_usd FROM trading_positions WHERE status = 'closed' AND exit_ts >= ?`,
            ).all(todayTs) as Array<{ pnl_usd: number }>;

            for (const c2 of closed) {
              todayPnl += c2.pnl_usd || 0;
              todayTrades++;
            }
          }
          db.close();
        } catch { /* skip unreadable DBs */ }
      }

      const online = tradingProcs.filter(p => p.status === 'online').length;

      return c.json({
        bots: tradingProcs,
        online,
        total: tradingProcs.length,
        alphaLastReport,
        scoutIntake,
        positions,
        todayPnl: Math.round(todayPnl * 100) / 100,
        todayTrades,
      });
    } catch (err) {
      logger.error({ err }, 'Trading status endpoint error');
      return c.json({ bots: [], online: 0, total: 0, positions: [], todayPnl: 0, todayTrades: 0, error: 'Failed' });
    }
  });

  // Tasks -- read unchecked items from vault Tasks.md
  app.get('/kiosk/tasks', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const content = fs.readFileSync(TASKS_PATH, 'utf-8');
      const lines = content.split('\n');
      const tasks: Array<{ section: string; text: string }> = [];
      let currentSection = 'General';

      for (const line of lines) {
        const sectionMatch = line.match(/^##\s+(.+)/);
        if (sectionMatch) {
          currentSection = sectionMatch[1].replace(/^Active\s*--?\s*/, '').trim();
          continue;
        }
        const taskMatch = line.match(/^-\s+\[ \]\s+(.+)/);
        if (taskMatch) {
          tasks.push({ section: currentSection, text: taskMatch[1].trim() });
        }
      }

      return c.json({ tasks: tasks.slice(0, 30), total: tasks.length });
    } catch (err) {
      logger.error({ err }, 'Tasks endpoint error');
      return c.json({ tasks: [], total: 0, error: 'Failed to read tasks' });
    }
  });

  // ── Kiosk Calendar endpoints ─────────────────────────────────────

  // Calendar data -- returns scheduled task occurrences for a given month
  app.get('/kiosk/calendar', (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const monthParam = c.req.query('month');
      const now = new Date();
      let year: number;
      let month: number;

      if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
        const parts = monthParam.split('-');
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
      } else {
        year = now.getFullYear();
        month = now.getMonth();
      }

      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);

      const systemKw = ['security', 'audit', 'scan', 'pii', 'sweep', 'health', 'integrity', 'encrypt'];
      const operationalKw = ['morning', 'brief', 'chat', 'export', 'trading', 'perf', 'log', 'nightly', 'cleanup', 'gmail'];
      const autoKw = ['competitive', 'ranking', 'quality', 'review', 'weekly', 'llm', 'matrix'];

      function classify(prompt: string): string {
        const lower = prompt.toLowerCase();
        for (const kw of systemKw) { if (lower.includes(kw)) return 'system'; }
        for (const kw of operationalKw) { if (lower.includes(kw)) return 'operational'; }
        for (const kw of autoKw) { if (lower.includes(kw)) return 'auto'; }
        return 'operational';
      }

      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: false, day: 'numeric',
      });

      function formatET(ts: number): { time: string; day: number } {
        const parts = etParts.formatToParts(new Date(ts));
        let hour = '00';
        let minute = '00';
        let day = 1;
        for (const p of parts) {
          if (p.type === 'hour') hour = p.value;
          else if (p.type === 'minute') minute = p.value;
          else if (p.type === 'day') day = parseInt(p.value, 10);
        }
        if (hour === '24') hour = '00';
        return { time: `${hour}:${minute}`, day };
      }

      const tasks = getAllScheduledTasks();
      const events: Array<{
        id: string; name: string; schedule: string; category: string;
        agent: string; status: string; occurrences: number[];
      }> = [];
      const days: Record<string, Array<{ time: string; name: string; cat: string; agent: string; schedule: string }>> = {};

      for (const task of tasks) {
        if (task.status !== 'active' && task.status !== 'running') continue;

        try {
          const interval = CronExpressionParser.parse(task.schedule, {
            currentDate: new Date(monthStart.getTime() - 1000),
          });

          const occurrences: number[] = [];
          const cat = classify(task.prompt);
          const name = task.prompt.substring(0, 50);
          let safety = 0;

          while (safety < 1000) {
            safety++;
            let next;
            try {
              next = interval.next();
            } catch {
              break;
            }
            const ts = next.getTime();
            if (ts > monthEnd.getTime()) break;

            const unixTs = Math.floor(ts / 1000);
            occurrences.push(unixTs);

            const et = formatET(ts);
            const dayKey = et.day.toString();
            if (!days[dayKey]) days[dayKey] = [];
            days[dayKey].push({
              time: et.time,
              name,
              cat,
              agent: task.agent || '',
              schedule: task.schedule,
            });
          }

          if (occurrences.length > 0) {
            events.push({
              id: task.id,
              name,
              schedule: task.schedule,
              category: cat,
              agent: task.agent || '',
              status: task.status,
              occurrences,
            });
          }
        } catch (err) {
          logger.warn({ taskId: task.id, schedule: task.schedule, err }, 'Failed to parse cron for calendar');
        }
      }

      for (const key of Object.keys(days)) {
        days[key].sort((a, b) => a.time.localeCompare(b.time));
      }

      const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
      return c.json({ month: monthStr, events, days });
    } catch (err) {
      logger.error({ err }, 'Calendar endpoint error');
      return c.json({ month: '', events: [], days: {} });
    }
  });

  // Calendar standalone page -- pop-up window served as full HTML
  app.get('/kiosk/calendar-page', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(getCalendarPageHtml());
  });

  // ── Vault Browser endpoints ─────────────────────────────────────────

  // Vault file/directory browser -- directory listings + file content
  app.get('/kiosk/vault-browse', (c) => {
    c.header('Cache-Control', 'no-store');
    if (!VAULT_PATH) {
      return c.json({ error: 'VAULT_ROOT not configured' });
    }

    const searchTerm = c.req.query('search') || '';
    const reqPath = c.req.query('path') || '';
    const wantContent = c.req.query('content') === '1';

    // Resolve and validate path stays within vault
    const resolved = path.resolve(VAULT_PATH, reqPath);
    if (!resolved.startsWith(path.resolve(VAULT_PATH))) {
      return c.json({ error: 'Access denied' });
    }

    try {
      // Search mode: find files matching term across vault
      if (searchTerm) {
        const results: Array<{ name: string; path: string; type: string; size?: number; modified?: string }> = [];
        const term = searchTerm.toLowerCase();
        const maxResults = 50;

        function searchDir(dir: string, relBase: string): void {
          if (results.length >= maxResults) return;
          let entries: string[];
          try { entries = fs.readdirSync(dir); } catch { return; }
          for (const name of entries) {
            if (results.length >= maxResults) break;
            if (name.startsWith('.')) continue;
            const full = path.join(dir, name);
            const rel = relBase ? relBase + '/' + name : name;
            let stat: fs.Stats;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.isDirectory()) {
              // Search into subdirectories
              if (name.toLowerCase().includes(term)) {
                results.push({ name, path: rel, type: 'dir' });
              }
              searchDir(full, rel);
            } else if (name.toLowerCase().includes(term)) {
              results.push({
                name,
                path: rel,
                type: 'file',
                size: stat.size,
                modified: stat.mtime.toISOString(),
              });
            }
          }
        }

        searchDir(VAULT_PATH, '');
        return c.json({ entries: results, search: true });
      }

      // Content mode: return file content
      if (wantContent) {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          return c.json({ error: 'Not a file' });
        }
        // Limit to text files under 2MB
        if (stat.size > 2 * 1024 * 1024) {
          return c.json({ error: 'File too large (max 2MB)' });
        }
        const content = fs.readFileSync(resolved, 'utf-8');
        return c.json({
          name: path.basename(resolved),
          path: reqPath,
          content,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }

      // Directory listing mode
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return c.json({ error: 'Not a directory' });
      }

      const raw = fs.readdirSync(resolved);
      const entries: Array<{ name: string; type: string; size?: number; modified?: string; count?: number }> = [];

      for (const name of raw) {
        if (name.startsWith('.')) continue; // skip dotfiles
        const full = path.join(resolved, name);
        let s: fs.Stats;
        try { s = fs.statSync(full); } catch { continue; }

        if (s.isDirectory()) {
          // Count items in directory
          let count = 0;
          try { count = fs.readdirSync(full).filter(n => !n.startsWith('.')).length; } catch { /* skip */ }
          entries.push({ name, type: 'dir', modified: s.mtime.toISOString(), count });
        } else {
          entries.push({ name, type: 'file', size: s.size, modified: s.mtime.toISOString() });
        }
      }

      return c.json({ path: reqPath, entries });
    } catch (err) {
      logger.error({ err }, 'Vault browse endpoint error');
      return c.json({ error: 'Failed to browse vault' });
    }
  });

  // Vault file save -- write content back to vault + auto-commit
  app.post('/kiosk/vault-save', async (c) => {
    if (!VAULT_PATH) {
      return c.json({ error: 'VAULT_ROOT not configured' }, 500);
    }
    try {
      const body = await c.req.json() as { path?: string; content?: string };
      const reqPath = body.path || '';
      const content = body.content;

      if (typeof content !== 'string') {
        return c.json({ error: 'Missing content' }, 400);
      }
      if (!reqPath) {
        return c.json({ error: 'Missing path' }, 400);
      }

      // Resolve and jail to vault
      const resolved = path.resolve(VAULT_PATH, reqPath);
      if (!resolved.startsWith(path.resolve(VAULT_PATH))) {
        return c.json({ error: 'Access denied' }, 403);
      }

      // Only allow editing existing files (no creating new files from browser)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return c.json({ error: 'File not found' }, 404);
      }

      // Block Templates/ edits
      const relPath = path.relative(VAULT_PATH, resolved);
      if (relPath.startsWith('Templates')) {
        return c.json({ error: 'Templates are read-only' }, 403);
      }

      fs.writeFileSync(resolved, content, 'utf-8');

      // Auto-commit
      try {
        execSync(
          `bash ${path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh')} "Kiosk edit: ${path.basename(resolved)}"`,
          { timeout: 10000, windowsHide: true }
        );
      } catch { /* commit failure is non-fatal */ }

      logger.info({ path: reqPath }, 'Vault file saved via kiosk');
      return c.json({ ok: true, path: reqPath });
    } catch (err) {
      logger.error({ err }, 'Vault save endpoint error');
      return c.json({ error: 'Save failed' }, 500);
    }
  });

  // Vault browser standalone page -- pop-up window served as full HTML
  app.get('/kiosk/vault-page', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(getVaultBrowserPageHtml());
  });

  // Status endpoint (includes version for client polling)
  app.get('/status', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      state: getAvatarState(),
      clients: getAvatarClientCount(),
      uptime: process.uptime(),
      version: AVATAR_VERSION,
    });
  });

  // TLS setup -- use HTTPS if certs exist, fall back to HTTP
  const certPath = path.join(PROJECT_ROOT, 'certs', 'kiosk.crt');
  const keyPath = path.join(PROJECT_ROOT, 'certs', 'kiosk.key');
  const hasTLS = fs.existsSync(certPath) && fs.existsSync(keyPath);

  let server: ServerType;
  if (hasTLS) {
    const tlsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    server = serve({
      fetch: app.fetch,
      port: AVATAR_PORT,
      createServer: createHttpsServer,
      serverOptions: tlsOptions,
    }, () => {
      logger.info({ port: AVATAR_PORT, tls: true }, 'Avatar display server running (HTTPS)');
    });
  } else {
    logger.warn('TLS certs not found at certs/kiosk.{crt,key} -- falling back to HTTP (mic will not work on remote devices)');
    server = serve({ fetch: app.fetch, port: AVATAR_PORT }, () => {
      logger.info({ port: AVATAR_PORT, tls: false }, 'Avatar display server running (HTTP)');
    });
  }

  // Handle port binding errors (EADDRINUSE on fast restarts)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: AVATAR_PORT }, 'Avatar port in use, retrying in 5s...');
      setTimeout(() => {
        server.close();
        server.listen(AVATAR_PORT);
      }, 5000);
    } else {
      logger.error({ err }, 'Avatar server error');
    }
  });

  // WebSocket server -- attach to the same HTTP server via upgrade event
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const proto = hasTLS ? 'https' : 'http';
    const url = new URL(request.url || '', `${proto}://localhost:${AVATAR_PORT}`);
    if (url.pathname === '/ws') {
      // Validate auth token in query params for WebSocket connections
      const wsToken = url.searchParams.get('token');
      if (wsToken !== AVATAR_AUTH_TOKEN) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        addClient(ws);
      });
    } else {
      socket.destroy();
    }
  });

  // Start WebSocket heartbeat to detect dead connections
  startAvatarHeartbeat();

  return server;
}
