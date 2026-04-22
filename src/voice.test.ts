import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(),
}));

import { voiceCapabilities, UPLOADS_DIR } from './voice.js';
import { readEnvFile } from './env.js';

const mockReadEnvFile = vi.mocked(readEnvFile);

describe('voiceCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all false when no env vars set', () => {
    mockReadEnvFile.mockReturnValue({});
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: false, ttsProvider: null });
  });

  it('returns stt only when only GROQ_API_KEY is set', () => {
    mockReadEnvFile.mockReturnValue({ GROQ_API_KEY: 'gsk_test123' });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: true, tts: false, ttsProvider: null });
  });

  it('returns tts false when only ELEVENLABS_API_KEY is set (missing voice ID)', () => {
    mockReadEnvFile.mockReturnValue({ ELEVENLABS_API_KEY: 'el_test123' });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: false, ttsProvider: null });
  });

  it('returns tts via elevenlabs when both API key and voice ID set', () => {
    mockReadEnvFile.mockReturnValue({
      ELEVENLABS_API_KEY: 'el_test123',
      ELEVENLABS_VOICE_ID: 'voice_abc',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: true, ttsProvider: 'elevenlabs' });
  });

  it('returns tts via venice when VENICE_API_KEY is set', () => {
    mockReadEnvFile.mockReturnValue({
      VENICE_API_KEY: 'venice_test123',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: false, tts: true, ttsProvider: 'venice' });
  });

  it('prefers venice over elevenlabs when both configured', () => {
    mockReadEnvFile.mockReturnValue({
      GROQ_API_KEY: 'gsk_test123',
      VENICE_API_KEY: 'venice_test123',
      ELEVENLABS_API_KEY: 'el_test123',
      ELEVENLABS_VOICE_ID: 'voice_abc',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: true, tts: true, ttsProvider: 'venice' });
  });

  it('returns full capabilities with STT and Venice TTS', () => {
    mockReadEnvFile.mockReturnValue({
      GROQ_API_KEY: 'gsk_test123',
      VENICE_API_KEY: 'venice_test123',
    });
    const result = voiceCapabilities();
    expect(result).toEqual({ stt: true, tts: true, ttsProvider: 'venice' });
  });
});

describe('UPLOADS_DIR', () => {
  it('is an absolute path', () => {
    expect(path.isAbsolute(UPLOADS_DIR)).toBe(true);
  });

  it('ends with workspace/uploads', () => {
    expect(UPLOADS_DIR).toMatch(/workspace[/\\]uploads$/);
  });
});
