import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ── Age decryption config ────────────────────────────────────
// Key file lives outside the project tree for security.
// Age binary: check PATH first, then known winget install location.
const AGE_KEY_FILE = process.env.SOPS_AGE_KEY_FILE
  || path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'sops', 'age', 'keys.txt');

function findAgeBinary(): string | null {
  // Try PATH first (works on Linux, or after Windows PATH update)
  try {
    execSync('age --version', { stdio: 'pipe', windowsHide: true });
    return 'age';
  } catch { /* not in PATH */ }

  // Winget install location (Windows)
  const wingetBase = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
  );
  if (fs.existsSync(wingetBase)) {
    try {
      const dirs = fs.readdirSync(wingetBase).filter(d => d.startsWith('FiloSottile.age'));
      for (const d of dirs) {
        const agePath = path.join(wingetBase, d, 'age', 'age.exe');
        if (fs.existsSync(agePath)) return agePath;
      }
    } catch { /* scan failed */ }
  }

  return null;
}

/**
 * Decrypt a .env.age file in memory using the age CLI.
 * Returns the decrypted content as a string, or null on failure.
 */
export function decryptAgeFile(encFile: string): string | null {
  if (!fs.existsSync(encFile)) return null;
  if (!fs.existsSync(AGE_KEY_FILE)) {
    console.warn(`[env] .env.age found but no age key at ${AGE_KEY_FILE} -- falling back to plaintext .env`);
    return null;
  }

  const ageBin = findAgeBinary();
  if (!ageBin) {
    console.warn('[env] .env.age found but age binary not found -- falling back to plaintext .env');
    return null;
  }

  try {
    const decrypted = execSync(
      `"${ageBin}" -d -i "${AGE_KEY_FILE}" "${encFile}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, windowsHide: true },
    );
    return decrypted;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[env] Failed to decrypt ${encFile}: ${msg}`);
    return null;
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * Security: checks for .env.age (encrypted) first. If found and age key
 * is available, decrypts in memory. Falls back to plaintext .env for
 * backward compatibility and development.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  // Try multiple .env locations: APEX_ROOT (set by PM2), cwd, then script dir
  const candidates = [
    process.env.APEX_ROOT ? path.join(process.env.APEX_ROOT, '.env') : '',
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);

  let content: string | undefined;
  for (const envBase of candidates) {
    if (!envBase) continue;
    const ageFile = envBase + '.age';

    // Try encrypted .env.age first
    const decrypted = decryptAgeFile(ageFile);
    if (decrypted) {
      content = decrypted;
      break;
    }

    // Fall back to plaintext .env
    try {
      content = fs.readFileSync(envBase, 'utf-8');
      break;
    } catch {
      continue;
    }
  }
  if (!content) return {};

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
