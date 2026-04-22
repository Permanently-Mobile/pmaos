#!/usr/bin/env node

/**
 * Bridge CLI -- queue research tasks and check results.
 *
 * Usage:
 *   node dist/bridge-cli.js send <agent> "prompt"     Queue a task
 *   node dist/bridge-cli.js status                      Show queue stats
 *   node dist/bridge-cli.js results [agent]             Show completed results
 *   node dist/bridge-cli.js pending [agent]             Show pending tasks
 */

import path from 'path';
import { fileURLToPath } from 'url';

import {
  initBridge,
  sendTask,
  getQueueStats,
  getCompletedResults,
  TaskPayload,
  ResultPayload,
  BridgeMessage,
} from './bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAIN_ROOT = process.env.BRIDGE_MAIN_ROOT || path.resolve(__dirname, '..');
initBridge(MAIN_ROOT);

const [,, command, ...rest] = process.argv;

function usage(): void {
  console.log(`Bridge CLI -- inter-agent task queue

Commands:
  send <agent> "prompt" [--priority N]   Queue a task for <agent>
  status                                  Show queue statistics
  results [agent]                         Show completed results (default: apex-bot)
  pending [agent]                         Show pending tasks for <agent>

Priority levels:
  1 = low (default)   Research, routine tasks
  2 = medium          "Let me know when done" items
  3 = high            Critical / trade emergencies

Examples:
  node dist/bridge-cli.js send researcher-1 "Research the top 5 VPN providers"
  node dist/bridge-cli.js send coder-1 "Fix the auth bug" --priority 2
  node dist/bridge-cli.js status
  node dist/bridge-cli.js results apex-bot`);
}

switch (command) {
  case 'send': {
    const toAgent = rest[0];

    // Parse --priority flag from args
    let priority = 1;
    const priorityIdx = rest.indexOf('--priority');
    let promptParts = rest.slice(1);
    if (priorityIdx !== -1) {
      const pVal = parseInt(rest[priorityIdx + 1], 10);
      if (pVal >= 1 && pVal <= 3) priority = pVal;
      // Remove --priority and its value from prompt parts
      promptParts = rest.slice(1).filter((_, i) => {
        const absIdx = i + 1; // offset since we sliced at 1
        return absIdx !== priorityIdx && absIdx !== priorityIdx + 1;
      });
    }

    const prompt = promptParts.join(' ');

    if (!toAgent || !prompt) {
      console.error('Usage: bridge-cli send <agent> "prompt" [--priority N]');
      process.exit(1);
    }

    const priorityLabels = ['', 'low', 'medium', 'high'];
    // Research agents need longer TTL (2-hour cooldown between tasks, queue can back up)
    // Code/processor workers: 60 min is fine (no cooldown)
    const ttlMinutes = toAgent.startsWith('researcher') ? 720 : 60;
    const payload: TaskPayload = { prompt, timeout_minutes: toAgent.startsWith('researcher') ? 90 : 30 };
    const id = sendTask(process.env.BOT_NAME || 'apex-bot', toAgent, payload, priority, ttlMinutes);

    console.log(`Task queued successfully.`);
    console.log(`  ID:       ${id}`);
    console.log(`  To:       ${toAgent}`);
    console.log(`  Priority: ${priority} (${priorityLabels[priority]})`);
    console.log(`  Prompt:   ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
    console.log(`  TTL:      ${ttlMinutes} minutes`);
    break;
  }

  case 'status': {
    const stats = getQueueStats();
    console.log(`Bridge Queue Status`);
    console.log(`  Pending:     ${stats.pending}`);
    console.log(`  In-progress: ${stats.claimed}`);
    console.log(`  Completed:   ${stats.completed}`);
    console.log(`  Failed:      ${stats.failed}`);
    console.log(`  Expired:     ${stats.expired}`);
    break;
  }

  case 'results': {
    const agent = rest[0] || process.env.BOT_NAME || 'apex-bot';
    const results = getCompletedResults(agent, 10);

    if (results.length === 0) {
      console.log(`No completed results for ${agent}.`);
      break;
    }

    console.log(`${results.length} result(s) for ${agent}:\n`);
    for (const msg of results) {
      let payload: ResultPayload;
      try {
        payload = JSON.parse(msg.payload) as ResultPayload;
      } catch {
        payload = { summary: msg.payload };
      }

      console.log(`--- [${msg.id}] from ${msg.from_agent} (${msg.msg_type}) ---`);
      if (msg.msg_type === 'error') {
        console.log(`  ERROR: ${msg.error || payload.summary}`);
      } else {
        console.log(`  ${payload.summary.slice(0, 200)}${payload.summary.length > 200 ? '...' : ''}`);
        if (payload.report_path) console.log(`  Report: ${payload.report_path}`);
        if (payload.cost_usd) console.log(`  Cost: $${payload.cost_usd.toFixed(4)}`);
      }
      console.log('');
    }
    break;
  }

  case 'pending': {
    const agent = rest[0] || 'researcher-1';
    // Use getCompletedResults pattern but for pending -- quick inline query
    // For now just show stats
    const stats = getQueueStats();
    console.log(`${stats.pending} pending, ${stats.claimed} in-progress for all agents.`);
    break;
  }

  default: {
    usage();
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
  }
}
