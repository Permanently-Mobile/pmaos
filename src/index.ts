import fs from 'fs';
import path from 'path';

import { createBot, splitMessage } from './bot.js';
import {
  initBridge,
} from './bridge.js';
import { startInboxSystem } from './inbox.js';
import { onUserMessage, onBotResponse } from './inbox.js';
import { ALLOWED_CHAT_ID, BOT_NAME, IS_PRIMARY_BOT, TELEGRAM_BOT_TOKEN, STORE_DIR, PROJECT_ROOT, WORKFLOW_CHAT_ID } from './config.js';
import { startAvatarServer } from './avatar-server.js';
import { startDashboard } from './dashboard.js';
import { initDatabase, getSession, setSession, saveTokenUsage } from './db.js';
import { logger } from './logger.js';
import { cleanupOldUploads } from './media.js';
import { runDecaySweep, buildMemoryContext, saveConversationTurn } from './memory.js';
import { initScheduler } from './scheduler.js';
import { initTradingSchema, pullAllWatchlist, seedWatchlist } from './trading/index.js';
import { readRestartContext, clearRestartContext } from './restart-context.js';
import { initVaultSync, stopVaultSync } from './vault-sync.js';
import { initPolicy } from './policy-loader.js';
import { setWorkSessionNotify, reapStaleSessions } from './work-session.js';
import { initDiscord, closeDiscord } from './discord.js';
import { isMatrixConfigured, startMatrixListener, stopMatrixListener } from './matrix-listener.js';
import { isSignalConfigured, startSignalListener, stopSignalListener } from './signal-listener.js';
import { getSender } from './message-interface.js';
import { runWithFallback } from './fallback-model.js';
import { buildSpiceContext } from './spice.js';
import { buildVoiceFilter } from './voice-filter.js';
import { scanForInjection, formatDetection } from './prompt-guard.js';
import type { IncomingMessage } from './message-interface.js';
const PID_FILE = path.join(STORE_DIR, 'apex.pid');

// ── Matrix message handler ──────────────────────────────────────────
// Same pipeline as kiosk-handler: memory context + Claude + save turn.
// Uses the MatrixSender registered by startMatrixListener().

async function handleMatrixMessage(msg: IncomingMessage): Promise<void> {
  const chatId = msg.chatId;
  const sender = getSender('matrix');
  if (!sender) {
    logger.warn('Matrix message received but no MatrixSender registered');
    return;
  }

  // Prompt injection check
  const injResult = scanForInjection(msg.text);
  if (injResult.risk > 0) {
    const logLine = formatDetection(injResult, msg.text);
    if (logLine) logger.warn(logLine);
  }
  if (injResult.blocked) {
    logger.error({ triggers: injResult.triggers }, 'BLOCKED: prompt injection on Matrix');
    await sender.sendText(chatId, 'That message triggered security filters.');
    return;
  }

  onUserMessage();

  // Build context (same as Telegram/kiosk)
  const chatIdStr = ALLOWED_CHAT_ID || chatId;
  const memCtx = await buildMemoryContext(chatIdStr, msg.text);
  const spiceCtx = buildSpiceContext(chatIdStr, msg.text);
  const voiceCtx = buildVoiceFilter(msg.text);
  const fullMessage = [memCtx, spiceCtx, voiceCtx, `[Matrix message]: ${msg.text}`].filter(Boolean).join('\n\n');

  const sessionId = getSession(chatIdStr);

  // Typing indicator
  await sender.sendTyping(chatId);
  const typingInterval = setInterval(() => void sender.sendTyping(chatId), 4000);

  try {
    const result = await runWithFallback(
      fullMessage,
      sessionId,
      () => void sender.sendTyping(chatId),
      undefined,
      chatIdStr,
    );

    clearInterval(typingInterval);

    if (result.resumeToken) {
      setSession(chatIdStr, result.resumeToken);
    }

    const responseText = result.text?.trim() || 'Done.';

    // Save conversation turn with source=matrix
    saveConversationTurn(chatIdStr, msg.text, responseText, result.resumeToken ?? sessionId, 'matrix');

    // Send response
    await sender.sendText(chatId, responseText);

    onBotResponse();

    // Log token usage if available
    if (result.usage) {
      saveTokenUsage(
        chatIdStr,
        result.resumeToken ?? sessionId ?? '',
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cacheReadInputTokens ?? 0,
        result.usage.lastCallInputTokens ?? 0,
        result.usage.totalCostUsd ?? 0,
        result.usage.didCompact,
      );
    }

    logger.info({ chatId, source: 'matrix', len: responseText.length }, 'Matrix response sent');
  } catch (err) {
    clearInterval(typingInterval);
    logger.error({ err }, 'Matrix message processing failed');
    await sender.sendText(chatId, 'Processing error. Check logs.').catch(() => {});
  }
}
// ── Signal message handler ──────────────────────────────────────────
// Same pipeline as Matrix/kiosk: memory context + Claude + save turn.
// Uses the SignalSender registered by startSignalListener().

