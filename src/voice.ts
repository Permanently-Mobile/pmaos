import fs, { mkdirSync } from 'fs';
import https from 'https';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';
import { veniceTTS, veniceCapabilities as checkVenice } from './venice.js';
import { isLuxTTSAvailable, generateSpeechBuffer } from './luxtts.js';
import { isPiperAvailable, piperSynthesize, type PiperOptions } from './piper-tts.js';

// ── Upload directory ────────────────────────────────────────────────────────

export const UPLOADS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'workspace',
  'uploads',
);

mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Make an HTTPS request and return the response body as a Buffer.
 */
function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: Buffer | string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Convenience wrapper for HTTPS GET that returns a Buffer.
 */
function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow a single redirect if present
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        https.get(res.headers.location, (res2) => {
          const chunks: Buffer[] = [];
          res2.on('data', (chunk: Buffer) => chunks.push(chunk));
          res2.on('end', () => resolve(Buffer.concat(chunks)));
          res2.on('error', reject);
        }).on('error', reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── STT: Groq Whisper ───────────────────────────────────────────────────────

/**
 * Download a Telegram file to a local temp path and return the path.
 * Uses the Telegram Bot API file download endpoint.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  destDir: string,
): Promise<string> {
  mkdirSync(destDir, { recursive: true });

  // Step 1: Get the file path from Telegram
  const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const infoBuffer = await httpsGet(infoUrl);
  const info = JSON.parse(infoBuffer.toString('utf-8')) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  if (!info.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${infoBuffer.toString('utf-8').slice(0, 300)}`);
  }

  // Step 2: Download the actual file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`;
  const fileBuffer = await httpsGet(downloadUrl);

  // Step 3: Save locally
  // Telegram sends voice as .oga — Groq requires .ogg. Rename transparently.
  const rawExt = path.extname(info.result.file_path) || '.ogg';
  const ext = rawExt === '.oga' ? '.ogg' : rawExt;
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const localPath = path.join(destDir, filename);
  fs.writeFileSync(localPath, fileBuffer);

  return localPath;
}

/**
 * Transcribe an audio file using Groq's Whisper API.
 * Supports .ogg, .mp3, .wav, .m4a.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const env = readEnvFile(['GROQ_API_KEY']);
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not set in .env');
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;

  // Detect MIME type from extension
  const ext = path.extname(filePath).toLowerCase();
  const MIME_MAP: Record<string, string> = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/m4a',
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4',
    '.flac': 'audio/flac',
  };
  const mimeType = MIME_MAP[ext] || 'audio/ogg';

  // Build multipart/form-data body manually
  const parts: Buffer[] = [];

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-large-v3\r\n`,
    ),
  );

  // Response format field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`,
    ),
  );

  // Force English to prevent foreign language hallucinations on ambient noise
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `en\r\n`,
    ),
  );

  // NOTE: Prompt hint removed -- Whisper echoes the prompt text back as a transcription
  // when audio is ambiguous, causing false positives worse than the hallucinations it prevents.
  // Language forcing (above) handles the foreign-language hallucination case.

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const responseBuffer = await httpsRequest(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
    },
    body,
  );

  const response = JSON.parse(responseBuffer.toString('utf-8')) as {
    text?: string;
  };

  return response.text ?? '';
}

// ── TTS Types ────────────────────────────────────────────────────────────────

/**
 * Options for synthesizeSpeech().
 * - preSanitized: skip internal sanitizeForSpeech() when caller already sanitized
 * - piperOptions: speech tuning (rate, expressiveness) passed through to Piper
 */
export interface SpeechOptions {
  /** If true, text is already sanitized -- don't double-sanitize. */
  preSanitized?: boolean;
  /** Piper-specific tuning (ignored if Piper is not the active provider). */
  piperOptions?: PiperOptions;
}

// ── TTS: Multi-provider (Piper → ElevenLabs → Venice) ───────────────────────

import { logger as voiceLogger } from './logger.js';

// ── TTS env cache (avoids repeated age decryption on every voice response) ──
const TTS_ENV_KEYS = [
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_MODEL',
  'ELEVENLABS_STABILITY',
  'ELEVENLABS_SIMILARITY',
  'ELEVENLABS_STYLE',
  'ELEVENLABS_SPEAKER_BOOST',
  'VENICE_API_KEY',
  'VENICE_TTS_VOICE',
];
let _ttsEnvCache: Record<string, string> = {};
let _ttsEnvCachedAt = 0;
const TTS_ENV_TTL = 300_000; // 5 minutes

function getTTSEnv(): Record<string, string> {
  const now = Date.now();
  if (now - _ttsEnvCachedAt > TTS_ENV_TTL || !_ttsEnvCachedAt) {
    _ttsEnvCache = readEnvFile(TTS_ENV_KEYS);
    _ttsEnvCachedAt = now;
    voiceLogger.debug({ cached: Object.keys(_ttsEnvCache).length }, 'TTS env cache refreshed');
  }
  return _ttsEnvCache;
}

/**
 * Sanitize text for TTS: strip markdown formatting, convert emphasis to pauses.
 * Keeps the text readable for speech engines that would otherwise say "asterisk".
 */
export function sanitizeForSpeech(raw: string): string {
  let t = raw;
  // Bold **text** or __text__ -> pause + text (comma creates natural breath)
  t = t.replace(/\*\*(.+?)\*\*/g, ', $1,');
  t = t.replace(/__(.+?)__/g, ', $1,');
  // Italic *text* or _text_ -> just the text
  t = t.replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/_(.+?)_/g, '$1');
  // Strikethrough ~~text~~ -> text
  t = t.replace(/~~(.+?)~~/g, '$1');
  // Headers # -> strip
  t = t.replace(/^#{1,6}\s+/gm, '');
  // Code fences ```...``` -> strip fences, keep content
  t = t.replace(/```[\s\S]*?```/g, '');
  // Inline code `text` -> text
  t = t.replace(/`(.+?)`/g, '$1');
  // Bullet points - or * at start of line -> strip marker
  t = t.replace(/^[\s]*[-*]\s+/gm, '');
  // Numbered lists 1. 2. etc -> strip number
  t = t.replace(/^[\s]*\d+\.\s+/gm, '');
  // Links [text](url) -> just text
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // HTML tags
  t = t.replace(/<[^>]+>/g, '');
  // Em dash (—) -> pause
  t = t.replace(/—/g, ',');
  // Multiple commas/spaces from replacements
  t = t.replace(/,\s*,/g, ',');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

/**
 * Convert text to speech using the best available provider.
 * Priority: Piper (local, zero cost, no 3rd-party dependency) -> ElevenLabs (fallback) -> Venice (privacy).
 * Piper runs locally on CPU -- fast, free, no network required.
 * ElevenLabs requires both API key AND voice ID to be set.
 * Venice activates as last resort when local options are down.
 *
 * @param options.preSanitized - Skip internal sanitization when caller already cleaned the text
 * @param options.piperOptions - Speech tuning (rate, expressiveness) for Piper TTS
 */
export async function synthesizeSpeech(text: string, options?: SpeechOptions): Promise<Buffer> {
  const env = getTTSEnv();
  // Strip markdown for speech (bold -> pause, remove formatting chars)
  // Skip if caller already sanitized (e.g., conversation mode chunks)
  const speechText = options?.preSanitized ? text : sanitizeForSpeech(text);

  // Priority 1: Piper TTS (local, zero cost, CPU-based, no 3rd-party dependency)
  if (isPiperAvailable()) {
    try {
      voiceLogger.info({ provider: 'piper', chars: speechText.length }, 'TTS synthesis started');
      const buf = await piperSynthesize(speechText, options?.piperOptions);
      voiceLogger.info({ provider: 'piper', chars: speechText.length, audioBytes: buf.length }, 'TTS synthesis complete (zero cost)');
      return buf;
    } catch (err: any) {
      voiceLogger.warn({ provider: 'piper', err: err?.message }, 'Piper TTS failed, falling back to ElevenLabs');
    }
  }

  // Priority 2: ElevenLabs (cloud fallback, higher quality)
  const elevenReady = !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
  if (elevenReady) {
    try {
      voiceLogger.info({ provider: 'elevenlabs', chars: text.length }, 'TTS synthesis started (fallback)');
      const buf = await synthesizeSpeechElevenLabs(speechText);
      voiceLogger.info({ provider: 'elevenlabs', chars: text.length, audioBytes: buf.length }, 'TTS synthesis complete');
      return buf;
    } catch (err: any) {
      voiceLogger.warn({ provider: 'elevenlabs', err: err?.message }, 'ElevenLabs TTS failed, falling back to Venice');
    }
  }

  // Priority 3: Venice TTS (zero data retention, privacy-first)
  const venice = checkVenice();
  if (venice.configured) {
    const voice = env.VENICE_TTS_VOICE || 'af_nova';
    voiceLogger.info({ provider: 'venice', voice, chars: text.length }, 'TTS synthesis started (fallback)');
    const buf = await veniceTTS({ text: speechText, voice, responseFormat: 'mp3' });
    voiceLogger.info({ provider: 'venice', chars: text.length, audioBytes: buf.length }, 'TTS synthesis complete');
    return buf;
  }

  throw new Error('No TTS provider available. Install Piper or set ELEVENLABS/VENICE keys in .env');
}

/**
 * ElevenLabs TTS. Model and voice settings configurable via .env.
 *
 * Env vars:
 *   ELEVENLABS_API_KEY     - API key (required)
 *   ELEVENLABS_VOICE_ID    - Voice ID from dashboard or IVC (required)
 *   ELEVENLABS_MODEL       - Model ID (default: eleven_turbo_v2_5)
 *   ELEVENLABS_STABILITY   - Voice stability 0.0-1.0 (default: 0.35)
 *   ELEVENLABS_SIMILARITY  - Similarity boost 0.0-1.0 (default: 0.85)
 *   ELEVENLABS_STYLE       - Style exaggeration 0.0-1.0 (default: 0.4)
 */
async function synthesizeSpeechElevenLabs(text: string): Promise<Buffer> {
  const env = getTTSEnv();

  const apiKey = env.ELEVENLABS_API_KEY!;
  const voiceId = env.ELEVENLABS_VOICE_ID!;
  const model = env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
  const stability = parseFloat(env.ELEVENLABS_STABILITY || '0.35');
  const similarity = parseFloat(env.ELEVENLABS_SIMILARITY || '0.85');
  const style = parseFloat(env.ELEVENLABS_STYLE || '0.4');
  const speakerBoost = (env.ELEVENLABS_SPEAKER_BOOST || 'false') === 'true';

  const payload = JSON.stringify({
    text,
    model_id: model,
    voice_settings: {
      stability,
      similarity_boost: similarity,
      style,
      use_speaker_boost: speakerBoost,
    },
  });

  const audioBuffer = await httpsRequest(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Content-Length': Buffer.byteLength(payload).toString(),
      },
    },
    payload,
  );

  return audioBuffer;
}

