import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  searchMemories: vi.fn(),
  getRecentMemories: vi.fn(),
  getMemoryById: vi.fn(),
  getCoreMemories: vi.fn().mockReturnValue([]),
  countCoreMemories: vi.fn().mockReturnValue(0),
  getAllChatIds: vi.fn().mockReturnValue([]),
  getDatabase: vi.fn().mockReturnValue({ prepare: vi.fn().mockReturnValue({ run: vi.fn(), all: vi.fn().mockReturnValue([]) }) }),
  searchArchiveMemories: vi.fn().mockReturnValue([]),
  setMemoryTier: vi.fn(),
  getEmbeddingsForChat: vi.fn(),
  getEmbeddingForMemory: vi.fn().mockReturnValue(null),
  touchMemory: vi.fn(),
  saveMemory: vi.fn(),
  decayMemories: vi.fn(),
  logConversationTurn: vi.fn(),
  pruneConversationLog: vi.fn(),
  deserializeEmbedding: vi.fn(),
  CORE_MEMORY_LIMIT: 30,
}));

vi.mock('./venice.js', () => ({
  veniceCapabilities: vi.fn(),
}));

vi.mock('./memory-extract.js', () => ({
  extractAndSaveMemories: vi.fn().mockResolvedValue(0),
  embedText: vi.fn().mockResolvedValue(null),
  cosineSimilarity: vi.fn().mockReturnValue(0),
}));

