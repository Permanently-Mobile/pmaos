/**
 * Google OAuth 2.0 client -- handles authentication for Gmail + Calendar APIs.
 *
 * Stores tokens in store/google-tokens.json, encrypted at rest using
 * DB_PASSPHRASE (AES-256-GCM with scrypt-derived key).
 *
 * One-time setup flow:
 *   1. generateAuthUrl(scopes) -> user visits URL, grants consent
 *   2. handleAuthCallback(code) -> exchanges code for tokens, saves encrypted
 *
 * After setup, getAuthClient() returns an authenticated OAuth2 client
 * that auto-refreshes tokens as needed.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

// ── Constants ────────────────────────────────────────────────────────

const TOKEN_FILE = path.join(STORE_DIR, 'google-tokens.json');
const SCRYPT_SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const SCRYPT_KEYLEN = 32;

/** All scopes needed for Gmail + Calendar integration. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

// ── Types ────────────────────────────────────────────────────────────

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

// ── Encryption helpers ───────────────────────────────────────────────

function getPassphrase(): string | null {
  const env = readEnvFile(['DB_PASSPHRASE']);
  return env.DB_PASSPHRASE || null;
}

function encrypt(plaintext: string, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const key = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt (16) + iv (12) + authTag (16) + ciphertext
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decrypt(data: Buffer, passphrase: string): string {
  const salt = data.subarray(0, SCRYPT_SALT_LEN);
  const iv = data.subarray(SCRYPT_SALT_LEN, SCRYPT_SALT_LEN + IV_LEN);
  const authTag = data.subarray(
    SCRYPT_SALT_LEN + IV_LEN,
    SCRYPT_SALT_LEN + IV_LEN + AUTH_TAG_LEN,
  );
  const ciphertext = data.subarray(SCRYPT_SALT_LEN + IV_LEN + AUTH_TAG_LEN);

  const key = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ── Token storage ────────────────────────────────────────────────────

function saveTokens(tokens: StoredTokens): void {
  const json = JSON.stringify(tokens);
  const passphrase = getPassphrase();

  if (passphrase) {
    const encrypted = encrypt(json, passphrase);
    fs.writeFileSync(TOKEN_FILE, encrypted, { mode: 0o600 });
    logger.info('Google tokens saved (encrypted)');
  } else {
    // No passphrase -- store plaintext with a warning
    logger.warn('No DB_PASSPHRASE set -- Google tokens stored UNENCRYPTED');
    fs.writeFileSync(TOKEN_FILE, json, { encoding: 'utf-8', mode: 0o600 });
  }
}

function loadTokens(): StoredTokens | null {
  if (!fs.existsSync(TOKEN_FILE)) return null;

  try {
    const raw = fs.readFileSync(TOKEN_FILE);
    const passphrase = getPassphrase();

    let json: string;
    if (passphrase) {
      try {
        json = decrypt(raw, passphrase);
      } catch {
        // Check if it looks like valid JSON plaintext (migration from pre-encryption)
        const rawStr = raw.toString('utf-8').trim();
        if (rawStr.startsWith('{') && rawStr.endsWith('}')) {
          logger.warn('Google tokens appear plaintext despite DB_PASSPHRASE being set -- re-encrypting');
          json = rawStr;
          // Re-encrypt in place so next load is clean
          try {
            const reEncrypted = encrypt(rawStr, passphrase);
            fs.writeFileSync(TOKEN_FILE, reEncrypted, { mode: 0o600 });
          } catch { /* best-effort re-encrypt */ }
        } else {
          logger.error('Google tokens decryption failed and file is not plaintext JSON -- tokens corrupt');
          return null;
        }
      }
    } else {
      json = raw.toString('utf-8');
    }

    const parsed = JSON.parse(json) as StoredTokens;
    if (!parsed.access_token || !parsed.refresh_token) {
      logger.warn('Google tokens file exists but is missing required fields');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error({ err: String(err) }, 'Failed to load Google tokens');
    return null;
  }
}

// ── Refresh mutex ────────────────────────────────────────────────────

let _refreshPromise: Promise<boolean> | null = null;

// ── OAuth2 client ────────────────────────────────────────────────────

function getOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']);
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

