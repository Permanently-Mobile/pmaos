/**
 * Network Config Auditor
 *
 * Audits pfSense network configuration: VLAN integrity, firewall rules,
 * DHCP pool utilization, security services, config drift detection.
 *
 * Run: node dist/audit-network-config.js
 * Schedule: weekly Tuesdays 6am
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { decryptAgeFile, readEnvFile } from './env.js';

// Disable TLS verification for self-signed pfSense cert
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const VAULT_PATH = process.env.VAULT_ROOT || '';
const VAULT_COMMIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'vault-commit.sh');
const NOTIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'notify.sh');

function notify(message: string): void {
  try {
    execSync(`bash "${NOTIFY_SCRIPT}" "${message.replace(/"/g, '\\"')}"`, {
      timeout: 10000, windowsHide: true, stdio: 'pipe',
    });
  } catch { /* non-fatal */ }
}

const NETWORK_BOT_DIR = path.join(PROJECT_ROOT, 'bots', 'network');

// -- Expected VLAN config ---------------------------------------------------

interface ExpectedVlan {
  tag: number;
  name: string;
  isolation: 'full' | 'internet-only' | 'no-internet' | 'trusted';
}

const EXPECTED_VLANS: ExpectedVlan[] = [
  { tag: 1,  name: 'Management',  isolation: 'trusted' },
  { tag: 10, name: 'Trusted',     isolation: 'trusted' },
  { tag: 20, name: 'Media',       isolation: 'full' },
  { tag: 30, name: 'IoT',         isolation: 'internet-only' },
  { tag: 40, name: 'Guest',       isolation: 'internet-only' },
  { tag: 50, name: 'Security',    isolation: 'no-internet' },
  { tag: 60, name: 'Isolated',     isolation: 'full' },
];

// -- Types ------------------------------------------------------------------

interface Finding {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: string;
  title: string;
  detail: string;
}

interface ApiResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
}

// -- pfSense API client (standalone) ----------------------------------------

let pfHost = '';
let pfApiKey = '';

function loadPfSenseCredentials(): boolean {
  // Try encrypted .env.age in network bot directory
  const ageFile = path.join(NETWORK_BOT_DIR, '.env.age');
  const decrypted = decryptAgeFile(ageFile);
  if (decrypted) {
    const hostMatch = decrypted.match(/^PFSENSE_HOST=(.+)$/m);
    const keyMatch = decrypted.match(/^PFSENSE_API_KEY=(.+)$/m);
    pfHost = hostMatch?.[1]?.trim() || '';
    pfApiKey = keyMatch?.[1]?.trim() || '';
  }

  // Fallback to plaintext .env
  if (!pfHost || !pfApiKey) {
    const envFile = path.join(NETWORK_BOT_DIR, '.env');
    try {
      const content = fs.readFileSync(envFile, 'utf-8');
      if (!pfHost) {
        const m = content.match(/^PFSENSE_HOST=(.+)$/m);
        pfHost = m?.[1]?.trim() || '';
      }
      if (!pfApiKey) {
        const m = content.match(/^PFSENSE_API_KEY=(.+)$/m);
        pfApiKey = m?.[1]?.trim() || '';
      }
    } catch { /* no plaintext .env */ }
  }

  if (!pfHost) {
    throw new Error('PFSENSE_HOST environment variable is required for network audit');
  }
  return !!pfApiKey;
}

async function pfGet<T>(endpoint: string, params?: Record<string, string>): Promise<ApiResult<T>> {
  try {
    const url = new URL(`/api/v2/${endpoint}`, pfHost);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-API-Key': pfApiKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { ok: false, data: null, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const json = await response.json() as { data: T };
    return { ok: true, data: json.data ?? (json as unknown as T) };
  } catch (err) {
    return { ok: false, data: null, error: String(err) };
  }
}

// -- Check functions --------------------------------------------------------

async function checkConnectivity(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const result = await pfGet<{ cpu_usage?: number; uptime?: number }>('status/system');

  if (!result.ok) {
    findings.push({
      severity: 'critical', category: 'Connectivity',
      title: 'pfSense API unreachable',
      detail: result.error || 'Connection failed',
    });
  }

  return findings;
}

