#!/usr/bin/env node
/**
 * Vault Encryption Tool
 *
 * Encrypts/decrypts Obsidian vault files using AES-256-GCM.
 * Each file is individually encrypted with a unique IV.
 * The encryption key is derived from a passphrase using PBKDF2.
 *
 * Encrypted files get a .enc extension. Original files are securely deleted.
 * The .obsidian config folder is preserved unencrypted so Obsidian can still open the vault.
 *
 * Usage:
 *   node vault-crypt.mjs lock <vault-path> [--passphrase <pass>]
 *   node vault-crypt.mjs unlock <vault-path> [--passphrase <pass>]
 *   node vault-crypt.mjs status <vault-path>
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const SALT_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITERATIONS = 600000;
const ENCRYPTED_EXT = '.enc';
const LOCK_FILE = '.vault-locked';

// Folders/files to never encrypt
const SKIP_PATTERNS = [
  '.obsidian',
  '.vault-locked',
  '.vault-salt',
  'node_modules',
  '.git',
];

function shouldSkip(relativePath) {
  const parts = relativePath.split(path.sep);
  return SKIP_PATTERNS.some(p => parts[0] === p || relativePath === p);
}

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha512');
}

function encryptFile(filePath, key) {
  const plaintext = fs.readFileSync(filePath);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: [IV (16)] [AuthTag (16)] [Ciphertext]
  const output = Buffer.concat([iv, authTag, encrypted]);
  const encPath = filePath + ENCRYPTED_EXT;
  fs.writeFileSync(encPath, output);

  // Overwrite original before deleting (basic secure delete)
  const zeros = Buffer.alloc(plaintext.length, 0);
  fs.writeFileSync(filePath, zeros);
  fs.unlinkSync(filePath);

  return encPath;
}

function decryptFile(encPath, key) {
  const data = fs.readFileSync(encPath);

  const iv = data.subarray(0, IV_LEN);
  const authTag = data.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + AUTH_TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const originalPath = encPath.slice(0, -ENCRYPTED_EXT.length);
  fs.writeFileSync(originalPath, decrypted);
  fs.unlinkSync(encPath);

  return originalPath;
}

function walkDir(dir, basePath = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (shouldSkip(relativePath)) continue;

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, basePath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function getPassphrase(args) {
  const idx = args.indexOf('--passphrase');
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }

  // Check environment variable
  if (process.env.VAULT_PASSPHRASE) {
    return process.env.VAULT_PASSPHRASE;
  }

  // Prompt interactively
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question('Vault passphrase: ', answer => {
      rl.close();
      resolve(answer);
    });
  });
}

function getSalt(vaultPath) {
  const saltFile = path.join(vaultPath, '.vault-salt');
  if (fs.existsSync(saltFile)) {
    return fs.readFileSync(saltFile);
  }
  const salt = crypto.randomBytes(SALT_LEN);
  fs.writeFileSync(saltFile, salt);
  return salt;
}

function isLocked(vaultPath) {
  return fs.existsSync(path.join(vaultPath, LOCK_FILE));
}

function setLocked(vaultPath, locked) {
  const lockFile = path.join(vaultPath, LOCK_FILE);
  if (locked) {
    fs.writeFileSync(lockFile, JSON.stringify({
      locked_at: new Date().toISOString(),
      files_encrypted: true,
    }));
  } else {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  }
}

// ── Commands ──

async function lock(vaultPath, args) {
  if (isLocked(vaultPath)) {
    console.log('Vault is already locked.');
    process.exit(0);
  }

  const passphrase = await getPassphrase(args);
  if (!passphrase || passphrase.length < 8) {
    console.error('Passphrase must be at least 8 characters.');
    process.exit(1);
  }

  const salt = getSalt(vaultPath);
  const key = deriveKey(passphrase, salt);

  const files = walkDir(vaultPath).filter(f => !f.endsWith(ENCRYPTED_EXT));
  console.log(`Encrypting ${files.length} files...`);

  let encrypted = 0;
  let errors = 0;
  for (const file of files) {
    try {
      encryptFile(file, key);
      encrypted++;
    } catch (err) {
      console.error(`Failed to encrypt: ${path.relative(vaultPath, file)} - ${err.message}`);
      errors++;
    }
  }

  setLocked(vaultPath, true);
  console.log(`Vault locked. ${encrypted} files encrypted, ${errors} errors.`);
}

async function unlock(vaultPath, args) {
  if (!isLocked(vaultPath)) {
    console.log('Vault is already unlocked.');
    process.exit(0);
  }

  const passphrase = await getPassphrase(args);
  const salt = getSalt(vaultPath);
  const key = deriveKey(passphrase, salt);

  const files = walkDir(vaultPath).filter(f => f.endsWith(ENCRYPTED_EXT));
  console.log(`Decrypting ${files.length} files...`);

  let decrypted = 0;
  let errors = 0;
  for (const file of files) {
    try {
      decryptFile(file, key);
      decrypted++;
    } catch (err) {
      console.error(`Failed to decrypt: ${path.relative(vaultPath, file)} - ${err.message}`);
      errors++;
    }
  }

  if (errors === 0) {
    setLocked(vaultPath, false);
    console.log(`Vault unlocked. ${decrypted} files decrypted.`);
  } else {
    console.error(`Vault unlock incomplete. ${decrypted} decrypted, ${errors} failed. Check passphrase.`);
    process.exit(1);
  }
}

function status(vaultPath) {
  const locked = isLocked(vaultPath);
  const allFiles = walkDir(vaultPath);
  const encFiles = allFiles.filter(f => f.endsWith(ENCRYPTED_EXT));
  const plainFiles = allFiles.filter(f => !f.endsWith(ENCRYPTED_EXT));
  const hasSalt = fs.existsSync(path.join(vaultPath, '.vault-salt'));

  console.log(`Vault: ${vaultPath}`);
  console.log(`Status: ${locked ? 'LOCKED' : 'UNLOCKED'}`);
  console.log(`Salt file: ${hasSalt ? 'present' : 'none (will be created on first lock)'}`);
  console.log(`Encrypted files: ${encFiles.length}`);
  console.log(`Plain files: ${plainFiles.length}`);
  console.log(`Total: ${allFiles.length}`);
}

// ── Main ──

const [,, command, vaultPath, ...rest] = process.argv;

if (!command || !vaultPath) {
  console.log('Usage:');
  console.log('  node vault-crypt.mjs lock <vault-path> [--passphrase <pass>]');
  console.log('  node vault-crypt.mjs unlock <vault-path> [--passphrase <pass>]');
  console.log('  node vault-crypt.mjs status <vault-path>');
  process.exit(1);
}

const resolvedPath = path.resolve(vaultPath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`Vault path not found: ${resolvedPath}`);
  process.exit(1);
}

switch (command) {
  case 'lock':
    await lock(resolvedPath, rest);
    break;
  case 'unlock':
    await unlock(resolvedPath, rest);
    break;
  case 'status':
    status(resolvedPath);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
