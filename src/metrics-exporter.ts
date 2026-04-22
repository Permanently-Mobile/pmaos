/**
 * Prometheus metrics exporter for Apex infrastructure.
 * Exposes PM2 fleet, database, memory, bridge, and system metrics
 * on port 9191 in Prometheus text exposition format.
 *
 * Run standalone: node dist/metrics-exporter.js
 * Or import startMetricsServer() from bot startup.
 */

import http from 'http';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';

const PORT = 9191;

interface PM2Process {
  name: string;
  pm2_env?: {
    status?: string;
    restart_time?: number;
    pm_uptime?: number;
  };
  monit?: {
    memory?: number;
    cpu?: number;
  };
}

function getPM2Metrics(): string {
  try {
    const raw = execSync('pm2 jlist', {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const processes: PM2Process[] = JSON.parse(raw);
    const lines: string[] = [
      '# HELP apex_pm2_up Whether the PM2 process is online (1) or not (0)',
      '# TYPE apex_pm2_up gauge',
      '# HELP apex_pm2_restarts Total restart count for the process',
      '# TYPE apex_pm2_restarts counter',
      '# HELP apex_pm2_memory_bytes Memory usage in bytes',
      '# TYPE apex_pm2_memory_bytes gauge',
      '# HELP apex_pm2_cpu_percent CPU usage percentage',
      '# TYPE apex_pm2_cpu_percent gauge',
      '# HELP apex_pm2_uptime_ms Process uptime in milliseconds',
      '# TYPE apex_pm2_uptime_ms gauge',
    ];

    for (const p of processes) {
      const name = p.name;
      const status = p.pm2_env?.status === 'online' ? 1 : 0;
      const restarts = p.pm2_env?.restart_time ?? 0;
      const memory = p.monit?.memory ?? 0;
      const cpu = p.monit?.cpu ?? 0;
      const uptime = p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0;

      lines.push(`apex_pm2_up{process="${name}"} ${status}`);
      lines.push(`apex_pm2_restarts{process="${name}"} ${restarts}`);
      lines.push(`apex_pm2_memory_bytes{process="${name}"} ${memory}`);
      lines.push(`apex_pm2_cpu_percent{process="${name}"} ${cpu}`);
      lines.push(`apex_pm2_uptime_ms{process="${name}"} ${uptime}`);
    }

    lines.push(`# HELP apex_pm2_total_processes Total number of PM2 processes`);
    lines.push(`# TYPE apex_pm2_total_processes gauge`);
    lines.push(`apex_pm2_total_processes ${processes.length}`);

    const online = processes.filter(p => p.pm2_env?.status === 'online').length;
    lines.push(`# HELP apex_pm2_online_processes Number of online PM2 processes`);
    lines.push(`# TYPE apex_pm2_online_processes gauge`);
    lines.push(`apex_pm2_online_processes ${online}`);

    return lines.join('\n');
  } catch {
    return '# PM2 metrics unavailable\napex_pm2_up{process="error"} 0';
  }
}

function getSystemMetrics(): string {
  const lines: string[] = [];

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  lines.push('# HELP apex_system_memory_total_bytes Total system memory');
  lines.push('# TYPE apex_system_memory_total_bytes gauge');
  lines.push(`apex_system_memory_total_bytes ${totalMem}`);
  lines.push('# HELP apex_system_memory_free_bytes Free system memory');
  lines.push('# TYPE apex_system_memory_free_bytes gauge');
  lines.push(`apex_system_memory_free_bytes ${freeMem}`);
  lines.push('# HELP apex_system_memory_used_percent Memory usage percentage');
  lines.push('# TYPE apex_system_memory_used_percent gauge');
  lines.push(`apex_system_memory_used_percent ${((1 - freeMem / totalMem) * 100).toFixed(1)}`);

  // CPU load (1 min average)
  const load = os.loadavg()[0];
  lines.push('# HELP apex_system_load_1m One-minute load average');
  lines.push('# TYPE apex_system_load_1m gauge');
  lines.push(`apex_system_load_1m ${load.toFixed(2)}`);

  // Uptime
  lines.push('# HELP apex_system_uptime_seconds System uptime in seconds');
  lines.push('# TYPE apex_system_uptime_seconds gauge');
  lines.push(`apex_system_uptime_seconds ${os.uptime()}`);

  // Disk (C: drive)
  try {
    const diskInfo = execSync(
      'powershell -NoProfile -Command "(Get-PSDrive C).Free, (Get-PSDrive C).Used"',
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    ).trim().split('\n');
    const free = parseInt(diskInfo[0]?.trim() || '0', 10);
    const used = parseInt(diskInfo[1]?.trim() || '0', 10);
    lines.push('# HELP apex_disk_free_bytes Free disk space on C:');
    lines.push('# TYPE apex_disk_free_bytes gauge');
    lines.push(`apex_disk_free_bytes{drive="C"} ${free}`);
    lines.push('# HELP apex_disk_used_bytes Used disk space on C:');
    lines.push('# TYPE apex_disk_used_bytes gauge');
    lines.push(`apex_disk_used_bytes{drive="C"} ${used}`);
  } catch { /* disk metrics unavailable */ }

  return lines.join('\n');
}

function getDatabaseMetrics(): string {
  const lines: string[] = [];

  try {
    const dbPath = path.join(STORE_DIR, 'apex.db');
    const stat = fs.statSync(dbPath);
    lines.push('# HELP apex_db_size_bytes Main database file size');
    lines.push('# TYPE apex_db_size_bytes gauge');
    lines.push(`apex_db_size_bytes{db="apex"} ${stat.size}`);
  } catch { /* */ }

  // Bridge DB
  try {
    const bridgePath = path.join(STORE_DIR, 'bridge.db');
    const stat = fs.statSync(bridgePath);
    lines.push(`apex_db_size_bytes{db="bridge"} ${stat.size}`);
  } catch { /* */ }

  // Processor DB
  try {
    const processorPath = path.join(STORE_DIR, 'processor.db');
    const stat = fs.statSync(processorPath);
    lines.push(`apex_db_size_bytes{db="processor"} ${stat.size}`);
  } catch { /* */ }

  return lines.join('\n');
}

function getBridgeMetrics(): string {
  const lines: string[] = [];

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3-multiple-ciphers');
    const bridgePath = path.join(STORE_DIR, 'bridge.db');
    const db = new Database(bridgePath);

    const pending = db.prepare("SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'pending'").get() as { c: number };
    const claimed = db.prepare("SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'claimed'").get() as { c: number };
    const completed = db.prepare("SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'completed'").get() as { c: number };
    const failed = db.prepare("SELECT COUNT(*) as c FROM bridge_messages WHERE status = 'failed'").get() as { c: number };

    lines.push('# HELP apex_bridge_tasks Bridge task counts by status');
    lines.push('# TYPE apex_bridge_tasks gauge');
    lines.push(`apex_bridge_tasks{status="pending"} ${pending.c}`);
    lines.push(`apex_bridge_tasks{status="claimed"} ${claimed.c}`);
    lines.push(`apex_bridge_tasks{status="completed"} ${completed.c}`);
    lines.push(`apex_bridge_tasks{status="failed"} ${failed.c}`);

    db.close();
  } catch { /* bridge metrics unavailable */ }

  return lines.join('\n');
}

function getLogMetrics(): string {
  const lines: string[] = [];
  const pm2LogDir = path.join(os.homedir(), '.pm2', 'logs');

  try {
    let totalLogSize = 0;
    const logFiles = fs.readdirSync(pm2LogDir);
    for (const f of logFiles) {
      try {
        totalLogSize += fs.statSync(path.join(pm2LogDir, f)).size;
      } catch { /* */ }
    }
    lines.push('# HELP apex_logs_total_bytes Total PM2 log directory size');
    lines.push('# TYPE apex_logs_total_bytes gauge');
    lines.push(`apex_logs_total_bytes ${totalLogSize}`);
  } catch { /* */ }

  return lines.join('\n');
}

async function collectMetrics(): Promise<string> {
  const sections = [
    getPM2Metrics(),
    getSystemMetrics(),
    getDatabaseMetrics(),
    getLogMetrics(),
  ];

  try {
    sections.push(getBridgeMetrics());
  } catch { /* */ }

  return sections.filter(Boolean).join('\n\n') + '\n';
}

export function startMetricsServer(): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        const metrics = await collectMetrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(metrics);
      } catch (err) {
        res.writeHead(500);
        res.end('Error collecting metrics');
      }
    } else {
      res.writeHead(404);
      res.end('Not found. Use /metrics');
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[metrics] Prometheus exporter running on http://127.0.0.1:${PORT}/metrics`);
  });
}

// Run standalone
if (process.argv[1]?.endsWith('metrics-exporter.js')) {
  startMetricsServer();
}
