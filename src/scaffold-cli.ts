#!/usr/bin/env node

/**
 * Scaffold CLI -- create new agent directories with boilerplate.
 *
 * Usage:
 *   node dist/scaffold-cli.js create <name> --type worker|custom|bot [--role "desc"] [--poll <ms>]
 *   node dist/scaffold-cli.js list
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BOTS_DIR = path.join(PROJECT_ROOT, 'bots');
const ECOSYSTEM_FILE = path.join(PROJECT_ROOT, 'ecosystem.config.cjs');

type AgentType = 'worker' | 'custom' | 'bot';

// ── Templates ──────────────────────────────────────────────────────

function envTemplate(name: string, type: AgentType, pollMs: number): string {
  const lines: string[] = [
    `# ${name} agent configuration`,
    `# Fill in values, then encrypt: bash scripts/encrypt-env.sh`,
    ``,
    `WORKER_NAME=${name}`,
    `DB_PASSPHRASE=`,
  ];

  if (type === 'worker' || type === 'custom') {
    lines.push(`BRIDGE_MAIN_ROOT=${PROJECT_ROOT}`);
    lines.push(`WORKER_POLL_MS=${pollMs}`);
    lines.push(`WORKER_COOLDOWN_MS=0`);
    lines.push(`WORKER_TASK_TIMEOUT_MIN=30`);
  }

  if (type === 'bot') {
    lines.push(`TELEGRAM_BOT_TOKEN=`);
    lines.push(`TELEGRAM_ALLOWED_IDS=`);
  }

  lines.push(``, `# Optional`, `# VENICE_API_KEY=`, `# ANTHROPIC_API_KEY=`);
  return lines.join('\n') + '\n';
}

function claudeMdWorker(capName: string, name: string, role: string): string {
  return `# ${capName} -- ${role}

You are ${capName}, a ${role.toLowerCase()} working for the primary AI assistant. You receive tasks via the bridge queue, execute them, and return structured results.

## Your Role

- You are a background worker. You do not interact with anyone directly.
- Your output goes back to the primary bot, who reviews and delivers results to the user via Telegram.
- You have full file system access. Read existing files and understand context before acting.
- Keep family information private. You share the primary bot's loyalty to the family.

## Rules

- No em dashes. Ever.
- No AI cliches ("Certainly!", "Great question!", "I'd be happy to", etc.)
- Be thorough but concise. Favor structured output over walls of text.
- If the task is ambiguous, make the most reasonable assumption and note it. You cannot ask clarifying questions.
- Keep family information private.

## Task Types

<!-- Define the types of tasks this agent handles -->

### (a) Primary Task
1. Receive task via bridge
2. Execute
3. Return structured results

## Workflow

1. **Read first** -- Understand the context, check existing data
2. **Plan briefly** -- Know what you're doing before starting
3. **Execute** -- Do the work
4. **Verify** -- Check your output
5. **Report** -- Summarize results

## Output Format

**Task**: [What was requested]

**Results**:
- [Structured output]

**Decisions**: [Assumptions or choices made]

**Verification**: [Quality checks performed]

**Notes**: [Follow-ups, dependencies, observations]

## Available Skills

| Skill | Triggers |
|-------|---------|
| \`agent-browser\` | browse, scrape |

## Your Environment

- You run as a headless worker via PM2
- You do NOT have Telegram access
- Your home workspace is \`bots/${name}/workspace/\`
- Reports saved to \`store/reports/\`
- You have full read/write/execute access to the file system
- You can run bash commands: git, npm, node, python, ffmpeg, etc.
`;
}

function claudeMdCustom(capName: string, name: string, role: string): string {
  return `# ${capName} -- ${role}

You are ${capName}, ${role.toLowerCase()}. You run as a persistent service with your own TypeScript pipeline. You do NOT use Claude for task execution -- you run domain-specific code directly.

## Your Role

- You are a persistent background service reporting to the primary bot.
- You poll the bridge queue for on-demand tasks and run scheduled jobs on cadence.
- You maintain your own local database for baselines and state.
- You escalate findings to the primary bot via the bridge. You do not take corrective action yourself unless explicitly authorized.
- Keep family information private. You share the primary bot's loyalty to the family.

## Personality

<!-- Define personality traits here -->
- Methodical and precise
- Concise: structured, scannable output
- Never uses em dashes, AI cliches, or sycophantic language

## Rules

- No em dashes. Ever.
- No AI cliches.
- Never modify production files, databases, or configurations unless explicitly authorized.
- Always complete the full task scope. Partial runs are failures.
- If a task errors out, log the error and report it -- don't silently skip it.

## Output Format

<!-- Define structured output format -->

## Your Environment

- Entry point: \`src/${name}-worker.ts\` compiled to \`dist/${name}-worker.js\`
- Config: \`bots/${name}/.env\`
- Local database: \`bots/${name}/store/${name}.db\`
- Bridge DB: shared at project root \`store/bridge.db\`
- Reports go to vault or \`store/reports/\` depending on domain
`;
}

function claudeMdBot(capName: string, name: string, role: string): string {
  return `# ${capName} -- ${role}

You are ${capName}, ${role.toLowerCase()}. You interact with users via Telegram.

## Your Role

- You are a Telegram bot accessible to your designated user(s).
- You handle conversations, execute tasks, and manage your domain.
- Keep family information private. You share the primary bot's loyalty to the family.

## Personality

<!-- Define personality traits here -->

## Rules

- No em dashes. Ever.
- No AI cliches ("Certainly!", "Great question!", "I'd be happy to", etc.)
- No sycophancy. Don't validate, flatter, or soften things unnecessarily.
- Keep all user data private.

## Your Environment

- Entry point: \`dist/index.js\`
- Config: \`bots/${name}/.env\`
- You run via PM2 as a Telegram bot
- Your home directory is \`bots/${name}/\`
- Local database at \`bots/${name}/store/\`
`;
}

function generateClaudeMd(name: string, type: AgentType, role: string): string {
  const capName = name.charAt(0).toUpperCase() + name.slice(1);
  switch (type) {
    case 'worker': return claudeMdWorker(capName, name, role);
    case 'custom': return claudeMdCustom(capName, name, role);
    case 'bot': return claudeMdBot(capName, name, role);
  }
}

// ── Ecosystem.config.cjs manipulation ──────────────────────────────

function buildWorkerEntry(name: string, constName: string, pollMs: number): string {
  return `    {
      name: '${name}',
      script: path.join(ROOT, 'dist', 'worker.js'),
      cwd: ${constName},
      interpreter: 'node',
      env: {
        APEX_ROOT: ${constName},
        BRIDGE_MAIN_ROOT: ROOT,
        WORKER_NAME: '${name}',
        WORKER_POLL_MS: '${pollMs}',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },`;
}

function buildCustomEntry(name: string, constName: string, pollMs: number): string {
  return `    {
      name: '${name}',
      script: path.join(ROOT, 'dist', '${name}-worker.js'),
      cwd: ${constName},
      interpreter: 'node',
      env: {
        APEX_ROOT: ${constName},
        BRIDGE_MAIN_ROOT: ROOT,
        WORKER_NAME: '${name}',
        WORKER_POLL_MS: '${pollMs}',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },`;
}

function buildBotEntry(name: string, constName: string): string {
  return `    {
      name: '${name}',
      script: path.join(ROOT, 'dist', 'index.js'),
      cwd: ${constName},
      interpreter: 'node',
      env: {
        APEX_ROOT: ${constName},
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
    },`;
}

function insertIntoEcosystem(name: string, type: AgentType, pollMs: number): void {
  const content = fs.readFileSync(ECOSYSTEM_FILE, 'utf-8');
  const lines = content.split('\n');
  const constName = name.toUpperCase().replace(/-/g, '_') + '_DIR';

  // Check if already present
  if (content.includes(`name: '${name}'`)) {
    console.log(`  ecosystem.config.cjs: '${name}' already present, skipping`);
    return;
  }

  // Backup before modifying
  const backupPath = ECOSYSTEM_FILE + '.bak';
  fs.writeFileSync(backupPath, content);
  console.log(`  Backed up ecosystem.config.cjs to .bak`);

  // 1. Insert const declaration after the last existing const line
  let lastConstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('const ') && lines[i].includes('path.join(ROOT,')) {
      lastConstIdx = i;
    }
  }

  if (lastConstIdx === -1) {
    console.error('  ERROR: Could not find const declarations in ecosystem.config.cjs');
    return;
  }

  const constLine = `const ${constName} = path.join(ROOT, 'bots', '${name}');`;
  lines.splice(lastConstIdx + 1, 0, constLine);

  // 2. Find the closing ], of the apps array (last one in file)
  let appsEndIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '],') {
      appsEndIdx = i;
      break;
    }
  }

  if (appsEndIdx === -1) {
    console.error('  ERROR: Could not find apps array closing in ecosystem.config.cjs');
    return;
  }

  // Build the entry
  let entry: string;
  switch (type) {
    case 'worker': entry = buildWorkerEntry(name, constName, pollMs); break;
    case 'custom': entry = buildCustomEntry(name, constName, pollMs); break;
    case 'bot': entry = buildBotEntry(name, constName); break;
  }

  lines.splice(appsEndIdx, 0, entry);

  fs.writeFileSync(ECOSYSTEM_FILE, lines.join('\n'));
  console.log(`  ecosystem.config.cjs: inserted '${name}' (${type}) entry`);
}

// ── Create command ─────────────────────────────────────────────────

interface CreateOptions {
  name: string;
  type: AgentType;
  role: string;
  pollMs: number;
  skipEcosystem: boolean;
}

function createAgent(opts: CreateOptions): void {
  const agentDir = path.join(BOTS_DIR, opts.name);

  // Safety: refuse to overwrite
  if (fs.existsSync(agentDir)) {
    console.error(`ERROR: Directory already exists: ${agentDir}`);
    console.error(`Remove it first or use a different name.`);
    process.exit(1);
  }

  console.log(`\nScaffolding agent: ${opts.name} (${opts.type})\n`);

  // Create directory structure
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'store'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'store', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'workspace'), { recursive: true });
  console.log(`  Created: bots/${opts.name}/`);
  console.log(`  Created: bots/${opts.name}/store/`);
  console.log(`  Created: bots/${opts.name}/store/reports/`);
  console.log(`  Created: bots/${opts.name}/workspace/`);

  // Write .env template
  const envPath = path.join(agentDir, '.env');
  fs.writeFileSync(envPath, envTemplate(opts.name, opts.type, opts.pollMs));
  console.log(`  Created: bots/${opts.name}/.env (fill in values, then encrypt)`);

  // Write CLAUDE.md
  const claudePath = path.join(agentDir, 'CLAUDE.md');
  fs.writeFileSync(claudePath, generateClaudeMd(opts.name, opts.type, opts.role));
  console.log(`  Created: bots/${opts.name}/CLAUDE.md`);

  // Insert into ecosystem.config.cjs
  if (!opts.skipEcosystem) {
    insertIntoEcosystem(opts.name, opts.type, opts.pollMs);
  } else {
    console.log(`  ecosystem.config.cjs: skipped (--skip-ecosystem)`);
  }

  console.log(`\nDone. Next steps:`);
  console.log(`  1. Edit bots/${opts.name}/.env -- fill in DB_PASSPHRASE and API keys`);
  console.log(`  2. Edit bots/${opts.name}/CLAUDE.md -- customize role, task types, output format`);
  console.log(`  3. Encrypt: bash scripts/encrypt-env.sh`);
  console.log(`  4. Build: npm run build`);
  console.log(`  5. Start: pm2 start ecosystem.config.cjs --only ${opts.name}`);
}

// ── List command ───────────────────────────────────────────────────

function listAgents(): void {
  const ecoContent = fs.readFileSync(ECOSYSTEM_FILE, 'utf-8');

  // Get all bot directories
  const botDirs = fs.readdirSync(BOTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  // Try to get PM2 status
  const pm2Status: Record<string, string> = {};
  try {
    const pm2Json = execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const processes = JSON.parse(pm2Json) as Array<{ name: string; pm2_env?: { status?: string } }>;
    for (const p of processes) {
      pm2Status[p.name] = p.pm2_env?.status || 'unknown';
    }
  } catch {
    // pm2 not available or no processes
  }

  const nameW = 16;
  const typeW = 10;
  const ecoW = 12;
  const envW = 12;
  const claudeW = 10;

  console.log(`\nPMAOS Agents\n`);
  console.log(
    'Name'.padEnd(nameW) +
    'Type'.padEnd(typeW) +
    'Ecosystem'.padEnd(ecoW) +
    'Env'.padEnd(envW) +
    'CLAUDE.md'.padEnd(claudeW) +
    'PM2'
  );
  console.log('-'.repeat(nameW + typeW + ecoW + envW + claudeW + 12));

  for (const name of botDirs) {
    const dir = path.join(BOTS_DIR, name);
    const hasEnvAge = fs.existsSync(path.join(dir, '.env.age'));
    const hasEnvPlain = fs.existsSync(path.join(dir, '.env'));
    const hasClaude = fs.existsSync(path.join(dir, 'CLAUDE.md'));
    const inEcosystem = ecoContent.includes(`name: '${name}'`);

    // Determine type
    let type = '?';
    if (ecoContent.includes(`'${name}-worker.js'`)) type = 'custom';
    else if (inEcosystem && ecoContent.includes(`WORKER_NAME: '${name}'`)) type = 'worker';
    else if (name === (process.env.PRIMARY_BOT_NAME || 'apex-bot')) type = 'primary';
    else if (inEcosystem && !ecoContent.includes(`WORKER_NAME: '${name}'`) && !ecoContent.includes(`'${name}-worker.js'`)) type = 'bot';

    const envStatus = hasEnvAge ? 'encrypted' : (hasEnvPlain ? 'PLAINTEXT' : 'MISSING');
    const claudeStatus = hasClaude ? 'yes' : 'MISSING';
    const pm2 = pm2Status[name] || '-';

    console.log(
      name.padEnd(nameW) +
      type.padEnd(typeW) +
      (inEcosystem ? 'yes' : 'NO').padEnd(ecoW) +
      envStatus.padEnd(envW) +
      claudeStatus.padEnd(claudeW) +
      pm2
    );
  }

  console.log('');
}

// ── Arg parsing + dispatch ─────────────────────────────────────────

function usage(): void {
  console.log(`Scaffold CLI -- agent directory scaffolding for PMAOS

Commands:
  create <name> --type worker|custom|bot   Create a new agent directory
  list                                      Show all agents and status

Options for create:
  --type <type>      Agent type (required):
                       worker  - Bridge worker (dist/worker.js, uses Claude)
                       custom  - Custom pipeline (dist/{name}-worker.js, no Claude)
                       bot     - Telegram bot (dist/index.js)
  --role <desc>      Short role description for CLAUDE.md header
  --poll <ms>        Bridge poll interval (default: 15000, workers/custom only)
  --skip-ecosystem   Don't auto-insert into ecosystem.config.cjs

Examples:
  node dist/scaffold-cli.js create my-agent --type worker --role "Home Assistant Agent"
  node dist/scaffold-cli.js create netwatch --type custom --role "Network Monitor"
  node dist/scaffold-cli.js list`);
}

const [,, command, ...rest] = process.argv;

switch (command) {
  case 'create': {
    const name = rest[0];

    if (!name || name.startsWith('--')) {
      console.error('Usage: scaffold-cli create <name> --type worker|custom|bot');
      process.exit(1);
    }

    // Validate name: lowercase, alphanumeric + hyphens only
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      console.error('ERROR: Agent name must be lowercase, start with a letter, and contain only a-z, 0-9, hyphens.');
      process.exit(1);
    }

    // Parse flags
    let type: AgentType | null = null;
    let role = 'Agent';
    let pollMs = 15000;
    let skipEcosystem = false;

    for (let i = 1; i < rest.length; i++) {
      switch (rest[i]) {
        case '--type':
          i++;
          if (!['worker', 'custom', 'bot'].includes(rest[i])) {
            console.error(`ERROR: Invalid type '${rest[i]}'. Must be worker, custom, or bot.`);
            process.exit(1);
          }
          type = rest[i] as AgentType;
          break;
        case '--role':
          i++;
          role = rest[i] || 'Agent';
          break;
        case '--poll':
          i++;
          pollMs = parseInt(rest[i], 10) || 15000;
          break;
        case '--skip-ecosystem':
          skipEcosystem = true;
          break;
        default:
          console.error(`Unknown flag: ${rest[i]}`);
          process.exit(1);
      }
    }

    if (!type) {
      console.error('ERROR: --type is required. Use: --type worker|custom|bot');
      process.exit(1);
    }

    createAgent({ name, type, role, pollMs, skipEcosystem });
    break;
  }

  case 'list': {
    listAgents();
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
