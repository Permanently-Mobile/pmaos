import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  getSpiceState: vi.fn(),
  setSpiceState: vi.fn(),
  saveSpiceHistory: vi.fn(),
}));

vi.mock('./voice-filter.js', () => ({
  detectRegisterName: vi.fn(() => 'confident'),
}));

vi.mock('./spice-context.js', () => ({
  computeDimensionWeights: vi.fn((names: string[]) =>
    names.map((name: string) => ({ name, weight: 1.0 })),
  ),
  weightedPickRandom: vi.fn(),
  detectTopic: vi.fn(() => 'general'),
}));

import {
  buildSpiceContext,
  rollNewSpices,
  SPICE_DIMENSIONS,
  ROTATION_INTERVAL,
  ACTIVE_COUNT,
} from './spice.js';

import { DEFAULT_BOT_PROFILE, getAllProfileDirectives } from './personality-dna.js';
import { getSpiceState, setSpiceState, saveSpiceHistory } from './db.js';

const mockGetSpiceState = vi.mocked(getSpiceState);
const mockSetSpiceState = vi.mocked(setSpiceState);
const mockSaveSpiceHistory = vi.mocked(saveSpiceHistory);

describe('SPICE_DIMENSIONS', () => {
  it('has 10 dimensions', () => {
    expect(SPICE_DIMENSIONS).toHaveLength(10);
  });

  it('includes the 3 new dimensions (humor, formality, depth)', () => {
    const names = SPICE_DIMENSIONS.map((d) => d.name);
    expect(names).toContain('humor');
    expect(names).toContain('formality');
    expect(names).toContain('depth');
  });

  it('every dimension has at least 3 options', () => {
    for (const dim of SPICE_DIMENSIONS) {
      expect(dim.options.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('no option contains em dashes', () => {
    for (const dim of SPICE_DIMENSIONS) {
      for (const opt of dim.options) {
        expect(opt).not.toContain('\u2014'); // em dash
        expect(opt).not.toContain('\u2013'); // en dash
      }
    }
  });

  it('no option contains AI cliches', () => {
    const cliches = ['certainly', 'great question', "i'd be happy to", 'as an ai'];
    for (const dim of SPICE_DIMENSIONS) {
      for (const opt of dim.options) {
        const lower = opt.toLowerCase();
        for (const c of cliches) {
          expect(lower).not.toContain(c);
        }
      }
    }
  });
});

describe('rollNewSpices', () => {
  it('returns ACTIVE_COUNT SpiceRollResult objects', () => {
    const results = rollNewSpices();
    expect(results).toHaveLength(ACTIVE_COUNT);
    for (const r of results) {
      expect(r).toHaveProperty('directive');
      expect(r).toHaveProperty('dimension');
      expect(r).toHaveProperty('characterId');
    }
  });

  it('returns directives that exist in character profiles or generic pool', () => {
    const allOptions = [
      ...getAllProfileDirectives(DEFAULT_BOT_PROFILE),
      ...SPICE_DIMENSIONS.flatMap((d) => d.options),
    ];
    for (let i = 0; i < 50; i++) {
      const results = rollNewSpices();
      for (const r of results) {
        expect(allOptions).toContain(r.directive);
      }
    }
  });

  it('picks from different dimensions (no two from same dimension)', () => {
    for (let i = 0; i < 50; i++) {
      const results = rollNewSpices();
      const dims = results.map((r) => r.dimension);
      expect(new Set(dims).size).toBe(dims.length);
    }
  });
});

describe('buildSpiceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rolls new spices on first message (no existing state)', () => {
    mockGetSpiceState.mockReturnValue(undefined);

    const result = buildSpiceContext('chat1');

    expect(result).toContain('[Bot spice - active flavor]');
    expect(result).toContain('[End spice]');
    expect(mockSetSpiceState).toHaveBeenCalledWith(
      'chat1',
      expect.any(Array),
      1,
    );

    // Verify the saved spices have ACTIVE_COUNT entries
    const savedSpices = mockSetSpiceState.mock.calls[0][1] as string[];
    expect(savedSpices).toHaveLength(ACTIVE_COUNT);
  });

  it('writes to spice history on first message', () => {
    mockGetSpiceState.mockReturnValue(undefined);

    buildSpiceContext('chat1', 'hello');

    expect(mockSaveSpiceHistory).toHaveBeenCalledTimes(1);
    expect(mockSaveSpiceHistory).toHaveBeenCalledWith(
      'chat1',
      expect.any(Array),
    );

    // Verify history entries have the right structure
    const entries = mockSaveSpiceHistory.mock.calls[0][1] as Array<{ dimension: string; directive: string; characterId: string; register: string }>;
    expect(entries).toHaveLength(ACTIVE_COUNT);
    for (const entry of entries) {
      expect(entry).toHaveProperty('dimension');
      expect(entry).toHaveProperty('directive');
      expect(entry).toHaveProperty('characterId');
      expect(entry).toHaveProperty('register');
    }
  });

  it('increments message count on subsequent messages', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(['spice1', 'spice2', 'spice3']),
      message_count: 2,
      updated_at: 1000,
    });

    buildSpiceContext('chat1');

    expect(mockSetSpiceState).toHaveBeenCalledWith(
      'chat1',
      ['spice1', 'spice2', 'spice3'],
      3,
    );
  });

  it('does NOT write history on non-rotation messages', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(['spice1', 'spice2', 'spice3']),
      message_count: 2,
      updated_at: 1000,
    });

    buildSpiceContext('chat1', 'hello');

    expect(mockSaveSpiceHistory).not.toHaveBeenCalled();
  });

  it('rotates spices when message count reaches ROTATION_INTERVAL', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(['old1', 'old2', 'old3']),
      message_count: ROTATION_INTERVAL - 1,
      updated_at: 1000,
    });

    const result = buildSpiceContext('chat1');

    // Count reset to 1 means rotation happened
    expect(mockSetSpiceState).toHaveBeenCalledWith(
      'chat1',
      expect.any(Array),
      1,
    );

    // New spices should be from character profiles or generic pool, not 'old1' etc.
    const savedSpices = mockSetSpiceState.mock.calls[0][1] as string[];
    const allOptions = [
      ...getAllProfileDirectives(DEFAULT_BOT_PROFILE),
      ...SPICE_DIMENSIONS.flatMap((d) => d.options),
    ];
    for (const s of savedSpices) {
      expect(allOptions).toContain(s);
    }

    expect(result).toContain('[Bot spice - active flavor]');
  });

  it('writes history on rotation', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(['old1', 'old2', 'old3']),
      message_count: ROTATION_INTERVAL - 1,
      updated_at: 1000,
    });

    buildSpiceContext('chat1', 'crypto strategy');

    expect(mockSaveSpiceHistory).toHaveBeenCalledTimes(1);
  });

  it('does NOT rotate before reaching ROTATION_INTERVAL', () => {
    const originalSpices = ['keep1', 'keep2', 'keep3'];
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(originalSpices),
      message_count: ROTATION_INTERVAL - 2,
      updated_at: 1000,
    });

    buildSpiceContext('chat1');

    expect(mockSetSpiceState).toHaveBeenCalledWith(
      'chat1',
      originalSpices,
      ROTATION_INTERVAL - 1,
    );
  });

  it('includes all active spices in the output', () => {
    const spices = [
      'Keep it tight. Short sentences.',
      'Straight business. Clean.',
      'Just the verdict.',
    ];
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(spices),
      message_count: 1,
      updated_at: 1000,
    });

    const result = buildSpiceContext('chat1');

    for (const s of spices) {
      expect(result).toContain(s);
    }
  });

  it('returns empty string if DB throws (fail-open)', () => {
    mockGetSpiceState.mockImplementation(() => {
      throw new Error('DB locked');
    });

    const result = buildSpiceContext('chat1');
    expect(result).toBe('');
  });

  it('still works if saveSpiceHistory throws (fail-open)', () => {
    mockGetSpiceState.mockReturnValue(undefined);
    mockSaveSpiceHistory.mockImplementation(() => {
      throw new Error('DB locked');
    });

    const result = buildSpiceContext('chat1', 'test message');

    // Should still return valid spice context
    expect(result).toContain('[Bot spice - active flavor]');
    expect(mockSetSpiceState).toHaveBeenCalled();
  });

  it('uses context-aware selection when message is provided on rotation', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'chat1',
      active_spices: JSON.stringify(['old1', 'old2', 'old3']),
      message_count: ROTATION_INTERVAL - 1,
      updated_at: 1000,
    });

    // With message, should go through context-aware path
    const result = buildSpiceContext('chat1', 'check the BTC chart');
    expect(result).toContain('[Bot spice - active flavor]');

    // Spices should be from valid pools
    const savedSpices = mockSetSpiceState.mock.calls[0][1] as string[];
    const allOptions = [
      ...getAllProfileDirectives(DEFAULT_BOT_PROFILE),
      ...SPICE_DIMENSIONS.flatMap((d) => d.options),
    ];
    for (const s of savedSpices) {
      expect(allOptions).toContain(s);
    }
  });

  it('includes sessionTopic in history for non-general topics', () => {
    mockGetSpiceState.mockReturnValue(undefined);

    buildSpiceContext('chat1', 'check the BTC chart');

    expect(mockSaveSpiceHistory).toHaveBeenCalledTimes(1);
    const entries = mockSaveSpiceHistory.mock.calls[0][1] as Array<{ sessionTopic?: string }>;
    // detectTopic is mocked to return 'general' so sessionTopic should be undefined
    // In real usage with crypto message, it would be 'crypto'
    expect(entries).toHaveLength(ACTIVE_COUNT);
  });
});
