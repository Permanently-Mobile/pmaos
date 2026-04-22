import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';

import { BOT_NAME, DASHBOARD_PORT, DASHBOARD_TOKEN, WHATSAPP_ENABLED, SLACK_USER_TOKEN, CONTEXT_LIMIT, ANTHROPIC_DAILY_TOKEN_BUDGET, ANTHROPIC_WEEKLY_TOKEN_BUDGET, ANTHROPIC_MONTHLY_BUDGET_USD, PROJECT_ROOT } from './config.js';
import {
  getAllScheduledTasks,
  getDashboardMemoryStats,
  getDashboardLowSalienceMemories,
  getDashboardTopAccessedMemories,
  getDashboardMemoryTimeline,
  getDashboardTokenStats,
  getDashboardWeeklyTokenStats,
  getDashboardMonthlySpend,
  getDashboardOpenRouterSpend,
  getDashboardCostTimeline,
  getDashboardCostTimelineHourly,
  getDashboardRecentTokenUsage,
  getDashboardMemoriesBySector,
  getSession,
  getSessionTokenUsage,
  getDefaultChatId,
} from './db.js';
import { veniceGetBalance } from './venice.js';
import { getDashboardHtml } from './dashboard-html.js';
import { logger } from './logger.js';
import { createTradingRoutes } from './trading/dashboard.js';
import { readEnvFile } from './env.js';
import { getNetworkStatus, getNetworkInterfaces, getNetworkDevices, getFirewallLog } from './dashboard-network.js';

const VAULT_PATH = process.env.VAULT_ROOT || '';

// ── Bridge DB (cached connection for agent queue lookups) ────────────
let bridgeDb: Database.Database | null = null;

interface AgentQueueItem {
  prompt: string;
  createdAt?: string;
  claimedAt?: string;
  completedAt?: string;
  cost?: number | null;
}

interface AgentQueue {
  current: (AgentQueueItem & { claimedAt: string }) | null;
  pending: AgentQueueItem[];
  recentDone: AgentQueueItem[];
}

function getBridgeDb(): Database.Database | null {
  if (bridgeDb) return bridgeDb;
  try {
    const dbPath = path.join(process.cwd(), 'store', 'bridge.db');
    if (!fs.existsSync(dbPath)) return null;
    bridgeDb = new Database(dbPath, { readonly: true });
    const dbKey = readEnvFile(['DB_PASSPHRASE']).DB_PASSPHRASE;
    if (dbKey) {
      // DBs use default cipher (not sqlcipher).
      bridgeDb.pragma(`key='${dbKey}'`);
    }
    bridgeDb.pragma('busy_timeout = 3000');
    return bridgeDb;
  } catch (err) {
    logger.warn({ err }, 'Failed to open bridge DB for dashboard');
    return null;
  }
}

function getAgentQueue(agentName: string): AgentQueue {
  const empty: AgentQueue = { current: null, pending: [], recentDone: [] };
  const db = getBridgeDb();
  if (!db) return empty;

  try {
    // Current task: claimed and assigned to this agent
    const currentRow = db.prepare(`
      SELECT payload, claimed_at FROM bridge_messages
      WHERE to_agent = ? AND status = 'claimed' AND msg_type = 'task'
      ORDER BY claimed_at DESC LIMIT 1
    `).get(agentName) as { payload: string; claimed_at: number } | undefined;

    let current: AgentQueue['current'] = null;
    if (currentRow) {
      const parsed = JSON.parse(currentRow.payload);
      current = {
        prompt: (parsed.prompt || '').slice(0, 80),
        claimedAt: new Date(currentRow.claimed_at * 1000).toISOString(),
      };
    }

    // Pending tasks queued for this agent
    const pendingRows = db.prepare(`
      SELECT payload, created_at FROM bridge_messages
      WHERE to_agent = ? AND status = 'pending' AND msg_type = 'task'
      ORDER BY priority DESC, created_at
    `).all(agentName) as Array<{ payload: string; created_at: number }>;

    const pending: AgentQueueItem[] = pendingRows.map(r => {
      const parsed = JSON.parse(r.payload);
      return {
        prompt: (parsed.prompt || '').slice(0, 80),
        createdAt: new Date(r.created_at * 1000).toISOString(),
      };
    });

    // Recent completions (result messages FROM this agent)
    const doneRows = db.prepare(`
      SELECT payload, completed_at FROM bridge_messages
      WHERE from_agent = ? AND status = 'completed' AND msg_type = 'result'
      ORDER BY completed_at DESC LIMIT 3
    `).all(agentName) as Array<{ payload: string; completed_at: number }>;

    const recentDone: AgentQueueItem[] = doneRows.map(r => {
      const parsed = JSON.parse(r.payload);
      return {
        prompt: (parsed.summary || parsed.original_prompt || '').slice(0, 80),
        completedAt: new Date(r.completed_at * 1000).toISOString(),
        cost: parsed.cost_usd ?? null,
      };
    });

    return { current, pending, recentDone };
  } catch (err) {
    logger.warn({ err, agent: agentName }, 'Failed to query bridge queue');
    return empty;
  }
}