vi.mock('./memory-consolidation.js', () => ({
  runConsolidation: vi.fn().mockResolvedValue({ merged: 0, contradictions: 0, episodicSummaries: 0 }),
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
  buildMemoryContext,
  saveConversationTurn,
  runDecaySweep,
} from './memory.js';

import {
  searchMemories,
  getRecentMemories,
  touchMemory,
  saveMemory,
  decayMemories,
} from './db.js';

import { veniceCapabilities } from './venice.js';
import { extractAndSaveMemories } from './memory-extract.js';

const mockSearchMemories = vi.mocked(searchMemories);
const mockGetRecentMemories = vi.mocked(getRecentMemories);
const mockTouchMemory = vi.mocked(touchMemory);
const mockSaveMemory = vi.mocked(saveMemory);
const mockDecayMemories = vi.mocked(decayMemories);
const mockVeniceCapabilities = vi.mocked(veniceCapabilities);
const mockExtractAndSave = vi.mocked(extractAndSaveMemories);

// ── buildMemoryContext ───────────────────────────────────────────────

describe('buildMemoryContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no embeddings available (embedText returns null via mock)
  });

  it('returns empty string when no memories found', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentMemories.mockReturnValue([]);

    const result = await buildMemoryContext('chat1', 'hello');
    expect(result).toBe('');
  });

  it('returns formatted string when FTS results exist', async () => {
    mockSearchMemories.mockReturnValue([
      {
        id: 1,
        chat_id: 'chat1',
        topic_key: 'preferences',
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
    mockGetRecentMemories.mockReturnValue([]);

    const result = await buildMemoryContext('chat1', 'dark mode');
    expect(result).toContain('[Memory context]');
    expect(result).toContain('Prefers dark mode');
    expect(result).toContain('preferences/semantic');
    expect(result).toContain('[End memory context]');
  });

  it('returns formatted string when recent memories exist', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentMemories.mockReturnValue([
      {
        id: 2,
        chat_id: 'chat1',
        topic_key: null,
        content: 'Recent thought',
        sector: 'episodic',
        tier: 'active',
        agent_id: 'test-bot',
        namespace: 'private',
        access_count: 1,
        half_life_hours: null,
        salience: 1.0,
        created_at: 100,
        accessed_at: 200,
      },
    ]);

    const result = await buildMemoryContext('chat1', 'anything');
    expect(result).toContain('Recent thought');
    expect(result).toContain('episodic');
  });

  it('deduplicates between FTS and recent results', async () => {
    const sharedMemory = {
      id: 1,
      chat_id: 'chat1',
      topic_key: null,
      content: 'shared memory',
      sector: 'semantic',
      tier: 'active',
      agent_id: 'test-bot',
      namespace: 'private',
      access_count: 1,
      half_life_hours: null,
      salience: 1.0,
      created_at: 100,
      accessed_at: 100,
    };

    mockSearchMemories.mockReturnValue([sharedMemory]);
    mockGetRecentMemories.mockReturnValue([sharedMemory]);

    const result = await buildMemoryContext('chat1', 'shared');
    // Should only appear once
    const occurrences = result.split('shared memory').length - 1;
    expect(occurrences).toBe(1);
  });

  it('touches (boosts salience of) returned memories', async () => {
    mockSearchMemories.mockReturnValue([
      {
        id: 10,
        chat_id: 'chat1',
        topic_key: null,
        content: 'mem1',
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
    mockGetRecentMemories.mockReturnValue([
      {
        id: 20,
        chat_id: 'chat1',
        topic_key: null,
        content: 'mem2',
        sector: 'episodic',
        tier: 'active',
        agent_id: 'test-bot',
        namespace: 'private',
        access_count: 1,
        half_life_hours: null,
        salience: 1.0,
        created_at: 100,
        accessed_at: 200,
      },
    ]);

    await buildMemoryContext('chat1', 'test');
    expect(mockTouchMemory).toHaveBeenCalledWith(10);
    expect(mockTouchMemory).toHaveBeenCalledWith(20);
    expect(mockTouchMemory).toHaveBeenCalledTimes(2);
  });

  it('handles empty user message gracefully', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentMemories.mockReturnValue([]);

    const result = await buildMemoryContext('chat1', '');
    expect(result).toBe('');
  });

  it('handles short user message gracefully', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentMemories.mockReturnValue([]);

    const result = await buildMemoryContext('chat1', 'hi');
    expect(result).toBe('');
  });

  it('includes topic_key in output when present', async () => {
    mockSearchMemories.mockReturnValue([
      {
        id: 1,
        chat_id: 'chat1',
        topic_key: 'crypto',
        content: 'Invests in BTC and ETH',
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
    mockGetRecentMemories.mockReturnValue([]);

    const result = await buildMemoryContext('chat1', 'crypto');
    expect(result).toContain('crypto/semantic');
  });

  it('omits topic prefix when topic_key is null', async () => {
    mockSearchMemories.mockReturnValue([
      {
        id: 1,
        chat_id: 'chat1',
        topic_key: null,
        content: 'Some old memory',
        sector: 'episodic',
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
    mockGetRecentMemories.mockReturnValue([]);

    const result = await buildMemoryContext('chat1', 'test');
    expect(result).toContain('(episodic)');
    expect(result).not.toContain('null');
  });
});

// ── saveConversationTurn ─────────────────────────────────────────────

describe('saveConversationTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses Venice extraction when configured', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: true, features: ['chat', 'embeddings'] });
    saveConversationTurn('chat1', 'I prefer TypeScript over JavaScript always', 'Noted.');
    expect(mockExtractAndSave).toHaveBeenCalledWith(
      'chat1',
      'I prefer TypeScript over JavaScript always',
      'Noted.',
    );
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('falls back to regex when Venice is not configured', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: false, features: [] });
    saveConversationTurn('chat1', 'I prefer TypeScript over JavaScript always', 'Noted.');
    expect(mockExtractAndSave).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'chat1',
      'I prefer TypeScript over JavaScript always',
      'semantic',
    );
  });

  it('saves episodic via regex fallback for non-signal messages', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: false, features: [] });
    saveConversationTurn('chat1', 'Can you help me refactor this code please?', 'Sure.');
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'chat1',
      'Can you help me refactor this code please?',
      'episodic',
    );
  });

  it('does NOT save very short messages (<=20 chars)', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: true, features: ['chat'] });
    saveConversationTurn('chat1', 'short msg', 'ok');
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockExtractAndSave).not.toHaveBeenCalled();
  });

  it('does NOT save messages exactly 20 chars', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: true, features: ['chat'] });
    saveConversationTurn('chat1', '12345678901234567890', 'ok');
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockExtractAndSave).not.toHaveBeenCalled();
  });

  it('processes messages that are 21 chars when Venice is configured', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: true, features: ['chat'] });
    saveConversationTurn('chat1', '123456789012345678901', 'ok');
    expect(mockExtractAndSave).toHaveBeenCalled();
  });

  it('does NOT save messages starting with /', () => {
    mockVeniceCapabilities.mockReturnValue({ configured: true, features: ['chat'] });
    saveConversationTurn('chat1', '/command with a long argument that is over 20 chars', 'done');
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockExtractAndSave).not.toHaveBeenCalled();
  });
});

// ── runDecaySweep ────────────────────────────────────────────────────

describe('runDecaySweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls decayMemories once', () => {
    runDecaySweep();
    expect(mockDecayMemories).toHaveBeenCalledOnce();
  });
});
