import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  getDefaultChatId: vi.fn(() => 'test-chat'),
  getSpiceState: vi.fn(),
  getSpiceFrequency: vi.fn(() => []),
  getSpiceCharacterFrequency: vi.fn(() => []),
  countSpiceHistory: vi.fn(() => 0),
  getOldestSpiceHistory: vi.fn(() => null),
  countSpiceRotations: vi.fn(() => 0),
}));

vi.mock('./spice.js', () => ({
  ROTATION_INTERVAL: 5,
  ACTIVE_COUNT: 3,
  SPICE_DIMENSIONS: Array.from({ length: 10 }, (_, i) => ({ name: `dim${i}`, options: [] })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  getSpiceStatus,
  formatSpiceStatus,
  checkSpiceHealth,
  type SpiceStatus,
} from './spice-monitor.js';

import {
  getDefaultChatId,
  getSpiceState,
  getSpiceFrequency,
  getSpiceCharacterFrequency,
  countSpiceHistory,
  getOldestSpiceHistory,
  countSpiceRotations,
} from './db.js';

const mockGetDefaultChatId = vi.mocked(getDefaultChatId);
const mockGetSpiceState = vi.mocked(getSpiceState);
const mockGetSpiceFrequency = vi.mocked(getSpiceFrequency);
const mockGetSpiceCharacterFrequency = vi.mocked(getSpiceCharacterFrequency);
const mockCountSpiceHistory = vi.mocked(countSpiceHistory);
const mockGetOldestSpiceHistory = vi.mocked(getOldestSpiceHistory);
const mockCountSpiceRotations = vi.mocked(countSpiceRotations);

describe('getSpiceStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultChatId.mockReturnValue('test-chat');
  });

  it('returns null when no chat ID', () => {
    mockGetDefaultChatId.mockReturnValue('');
    expect(getSpiceStatus()).toBeNull();
  });

  it('returns status with active spices', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'test-chat',
      active_spices: JSON.stringify(['spice1', 'spice2', 'spice3']),
      message_count: 3,
      updated_at: 1000,
    });
    mockCountSpiceRotations.mockReturnValue(5);
    mockCountSpiceHistory.mockReturnValue(100);
    mockGetOldestSpiceHistory.mockReturnValue(Math.floor(Date.now() / 1000) - 10 * 86400);
    mockGetSpiceFrequency.mockReturnValue([
      { dimension: 'cadence', count: 20 },
      { dimension: 'warmth', count: 15 },
    ]);
    mockGetSpiceCharacterFrequency.mockReturnValue([
      { character_id: 'test-bot', count: 70 },
      { character_id: 'char-b', count: 20 },
      { character_id: 'char-c', count: 10 },
    ]);

    const status = getSpiceStatus();
    expect(status).not.toBeNull();
    expect(status!.activeSpices).toHaveLength(3);
    expect(status!.currentMessageCount).toBe(3);
    expect(status!.messagesUntilRotation).toBe(2); // 5 - 3
    expect(status!.historyCount).toBe(100);
    expect(status!.oldestEntryDays).toBe(10);
    expect(status!.topDimensions).toHaveLength(2);
    expect(status!.characterSplit).toHaveLength(3);
  });

  it('handles no state (fresh chat)', () => {
    mockGetSpiceState.mockReturnValue(undefined);
    const status = getSpiceStatus();
    expect(status).not.toBeNull();
    expect(status!.activeSpices).toEqual([]);
    expect(status!.messagesUntilRotation).toBe(5); // ROTATION_INTERVAL
  });
});

describe('formatSpiceStatus', () => {
  it('formats a complete status report', () => {
    const status: SpiceStatus = {
      activeSpices: ['Keep it tight.', 'Straight business.', 'Stay on target.'],
      messagesUntilRotation: 2,
      currentMessageCount: 3,
      rotations24h: 15,
      rotations7d: 87,
      historyCount: 312,
      oldestEntryDays: 28,
      topDimensions: [
        { dimension: 'perspective', count: 23, pct: 23 },
        { dimension: 'warmth', count: 19, pct: 19 },
      ],
      characterSplit: [
        { character_id: 'test-bot', count: 68, pct: 68 },
        { character_id: 'char-b', count: 22, pct: 22 },
        { character_id: 'char-c', count: 10, pct: 10 },
      ],
    };

    const output = formatSpiceStatus(status);
    expect(output).toContain('Spice System v2');
    expect(output).toContain('Active:');
    expect(output).toContain('Next rotation: 2 messages');
    expect(output).toContain('Rotations (24h): 15 | (7d): 87');
    expect(output).toContain('History: 312 entries (oldest: 28d)');
    expect(output).toContain('perspective (23%)');
    expect(output).toContain('test-bot 68%');
    expect(output).toContain('char-b 22%');
  });

  it('handles empty spices', () => {
    const status: SpiceStatus = {
      activeSpices: [],
      messagesUntilRotation: 5,
      currentMessageCount: 0,
      rotations24h: 0,
      rotations7d: 0,
      historyCount: 0,
      oldestEntryDays: null,
      topDimensions: [],
      characterSplit: [],
    };

    const output = formatSpiceStatus(status);
    expect(output).toContain('none (will roll on next message)');
  });

  it('truncates long active spices', () => {
    const longSpice = 'A'.repeat(80);
    const status: SpiceStatus = {
      activeSpices: [longSpice],
      messagesUntilRotation: 3,
      currentMessageCount: 2,
      rotations24h: 5,
      rotations7d: 30,
      historyCount: 50,
      oldestEntryDays: 7,
      topDimensions: [],
      characterSplit: [],
    };

    const output = formatSpiceStatus(status);
    expect(output).toContain('...');
    // Should not contain the full 80-char string
    expect(output).not.toContain(longSpice);
  });
});

describe('checkSpiceHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultChatId.mockReturnValue('test-chat');
  });

  it('returns WARN when no chat ID', () => {
    mockGetDefaultChatId.mockReturnValue('');
    const result = checkSpiceHealth();
    expect(result.status).toBe('WARN');
    expect(result.tier).toBe(2);
  });

  it('returns PASS with healthy metrics', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'test-chat',
      active_spices: JSON.stringify(['a', 'b', 'c']),
      message_count: 2,
      updated_at: 1000,
    });
    mockCountSpiceRotations.mockReturnValue(5);
    mockCountSpiceHistory.mockReturnValue(100);

    const result = checkSpiceHealth();
    expect(result.status).toBe('PASS');
    expect(result.detail).toContain('3/3 active');
    expect(result.detail).toContain('5 rot/24h');
  });

  it('returns WARN when no rotations in 24h but history exists', () => {
    mockGetSpiceState.mockReturnValue({
      chat_id: 'test-chat',
      active_spices: JSON.stringify(['a', 'b', 'c']),
      message_count: 2,
      updated_at: 1000,
    });
    mockCountSpiceRotations
      .mockReturnValueOnce(0)  // 24h
      .mockReturnValueOnce(10); // 7d
    mockCountSpiceHistory.mockReturnValue(50);

    const result = checkSpiceHealth();
    expect(result.status).toBe('WARN');
    expect(result.detail).toContain('No rotations in 24h');
  });

  it('returns WARN when no history', () => {
    mockGetSpiceState.mockReturnValue(undefined);
    mockCountSpiceRotations.mockReturnValue(0);
    mockCountSpiceHistory.mockReturnValue(0);

    const result = checkSpiceHealth();
    expect(result.status).toBe('WARN');
    expect(result.detail).toContain('No history data');
  });
});
