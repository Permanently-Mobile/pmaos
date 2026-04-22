import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock venice
vi.mock('./venice.js', () => ({
  venicePrivateChat: vi.fn(),
  veniceEmbed: vi.fn(),
  veniceCapabilities: vi.fn().mockReturnValue({ configured: true, features: ['chat', 'embeddings'] }),
}));

// Mock db
vi.mock('./db.js', () => ({
  searchMemories: vi.fn().mockReturnValue([]),
  saveMemoryReturningId: vi.fn().mockReturnValue(1),
  updateMemoryContent: vi.fn(),
  getEmbeddingsForChat: vi.fn().mockReturnValue([]),
  saveEmbedding: vi.fn(),
  deserializeEmbedding: vi.fn().mockReturnValue([]),
  vectorSearch: vi.fn().mockReturnValue([]),
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
  extractFacts,
  findDuplicate,
  extractAndSaveMemories,
  jaccardSimilarity,
  cosineSimilarity,
  embedText,
} from './memory-extract.js';

import { venicePrivateChat, veniceEmbed } from './venice.js';
import { searchMemories, saveMemoryReturningId, updateMemoryContent, saveEmbedding } from './db.js';

const mockVeniceChat = vi.mocked(venicePrivateChat);
const mockVeniceEmbed = vi.mocked(veniceEmbed);
const mockSearchMemories = vi.mocked(searchMemories);
const mockSaveMemoryReturningId = vi.mocked(saveMemoryReturningId);
const mockUpdateMemoryContent = vi.mocked(updateMemoryContent);
const mockSaveEmbedding = vi.mocked(saveEmbedding);

// ── cosineSimilarity ─────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('handles high-dimensional vectors', () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });
});

// ── jaccardSimilarity ────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(jaccardSimilarity('hello world', 'foo bar')).toBe(0.0);
  });

  it('returns partial overlap correctly', () => {
    // "hello world" vs "hello there" -> intersection: {hello} = 1, union: {hello, world, there} = 3
    expect(jaccardSimilarity('hello world', 'hello there')).toBeCloseTo(1 / 3);
  });

  it('is case insensitive', () => {
    expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1.0);
  });

  it('handles empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
  });
});

// ── extractFacts ─────────────────────────────────────────────────────

describe('extractFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses valid JSON response from Venice', async () => {
    mockVeniceChat.mockResolvedValue(
      '[{"fact": "Prefers dark mode", "topic": "preferences", "sector": "semantic"}]',
    );

    const facts = await extractFacts('I always use dark mode on everything', 'Got it.');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      fact: 'Prefers dark mode',
      topic: 'preferences',
      sector: 'semantic',
      importance: 5,
    });
  });

  it('returns empty array when Venice returns []', async () => {
    mockVeniceChat.mockResolvedValue('[]');
    const facts = await extractFacts('Can you help me with something real quick?', 'Sure.');
    expect(facts).toHaveLength(0);
  });

  it('returns empty array when Venice returns invalid JSON', async () => {
    mockVeniceChat.mockResolvedValue('not valid json at all');
    const facts = await extractFacts('I prefer TypeScript always', 'Noted.');
    expect(facts).toHaveLength(0);
  });

  it('returns empty array when Venice throws', async () => {
    mockVeniceChat.mockRejectedValue(new Error('Venice 500'));
    const facts = await extractFacts('I prefer TypeScript always', 'Noted.');
    expect(facts).toHaveLength(0);
  });

  it('filters out facts with invalid topic keys', async () => {
    mockVeniceChat.mockResolvedValue(
      '[{"fact": "Good fact", "topic": "preferences", "sector": "semantic"}, {"fact": "Bad fact", "topic": "invalid_topic", "sector": "semantic"}]',
    );
    const facts = await extractFacts('I prefer lots of things and stuff', 'OK.');
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Good fact');
  });

  it('filters out facts with invalid sector', async () => {
    mockVeniceChat.mockResolvedValue(
      '[{"fact": "Bad sector", "topic": "general", "sector": "unknown"}]',
    );
    const facts = await extractFacts('Some message that is long enough to process', 'OK.');
    expect(facts).toHaveLength(0);
  });

  it('skips messages shorter than MIN_EXTRACT_LENGTH', async () => {
    const facts = await extractFacts('short msg', 'ok');
    expect(facts).toHaveLength(0);
    expect(mockVeniceChat).not.toHaveBeenCalled();
  });

  it('caps at 5 facts per turn', async () => {
    const manyFacts = Array.from({ length: 8 }, (_, i) => ({
      fact: `Fact ${i}`,
      topic: 'general',
      sector: 'episodic',
    }));
    mockVeniceChat.mockResolvedValue(JSON.stringify(manyFacts));
    const facts = await extractFacts('A really long message with lots of info for extraction', 'Noted.');
    expect(facts.length).toBeLessThanOrEqual(5);
  });

  it('handles Venice returning markdown-fenced JSON', async () => {
    mockVeniceChat.mockResolvedValue(
      '```json\n[{"fact": "Uses vim", "topic": "tools", "sector": "semantic"}]\n```',
    );
    const facts = await extractFacts('I always use vim for everything', 'Nice.');
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Uses vim');
  });
});

// ── embedText ────────────────────────────────────────────────────────

