/**
 * Work Session CLI — Thin wrapper for the primary bot's Claude subprocess to manage work sessions.
 *
 * The `spawn` command creates the session directory and launches the runner as a
 * fully detached process (survives parent exit on Windows). No fork/IPC -- pure
 * child_process.spawn with stdio: 'ignore' and detached: true.
 *
 * Read-only commands (status, result, kill, list) use the work-session module
 * which reads from the filesystem (status.json files).
 *
 * Usage:
 *   node dist/work-session-cli.js spawn "task prompt" [--budget 2.00] [--timeout 15] [--label "name"]
 *   node dist/work-session-cli.js status [id]
 *   node dist/work-session-cli.js result <id>
 *   node dist/work-session-cli.js kill <id>
 *   node dist/work-session-cli.js list [--limit 10]
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getSessionStatus,
  getSessionResult,
  listAllSessions,
  WorkSessionStatus,
} from './work-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = process.env.APEX_ROOT || path.resolve(__dirname, '..');
const SESSIONS_DIR = path.join(PROJECT_ROOT, 'workspace', 'work-sessions');

const args = process.argv.slice(2);
const command = args[0];

function parseFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function formatStatus(s: {
  id: string;
  status: string;
  label: string;
  costUsd: number;
  tokensUsed: number;
  stage: string;
  error?: string;
  startedAt: number;
}): string {
  const elapsed = Math.round((Date.now() - s.startedAt) / 60000);
  const emojiMap: Record<string, string> = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
    killed: '💀',
    budget_exceeded: '💰',
    timed_out: '⏰',
    starting: '🔧',
  };
  const statusEmoji = emojiMap[s.status] ?? '❓';

  let line = `${statusEmoji} ${s.id} | ${s.label} | ${s.status} | ${elapsed}m | $${s.costUsd.toFixed(3)} | ${Math.round(s.tokensUsed / 1000)}k tokens`;
  if (s.stage && s.status === 'running') line += `\n   Stage: ${s.stage}`;
  if (s.error) line += `\n   Error: ${s.error}`;
  return line;
}

function main(): void {
  switch (command) {
    case 'spawn': {
      const task = args[1];
      if (!task) {
        console.error('Usage: spawn "task prompt" [--budget N] [--timeout N] [--label "name"]');
        process.exit(1);
      }

      const budgetUsd = Math.min(parseFloat(parseFlag('--budget') ?? '2.0'), 10.0);
      const timeoutMinutes = Math.min(parseInt(parseFlag('--timeout') ?? '15', 10), 60);
      const label = parseFlag('--label') ?? 'Work Session';

      // Create session directory
      const timestamp = Date.now();
      const hex = Math.random().toString(16).slice(2, 6);
      const id = `ws-${timestamp}-${hex}`;
      const sessionDir = path.join(SESSIONS_DIR, id);
      fs.mkdirSync(sessionDir, { recursive: true });

      // Write task + options
      fs.writeFileSync(path.join(sessionDir, 'task.txt'), task, 'utf-8');
      fs.writeFileSync(path.join(sessionDir, 'options.json'), JSON.stringify({ budgetUsd, timeoutMinutes, label }, null, 2), 'utf-8');

      // Write initial status
      const initialStatus: WorkSessionStatus = {
        id,
        pid: 0,
        status: 'starting',
        label,
        startedAt: timestamp,
        updatedAt: timestamp,
        tokensUsed: 0,
        outputTokens: 0,
        costUsd: 0,
        stage: 'Launching runner...',
      };
      fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify(initialStatus, null, 2), 'utf-8');

      // Spawn runner as fully detached process (survives this CLI exiting)
      const runnerScript = path.join(__dirname, 'work-session-runner.js');
      const env = { ...process.env } as Record<string, string>;
      env['WORK_SESSION_ID'] = id;
      env['WORK_SESSION_DIR'] = sessionDir;
      env['WORK_SESSION_BUDGET_USD'] = String(budgetUsd);
      env['WORK_SESSION_TIMEOUT_MIN'] = String(timeoutMinutes);
      delete (env as Record<string, string | undefined>)['CLAUDECODE'];
      delete (env as Record<string, string | undefined>)['CLAUDE_CODE_ENTRYPOINT'];

      const child = spawn('node', [runnerScript, sessionDir], {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'ignore',     // No pipes -- fully independent
        detached: true,       // New process group
        windowsHide: true,
      });

      const pid = child.pid ?? 0;
      child.unref(); // Let this CLI process exit

      // Update status with real PID
      initialStatus.pid = pid;
      initialStatus.status = 'running';
      initialStatus.stage = 'Agent starting...';
      fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify(initialStatus, null, 2), 'utf-8');

      console.log(`Work session spawned:`);
      console.log(`  ID: ${id}`);
      console.log(`  PID: ${pid}`);
      console.log(`  Label: ${label}`);
      console.log(`  Budget: $${budgetUsd}`);
      console.log(`  Timeout: ${timeoutMinutes}m`);
      console.log(`  Dir: ${sessionDir}`);
      console.log(`\nMonitor: node dist/work-session-cli.js status ${id}`);
      break;
    }

    case 'status': {
      const id = args[1];
      if (id) {
        const status = getSessionStatus(id);
        if (!status) {
          console.log(`No session found: ${id}`);
          process.exit(1);
        }
        console.log(formatStatus(status));
      } else {
        // Show all recent sessions (filesystem-based, not in-memory)
        const sessions = listAllSessions(10);
        const running = sessions.filter(s => s.status === 'running');
        if (running.length > 0) {
          console.log(`Active sessions (${running.length}):\n`);
          for (const s of running) {
            console.log(formatStatus(s));
            console.log();
          }
        }
        const done = sessions.filter(s => s.status !== 'running');
        if (done.length > 0) {
          console.log(`Recent completed (${done.length}):\n`);
          for (const s of done.slice(0, 5)) {
            console.log(formatStatus(s));
            console.log();
          }
        }
        if (sessions.length === 0) {
          console.log('No work sessions found.');
        }
      }
      break;
    }

    case 'result': {
      const id = args[1];
      if (!id) {
        console.error('Usage: result <session-id>');
        process.exit(1);
      }
      const result = getSessionResult(id);
      if (!result) {
        console.log(`No result found for session: ${id}`);
        process.exit(1);
      }
      console.log(result);
      break;
    }

    case 'kill': {
      const id = args[1];
      if (!id) {
        console.error('Usage: kill <session-id>');
        process.exit(1);
      }
      // Read status to get PID, then kill via taskkill
      const status = getSessionStatus(id);
      if (!status || !['running', 'starting'].includes(status.status)) {
        console.log(`Session ${id} not running.`);
        process.exit(1);
      }
      if (status.pid > 0) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /PID ${status.pid} /T /F`, { windowsHide: true, timeout: 5000 });
          } else {
            process.kill(status.pid, 'SIGKILL');
          }
        } catch { /* already dead */ }
      }
      // Update status file
      status.status = 'killed';
      status.error = 'Killed via CLI';
      status.updatedAt = Date.now();
      fs.writeFileSync(
        path.join(SESSIONS_DIR, id, 'status.json'),
        JSON.stringify(status, null, 2),
        'utf-8',
      );
      console.log(`Killed: ${id}`);
      break;
    }

    case 'list': {
      const limit = parseFlag('--limit');
      const sessions = listAllSessions(limit ? parseInt(limit, 10) : 10);
      if (sessions.length === 0) {
        console.log('No work sessions found.');
      } else {
        console.log(`Recent sessions (${sessions.length}):\n`);
        for (const s of sessions) {
          console.log(formatStatus(s));
          console.log();
        }
      }
      break;
    }

    default:
      console.log('Work Session CLI');
      console.log('');
      console.log('Commands:');
      console.log('  spawn "task" [--budget N] [--timeout N] [--label "name"]  Spawn isolated session');
      console.log('  status [id]                                                Check session status');
      console.log('  result <id>                                                Get session result');
      console.log('  kill <id>                                                  Kill a running session');
      console.log('  list [--limit N]                                           List recent sessions');
  }
}

main();
