/**
 * Google OAuth 2.0 setup CLI -- one-time interactive setup for Gmail + Calendar.
 *
 * Usage:
 *   node dist/google-auth-setup.js           -- full setup (generate URL, exchange code)
 *   node dist/google-auth-setup.js --refresh  -- force-refresh existing tokens
 *   node dist/google-auth-setup.js --status   -- check current auth status
 *
 * Prerequisites:
 *   - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set in .env
 *   - GOOGLE_REDIRECT_URI in .env (defaults to urn:ietf:wg:oauth:2.0:oob for CLI flow)
 */

import * as readline from 'readline';

import {
  generateAuthUrl,
  handleAuthCallback,
  refreshTokens,
  isAuthenticated,
  googleCapabilities,
  GOOGLE_SCOPES,
} from './google-auth.js';
import { logger } from './logger.js';

// ── Helpers ──────────────────────────────────────────────────────────

function print(msg: string): void {
  process.stdout.write(msg + '\n');
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Commands ─────────────────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const caps = googleCapabilities();
  print('');
  print('Google OAuth Status');
  print('-------------------');
  print(`Configured (client ID/secret): ${caps.configured ? 'YES' : 'NO'}`);
  print(`Authenticated (tokens saved):  ${caps.authenticated ? 'YES' : 'NO'}`);
  if (caps.features.length > 0) {
    print(`Active scopes: ${caps.features.join(', ')}`);
  }
  print('');
}

async function doRefresh(): Promise<void> {
  print('');
  print('Refreshing Google OAuth tokens...');

  const success = await refreshTokens();
  if (success) {
    print('Tokens refreshed successfully.');
  } else {
    print('Token refresh failed. You may need to re-run full setup.');
    process.exitCode = 1;
  }
  print('');
}

async function doSetup(): Promise<void> {
  print('');
  print('Google OAuth 2.0 Setup');
  print('======================');
  print('');

  // Check if already authenticated
  if (isAuthenticated()) {
    print('You already have saved tokens.');
    const answer = await prompt('Re-authorize? This will replace existing tokens. (y/N): ');
    if (answer.toLowerCase() !== 'y') {
      print('Aborted.');
      return;
    }
    print('');
  }

  // Generate auth URL
  const url = generateAuthUrl(GOOGLE_SCOPES);
  if (!url) {
    print('ERROR: Cannot generate auth URL.');
    print('Make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in .env');
    process.exitCode = 1;
    return;
  }

  print('Step 1: Open this URL in your browser and grant access:');
  print('');
  print(url);
  print('');

  // Get the authorization code
  const code = await prompt('Step 2: Paste the authorization code here: ');
  if (!code) {
    print('No code entered. Aborted.');
    process.exitCode = 1;
    return;
  }

  print('');
  print('Exchanging code for tokens...');

  const success = await handleAuthCallback(code);
  if (success) {
    print('');
    print('Setup complete. Google OAuth tokens saved and encrypted.');
    print('Gmail and Calendar APIs are now available.');
  } else {
    print('');
    print('Setup failed. Check the logs for details.');
    process.exitCode = 1;
  }
  print('');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    await showStatus();
  } else if (args.includes('--refresh')) {
    await doRefresh();
  } else {
    await doSetup();
  }
}

main().catch(err => {
  logger.error({ err: String(err) }, 'Google auth setup failed');
  process.exitCode = 1;
});