// Agents that don't use the bridge queue (trading bots use their own trading system)
const BRIDGE_SKIP = new Set<string>();

// ── Dispatch Board (all agent queues at a glance) ────────────────────
interface DispatchAgent {
  name: string;
  current: { prompt_preview: string; claimed_at: string } | null;
  pending_count: number;
  recent_completed: Array<{ prompt_preview: string; completed_at: string; cost: number | null }>;
}

const DISPATCH_AGENTS = ['researcher-1', 'researcher-2', 'coder-1', 'coder-2', 'coder-3', 'processor-1', 'creative-1', 'auditor-1'];

const DISPATCH_ROLES: Record<string, string> = {
  'researcher-1': 'Research',
  'researcher-2': 'Research',
  'coder-1': 'Code Dev',
  'coder-2': 'Code Dev',
  'coder-3': 'Code Dev',
  'processor-1': 'Note-Taker',
  'creative-1': 'Builder',
  'auditor-1': 'Audit / Escalation',
  [BOT_NAME]: 'Coordinator',
};

function getAllAgentQueues(): DispatchAgent[] {
  const db = getBridgeDb();
  const results: DispatchAgent[] = [];

  // Get next scheduled task per agent keyword
  const scheduledTasks = getAllScheduledTasks();
  const now = Math.floor(Date.now() / 1000);

  for (const name of DISPATCH_AGENTS) {
    const agent: DispatchAgent = {
      name,
      current: null,
      pending_count: 0,
      recent_completed: [],
    };

    if (!db) {
      results.push(agent);
      continue;
    }

    try {
      // Current claimed task
      const currentRow = db.prepare(`
        SELECT payload, claimed_at FROM bridge_messages
        WHERE to_agent = ? AND status = 'claimed' AND msg_type = 'task'
        ORDER BY claimed_at DESC LIMIT 1
      `).get(name) as { payload: string; claimed_at: number } | undefined;

      if (currentRow) {
        const parsed = JSON.parse(currentRow.payload);
        agent.current = {
          prompt_preview: (parsed.prompt || '').slice(0, 60),
          claimed_at: new Date(currentRow.claimed_at * 1000).toISOString(),
        };
      }

      // Pending count
      const countRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM bridge_messages
        WHERE to_agent = ? AND status = 'pending' AND msg_type = 'task'
      `).get(name) as { cnt: number } | undefined;

      agent.pending_count = countRow?.cnt || 0;

      // Recent completions (last 3)
      const doneRows = db.prepare(`
        SELECT payload, completed_at FROM bridge_messages
        WHERE from_agent = ? AND status = 'completed' AND msg_type = 'result'
        ORDER BY completed_at DESC LIMIT 3
      `).all(name) as Array<{ payload: string; completed_at: number }>;

      agent.recent_completed = doneRows.map(r => {
        const parsed = JSON.parse(r.payload);
        return {
          prompt_preview: (parsed.summary || parsed.original_prompt || '').slice(0, 60),
          completed_at: new Date(r.completed_at * 1000).toISOString(),
          cost: parsed.cost_usd ?? null,
        };
      });
    } catch (err) {
      logger.warn({ err, agent: name }, 'Failed to query dispatch queue');
    }

    results.push(agent);
  }

  return results;
}

// Get all scheduled tasks with next run times for the dispatch table
function getScheduledTasksSummary(): Array<{
  id: string;
  prompt_preview: string;
  schedule: string;
  next_run: string;
  last_run: string | null;
  status: string;
}> {
  const tasks = getAllScheduledTasks();
  return tasks.map(t => ({
    id: t.id,
    prompt_preview: t.prompt.slice(0, 80),
    schedule: t.schedule,
    next_run: new Date(t.next_run * 1000).toISOString(),
    last_run: t.last_run ? new Date(t.last_run * 1000).toISOString() : null,
    status: t.status,
  }));
}

// ── Rate limiter ──────────────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000; // 1 minute window
const RATE_MAX_REQUESTS = 60;  // 60 requests per window per IP
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count++;
  return bucket.count > RATE_MAX_REQUESTS;
}

// Clean stale buckets every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, 300_000);

export function startDashboard(): ServerType | null {
  if (!DASHBOARD_TOKEN) {
    logger.info('DASHBOARD_TOKEN not set, dashboard disabled');
    return null;
  }

  const app = new Hono();

  // Rate limiting middleware
  app.use('*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'local';
    if (isRateLimited(ip)) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    await next();
  });

  // Token auth middleware -- cookie-based sessions with one-time token bootstrap.
  // Initial auth via Authorization header or ?token= query param sets an HttpOnly cookie.
  // Subsequent requests use the cookie. Token is never embedded in HTML.
  app.use('*', async (c, next) => {
    // Check cookie first
    const cookieHeader = c.req.header('Cookie') || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)dash_session=([^\s;]+)/);
    const cookieToken = cookieMatch ? cookieMatch[1] : null;

    // Then check Authorization header
    const authHeader = c.req.header('Authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Query param is only accepted on GET / for initial bootstrap
    const queryToken = c.req.method === 'GET' && c.req.path === '/' ? c.req.query('token') : null;

    const token = cookieToken || headerToken || queryToken;
    if (token !== DASHBOARD_TOKEN) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // If authenticated via query param or header but no cookie, set the session cookie
    if (!cookieToken && token === DASHBOARD_TOKEN) {
      c.header('Set-Cookie', `dash_session=${DASHBOARD_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    }

    await next();
  });

  // Serve dashboard HTML (auto-detect chatId from DB if not provided)
  // Token is NOT embedded in HTML -- client JS uses the cookie for auth
  app.get('/', (c) => {
    const chatId = c.req.query('chatId') || getDefaultChatId();
    // If bootstrapped via ?token=, redirect to clean URL to strip token from address bar
    if (c.req.query('token')) {
      const chatParam = c.req.query('chatId') ? `?chatId=${encodeURIComponent(c.req.query('chatId')!)}` : '';
      return c.redirect(`/${chatParam}`, 302);
    }
    return c.html(getDashboardHtml(chatId));
  });

  // Scheduled tasks
  app.get('/api/tasks', (c) => {
    const tasks = getAllScheduledTasks();
    return c.json({ tasks });
  });

  // Memory stats (supports range query param: 1h, 6h, 24h, 7d, 30d)
  app.get('/api/memories', (c) => {
    const chatId = c.req.query('chatId') || getDefaultChatId();
    const range = c.req.query('range') || '30d';
    const rangeDays: Record<string, number> = { '1h': 1, '6h': 1, '24h': 1, '7d': 7, '30d': 30 };
    const days = rangeDays[range] || 30;
    const stats = getDashboardMemoryStats(chatId);
    const fading = getDashboardLowSalienceMemories(chatId, 10);
    const topAccessed = getDashboardTopAccessedMemories(chatId, 5);
    const timeline = getDashboardMemoryTimeline(chatId, days);
    return c.json({ stats, fading, topAccessed, timeline });
  });

  // Memory list by sector (for drill-down)
  app.get('/api/memories/list', (c) => {
    const chatId = c.req.query('chatId') || getDefaultChatId();
    const sector = c.req.query('sector') || 'semantic';
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const result = getDashboardMemoriesBySector(chatId, sector, limit, offset);
    return c.json(result);
  });

  // System health
  app.get('/api/health', (c) => {
    const chatId = c.req.query('chatId') || getDefaultChatId();
    const sessionId = getSession(chatId);
    let contextPct = 0;
    let turns = 0;
    let compactions = 0;
    let sessionAge = '-';

    if (sessionId) {
      const summary = getSessionTokenUsage(sessionId);
      if (summary) {
        turns = summary.turns;
        compactions = summary.compactions;
        const contextTokens = summary.lastContextTokens || summary.lastCacheRead;
        contextPct = contextTokens > 0 ? Math.round((contextTokens / CONTEXT_LIMIT) * 100) : 0;
        const ageSec = Math.floor(Date.now() / 1000) - summary.firstTurnAt;
        if (ageSec < 3600) sessionAge = Math.floor(ageSec / 60) + 'm';
        else if (ageSec < 86400) sessionAge = Math.floor(ageSec / 3600) + 'h';
        else sessionAge = Math.floor(ageSec / 86400) + 'd';
      }
    }

    return c.json({
      contextPct,
      turns,
      compactions,
      sessionAge,
      waConnected: WHATSAPP_ENABLED,
      slackConnected: !!SLACK_USER_TOKEN,
    });
  });

  // Mount trading dashboard sub-app
  const tradingApp = createTradingRoutes(DASHBOARD_TOKEN);
  app.route('/trading', tradingApp);

  // ── Command Center endpoints ──────────────────────────────────────

  // Agent status via pm2 + bridge queue
  app.get('/api/agents', (c) => {
    try {
      const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
      const procs = JSON.parse(raw);
      const exclude = new Set([BOT_NAME]);
      const agents = procs
        .filter((p: any) => !exclude.has(p.name))
        .map((p: any) => {
          const name: string = p.name;
          const agent: Record<string, unknown> = {
            name,
            status: p.pm2_env?.status || 'unknown',
            cpu: p.monit?.cpu || 0,
            memory: p.monit?.memory || 0,
            uptime: p.pm2_env?.pm_uptime || 0,
            restarts: p.pm2_env?.restart_time || 0,
          };
          if (!BRIDGE_SKIP.has(name)) {
            agent.queue = getAgentQueue(name);
          }
          return agent;
        });
      return c.json({ agents });
    } catch {
      return c.json({ agents: [] });
    }
  });

  // Dispatch board -- all agent queues + PM2 status + scheduled tasks
  app.get('/api/dispatch', (c) => {
    try {
      const agents = getAllAgentQueues();
      const scheduled = getScheduledTasksSummary();

      // Get PM2 status for each dispatch agent
      let pm2Status: Record<string, string> = {};
      try {
        const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        const procs = JSON.parse(raw);
        for (const p of procs) {
          pm2Status[p.name] = p.pm2_env?.status || 'unknown';
        }
      } catch { /* pm2 not available */ }

      // Merge PM2 status + role into agents
      const enriched = agents.map(a => ({
        ...a,
        role: DISPATCH_ROLES[a.name] || '',
        pm2_status: pm2Status[a.name] || 'unknown',
      }));

      return c.json({ agents: enriched, scheduled });
    } catch {
      return c.json({ agents: [], scheduled: [] });
    }
  });

  // ── Hive Mind endpoints (Track 4) ──────────────────────────────────

  // Agent health overview: PM2 status + last seen from hive_mind
  app.get('/api/hive', (c) => {
    try {
      const bdb = getBridgeDb();
      let lastSeen: Record<string, number> = {};
      if (bdb) {
        try {
          const rows = bdb.prepare(`
            SELECT agent, MAX(created_at) as last_seen FROM hive_mind GROUP BY agent
          `).all() as Array<{ agent: string; last_seen: number }>;
          for (const r of rows) lastSeen[r.agent] = r.last_seen;
        } catch { /* table may not exist yet */ }
      }

      let pm2Status: Record<string, { status: string; memory: number; uptime: number; restarts: number }> = {};
      try {
        const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        const procs = JSON.parse(raw);
        for (const p of procs) {
          pm2Status[p.name] = {
            status: p.pm2_env?.status || 'unknown',
            memory: p.monit?.memory || 0,
            uptime: p.pm2_env?.pm_uptime || 0,
            restarts: p.pm2_env?.restart_time || 0,
          };
        }
      } catch { /* pm2 not available */ }

      const now = Math.floor(Date.now() / 1000);
      const allAgents = [...new Set([...Object.keys(lastSeen), ...Object.keys(pm2Status)])];

      const agents = allAgents.map(name => ({
        name,
        role: DISPATCH_ROLES[name] || '',
        pm2_status: pm2Status[name]?.status || 'unknown',
        memory: pm2Status[name]?.memory || 0,
        uptime: pm2Status[name]?.uptime || 0,
        restarts: pm2Status[name]?.restarts || 0,
        last_seen: lastSeen[name] || 0,
        seconds_since_seen: lastSeen[name] ? now - lastSeen[name] : -1,
        healthy: pm2Status[name]?.status === 'online' && lastSeen[name] ? (now - lastSeen[name]) < 180 : false,
      }));

      return c.json({ agents, timestamp: now });
    } catch (err) {
      return c.json({ agents: [], error: String(err) });
    }
  });

  // Hive Mind activity log
  app.get('/api/hive/log', (c) => {
    const agent = c.req.query('agent');
    const limit = parseInt(c.req.query('limit') || '50', 10);
    try {
      const bdb = getBridgeDb();
      if (!bdb) return c.json({ entries: [] });

      let entries: Array<{ agent: string; action: string; detail: string | null; task_id: string | null; created_at: number }> = [];
      if (agent) {
        entries = bdb.prepare(`
          SELECT agent, action, detail, task_id, created_at FROM hive_mind
          WHERE agent = ? ORDER BY created_at DESC LIMIT ?
        `).all(agent, limit) as typeof entries;
      } else {
        entries = bdb.prepare(`
          SELECT agent, action, detail, task_id, created_at FROM hive_mind
          ORDER BY created_at DESC LIMIT ?
        `).all(limit) as typeof entries;
      }
      return c.json({ entries });
    } catch {
      return c.json({ entries: [] });
    }
  });

  // ── Workflow DAG endpoints (Track 3) ────────────────────────────────

  // Workflow status overview
  app.get('/api/workflows', async (c) => {
    try {
      const { getWorkflowStatus } = await import('./workflow/index.js');
      return c.json({ workflows: getWorkflowStatus() });
    } catch {
      return c.json({ workflows: [] });
    }
  });

  // Recent workflow runs
  app.get('/api/workflows/runs', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const workflow = c.req.query('workflow');
    try {
      const { getRecentRuns } = await import('./workflow/index.js');
      return c.json({ runs: getRecentRuns(workflow || undefined, limit) });
    } catch {
      return c.json({ runs: [] });
    }
  });

  // Workflow run detail (steps)
  app.get('/api/workflows/runs/:runId', async (c) => {
    const runId = c.req.param('runId');
    try {
      const { getRunDetails } = await import('./workflow/index.js');
      return c.json(getRunDetails(runId));
    } catch {
      return c.json({ run: null, steps: [] });
    }
  });

  // Trigger a workflow manually
  app.post('/api/workflows/run', async (c) => {
    try {
      const body = await c.req.json();
      const name = body?.workflow || body?.name;
      if (!name) return c.json({ error: 'Missing "workflow" field' }, 400);
      const { runWorkflow } = await import('./workflow/index.js');
      const result = await runWorkflow(name, { manual: true, source: 'dashboard' });
      if (!result) return c.json({ error: `Workflow "${name}" not found` }, 404);
      return c.json({
        runId: result.runId,
        status: result.status,
        error: result.error || null,
        durationMs: result.completedAt ? result.completedAt - result.startedAt : null,
        steps: result.stepResults?.map((s: { stepId: string; status: string; durationMs: number; error?: string }) => ({
          stepId: s.stepId,
          status: s.status,
          durationMs: s.durationMs,
          error: s.error || null,
        })) || [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // Mount webhook sub-app (receive endpoint is pre-auth, management uses dashboard auth)
  import('./workflow/webhooks.js')
    .then(({ createWebhookApp }) => {
      app.route('/api/webhooks', createWebhookApp());
    })
    .catch(() => {
      // Workflow system not available -- non-fatal
    });

  // Active projects from Obsidian Tasks.md
  app.get('/api/projects', (c) => {
    try {
      const content = fs.readFileSync(path.join(VAULT_PATH, 'Tasks.md'), 'utf-8');
      const projects: Array<{ name: string; file: string; done: number; total: number }> = [];
      const sections = content.split(/^## /m).slice(1);

      for (const section of sections) {
        const headerMatch = section.match(/^Active -- (.+?)\s*\(Project:\s*(.+?)\)/);
        if (!headerMatch) continue;
        const unchecked = (section.match(/- \[ \]/g) || []).length;
        const checked = (section.match(/- \[x\]/g) || []).length;
        projects.push({
          name: headerMatch[1],
          file: headerMatch[2],
          done: checked,
          total: checked + unchecked,
        });
      }

      return c.json({ projects: projects.slice(0, 5) });
    } catch {
      return c.json({ projects: [] });
    }
  });

  // Active tasks from Tasks.md grouped by section (checked + unchecked)
  app.get('/api/daily-tasks', (c) => {
    try {
      const content = fs.readFileSync(path.join(VAULT_PATH, 'Tasks.md'), 'utf-8');
      const lines = content.split('\n');
      const tasks: Array<{ task: string; section: string; done: boolean }> = [];
      let currentSection = '';

      for (const line of lines) {
        const sectionMatch = line.match(/^## Active -- (.+?)(?:\s*\(Project:.*\))?$/);
        if (sectionMatch) {
          currentSection = sectionMatch[1];
          continue;
        }
        if (line.startsWith('## ') && !line.includes('Active --')) {
          currentSection = '';
          continue;
        }
        const uncheckedMatch = line.match(/^- \[ \] (.+)$/);
        if (uncheckedMatch && currentSection) {
          tasks.push({ task: uncheckedMatch[1], section: currentSection, done: false });
        }
        const checkedMatch = line.match(/^- \[x\] (.+)$/);
        if (checkedMatch && currentSection) {
          tasks.push({ task: checkedMatch[1], section: currentSection, done: true });
        }
      }

      return c.json({ tasks });
    } catch {
      return c.json({ tasks: [] });
    }
  });

  // Toggle a task's checked state in Tasks.md
  app.post('/api/daily-tasks/toggle', async (c) => {
    try {
      const body = await c.req.json();
      const { section, task, done } = body as { section: string; task: string; done: boolean };

      if (!section || !task || typeof done !== 'boolean') {
        return c.json({ success: false, error: 'Missing required fields: section, task, done' }, 400);
      }

      const tasksPath = path.join(VAULT_PATH, 'Tasks.md');
      const content = fs.readFileSync(tasksPath, 'utf-8');
      const lines = content.split('\n');

      let currentSection = '';
      let found = false;

      for (let i = 0; i < lines.length; i++) {
        const sectionMatch = lines[i].match(/^## Active -- (.+?)(?:\s*\(Project:.*\))?$/);
        if (sectionMatch) {
          currentSection = sectionMatch[1];
          continue;
        }
        if (lines[i].startsWith('## ') && !lines[i].includes('Active --')) {
          currentSection = '';
          continue;
        }

        if (currentSection === section) {
          const uncheckedMatch = lines[i].match(/^- \[ \] (.+)$/);
          const checkedMatch = lines[i].match(/^- \[x\] (.+)$/);

          if (done && uncheckedMatch && uncheckedMatch[1] === task) {
            lines[i] = `- [x] ${task}`;
            found = true;
            break;
          } else if (!done && checkedMatch && checkedMatch[1] === task) {
            lines[i] = `- [ ] ${task}`;
            found = true;
            break;
          }
        }
      }

      if (!found) {
        return c.json({ success: false, error: 'Task not found in specified section' }, 404);
      }

      fs.writeFileSync(tasksPath, lines.join('\n'), 'utf-8');

      // Async vault commit -- fire and forget so the user isn't waiting on git
      const safeTask = task.replace(/["`$\\]/g, '');
      const commitMsg = done
        ? `dashboard: checked off ${safeTask}`
        : `dashboard: unchecked ${safeTask}`;
      const child = spawn('bash', [
        path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh'),
        commitMsg,
      ], { windowsHide: true, stdio: 'ignore' });
      child.on('error', (err) => logger.error({ err }, 'Vault commit failed after task toggle'));

      return c.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to toggle task');
      return c.json({ success: false, error: 'Failed to toggle task' }, 500);
    }
  });

  // EOD reconciliation -- returns current vault state for sync comparison
  app.get('/api/daily-tasks/sync-check', (c) => {
    try {
      const content = fs.readFileSync(path.join(VAULT_PATH, 'Tasks.md'), 'utf-8');
      const lines = content.split('\n');
      const tasks: Array<{ task: string; section: string; done: boolean }> = [];
      let currentSection = '';

      for (const line of lines) {
        const sectionMatch = line.match(/^## Active -- (.+?)(?:\s*\(Project:.*\))?$/);
        if (sectionMatch) {
          currentSection = sectionMatch[1];
          continue;
        }
        if (line.startsWith('## ') && !line.includes('Active --')) {
          currentSection = '';
          continue;
        }
        const uncheckedMatch = line.match(/^- \[ \] (.+)$/);
        if (uncheckedMatch && currentSection) {
          tasks.push({ task: uncheckedMatch[1], section: currentSection, done: false });
        }
        const checkedMatch = line.match(/^- \[x\] (.+)$/);
        if (checkedMatch && currentSection) {
          tasks.push({ task: checkedMatch[1], section: currentSection, done: true });
        }
      }

      return c.json({ tasks, syncedAt: new Date().toISOString() });
    } catch {
      return c.json({ tasks: [], syncedAt: new Date().toISOString(), error: 'Failed to read Tasks.md' });
    }
  });

  // API usage (Anthropic daily/weekly/monthly + Venice balance)
  app.get('/api/usage', async (c) => {
    const chatId = c.req.query('chatId') || getDefaultChatId();
    const daily = getDashboardTokenStats(chatId);
    const weekly = getDashboardWeeklyTokenStats(chatId);
    const monthly = getDashboardMonthlySpend();

    let veniceBalance = null;
    try {
      veniceBalance = await veniceGetBalance();
    } catch { /* degrade gracefully */ }

    const openrouter = getDashboardOpenRouterSpend();

    return c.json({
      daily,
      weekly,
      monthly,
      veniceBalance,
      openrouter,
      budgets: {
        daily: ANTHROPIC_DAILY_TOKEN_BUDGET,
        weekly: ANTHROPIC_WEEKLY_TOKEN_BUDGET,
        monthlyUsd: ANTHROPIC_MONTHLY_BUDGET_USD,
      },
    });
  });

  // Token / cost stats (supports range query param: 1h, 6h, 24h, 7d, 30d)
  app.get('/api/tokens', (c) => {
    const chatId = c.req.query('chatId') || getDefaultChatId();
    const range = c.req.query('range') || '30d';
    const stats = getDashboardTokenStats(chatId);

    // Parse range to days for daily timeline
    const rangeDays: Record<string, number> = { '1h': 1, '6h': 1, '24h': 1, '7d': 7, '30d': 30 };
    const days = rangeDays[range] || 30;
    const costTimeline = getDashboardCostTimeline(chatId, days);

    // For sub-day ranges, also include hourly data
    let hourlyTimeline: { hour: string; cost: number; turns: number }[] = [];
    const rangeHours: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24 };
    if (rangeHours[range]) {
      hourlyTimeline = getDashboardCostTimelineHourly(chatId, rangeHours[range]);
    }

    const recentUsage = getDashboardRecentTokenUsage(chatId, 20);
    return c.json({ stats, costTimeline, hourlyTimeline, recentUsage });
  });

  // ── Network monitoring endpoints (pfSense + network agent device DB) ────────

  // pfSense system status (CPU, RAM, uptime, temperature)
  app.get('/api/network/status', async (c) => {
    try {
      const status = await getNetworkStatus();
      return c.json({ status });
    } catch {
      return c.json({ status: null });
    }
  });

  // pfSense interface stats (name, status, bandwidth in/out)
  app.get('/api/network/interfaces', async (c) => {
    try {
      const interfaces = await getNetworkInterfaces();
      return c.json({ interfaces });
    } catch {
      return c.json({ interfaces: [] });
    }
  });

  // Connected devices from the network agent's device tracker DB
  app.get('/api/network/devices', (c) => {
    try {
      const devices = getNetworkDevices();
      return c.json({ devices });
    } catch {
      return c.json({ devices: [] });
    }
  });

  // Recent firewall log entries from pfSense
  app.get('/api/network/firewall', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    try {
      const entries = await getFirewallLog(limit);
      return c.json({ entries });
    } catch {
      return c.json({ entries: [] });
    }
  });

  const server = serve({ fetch: app.fetch, port: DASHBOARD_PORT }, () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server running');
  });

  // Handle port binding errors (EADDRINUSE on fast restarts)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: DASHBOARD_PORT }, 'Dashboard port in use, retrying in 5s...');
      setTimeout(() => {
        server.close();
        server.listen(DASHBOARD_PORT);
      }, 5000);
    } else {
      logger.error({ err }, 'Dashboard server error');
    }
  });

  return server;
}
