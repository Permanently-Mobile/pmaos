/**
 * LuxTTS -- Local Text-to-Speech Module
 *
 * This is a stub module included as an extension point. The full module
 * connects to a locally-hosted LuxTTS server for high-quality,
 * privacy-preserving text-to-speech with voice cloning support.
 *
 * To use: run a LuxTTS-compatible server on port 5050 (or set LUXTTS_PORT)
 * and implement the functions below.
 */

const LUXTTS_PORT = parseInt(process.env.LUXTTS_PORT || '5050', 10);

/**
 * Check whether a LuxTTS server is reachable.
 * Tests HTTP GET to http://127.0.0.1:{port}/health.
 *
 * Stub: always returns false. Implement to enable local TTS.
 */
export async function isLuxTTSAvailable(): Promise<boolean> {
  return false;
}

/**
 * Generate speech from text and return as OGG/Opus Buffer.
 * Pipeline: text -> LuxTTS server (WAV) -> FFmpeg (OGG/Opus) -> Buffer
 *
 * Stub: throws not-implemented. Implement to enable local TTS generation.
 */
export async function generateSpeechBuffer(
  _text: string,
  _speed?: number,
): Promise<Buffer> {
  throw new Error('LuxTTS not implemented. Install the luxtts add-on module.');
}