async function handleSignalMessage(msg: IncomingMessage): Promise<void> {
  const chatId = msg.chatId;
  const sender = getSender('signal');
  if (!sender) {
    logger.warn('Signal message received but no SignalSender registered');
    return;
  }

  // Prompt injection check
  const injResult = scanForInjection(msg.text);
  if (injResult.risk > 0) {
    const logLine = formatDetection(injResult, msg.text);
    if (logLine) logger.warn(logLine);
  }
  if (injResult.blocked) {
    logger.error({ triggers: injResult.triggers }, 'BLOCKED: prompt injection on Signal');
    await sender.sendText(chatId, 'That message triggered security filters.');
    return;
  }

  onUserMessage();

  // Build context (same as Telegram/Matrix/kiosk)
  const chatIdStr = ALLOWED_CHAT_ID || chatId;
  const memCtx = await buildMemoryContext(chatIdStr, msg.text);
  const spiceCtx = buildSpiceContext(chatIdStr, msg.text);
  const voiceCtx = buildVoiceFilter(msg.text);
  const fullMessage = [memCtx, spiceCtx, voiceCtx, `[Signal message]: ${msg.text}`].filter(Boolean).join('\n\n');

  const sessionId = getSession(chatIdStr);

  // Typing indicator
  await sender.sendTyping(chatId);
  const typingInterval = setInterval(() => void sender.sendTyping(chatId), 4000);

  try {
    const result = await runWithFallback(
      fullMessage,
      sessionId,
      () => void sender.sendTyping(chatId),
      undefined,
      chatIdStr,
    );

    clearInterval(typingInterval);

    if (result.resumeToken) {
      setSession(chatIdStr, result.resumeToken);
    }

    const responseText = result.text?.trim() || 'Done.';

    // Save conversation turn with source=signal
    saveConversationTurn(chatIdStr, msg.text, responseText, result.resumeToken ?? sessionId, 'signal');

    // Send response
    await sender.sendText(chatId, responseText);

    onBotResponse();

    // Log token usage if available
    if (result.usage) {
      saveTokenUsage(
        chatIdStr,
        result.resumeToken ?? sessionId ?? '',
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cacheReadInputTokens ?? 0,
        result.usage.lastCallInputTokens ?? 0,
        result.usage.totalCostUsd ?? 0,
        result.usage.didCompact,
      );
    }

    logger.info({ chatId, source: 'signal', len: responseText.length }, 'Signal response sent');
  } catch (err) {
    clearInterval(typingInterval);
    logger.error({ err }, 'Signal message processing failed');
    await sender.sendText(chatId, 'Processing error. Check logs.').catch(() => {});
  }
}

// startup.lock removed -- auto-greetings disabled to prevent restart spam

function showBanner(): void {
  const bannerPath = path.join(PROJECT_ROOT, 'banner.txt');
  try {
    const banner = fs.readFileSync(bannerPath, 'utf-8');
    console.log('\n' + banner);
  } catch {
    console.log('\n  PMAOS\n');
  }
}

