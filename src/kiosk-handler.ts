/**
 * Kiosk Voice + Text Handler
 *
 * Handles voice and text input from the avatar kiosk display.
 * Voice: Transcribes audio via Groq Whisper, runs through Claude,
 * sends response audio back to kiosk via WebSocket.
 * Text: Direct text input, runs through Claude, responds via WebSocket.
 *
 * Conversation mode: Detects casual messages and delivers response
 * sentence-by-sentence with progressive TTS for natural conversation flow.
 *
 * This is the non-Telegram voice/text path -- no Grammy ctx needed.
 * Uses the same Claude session as Telegram for continuity.
 */

import fs from 'fs';
import path from 'path';

import { ALLOWED_CHAT_ID } from './config.js';
import { getSession, setSession, saveTokenUsage, getPendingBtw, markBtwProcessed } from './db.js';
import { onUserMessage, onBotResponse } from './inbox.js';
import { buildConversationRecallContext } from './conversation-search.js';
import { logger } from './logger.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import { buildSpiceContext } from './spice.js';
import { buildVoiceFilter, detectRegisterName } from './voice-filter.js';
import { runWithFallback } from './fallback-model.js';
import { classifyMessage, chunkIntoSentences } from './conversation-mode.js';
import {
  transcribeAudio,
  synthesizeSpeech,
  sanitizeForSpeech,
  voiceCapabilities,
  UPLOADS_DIR,
  type SpeechOptions,
} from './voice.js';
import {
  avatarOnMessageReceived,
  avatarOnThinking,
  avatarOnResponseReady,
  avatarOnSpeakingStart,
  avatarOnSpeakingEnd,
  avatarPlayAudio,
  avatarSendText,
  avatarSendUserText,
  avatarSendSystemText,
  avatarEmotionChange,
  avatarStreamStart,
  avatarSendTextChunk,
  avatarPlayAudioChunk,
  avatarStreamEnd,
} from './avatar-state.js';
import { logKioskExchange } from './kiosk-log.js';

/**
 * Hallucination filter for Groq Whisper STT.
 * Whisper hallucinates these phrases from ambient noise (HVAC hum, silence, etc).
 * Case-insensitive exact match after trimming punctuation.
 */
const WHISPER_HALLUCINATIONS = new Set([
  'thank you',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'subscribe',
  'like and subscribe',
  'please subscribe',
  'you',
  'bye',
  'goodbye',
  'okay',
  'ok',
  'hmm',
  'um',
  'uh',
  'ah',
  'oh',
  'so',
  'yeah',
  'yes',
  'no',
  'right',
  'well',
  'the',
  'and',
  'i',
  'a',
  'to',
  'it',
  'is',
]);

// Whisper sometimes echoes its own prompt hint as a transcription -- catch substrings
const WHISPER_PROMPT_ECHOES = [
  'they may ask questions',
  'give commands or have a conversation',
  'speaking to bot',
  'from a kiosk display',
];

