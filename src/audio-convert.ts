/**
 * FFmpeg WAV-to-OGG/Opus conversion utility.
 *
 * Telegram voice messages require OGG container with Opus codec.
 * This module wraps FFmpeg via child_process.execFile for async,
 * non-blocking conversion with proper error handling.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import { logger } from './logger.js';

// ── Conversion ───────────────────────────────────────────────────────

/**
 * Convert a WAV file to OGG/Opus format suitable for Telegram voice messages.
 *
 * Uses FFmpeg with libopus codec at 64kbps, 48kHz sample rate.
 * If `outputPath` is not provided, the output file uses the same
 * base name with an `.ogg` extension.
 *
 * @param inputPath  - Absolute path to the input WAV file.
 * @param outputPath - Optional absolute path for the output OGG file.
 * @returns The absolute path to the converted OGG file.
 */
export function convertWavToOgg(
  inputPath: string,
  outputPath?: string,
): Promise<string> {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = outputPath
    ? path.resolve(outputPath)
    : resolvedInput.replace(/\.wav$/i, '.ogg');

  return new Promise((resolve, reject) => {
    // Verify input file exists before spawning FFmpeg
    if (!fs.existsSync(resolvedInput)) {
      reject(new Error(`Input file not found: ${resolvedInput}`));
      return;
    }

    const args = [
      '-i', resolvedInput,
      '-c:a', 'libopus',
      '-b:a', '64k',
      '-ar', '48000',
      '-y',                   // overwrite output if it exists
      resolvedOutput,
    ];

    execFile('ffmpeg', args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        // Distinguish between FFmpeg not installed vs conversion failure
        const errMsg = error.message || '';
        if (errMsg.includes('ENOENT')) {
          logger.error('FFmpeg not found on PATH');
          reject(new Error('FFmpeg is not installed or not on PATH'));
          return;
        }
        logger.error({ err: errMsg, stderr }, 'FFmpeg conversion failed');
        reject(new Error(`FFmpeg conversion failed: ${stderr || errMsg}`));
        return;
      }

      // Verify output was actually created
      if (!fs.existsSync(resolvedOutput)) {
        reject(new Error(`Conversion completed but output file missing: ${resolvedOutput}`));
        return;
      }

      logger.info({ input: resolvedInput, output: resolvedOutput }, 'WAV to OGG conversion complete');
      resolve(resolvedOutput);
    });
  });
}