async function checkInterfaces(): Promise<{ findings: Finding[]; interfaces: Array<{ name: string; status: string; description?: string }> }> {
  const findings: Finding[] = [];
  const interfaces: Array<{ name: string; status: string; description?: string }> = [];

  const result = await pfGet<Record<string, { status?: string; if?: string; descr?: string }> | Array<{ status?: string; if?: string; descr?: string }>>('status/interface');
  if (!result.ok || !result.data) {
    findings.push({
      severity: 'low', category: 'Interfaces',
      title: 'Could not fetch interface status',
      detail: result.error || 'No data returned',
    });
    return { findings, interfaces };
  }

  // Normalize: could be object or array
  const ifaces = Array.isArray(result.data) ? result.data : Object.values(result.data);
  for (const iface of ifaces) {
    const name = (iface as Record<string, string>).if || (iface as Record<string, string>).descr || 'unknown';
    const status = (iface as Record<string, string>).status || 'unknown';
    interfaces.push({ name, status, description: (iface as Record<string, string>).descr });

    if (status !== 'up' && status !== 'active' && status !== 'associated') {
      findings.push({
        severity: 'medium', category: 'Interfaces',
        title: `Interface ${name} is ${status}`,
        detail: `Expected up/active, got "${status}"`,
      });
    }
  }

  // Check that we have at least as many interfaces as expected VLANs
  if (interfaces.length < EXPECTED_VLANS.length) {
    findings.push({
      severity: 'low', category: 'Interfaces',
      title: `Only ${interfaces.length} interfaces detected`,
      detail: `Expected at least ${EXPECTED_VLANS.length} for configured VLANs`,
    });
  }

  return { findings, interfaces };
}

async function checkFirewallRules(): Promise<Finding[]> {
  const findings: Finding[] = [];

  const result = await pfGet<Array<Record<string, string>>>('firewall/rule');
  if (!result.ok || !result.data) {
    findings.push({
      severity: 'low', category: 'Firewall Rules',
      title: 'Firewall rules endpoint not available',
      detail: `${result.error || 'Not supported'} -- manual review recommended`,
    });
    return findings;
  }

  const rules = result.data;
  findings.push({
    severity: 'info', category: 'Firewall Rules',
    title: `${rules.length} firewall rules found`,
    detail: 'Rules retrieved for analysis',
  });

  // Check for overly permissive rules
  for (const rule of rules) {
    const src = rule.source || rule.src || '';
    const dst = rule.destination || rule.dst || '';
    const action = rule.type || rule.action || rule.act || '';
    const iface = rule.interface || '';
    const disabled = rule.disabled === 'true' || rule.disabled === '1';

    if (disabled) continue;

    // Flag any:any pass rules (overly permissive)
    if (action === 'pass' && src === 'any' && dst === 'any') {
      findings.push({
        severity: 'high', category: 'Firewall Rules',
        title: `Overly permissive rule on ${iface || 'unknown'}`,
        detail: `Pass from any to any -- potential security gap`,
      });
    }
  }

  return findings;
}

async function checkDhcpPools(): Promise<{ findings: Finding[]; pools: Array<{ iface: string; leases: number }> }> {
  const findings: Finding[] = [];
  const pools: Array<{ iface: string; leases: number }> = [];

  const result = await pfGet<Array<Record<string, string | number>>>('services/dhcpd');
  if (!result.ok || !result.data) {
    findings.push({
      severity: 'low', category: 'DHCP',
      title: 'DHCP data unavailable',
      detail: result.error || 'Could not fetch DHCP config',
    });
    return { findings, pools };
  }

  // Group leases by interface
  const leasesByInterface: Record<string, number> = {};
  if (Array.isArray(result.data)) {
    for (const entry of result.data) {
      const iface = String(entry.interface || entry.if || 'unknown');
      leasesByInterface[iface] = (leasesByInterface[iface] || 0) + 1;
    }
  }

  for (const [iface, count] of Object.entries(leasesByInterface)) {
    pools.push({ iface, leases: count });
  }

  return { findings, pools };
}

async function checkServices(): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Check pfBlockerNG
  const pfb = await pfGet<Record<string, unknown>>('services/pfblockerng');
  if (!pfb.ok) {
    // Try service status endpoint as fallback
    const svc = await pfGet<Array<Record<string, string>>>('status/service');
    if (svc.ok && svc.data) {
      const services = Array.isArray(svc.data) ? svc.data : [];

      const pfbSvc = services.find(s =>
        (s.name || s.description || '').toLowerCase().includes('pfblocker'));
      if (pfbSvc) {
        const running = pfbSvc.status === 'running' || pfbSvc.status === 'active';
        findings.push({
          severity: running ? 'info' : 'high',
          category: 'Security Services',
          title: `pfBlockerNG: ${running ? 'running' : 'STOPPED'}`,
          detail: running ? 'DNSBL active' : 'DNS blocking is down -- ads and malware unfiltered',
        });
      } else {
        findings.push({
          severity: 'low', category: 'Security Services',
          title: 'pfBlockerNG status unknown',
          detail: 'Not found in service list -- verify manually',
        });
      }

      // Check Suricata
      const suricata = services.find(s =>
        (s.name || s.description || '').toLowerCase().includes('suricata'));
      if (suricata) {
        const running = suricata.status === 'running' || suricata.status === 'active';
        findings.push({
          severity: running ? 'info' : 'high',
          category: 'Security Services',
          title: `Suricata IDS: ${running ? 'running' : 'STOPPED'}`,
          detail: running ? 'Intrusion detection active' : 'IDS is down -- network traffic unmonitored',
        });
      } else {
        findings.push({
          severity: 'low', category: 'Security Services',
          title: 'Suricata IDS status unknown',
          detail: 'Not found in service list -- verify manually',
        });
      }
    } else {
      findings.push({
        severity: 'low', category: 'Security Services',
        title: 'Service status endpoint not available',
        detail: `${svc.error || 'Not supported'} -- manual verification recommended`,
      });
    }
  }

  return findings;
}