function isWhisperHallucination(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[.,!?;:'"\\-]/g, '').trim();
  // Exact match against known hallucinations
  if (WHISPER_HALLUCINATIONS.has(cleaned)) return true;
  // Prompt echo detection (Whisper regurgitates its own context hint)
  for (const echo of WHISPER_PROMPT_ECHOES) {
    if (cleaned.includes(echo)) return true;
  }
  // Single-word transcriptions are almost always hallucinated from noise
  if (cleaned.split(/\s+/).length <= 1 && cleaned.length < 10) return true;
  // Very short phrases (2 words, under 8 chars total) are suspect
  const words = cleaned.split(/\s+/);
  if (words.length <= 2 && cleaned.length < 8) return true;
  return false;
}

// ── Conversation Mode Response Delivery ────────────────────────────────

/**
 * Deliver a response to the kiosk, choosing between:
 * - Chunked streaming (conversation mode): sentence-by-sentence text + audio
 * - Standard delivery (task mode): full text + full audio
 *
 * Conversation mode delivers first sentence audio within ~100ms (Piper)
 * instead of waiting for full-text TTS synthesis.
 */
async function deliverKioskResponse(
  responseText: string,
  originalMessage: string,
  enableTTS: boolean,
): Promise<void> {
  const caps = voiceCapabilities();
  const convMode = classifyMessage(originalMessage);

  // Chunked streaming: conversation mode with TTS available
  if (convMode.mode === 'conversation' && enableTTS && caps.tts) {
    // Sanitize once here -- pass preSanitized:true to synthesizeSpeech to prevent double-sanitize
    const speechText = sanitizeForSpeech(responseText);
    const sentences = chunkIntoSentences(speechText);

    // Conversational Piper tuning: slightly faster pace + more expressiveness
    const convSpeechOpts: SpeechOptions = {
      preSanitized: true,
      piperOptions: { lengthScale: 0.95, noiseScale: 0.75, sentenceSilence: 0.15 },
    };

    if (sentences.length <= 1) {
      // Single sentence: standard path (no chunking overhead)
      avatarSendText(responseText);
      try {
        avatarOnSpeakingStart();
        const ttsBuffer = await synthesizeSpeech(sentences[0] || speechText, convSpeechOpts);
        avatarPlayAudio(ttsBuffer);
      } catch (ttsErr) {
        avatarOnSpeakingEnd();
        logger.error({ err: ttsErr }, 'Kiosk TTS failed');
      }
      return;
    }

    // Multi-sentence conversation: chunked delivery
    logger.info(
      { chunks: sentences.length, mode: 'conversation', confidence: convMode.confidence },
      'Kiosk: streaming response in conversation mode',
    );

    avatarStreamStart(sentences.length, 'conversation');
    avatarOnSpeakingStart();

    for (let i = 0; i < sentences.length; i++) {
      // Send text chunk to display
      avatarSendTextChunk(sentences[i], i, sentences.length);

      // Synthesize and send audio chunk (preSanitized, conversation-tuned)
      try {
        const audioBuffer = await synthesizeSpeech(sentences[i], convSpeechOpts);
        avatarPlayAudioChunk(audioBuffer, i, sentences.length);
      } catch (ttsErr) {
        logger.error({ err: ttsErr, chunk: i }, 'Kiosk chunk TTS failed, skipping');
      }
    }

    avatarStreamEnd();
    // avatarOnSpeakingEnd() called by client when last audio chunk finishes
    return;
  }

  // Standard delivery: task mode or no TTS
  avatarSendText(responseText);

  if (enableTTS && caps.tts) {
    try {
      avatarOnSpeakingStart();
      const ttsBuffer = await synthesizeSpeech(responseText);
      avatarPlayAudio(ttsBuffer);
    } catch (ttsErr) {
      avatarOnSpeakingEnd();
      logger.error({ err: ttsErr }, 'Kiosk TTS failed');
    }
  } else {
    avatarOnResponseReady();
  }
}

// ── Voice Handler ──────────────────────────────────────────────────────

/**
 * Handle voice input from the kiosk display.
 * Transcribes audio, runs through Claude, sends response audio back via WebSocket.
 */
export async function handleKioskVoice(audioBuffer: Buffer): Promise<void> {
  const chatIdStr = ALLOWED_CHAT_ID;
  if (!chatIdStr) {
    logger.error('Kiosk voice: ALLOWED_CHAT_ID not set');
    avatarSendText('System not configured. Set ALLOWED_CHAT_ID.');
    return;
  }

  // Save audio to temp file for transcription
  const filename = `kiosk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webm`;
  const audioPath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(audioPath, audioBuffer);

  try {
    // Wake avatar
    avatarOnMessageReceived();

    // Transcribe
    const transcribed = await transcribeAudio(audioPath);
    if (!transcribed.trim()) {
      logger.warn('Kiosk voice: empty transcription');
      avatarSendText('No voice detected -- try again.');
      avatarOnResponseReady();
      return;
    }

    // Filter out Whisper hallucinations (phantom phrases from ambient noise)
    if (isWhisperHallucination(transcribed)) {
      logger.warn({ text: transcribed }, 'Kiosk voice: filtered Whisper hallucination');
      avatarSendSystemText(`Heard: "${transcribed}" (filtered as background noise). Try speaking closer to the mic.`);
      avatarOnResponseReady();
      return;
    }

    logger.info({ text: transcribed.slice(0, 100) }, 'Kiosk voice transcribed');
    avatarSendUserText(transcribed);
    avatarOnThinking();

    // Build context (full pipeline matching Telegram for compaction resilience)
    const message = `[Voice transcribed via kiosk]: ${transcribed}`;
    const memCtx = await buildMemoryContext(chatIdStr, message);
    const recallCtx = await buildConversationRecallContext(chatIdStr, message);
    const spiceCtx = buildSpiceContext(chatIdStr, message);
    const voiceCtx = buildVoiceFilter(message);
    const convMode = classifyMessage(message);
    const convCtx = convMode.directive;

    // BTW queue injection (same as Telegram)
    const btwItems = getPendingBtw(chatIdStr);
    let btwContext = '';
    if (btwItems.length > 0) {
      const lines = btwItems.map(item => `- ${item.content}`).join('\n');
      btwContext = `[BTW queue -- the user mentioned these while you were working on something else. Address them naturally alongside the current message if relevant, or acknowledge them separately:\n${lines}]`;
      for (const item of btwItems) {
        markBtwProcessed(item.id);
      }
    }

    // Shared learning context
    let learningCtx = '';
    try {
      const { searchLearning } = await import('./learning/search.js');
      const hits = searchLearning(message.slice(0, 500), { limit: 3 });
      if (hits.length > 0) {
        const entries = hits.map(h => `- [${h.type}] ${h.text}`).join('\n');
        learningCtx = `[Shared knowledge (from agent learning)]\n${entries}`;
      }
    } catch { /* learning system not initialized -- non-fatal */ }

    const fullMessage = [memCtx, recallCtx, spiceCtx, voiceCtx, convCtx, learningCtx, btwContext, message].filter(Boolean).join('\n\n');

    const sessionId = getSession(chatIdStr);

    // Detect register for avatar emotion
    const register = detectRegisterName(message);
    if (register !== 'confident') avatarEmotionChange(register);

    // Track conversation state
    onUserMessage();

    // Run through Claude
    const result = await runWithFallback(
      fullMessage,
      sessionId,
      () => {}, // No typing indicator for kiosk
      undefined, // No progress callback
      chatIdStr,
    );

    if (result.resumeToken) {
      setSession(chatIdStr, result.resumeToken);
    }

    const responseText = result.text?.trim() || 'Done.';

    // Save conversation turn
    saveConversationTurn(chatIdStr, message, responseText, result.resumeToken ?? sessionId);

    // Track usage
    if (result.usage) {
      saveTokenUsage(
        chatIdStr,
        result.resumeToken ?? sessionId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.lastCallCacheRead,
        result.usage.lastCallCacheRead + result.usage.lastCallInputTokens,
        result.usage.totalCostUsd,
        result.usage.didCompact,
      );
    }

    // Track bot response
    onBotResponse();

    // Log to vault (text archive)
    logKioskExchange(transcribed, responseText);

    // Deliver response (handles conversation mode chunking internally)
    await deliverKioskResponse(responseText, message, true);
  } catch (err) {
    logger.error({ err }, 'Kiosk voice handler failed');
    avatarSendText('Voice processing failed. Try again.');
    avatarOnResponseReady();
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

// ── Text Handler ───────────────────────────────────────────────────────

/**
 * Handle text input from the kiosk chat interface.
 * Same pipeline as voice, but skips transcription.
 * Now also enables TTS in conversation mode for a more natural feel.
 */
export async function handleKioskText(text: string): Promise<void> {
  const chatIdStr = ALLOWED_CHAT_ID;
  if (!chatIdStr) {
    logger.error('Kiosk text: ALLOWED_CHAT_ID not set');
    avatarSendText('System not configured.');
    return;
  }

  try {
    avatarOnMessageReceived();
    avatarOnThinking();

    // Build context (full pipeline matching Telegram for compaction resilience)
    const message = `[Kiosk text]: ${text}`;
    const memCtx = await buildMemoryContext(chatIdStr, message);
    const recallCtx = await buildConversationRecallContext(chatIdStr, message);
    const spiceCtx = buildSpiceContext(chatIdStr, message);
    const voiceCtx = buildVoiceFilter(message);
    const convMode = classifyMessage(message);
    const convCtx = convMode.directive;

    // BTW queue injection (same as Telegram)
    const btwItems = getPendingBtw(chatIdStr);
    let btwContext = '';
    if (btwItems.length > 0) {
      const lines = btwItems.map(item => `- ${item.content}`).join('\n');
      btwContext = `[BTW queue -- the user mentioned these while you were working on something else. Address them naturally alongside the current message if relevant, or acknowledge them separately:\n${lines}]`;
      for (const item of btwItems) {
        markBtwProcessed(item.id);
      }
    }

    // Shared learning context
    let learningCtx = '';
    try {
      const { searchLearning } = await import('./learning/search.js');
      const hits = searchLearning(message.slice(0, 500), { limit: 3 });
      if (hits.length > 0) {
        const entries = hits.map(h => `- [${h.type}] ${h.text}`).join('\n');
        learningCtx = `[Shared knowledge (from agent learning)]\n${entries}`;
      }
    } catch { /* learning system not initialized -- non-fatal */ }

    const fullMessage = [memCtx, recallCtx, spiceCtx, voiceCtx, convCtx, learningCtx, btwContext, message].filter(Boolean).join('\n\n');

    const sessionId = getSession(chatIdStr);

    const register = detectRegisterName(message);
    if (register !== 'confident') avatarEmotionChange(register);

    onUserMessage();

    const result = await runWithFallback(
      fullMessage,
      sessionId,
      () => {},
      undefined,
      chatIdStr,
    );

    if (result.resumeToken) {
      setSession(chatIdStr, result.resumeToken);
    }

    const responseText = result.text?.trim() || 'Done.';

    saveConversationTurn(chatIdStr, message, responseText, result.resumeToken ?? sessionId);

    if (result.usage) {
      saveTokenUsage(
        chatIdStr,
        result.resumeToken ?? sessionId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.lastCallCacheRead,
        result.usage.lastCallCacheRead + result.usage.lastCallInputTokens,
        result.usage.totalCostUsd,
        result.usage.didCompact,
      );
    }

    onBotResponse();

    logKioskExchange(text, responseText);

    // Deliver response with TTS enabled (conversation mode gets voice too)
    await deliverKioskResponse(responseText, message, true);
  } catch (err) {
    logger.error({ err }, 'Kiosk text handler failed');
    avatarSendText('Text processing failed. Try again.');
    avatarOnResponseReady();
  }
}