// ── Capabilities check ──────────────────────────────────────────────────────

/** Which TTS provider is active, if any. */
export type TTSProvider = 'piper' | 'luxtts' | 'venice' | 'elevenlabs' | null;

// Cache LuxTTS availability (checked async, refreshed periodically)
let _luxttsAvailable: boolean | null = null;
let _luxttsCheckedAt = 0;
const LUXTTS_CHECK_INTERVAL = 60_000; // re-check every 60s

/** Refresh the cached LuxTTS availability (call periodically or on /voice). */
export async function refreshLuxTTSStatus(): Promise<boolean> {
  _luxttsAvailable = await isLuxTTSAvailable();
  _luxttsCheckedAt = Date.now();
  return _luxttsAvailable;
}

/**
 * Check whether voice mode is available (all required env vars are set).
 * TTS is available if ElevenLabs, Piper, or Venice is configured.
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean; ttsProvider: TTSProvider } {
  const env = getTTSEnv();

  const veniceReady = !!env.VENICE_API_KEY;
  const elevenReady = !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
  const piperReady = isPiperAvailable();

  // Priority matches synthesizeSpeech(): Piper (local) > ElevenLabs > Venice
  let ttsProvider: TTSProvider = null;
  if (piperReady) ttsProvider = 'piper';
  else if (elevenReady) ttsProvider = 'elevenlabs';
  else if (veniceReady) ttsProvider = 'venice';

  return {
    stt: !!env.GROQ_API_KEY,
    tts: elevenReady || piperReady || veniceReady,
    ttsProvider,
  };
}
