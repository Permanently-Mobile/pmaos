const path = require('path');

const ROOT = __dirname;

// Shared env vars inherited by all processes
const SHARED_ENV = {
  VAULT_ROOT: process.env.VAULT_ROOT || path.join(ROOT, '..', 'vault'),
  // Study sessions disabled until bridge.db FOREIGN KEY issue is resolved.
  // Without this, idle workers loop study -> fail -> retry every 15s, burning Venice tokens.
  WORKER_STUDY_ENABLED: 'false',
};

// Bot directory constants -- add one per worker bot
const SECONDARY_BOT_DIR = path.join(ROOT, 'bots', 'secondary-bot');
const RESEARCHER_DIR = path.join(ROOT, 'bots', 'researcher-1');
const PROCESSOR_DIR = path.join(ROOT, 'bots', 'processor-1');
const CODER_DIR = path.join(ROOT, 'bots', 'coder-1');
const CREATIVE_DIR = path.join(ROOT, 'bots', 'creative-1');
// Add more bot directories as needed

module.exports = {
  apps: [
    {
      name: 'paladin',  // Security policy engine -- starts before all other bots
      script: path.join(ROOT, 'dist', 'paladin.js'),
      cwd: ROOT,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        PALADIN_PORT: '3150',
      },
      restart_delay: 2000,
      max_restarts: 10,
      autorestart: true,
      // Paladin starts BEFORE all other bots -- it's the security gate
    },
    {
      // Rename to your primary bot
      name: 'primary-bot',
      script: 'dist/index.js',
      cwd: ROOT,
      interpreter: 'node',
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      env: {
        ...SHARED_ENV,
        MATRIX_ACCESS_TOKEN: '',
        MATRIX_HOMESERVER_URL: '',
      },
    },
    {
      name: 'secondary-bot',
      script: path.join(ROOT, 'dist', 'index.js'),
      cwd: SECONDARY_BOT_DIR,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        APEX_ROOT: SECONDARY_BOT_DIR,
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
    },
    {
      name: 'researcher-1',
      script: path.join(ROOT, 'dist', 'worker.js'),
      cwd: RESEARCHER_DIR,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        APEX_ROOT: RESEARCHER_DIR,
        BRIDGE_MAIN_ROOT: ROOT,
        WORKER_NAME: 'researcher-1',
        WORKER_POLL_MS: '15000',
        WORKER_COOLDOWN_MS: '900000',
        WORKER_SPECIALTIES: 'research,analysis,comparison,deep-dive,market-research',
        WORKER_ROLE: 'Research specialist producing thorough, sourced reports',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },
    {
      name: 'processor-1',
      script: path.join(ROOT, 'dist', 'scribe-worker.js'),
      cwd: PROCESSOR_DIR,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        APEX_ROOT: PROCESSOR_DIR,
        BRIDGE_MAIN_ROOT: ROOT,
        WORKER_NAME: 'processor-1',
        WORKER_POLL_MS: '30000',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },
    {
      name: 'coder-1',
      script: path.join(ROOT, 'dist', 'worker.js'),
      cwd: CODER_DIR,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        APEX_ROOT: CODER_DIR,
        BRIDGE_MAIN_ROOT: ROOT,
        WORKER_NAME: 'coder-1',
        WORKER_POLL_MS: '15000',
        WORKER_SPECIALTIES: 'typescript,nodejs,react,python,infrastructure,devops',
        WORKER_ROLE: 'Code development agent building, refactoring, debugging, and testing production code',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },
    {
      name: 'creative-1',
      script: path.join(ROOT, 'dist', 'worker.js'),
      cwd: CREATIVE_DIR,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        APEX_ROOT: CREATIVE_DIR,
        BRIDGE_MAIN_ROOT: ROOT,
        WORKER_NAME: 'creative-1',
        WORKER_POLL_MS: '15000',
        WORKER_SPECIALTIES: 'copywriting,proposals,social-content,video-scripts,brand-voice,marketing',
        WORKER_ROLE: 'Creative production agent writing ads, proposals, social content, and brand-consistent marketing materials',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },
    // Add additional worker entries as needed. Copy a worker template and customize.
    // Example worker template:
    // {
    //   name: 'worker-name',
    //   script: path.join(ROOT, 'dist', 'worker.js'),
    //   cwd: path.join(ROOT, 'bots', 'worker-name'),
    //   interpreter: 'node',
    //   env: {
    //     ...SHARED_ENV,
    //     APEX_ROOT: path.join(ROOT, 'bots', 'worker-name'),
    //     BRIDGE_MAIN_ROOT: ROOT,
    //     WORKER_NAME: 'worker-name',
    //     WORKER_POLL_MS: '15000',
    //     WORKER_SPECIALTIES: 'specialty1,specialty2',
    //     WORKER_ROLE: 'Description of what this worker does',
    //   },
    //   restart_delay: 5000,
    //   max_restarts: 5,
    //   autorestart: true,
    // },
    {
      name: 'content-board',
      script: path.join(ROOT, 'dist', 'content-board', 'index.js'),
      cwd: ROOT,
      interpreter: 'node',
      env: {
        ...SHARED_ENV,
        APEX_ROOT: ROOT,
        CONTENT_BOARD_PORT: '3210',
      },
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
    },
  ],
};