async function checkSystemHealth(): Promise<{ findings: Finding[]; cpu: number; memory: number; uptime: number }> {
  const findings: Finding[] = [];
  let cpu = 0, memory = 0, uptime = 0;

  const result = await pfGet<Record<string, number | number[]>>('status/system');
  if (result.ok && result.data) {
    cpu = Number(result.data.cpu_usage ?? (Array.isArray(result.data.cpu_load_avg) ? result.data.cpu_load_avg[0] : 0)) || 0;
    memory = Number(result.data.mem_usage ?? 0) || 0;
    uptime = Number(result.data.uptime ?? 0) || 0;

    if (cpu > 80) {
      findings.push({
        severity: 'medium', category: 'System Health',
        title: `CPU at ${cpu.toFixed(0)}%`,
        detail: 'High CPU load -- check for Suricata rule processing or pfBlockerNG updates',
      });
    }
    if (memory > 85) {
      findings.push({
        severity: 'medium', category: 'System Health',
        title: `Memory at ${memory.toFixed(0)}%`,
        detail: 'High memory usage -- check state table size',
      });
    }
  }

  return { findings, cpu, memory, uptime };
}

function checkConfigDrift(): Finding[] {
  const findings: Finding[] = [];

  const projectFile = path.join(VAULT_PATH, 'Projects', 'Home Network Overhaul', 'Home Network Overhaul.md');
  if (!fs.existsSync(projectFile)) {
    findings.push({
      severity: 'info', category: 'Config Drift',
      title: 'No project file found for comparison',
      detail: 'Skipping config drift check -- create Projects/Home Network Overhaul/ to enable',
    });
    return findings;
  }

  try {
    const content = fs.readFileSync(projectFile, 'utf-8');

    // Check for decision log entries
    const hasDecisions = content.includes('## Decision Log') || content.includes('## Decisions');
    if (!hasDecisions) {
      findings.push({
        severity: 'info', category: 'Config Drift',
        title: 'No decision log in project file',
        detail: 'Add a Decision Log section to enable drift detection',
      });
    } else {
      findings.push({
        severity: 'info', category: 'Config Drift',
        title: 'Decision log present',
        detail: 'Manual review recommended -- automated drift detection requires structured decision format',
      });
    }
  } catch {
    findings.push({
      severity: 'low', category: 'Config Drift',
      title: 'Could not read project file',
      detail: 'File exists but is unreadable',
    });
  }

  return findings;
}

// -- Helpers ----------------------------------------------------------------

