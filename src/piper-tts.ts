/**
 * Piper TTS integration -- lightweight, local, zero-cost.
 *
 * Piper is a fast neural TTS engine that runs on CPU.
 * Binary + voice model live in store/piper/.
 * Returns WAV audio buffers (browser AudioContext handles decoding).
 *
 * Priority 1 in the TTS chain: Piper (local) -> ElevenLabs -> Venice
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

// ── Paths ────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIPER_DIR = path.join(PROJECT_ROOT, 'store', 'piper');
const PIPER_BIN = path.join(PIPER_DIR, 'piper', 'piper');
const PIPER_LIB = path.join(PIPER_DIR, 'piper');

// Voice model (configurable via env, defaults to Alba medium GB)
const PIPER_MODEL = process.env.PIPER_MODEL
  || path.join(PIPER_DIR, 'en_GB-alba-medium.onnx');

// Temp dir for output WAV files
const TMP_DIR = path.join(PROJECT_ROOT, 'workspace', 'piper-tmp');

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Speech tuning parameters for Piper TTS.
 * All optional -- Piper's defaults are used when omitted.
 */
export interface PiperOptions {
  /** Speech rate: 1.0 = normal, lower = faster, higher = slower. Default: 1.0 */
  lengthScale?: number;
  /** Voice expressiveness / generator noise: 0.0-1.0. Default: 0.667 */
  noiseScale?: number;
  /** Phoneme width variation: 0.0-1.0. Default: 0.8 */
  noiseW?: number;
  /** Seconds of silence after each sentence. Default: 0.2 */
  sentenceSilence?: number;
}

// ── Health check ─────────────────────────────────────────────────────

let _piperAvailable: boolean | null = null;

/**
 * Check if Piper binary and voice model are present.
 * Cached after first check (files don't move at runtime).
 */
export function isPiperAvailable(): boolean {
  if (_piperAvailable !== null) return _piperAvailable;

  try {
    const binExists = fs.existsSync(PIPER_BIN);
    const modelExists = fs.existsSync(PIPER_MODEL);
    _piperAvailable = binExists && modelExists;

    if (_piperAvailable) {
      logger.info({ model: path.basename(PIPER_MODEL) }, 'Piper TTS available (local, zero cost)');
    } else {
      logger.debug({
        bin: binExists ? 'found' : 'missing',
        model: modelExists ? 'found' : 'missing',
      }, 'Piper TTS not available');
    }
  } catch {
    _piperAvailable = false;
  }

  return _piperAvailable;
}

/** Reset the cached availability check (for testing). */
export function resetPiperCache(): void {
  _piperAvailable = null;
}

// ── Synthesis ────────────────────────────────────────────────────────

/**
 * Synthesize text to a WAV audio buffer using Piper.
 *
 * Spawns the Piper binary as a child process:
 *   echo "text" | piper --model X --output_file Y [--length_scale N ...]
 *
 * Optional PiperOptions allow per-call tuning of speech rate, expressiveness,
 * and sentence silence. Conversational chunks use slightly faster, more
 * expressive settings for natural delivery.
 *
 * Returns the WAV buffer. Caller is responsible for format conversion
 * if needed (e.g., WAV -> OGG for Telegram).
 */
export async function piperSynthesize(text: string, options?: PiperOptions): Promise<Buffer> {
  if (!isPiperAvailable()) {
    throw new Error('Piper TTS not available (binary or model missing)');
  }

  // Ensure temp dir exists
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const outFile = path.join(TMP_DIR, `piper-${crypto.randomBytes(4).toString('hex')}.wav`);

  // Build CLI args with optional speech tuning
  const args = [
    '--model', PIPER_MODEL,
    '--output_file', outFile,
    '--quiet',
  ];

  if (options?.lengthScale !== undefined) {
    args.push('--length_scale', options.lengthScale.toString());
  }
  if (options?.noiseScale !== undefined) {
    args.push('--noise_scale', options.noiseScale.toString());
  }
  if (options?.noiseW !== undefined) {
    args.push('--noise_w', options.noiseW.toString());
  }
  if (options?.sentenceSilence !== undefined) {
    args.push('--sentence_silence', options.sentenceSilence.toString());
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      PIPER_BIN,
      args,
      {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: PIPER_LIB,
        },
        timeout: 30_000, // 30s max for TTS
        maxBuffer: 10 * 1024 * 1024,
      },
      (err) => {
        if (err) {
          // Cleanup on error
          try { fs.unlinkSync(outFile); } catch {}
          reject(new Error(`Piper TTS failed: ${err.message}`));
          return;
        }

        try {
          const buf = fs.readFileSync(outFile);
          fs.unlinkSync(outFile); // Cleanup temp file
          logger.info(
            { chars: text.length, bytes: buf.length, model: path.basename(PIPER_MODEL),
              ...(options?.lengthScale ? { lengthScale: options.lengthScale } : {}) },
            'Piper TTS synthesis complete (zero cost)',
          );
          resolve(buf);
        } catch (readErr) {
          reject(new Error(`Piper TTS output read failed: ${readErr}`));
        }
      },
    );

    // Feed text via stdin
    if (child.stdin) {
      child.stdin.write(text);
      child.stdin.end();
    }
  });
}