function acquireLock(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  try {
    if (fs.existsSync(PID_FILE)) {
      const old = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(old) && old !== process.pid) {
        try {
          process.kill(old, 'SIGTERM');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        } catch { /* already dead */ }
      }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  showBanner();

  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is not set. Add it to .env and restart.');
    process.exit(1);
  }

  acquireLock();

  initPolicy();
  logger.info('Paladin policy loaded');

  initDatabase();
  if (IS_PRIMARY_BOT) {
    initTradingSchema();
    logger.info('Database ready (trading tables initialized)');
  } else {
    logger.info('Database ready');
  }

  // Initialize inter-agent bridge (Primary bot only -- other bots don't queue research)
  if (IS_PRIMARY_BOT) {
    try {
      initBridge(PROJECT_ROOT);
      logger.info('Bridge ready');
    } catch (bridgeErr) {
      logger.warn({ err: bridgeErr }, 'Bridge init failed (non-fatal, research worker will be unavailable)');
    }
  }

  const dashboardServer = startDashboard();

  // Avatar kiosk display -- Primary bot only (local network, no auth)
  let avatarServer: ReturnType<typeof startAvatarServer> | null = null;
  if (IS_PRIMARY_BOT) {
    avatarServer = startAvatarServer();
  }

  // Internal automation -- disabled by default in release builds
  // Memory decay sweep every 24h (requires Venice API for consolidation)
  if (process.env.ENABLE_DECAY_SWEEP === 'true') {
    // Delay first decay sweep by 10 minutes to avoid Venice token burn during crash loops.
    setTimeout(() => {
      runDecaySweep();
      setInterval(() => runDecaySweep(), 24 * 60 * 60 * 1000);
    }, 10 * 60 * 1000);
  } else {
    logger.info('Decay sweep disabled (set ENABLE_DECAY_SWEEP=true to enable)');
  }

  cleanupOldUploads();

  // ── Primary-bot-only: Database backups + Trading pulls ──
  if (IS_PRIMARY_BOT) {
    const DB_BACKUP_DIR = process.env.DB_BACKUP_DIR || path.join(STORE_DIR, 'backups', 'db');
    const DB_BACKUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const DB_BACKUP_KEEP = 7; // keep 7 daily backups

    function runDbBackup(): void {
      try {
        fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

        // Backup main DB
        const mainSrc = path.join(STORE_DIR, 'apex.db');
        const mainDst = path.join(DB_BACKUP_DIR, `apex-${today}.db`);
        if (fs.existsSync(mainSrc)) {
          fs.copyFileSync(mainSrc, mainDst);
        }

        // Backup bridge DB
        const bridgeSrc = path.join(STORE_DIR, 'bridge.db');
        const bridgeDst = path.join(DB_BACKUP_DIR, `bridge-${today}.db`);
        if (fs.existsSync(bridgeSrc)) {
          fs.copyFileSync(bridgeSrc, bridgeDst);
        }

        // Rotate old backups (keep last N days)
        const files = fs.readdirSync(DB_BACKUP_DIR)
          .filter(f => f.match(/^(apex|bridge)-\d{4}-\d{2}-\d{2}\.db$/))
          .sort();
        const uniqueDates = [...new Set(files.map(f => f.match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(Boolean))].sort();
        if (uniqueDates.length > DB_BACKUP_KEEP) {
          const datesToRemove = uniqueDates.slice(0, uniqueDates.length - DB_BACKUP_KEEP);
          for (const date of datesToRemove) {
            for (const f of files.filter(f => f.includes(date!))) {
              try { fs.unlinkSync(path.join(DB_BACKUP_DIR, f)); } catch { /* ignore */ }
            }
          }
        }

        logger.info({ mainDst, bridgeDst }, 'Database backup completed');
      } catch (err) {
        logger.error({ err }, 'Database backup failed');
      }
    }

    // Internal automation -- disabled by default in release builds
    // Database backups every 6 hours
    if (process.env.ENABLE_DB_BACKUP === 'true') {
      runDbBackup();
      setInterval(runDbBackup, DB_BACKUP_INTERVAL);
      logger.info('Database backup scheduled (every 6 hours, keeping 7 daily)');
    } else {
      logger.info('Database backup disabled (set ENABLE_DB_BACKUP=true to enable)');
    }

    // Internal automation -- disabled by default in release builds
    // Trading data pulls every 5 minutes
    if (process.env.ENABLE_TRADING_PULLS === 'true') {
      seedWatchlist();

      // Initial pull on startup (5s delay to let everything init)
      setTimeout(() => {
        logger.info('Running initial trading data pull...');
        pullAllWatchlist('1H').catch((err) => logger.error({ err }, 'Initial 1H trading pull failed'));
      }, 5000);

      // Pull every 5 minutes -- checks for new 1H candle closes + risk management
      setInterval(() => {
        pullAllWatchlist('1H').catch((err) => logger.error({ err }, 'Trading 1H pull failed'));
      }, 5 * 60 * 1000);

      logger.info('Trading data pulls scheduled (every 5 min, 1H timeframe)');
    } else {
      logger.info('Trading data pulls disabled (set ENABLE_TRADING_PULLS=true to enable)');
    }
  }

  const bot = createBot();

  if (ALLOWED_CHAT_ID) {
    const sendToTelegram = async (text: string) => {
      for (const part of splitMessage(text)) {
        await bot.api.sendMessage(ALLOWED_CHAT_ID, part, { parse_mode: 'HTML' });
      }
    };

    // Workflow group send function (agent research, audit results, processor notes)
    const sendToWorkflow = WORKFLOW_CHAT_ID
      ? async (text: string) => {
          for (const part of splitMessage(text)) {
            await bot.api.sendMessage(WORKFLOW_CHAT_ID, part, { parse_mode: 'HTML' });
          }
        }
      : undefined;

    initScheduler(sendToTelegram);

    // ReflectLoop self-improvement engine -- session boundary hooks + feedback collection
    if (IS_PRIMARY_BOT) {
      const { initReflectSystem } = await import('./reflect-orchestrator.js');
      initReflectSystem();
    }

    // Shared learning system -- cross-agent knowledge base (FTS5 + BM25 + temporal decay)
    if (IS_PRIMARY_BOT) {
      try {
        const { initLearning } = await import('./learning/index.js');
        initLearning(PROJECT_ROOT);
      } catch (err) {
        logger.warn({ err }, 'Learning system init failed (non-fatal)');
      }
    }

    // Workflow DAG engine -- Primary bot only (event triggers, automation pipelines)
    if (IS_PRIMARY_BOT) {
      const { initWorkflowSystem } = await import('./workflow/index.js');
      initWorkflowSystem(sendToTelegram);
      logger.info('Workflow engine ready');
    }

    // Inbox system -- Primary bot only (priority-aware result delivery)
    if (IS_PRIMARY_BOT) {
      startInboxSystem(sendToTelegram, sendToWorkflow);
    }

    // Work session isolation -- wire up notifications and stale reaper
    if (IS_PRIMARY_BOT) {
      setWorkSessionNotify(sendToTelegram);
      setInterval(() => reapStaleSessions(), 60_000);
      logger.info('Work session reaper started (60s interval)');
    }

    // Vault sync -- immediate memory indexing on vault writes (Primary bot only)
    if (IS_PRIMARY_BOT) {
      initVaultSync(ALLOWED_CHAT_ID);
    }

    // Discord integration -- connect if enabled (Primary bot only)
    if (IS_PRIMARY_BOT) {
      initDiscord((author, channel, server, content) => {
        const label = server ? `${server} / ${channel}` : channel;
        const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
        sendToTelegram(`🎮 <b>${author}</b> in <i>${label}</i>:\n${preview}`).catch(() => {});
      }).catch((err) => logger.warn({ err }, 'Discord init failed (non-fatal)'));
    }

    // Matrix integration -- DISABLED (token expired, causes crash loop)
    // if (IS_PRIMARY_BOT && isMatrixConfigured()) {
    //   startMatrixListener(handleMatrixMessage)
    //     .then(() => {
    //       logger.info('Matrix listener started');
    //       sendToTelegram('Matrix connected. Listening in configured rooms.').catch(() => {});
    //     })
    //     .catch((err) => logger.warn({ err }, 'Matrix init failed (non-fatal)'));
    // }

    // Signal integration -- connect if configured (Primary bot only)
    if (IS_PRIMARY_BOT && isSignalConfigured()) {
      startSignalListener(handleSignalMessage)
        .then(() => {
          logger.info('Signal listener started');
          sendToTelegram('Signal connected. Listening for messages.').catch(() => {});
        })
        .catch((err) => logger.warn({ err }, 'Signal init failed (non-fatal)'));
    }
  }

  const shutdown = async () => {
    logger.info('Shutting down...');
    stopVaultSync();
    await closeDiscord().catch(() => {});
    stopMatrixListener();
    stopSignalListener();
    // Close HTTP/WS servers gracefully before killing the process
    if (avatarServer) {
      try { avatarServer.close(); } catch { /* ignore */ }
    }
    if (dashboardServer) {
      try { dashboardServer.close(); } catch { /* ignore */ }
    }
    releaseLock();
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('Starting PMAOS...');

  await bot.start({
    onStart: async (botInfo) => {
      logger.info({ username: botInfo.username }, 'PMAOS is running');
      console.log(`\n  PMAOS online: @${botInfo.username}`);
      console.log(`  Send /chatid to get your chat ID for ALLOWED_CHAT_ID\n`);

      // Silent boot by default -- no generic greeting (prevents restart spam).
      // BUT: if a restart context exists (build completed, deploy finished),
      // deliver the targeted ack message so the user knows it's ready to test.
      if (ALLOWED_CHAT_ID) {
        const restartCtx = readRestartContext();
        if (restartCtx) {
          try {
            await bot.api.sendMessage(ALLOWED_CHAT_ID, restartCtx.ackMessage, { parse_mode: 'HTML' });
            logger.info({ summary: restartCtx.summary }, 'Restart context delivered to Telegram');
          } catch (err) {
            logger.error({ err }, 'Failed to deliver restart context ack');
          } finally {
            clearRestartContext();
          }
        } else {
          logger.info('Bot online, no restart context (silent boot)');
        }
      }
    },
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — exiting');
  releaseLock();
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