function formatUptime(seconds: number): string {
  if (seconds <= 0) return 'unknown';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

// -- Main -------------------------------------------------------------------

async function run(): Promise<void> {
  const reportDate = new Date().toISOString().split('T')[0];
  console.log(`Network config audit for ${reportDate}...`);

  // Load credentials
  if (!loadPfSenseCredentials()) {
    console.error('No pfSense API key found. Check bots/network/.env or .env.age');
    console.error('Audit cannot run without API credentials.');
    return;
  }

  console.log(`  Connecting to ${pfHost}...`);

  // Run all checks
  const connectFindings = await checkConnectivity();
  if (connectFindings.some(f => f.severity === 'critical')) {
    console.error('  pfSense unreachable -- aborting audit');
    // Still write a report noting the failure
    const findings = connectFindings;
    writeReport(reportDate, findings, null);
    return;
  }

  const [
    { findings: ifaceFindings, interfaces },
    firewallFindings,
    { findings: dhcpFindings, pools },
    serviceFindings,
    { findings: healthFindings, cpu, memory, uptime },
  ] = await Promise.all([
    checkInterfaces(),
    checkFirewallRules(),
    checkDhcpPools(),
    checkServices(),
    checkSystemHealth(),
  ]);

  const driftFindings = checkConfigDrift();

  const allFindings = [
    ...connectFindings,
    ...ifaceFindings,
    ...firewallFindings,
    ...dhcpFindings,
    ...serviceFindings,
    ...healthFindings,
    ...driftFindings,
  ];

  // Summary
  const highCount = allFindings.filter(f => f.severity === 'high' || f.severity === 'critical').length;
  const medCount = allFindings.filter(f => f.severity === 'medium').length;
  console.log(`  ${allFindings.length} findings (${highCount} high, ${medCount} medium)`);
  console.log(`  System: CPU ${cpu.toFixed(0)}%, Memory ${memory.toFixed(0)}%, Uptime ${formatUptime(uptime)}`);
  console.log(`  Interfaces: ${interfaces.length}, DHCP pools: ${pools.length}`);

  writeReport(reportDate, allFindings, { interfaces, pools, cpu, memory, uptime });
}

function writeReport(
  reportDate: string,
  findings: Finding[],
  data: {
    interfaces: Array<{ name: string; status: string; description?: string }>;
    pools: Array<{ iface: string; leases: number }>;
    cpu: number;
    memory: number;
    uptime: number;
  } | null,
): void {
  const status = findings.some(f => f.severity === 'high' || f.severity === 'critical') ? 'flagged' : 'clean';

  let md = `---
type: audit
tags: [audit, network-config, pfsense]
created: ${reportDate}
status: ${status}
---

# Network Config Audit - ${reportDate}

`;

  if (data) {
    md += `## System Health
| Metric | Value |
|--------|-------|
| CPU | ${data.cpu.toFixed(0)}% |
| Memory | ${data.memory.toFixed(0)}% |
| Uptime | ${formatUptime(data.uptime)} |

## Interfaces
| Interface | Status | Description |
|-----------|--------|-------------|
`;

    if (data.interfaces.length === 0) {
      md += `| (none detected) | - | - |\n`;
    } else {
      for (const iface of data.interfaces) {
        md += `| ${iface.name} | ${iface.status} | ${iface.description || '-'} |\n`;
      }
    }

    md += `
## Expected VLANs
| Tag | Name | Isolation | Verified |
|-----|------|-----------|----------|
`;

    for (const vlan of EXPECTED_VLANS) {
      md += `| ${vlan.tag} | ${vlan.name} | ${vlan.isolation} | Manual |\n`;
    }

    if (data.pools.length > 0) {
      md += `
## DHCP Pools
| Interface | Active Leases |
|-----------|---------------|
`;
      for (const pool of data.pools) {
        md += `| ${pool.iface} | ${pool.leases} |\n`;
      }
    }
  }

  // Group findings by category
  const categories = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!categories.has(f.category)) categories.set(f.category, []);
    categories.get(f.category)!.push(f);
  }

  md += `
## Findings by Category
`;

  for (const [category, catFindings] of categories) {
    md += `\n### ${category}\n`;
    for (const f of catFindings) {
      const icon = f.severity === 'critical' || f.severity === 'high' ? 'FLAG'
        : f.severity === 'medium' ? 'WARN'
        : f.severity === 'info' ? 'INFO' : 'NOTE';
      md += `- [${icon}] ${f.title}: ${f.detail}\n`;
    }
  }

  md += `
## Flags
`;

  const actionable = findings.filter(f => f.severity !== 'info');
  if (actionable.length === 0) {
    md += `No flags - all clear.\n`;
  } else {
    for (const f of actionable) {
      md += `- [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}\n`;
    }
  }

  // Write to vault
  const outputDir = path.join(VAULT_PATH, 'Audits', 'Network Config');
  const outputPath = path.join(outputDir, `${reportDate} - Network Config.md`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, md, 'utf-8');
  console.log(`Report written to: ${outputPath}`);

  // Vault commit
  try {
    execSync(`bash "${VAULT_COMMIT_SCRIPT}" "network config audit - ${reportDate}"`, {
      cwd: VAULT_PATH, stdio: 'pipe', windowsHide: true,
    });
    console.log('Vault commit done.');
  } catch (err) {
    console.error('Vault commit failed (non-fatal):', err);
  }

  console.log('Network config audit complete.');

  if (process.argv.includes('--notify')) {
    const actionable = findings.filter(f => f.severity !== 'info');
    if (actionable.length > 0) {
      const crits = actionable.filter(f => f.severity === 'critical' || f.severity === 'high').length;
      const warns = actionable.filter(f => f.severity === 'medium').length;
      notify(`Network Config: ${crits} critical/high, ${warns} medium. ${actionable.length} total flags.`);
    } else {
      notify('Network Config: all clear.');
    }
  }
}

// -- CLI entry point --------------------------------------------------------

run().catch(err => {
  console.error('Network config audit failed:', err);
  process.exit(1);
});
