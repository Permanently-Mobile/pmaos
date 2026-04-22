import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  getDefaultChatId: vi.fn(() => 'test-chat'),
  getSpiceFrequency: vi.fn(() => []),
  getSpiceCharacterFrequency: vi.fn(() => []),
  saveMemoryReturningId: vi.fn(() => 1),
  getDatabase: vi.fn(),
}));

vi.mock('./memory-extract.js', () => ({
  findDuplicate: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('./venice.js', () => ({
  veniceCapabilities: vi.fn(() => ({ configured: false })),
  venicePrivateChat: vi.fn(() => Promise.resolve('Test insight')),
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
  detectDimensionTopicPatterns,
  detectRegisterDimensionPatterns,
  detectTimeDimensionPatterns,
  runSpiceConsolidation,
} from './spice-consolidation.js';

import { getDefaultChatId, getDatabase, saveMemoryReturningId } from './db.js';
import { findDuplicate } from './memory-extract.js';
import { veniceCapabilities, venicePrivateChat } from './venice.js';

const mockGetDefaultChatId = vi.mocked(getDefaultChatId);
const mockGetDatabase = vi.mocked(getDatabase);
const mockSaveMemory = vi.mocked(saveMemoryReturningId);
const mockFindDuplicate = vi.mocked(findDuplicate);
const mockVeniceCapabilities = vi.mocked(veniceCapabilities);
const mockVenicePrivateChat = vi.mocked(venicePrivateChat);

// Mock database that returns results for pattern detection
function createMockDb(rows: unknown[] = []) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => rows),
      get: vi.fn(() => rows[0]),
      run: vi.fn(),
    })),
  };
}

describe('detectDimensionTopicPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no patterns found', () => {
    mockGetDatabase.mockReturnValue(createMockDb([]) as unknown as ReturnType<typeof getDatabase>);
    const patterns = detectDimensionTopicPatterns();
    expect(patterns).toEqual([]);
  });

  it('returns patterns from SQL results', () => {
    const rows = [
      { dimension: 'perspective', session_topic: 'crypto', cnt: 5 },
      { dimension: 'depth', session_topic: 'technical', cnt: 3 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);

    const patterns = detectDimensionTopicPatterns();
    expect(patterns).toHaveLength(2);
    expect(patterns[0].type).toBe('dimension-topic');
    expect(patterns[0].data.dimension).toBe('perspective');
    expect(patterns[0].data.topic).toBe('crypto');
    expect(patterns[0].data.count).toBe(5);
  });

  it('handles DB errors gracefully', () => {
    mockGetDatabase.mockImplementation(() => { throw new Error('DB locked'); });
    const patterns = detectDimensionTopicPatterns();
    expect(patterns).toEqual([]);
  });
});

describe('detectRegisterDimensionPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns patterns for non-confident registers', () => {
    const rows = [
      { register: 'hostile', dimension: 'energy', cnt: 4 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);

    const patterns = detectRegisterDimensionPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe('register-dimension');
    expect(patterns[0].data.register).toBe('hostile');
  });
});

describe('detectTimeDimensionPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns time-slot patterns', () => {
    const rows = [
      { time_slot: 'evening', dimension: 'warmth', cnt: 7 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);

    const patterns = detectTimeDimensionPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe('time-dimension');
    expect(patterns[0].data.timeSlot).toBe('evening');
  });
});

describe('runSpiceConsolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultChatId.mockReturnValue('test-chat');
    mockVeniceCapabilities.mockReturnValue({ configured: false } as ReturnType<typeof veniceCapabilities>);
    mockFindDuplicate.mockResolvedValue(null);
    mockSaveMemory.mockReturnValue(1);
  });

  it('returns 0 when no chat ID exists', async () => {
    mockGetDefaultChatId.mockReturnValue('');
    const result = await runSpiceConsolidation();
    expect(result).toBe(0);
  });

  it('returns 0 when no patterns detected', async () => {
    mockGetDatabase.mockReturnValue(createMockDb([]) as unknown as ReturnType<typeof getDatabase>);
    const result = await runSpiceConsolidation();
    expect(result).toBe(0);
  });

  it('saves insights for detected patterns', async () => {
    const rows = [
      { dimension: 'perspective', session_topic: 'crypto', cnt: 5 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);

    const result = await runSpiceConsolidation();
    // Mock DB returns same row for all 3 detector queries, so we get 3 patterns saved (capped at 3)
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(3);
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'test-chat',
      expect.any(String),
      'episodic',
      'preferences',
      1.5,
    );
  });

  it('skips duplicate insights', async () => {
    const rows = [
      { dimension: 'perspective', session_topic: 'crypto', cnt: 5 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);
    mockFindDuplicate.mockResolvedValue(42); // existing memory found

    const result = await runSpiceConsolidation();
    expect(result).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('caps at MAX_INSIGHTS_PER_RUN (3)', async () => {
    const rows = [
      { dimension: 'a', session_topic: 'crypto', cnt: 10 },
      { dimension: 'b', session_topic: 'crypto', cnt: 9 },
      { dimension: 'c', session_topic: 'crypto', cnt: 8 },
      { dimension: 'd', session_topic: 'crypto', cnt: 7 },
      { dimension: 'e', session_topic: 'crypto', cnt: 6 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);

    const result = await runSpiceConsolidation();
    // Should cap at 3 even though 5 patterns detected
    expect(result).toBeLessThanOrEqual(3);
  });

  it('uses Venice for insight generation when configured', async () => {
    const rows = [
      { dimension: 'perspective', session_topic: 'crypto', cnt: 5 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);
    mockVeniceCapabilities.mockReturnValue({ configured: true } as ReturnType<typeof veniceCapabilities>);
    mockVenicePrivateChat.mockResolvedValue('Prefers strategic framing during crypto discussions');

    const result = await runSpiceConsolidation();
    // 3 detectors each return 1 pattern = up to 3 saves
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(3);
    expect(mockVenicePrivateChat).toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'test-chat',
      'Prefers strategic framing during crypto discussions',
      'episodic',
      'preferences',
      1.5,
    );
  });

  it('falls back to raw description when Venice fails', async () => {
    const rows = [
      { dimension: 'perspective', session_topic: 'crypto', cnt: 5 },
    ];
    mockGetDatabase.mockReturnValue(createMockDb(rows) as unknown as ReturnType<typeof getDatabase>);
    mockVeniceCapabilities.mockReturnValue({ configured: true } as ReturnType<typeof veniceCapabilities>);
    mockVenicePrivateChat.mockRejectedValue(new Error('Venice down'));

    const result = await runSpiceConsolidation();
    // 3 detectors each return 1 pattern = up to 3 saves (with raw descriptions)
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(3);
    // Should save with raw description
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'test-chat',
      expect.stringContaining('perspective'),
      'episodic',
      'preferences',
      1.5,
    );
  });

  it('handles errors gracefully (fail-open)', async () => {
    mockGetDatabase.mockImplementation(() => { throw new Error('DB locked'); });
    const result = await runSpiceConsolidation();
    expect(result).toBe(0);
  });
});