describe('embedText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns vector from Venice on success', async () => {
    const vec = [0.1, 0.2, 0.3];
    mockVeniceEmbed.mockResolvedValue({ embeddings: [vec], model: 'test', usage: undefined });
    const result = await embedText('test text');
    expect(result).toEqual(vec);
  });

  it('returns null when Venice throws', async () => {
    mockVeniceEmbed.mockRejectedValue(new Error('Venice down'));
    const result = await embedText('test text');
    expect(result).toBeNull();
  });

  it('returns null when embeddings array is empty', async () => {
    mockVeniceEmbed.mockResolvedValue({ embeddings: [], model: 'test', usage: undefined });
    const result = await embedText('test text');
    expect(result).toBeNull();
  });
});

// ── findDuplicate ────────────────────────────────────────────────────

describe('findDuplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no memories exist', async () => {
    mockSearchMemories.mockReturnValue([]);
    const result = await findDuplicate('chat1', 'some fact');
    expect(result).toBeNull();
  });

  it('returns memory id when Jaccard overlap exceeds threshold', async () => {
    mockSearchMemories.mockReturnValue([
      {
        id: 42,
        chat_id: 'chat1',
        topic_key: null,
        content: 'Prefers dark mode',
        sector: 'semantic',
        tier: 'active',
        agent_id: 'test-bot',
        namespace: 'private',
        access_count: 1,
        half_life_hours: null,
        salience: 1.0,
        created_at: 100,
        accessed_at: 100,
      },
    ]);
    // High overlap with "Prefers dark mode" -- same words
    const result = await findDuplicate('chat1', 'Prefers dark mode');
    expect(result).toBe(42);
  });

  it('returns null when Jaccard overlap is below threshold', async () => {
    mockSearchMemories.mockReturnValue([
      {
        id: 42,
        chat_id: 'chat1',
        topic_key: null,
        content: 'Prefers dark mode for coding',
        sector: 'semantic',
        tier: 'active',
        agent_id: 'test-bot',
        namespace: 'private',
        access_count: 1,
        half_life_hours: null,
        salience: 1.0,
        created_at: 100,
        accessed_at: 100,
      },
    ]);
    // Low overlap
    const result = await findDuplicate('chat1', 'Uses light theme on phone');
    expect(result).toBeNull();
  });
});

// ── extractAndSaveMemories ───────────────────────────────────────────

describe('extractAndSaveMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset debounce by waiting or clearing the map
    // The debounce uses Date.now() so we can mock it
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves extracted facts with correct topic_key', async () => {
    mockVeniceChat.mockResolvedValue(
      '[{"fact": "Prefers TypeScript", "topic": "tools", "sector": "semantic"}]',
    );
    mockVeniceEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2]], model: 'test', usage: undefined });
    mockSearchMemories.mockReturnValue([]);

    const saved = await extractAndSaveMemories('chat1', 'I always prefer TypeScript over JavaScript', 'Noted.');
    expect(saved).toBe(1);
    expect(mockSaveMemoryReturningId).toHaveBeenCalledWith('chat1', 'Prefers TypeScript', 'semantic', 'tools', 2.5, 'test-bot');
  });

  it('updates existing memory on duplicate detection', async () => {
    mockVeniceChat.mockResolvedValue(
      '[{"fact": "Prefers dark mode", "topic": "preferences", "sector": "semantic"}]',
    );
    mockVeniceEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2]], model: 'test', usage: undefined });
    mockSearchMemories.mockReturnValue([
      {
        id: 99,
        chat_id: 'chatDedup',
        topic_key: 'preferences',
        content: 'Prefers dark mode',
        sector: 'semantic',
        tier: 'active',
        agent_id: 'test-bot',
        namespace: 'private',
        access_count: 1,
        half_life_hours: null,
        salience: 2.0,
        created_at: 100,
        accessed_at: 100,
      },
    ]);

    const saved = await extractAndSaveMemories('chatDedup', 'I always use dark mode on everything', 'Got it.');
    expect(saved).toBe(0); // Not a new save, it was a dedup refresh
    expect(mockUpdateMemoryContent).toHaveBeenCalledWith(99, 'Prefers dark mode');
    expect(mockSaveMemoryReturningId).not.toHaveBeenCalled();
  });

  it('returns 0 when Venice returns no facts', async () => {
    mockVeniceChat.mockResolvedValue('[]');

    vi.setSystemTime(new Date('2026-03-05T12:01:00Z')); // Advance past debounce
    const saved = await extractAndSaveMemories('chat2', 'Can you help me with a quick thing?', 'Sure.');
    expect(saved).toBe(0);
  });

  it('never throws (catches all errors)', async () => {
    mockVeniceChat.mockRejectedValue(new Error('Venice exploded'));

    vi.setSystemTime(new Date('2026-03-05T12:02:00Z'));
    const saved = await extractAndSaveMemories('chat3', 'This should not crash the bot at all', 'OK.');
    expect(saved).toBe(0);
  });

  it('saves embedding alongside memory', async () => {
    mockVeniceChat.mockResolvedValue(
      '[{"fact": "Lives in Texas", "topic": "personal", "sector": "semantic"}]',
    );
    const embedding = [0.5, 0.6, 0.7];
    mockVeniceEmbed.mockResolvedValue({ embeddings: [embedding], model: 'test', usage: undefined });
    mockSearchMemories.mockReturnValue([]);
    mockSaveMemoryReturningId.mockReturnValue(55);

    vi.setSystemTime(new Date('2026-03-05T12:03:00Z'));
    await extractAndSaveMemories('chat4', 'I live in Texas with my family and have for years', 'Cool.');
    expect(mockSaveEmbedding).toHaveBeenCalledWith(55, embedding, 'text-embedding-bge-m3', 'chat4');
  });
});