function createOAuth2Client(): OAuth2Client | null {
  const config = getOAuthConfig();
  if (!config) {
    logger.warn('Google OAuth not configured -- GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing from .env');
    return null;
  }

  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

/**
 * Get an authenticated OAuth2 client ready for API calls.
 * Returns null if not configured or no tokens available.
 * Automatically refreshes expired tokens and persists them.
 */
export async function getAuthClient(): Promise<OAuth2Client | null> {
  const client = createOAuth2Client();
  if (!client) return null;

  const tokens = loadTokens();
  if (!tokens) {
    logger.warn('No Google tokens found -- run google-auth-setup first');
    return null;
  }

  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date,
  });

  // Auto-refresh if expired (or within 5 min of expiry)
  const now = Date.now();
  if (tokens.expiry_date && tokens.expiry_date - now < 5 * 60 * 1000) {
    try {
      const refreshed = await refreshTokens(client);
      if (refreshed) {
        logger.info('Google tokens auto-refreshed');
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to auto-refresh Google tokens');
      // Return the client anyway -- the API call might still work
    }
  }

  return client;
}

/**
 * Refresh tokens using the OAuth2 client's refresh token.
 * Persists the new tokens on success.
 * Returns true if refresh succeeded.
 */
export async function refreshTokens(client?: OAuth2Client | null): Promise<boolean> {
  // Coalesce concurrent refresh calls to prevent race condition
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = _doRefreshTokens(client).finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

async function _doRefreshTokens(client?: OAuth2Client | null): Promise<boolean> {
  try {
    const oauthClient = client || createOAuth2Client();
    if (!oauthClient) return false;

    // If no client passed, load existing tokens
    if (!client) {
      const tokens = loadTokens();
      if (!tokens) return false;
      oauthClient.setCredentials({
        refresh_token: tokens.refresh_token,
      });
    }

    const { credentials } = await oauthClient.refreshAccessToken();

    // Merge with existing tokens (refresh_token might not be returned on refresh)
    const existing = loadTokens();
    const merged: StoredTokens = {
      access_token: credentials.access_token || existing?.access_token || '',
      refresh_token: credentials.refresh_token || existing?.refresh_token || '',
      scope: credentials.scope || existing?.scope || '',
      token_type: credentials.token_type || existing?.token_type || 'Bearer',
      expiry_date: credentials.expiry_date || existing?.expiry_date || 0,
    };

    saveTokens(merged);
    oauthClient.setCredentials(credentials);
    return true;
  } catch (err) {
    logger.error({ err: String(err) }, 'Google token refresh failed');
    return false;
  }
}

/**
 * Check if Google OAuth is configured and has valid tokens.
 */
export function isAuthenticated(): boolean {
  const config = getOAuthConfig();
  if (!config) return false;

  const tokens = loadTokens();
  if (!tokens) return false;

  return !!(tokens.access_token && tokens.refresh_token);
}

/**
 * Generate the OAuth consent URL for initial setup.
 * User visits this URL, grants access, receives a code.
 */
export function generateAuthUrl(scopes?: string[]): string | null {
  const client = createOAuth2Client();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes || GOOGLE_SCOPES,
  });
}

/**
 * Exchange the authorization code from consent flow for tokens.
 * Saves tokens encrypted to disk.
 */
export async function handleAuthCallback(code: string): Promise<boolean> {
  const client = createOAuth2Client();
  if (!client) {
    logger.error('Cannot handle auth callback -- OAuth not configured');
    return false;
  }

  try {
    const { tokens } = await client.getToken(code);

    const stored: StoredTokens = {
      access_token: tokens.access_token || '',
      refresh_token: tokens.refresh_token || '',
      scope: tokens.scope || '',
      token_type: tokens.token_type || 'Bearer',
      expiry_date: tokens.expiry_date || 0,
    };

    if (!stored.refresh_token) {
      logger.warn('No refresh_token received -- you may need to revoke and re-authorize');
    }

    saveTokens(stored);
    logger.info('Google OAuth tokens saved successfully');
    return true;
  } catch (err) {
    logger.error({ err: String(err) }, 'Failed to exchange auth code for tokens');
    return false;
  }
}

/**
 * Get Google API capabilities status.
 */
export function googleCapabilities(): {
  configured: boolean;
  authenticated: boolean;
  features: string[];
} {
  const config = getOAuthConfig();
  const hasTokens = isAuthenticated();

  return {
    configured: !!config,
    authenticated: hasTokens,
    features: hasTokens
      ? ['gmail.readonly', 'gmail.modify', 'gmail.send', 'calendar.readonly', 'calendar.events']
      : [],
  };
}
