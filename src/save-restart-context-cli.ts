/**
 * CLI: Save restart context before triggering a restart.
 * Writes both layers:
 *   Layer 1: workspace/restart-context.json (bot reads on startup, sends ack)
 *   Layer 2: high-salience episodic memory (next Claude session picks up context)
 *
 * Usage:
 *   node dist/save-restart-context-cli.js "Build summary" "Ack message for Telegram"
 *
 * Optional flags:
 *   --files=file1.ts,file2.ts  -- changed files
 *   --status=clean              -- build status (clean|warnings|failed)
 *   --phase="Phase 3"           -- current phase
 */
import { writeRestartContext } from './restart-context.js';
import { initDatabase, getDefaultChatId, saveMemory } from './db.js';
import { logger } from './logger.js';

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];

for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, ...val] = arg.slice(2).split('=');
    flags[key] = val.join('=') || 'true';
  } else {
    positional.push(arg);
  }
}

const summary = positional[0];
const ackMessage = positional[1];

if (!summary || !ackMessage) {
  console.error('Usage: node dist/save-restart-context-cli.js "summary" "ack message" [--files=...] [--status=...] [--phase=...]');
  process.exit(1);
}

// ── Layer 1: Write JSON file ──
writeRestartContext({
  summary,
  ackMessage,
  timestamp: Date.now(),
  filesChanged: flags.files ? flags.files.split(',') : undefined,
  buildStatus: (flags.status as 'clean' | 'warnings' | 'failed') || 'clean',
  currentPhase: flags.phase || undefined,
});
console.log('Layer 1: restart-context.json written');

// ── Layer 2: Write high-salience memory ──
try {
  initDatabase();
  const chatId = getDefaultChatId();
  if (chatId) {
    saveMemory(chatId, `[Restart Context] ${summary}`, 'episodic', 'restart-context');
    console.log('Layer 2: memory written to DB');
  } else {
    console.log('Layer 2: SKIP -- no chat_id in sessions');
  }
} catch (err) {
  logger.warn({ err }, 'Layer 2 memory write failed (non-fatal)');
  console.log('Layer 2: SKIP -- DB error (non-fatal)');
}

console.log('Restart context saved. Safe to restart.');
process.exit(0);
