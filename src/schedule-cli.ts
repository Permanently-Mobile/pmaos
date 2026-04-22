#!/usr/bin/env node
/**
 * PMAOS Schedule CLI
 *
 * Used by your Claude assistant via the Bash tool to manage scheduled tasks.
 *
 * Usage:
 *   node dist/schedule-cli.js create "prompt text" "0 9 * * 1"
 *   node dist/schedule-cli.js list
 *   node dist/schedule-cli.js delete <id>
 *   node dist/schedule-cli.js pause <id>
 *   node dist/schedule-cli.js resume <id>
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
} from './db.js';
import { computeNextRun } from './scheduler.js';

initDatabase();

const [, , command, ...rest] = process.argv;

function formatDate(unix: number | null): string {
  if (!unix) return 'never';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

switch (command) {
  case 'create': {
    // Parse --agent flag from args
    const agentIdx = rest.indexOf('--agent');
    let agent: string | undefined;
    let filteredRest = rest;
    if (agentIdx !== -1) {
      agent = rest[agentIdx + 1];
      filteredRest = rest.filter((_, i) => i !== agentIdx && i !== agentIdx + 1);
    }

    const prompt = filteredRest[0];
    const cron = filteredRest[1];

    if (!prompt || !cron) {
      console.error('Usage: schedule-cli create "prompt" "cron" [--agent <name>]');
      console.error('Example: schedule-cli create "Crypto market scan" "0 */4 * * *" --agent researcher-1');
      process.exit(1);
    }

    if (agentIdx !== -1 && !agent) {
      console.error('--agent requires a name (e.g. researcher-1, coder-1)');
      process.exit(1);
    }

    let nextRun: number;
    try {
      nextRun = computeNextRun(cron);
    } catch {
      console.error(`Invalid cron expression: "${cron}"`);
      console.error('Examples: "0 9 * * 1" (Mon 9am)  "0 8 * * *" (daily 8am)  "0 */4 * * *" (every 4h)');
      process.exit(1);
    }

    const id = randomBytes(4).toString('hex');
    createScheduledTask(id, prompt, cron, nextRun, agent);

    console.log(`Task created: ${id}`);
    console.log(`Prompt:       ${prompt}`);
    console.log(`Schedule:     ${cron}`);
    console.log(`Agent:        ${agent || 'local'}`);
    console.log(`Next run:     ${formatDate(nextRun)}`);
    break;
  }

  case 'list': {
    const tasks = getAllScheduledTasks();
    if (tasks.length === 0) {
      console.log('No scheduled tasks.');
      break;
    }
    console.log(`${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}:\n`);
    for (const t of tasks) {
      const status = t.status === 'paused' ? ' [PAUSED]' : '';
      const agentLabel = t.agent ? ` [${t.agent}]` : '';
      console.log(`${t.id}${status}${agentLabel}`);
      console.log(`  Prompt:   ${t.prompt}`);
      console.log(`  Schedule: ${t.schedule}`);
      console.log(`  Agent:    ${t.agent || 'local'}`);
      console.log(`  Next run: ${formatDate(t.next_run)}`);
      console.log(`  Last run: ${formatDate(t.last_run)}`);
      console.log();
    }
    break;
  }

  case 'delete': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli delete <id>'); process.exit(1); }
    deleteScheduledTask(id);
    console.log(`Deleted task: ${id}`);
    break;
  }

  case 'pause': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli pause <id>'); process.exit(1); }
    pauseScheduledTask(id);
    console.log(`Paused task: ${id}`);
    break;
  }

  case 'resume': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli resume <id>'); process.exit(1); }
    resumeScheduledTask(id);
    console.log(`Resumed task: ${id}`);
    break;
  }

  default:
    console.error('Commands: create | list | delete | pause | resume');
    process.exit(1);
}
