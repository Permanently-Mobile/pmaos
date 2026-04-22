import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BOT_PROFILE,
  getAllProfileDirectives,
  pickRandom,
  rollCharacter,
  rollDNASpices,
  rollContextualDNASpices,
  validateProfile,
  type SpiceRollResult,
} from './personality-dna.js';

import { SPICE_DIMENSIONS } from './spice.js';

describe('pickRandom', () => {
  it('returns the requested count of indices', () => {
    const result = pickRandom(7, 3);
    expect(result).toHaveLength(3);
  });

  it('returns unique indices', () => {
    for (let i = 0; i < 50; i++) {
      const result = pickRandom(7, 3);
      expect(new Set(result).size).toBe(result.length);
    }
  });

  it('all indices are within range', () => {
    for (let i = 0; i < 50; i++) {
      const result = pickRandom(10, 5);
      for (const idx of result) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(10);
      }
    }
  });

  it('handles count > total gracefully', () => {
    const result = pickRandom(3, 5);
    expect(result).toHaveLength(3);
  });
});

describe('validateProfile', () => {
  it('passes for DEFAULT_BOT_PROFILE', () => {
    expect(() => validateProfile(DEFAULT_BOT_PROFILE)).not.toThrow();
  });

  it('throws if weights do not sum to 1.0', () => {
    expect(() =>
      validateProfile({
        id: 'bad',
        characters: [
          { id: 'a', name: 'A', weight: 0.5, dimensions: {} },
          { id: 'b', name: 'B', weight: 0.3, dimensions: {} },
        ],
      }),
    ).toThrow('weights sum to');
  });

  it('passes for weights very close to 1.0 (floating point)', () => {
    expect(() =>
      validateProfile({
        id: 'ok',
        characters: [
          { id: 'a', name: 'A', weight: 0.65, dimensions: {} },
          { id: 'b', name: 'B', weight: 0.20, dimensions: {} },
          { id: 'c', name: 'C', weight: 0.15, dimensions: {} },
        ],
      }),
    ).not.toThrow();
  });
});

describe('rollCharacter', () => {
  it('returns a character from the profile', () => {
    const { characters } = DEFAULT_BOT_PROFILE;
    for (let i = 0; i < 50; i++) {
      const char = rollCharacter(characters);
      expect(characters).toContain(char);
    }
  });

  it('distribution roughly matches weights over many rolls', () => {
    const { characters } = DEFAULT_BOT_PROFILE;
    const counts: Record<string, number> = {};
    const N = 10000;

    for (let i = 0; i < N; i++) {
      const char = rollCharacter(characters);
      counts[char.id] = (counts[char.id] || 0) + 1;
    }

    // Allow 5% tolerance
    for (const char of characters) {
      const actual = (counts[char.id] || 0) / N;
      expect(actual).toBeGreaterThan(char.weight - 0.05);
      expect(actual).toBeLessThan(char.weight + 0.05);
    }
  });
});

describe('rollDNASpices', () => {
  it('returns ACTIVE_COUNT SpiceRollResult objects', () => {
    const result = rollDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3);
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r).toHaveProperty('directive');
      expect(r).toHaveProperty('dimension');
      expect(r).toHaveProperty('characterId');
    }
  });

  it('all directives are strings from character profiles or generic pool', () => {
    const allOptions = [
      ...getAllProfileDirectives(DEFAULT_BOT_PROFILE),
      ...SPICE_DIMENSIONS.flatMap((d) => d.options),
    ];

    for (let i = 0; i < 50; i++) {
      const results = rollDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3);
      for (const r of results) {
        expect(allOptions).toContain(r.directive);
      }
    }
  });

  it('returns valid dimension names', () => {
    const dimNames = new Set(SPICE_DIMENSIONS.map((d) => d.name));
    for (let i = 0; i < 50; i++) {
      const results = rollDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3);
      for (const r of results) {
        expect(dimNames).toContain(r.dimension);
      }
    }
  });

  it('returns valid character IDs', () => {
    const charIds = new Set(DEFAULT_BOT_PROFILE.characters.map((c) => c.id));
    for (let i = 0; i < 50; i++) {
      const results = rollDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3);
      for (const r of results) {
        expect(charIds).toContain(r.characterId);
      }
    }
  });

  it('picks from different dimensions (no two from same dimension)', () => {
    for (let i = 0; i < 50; i++) {
      const results = rollDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3);
      const dims = results.map((r) => r.dimension);
      expect(new Set(dims).size).toBe(dims.length);
    }
  });

  it('falls back to generic pool when character has no dimension options', () => {
    const sparseProfile = {
      id: 'sparse',
      characters: [
        {
          id: 'only-cadence',
          name: 'Sparse',
          weight: 1.0,
          dimensions: {
            cadence: ['Test cadence directive.'],
            // No other dimensions -- should fall back to generic pool
          },
        },
      ],
    };

    // When the dimension picked is not 'cadence', should fall back to generic pool
    for (let i = 0; i < 50; i++) {
      const result = rollDNASpices(sparseProfile, SPICE_DIMENSIONS, 3);
      expect(result).toHaveLength(3);
      for (const r of result) {
        expect(typeof r.directive).toBe('string');
        expect(r.directive.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('DEFAULT_BOT_PROFILE', () => {
  it('has 3 characters', () => {
    expect(DEFAULT_BOT_PROFILE.characters).toHaveLength(3);
  });

  it('weights sum to 1.0', () => {
    const sum = DEFAULT_BOT_PROFILE.characters.reduce((s, c) => s + c.weight, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  });

  it('every character covers all 10 dimensions', () => {
    const dimNames = SPICE_DIMENSIONS.map((d) => d.name);
    for (const char of DEFAULT_BOT_PROFILE.characters) {
      for (const name of dimNames) {
        expect(char.dimensions[name]).toBeDefined();
        expect(char.dimensions[name].length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('no directive contains em dashes', () => {
    const all = getAllProfileDirectives(DEFAULT_BOT_PROFILE);
    for (const d of all) {
      expect(d).not.toContain('\u2014'); // em dash
      expect(d).not.toContain('\u2013'); // en dash
    }
  });

  it('no directive contains AI cliches', () => {
    const cliches = ['certainly', 'great question', "i'd be happy to", 'as an ai'];
    const all = getAllProfileDirectives(DEFAULT_BOT_PROFILE);
    for (const d of all) {
      const lower = d.toLowerCase();
      for (const c of cliches) {
        expect(lower).not.toContain(c);
      }
    }
  });

  it('character IDs are unique', () => {
    const ids = DEFAULT_BOT_PROFILE.characters.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getAllProfileDirectives', () => {
  it('returns all directives from all characters', () => {
    const all = getAllProfileDirectives(DEFAULT_BOT_PROFILE);
    // 3 characters, 10 dimensions each, 3-5 options each = ~90-150 total
    expect(all.length).toBeGreaterThan(90);
    expect(all.every((d) => typeof d === 'string')).toBe(true);
  });
});

describe('rollContextualDNASpices', () => {
  it('returns correct number of SpiceRollResult objects', () => {
    const weights = SPICE_DIMENSIONS.map((d) => ({ name: d.name, weight: 1.0 }));
    const result = rollContextualDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3, weights);
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r).toHaveProperty('directive');
      expect(r).toHaveProperty('dimension');
      expect(r).toHaveProperty('characterId');
    }
  });

  it('respects weighted dimension selection (heavily weighted dim is picked more often)', () => {
    // Give 'cadence' a weight of 100, all others 0.1
    const weights = SPICE_DIMENSIONS.map((d) => ({
      name: d.name,
      weight: d.name === 'cadence' ? 100 : 0.1,
    }));

    let cadenceCount = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      const results = rollContextualDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3, weights);
      if (results.some((r) => r.dimension === 'cadence')) cadenceCount++;
    }

    // cadence should appear in almost all selections
    expect(cadenceCount).toBeGreaterThan(N * 0.85);
  });

  it('all directives come from valid pools', () => {
    const allOptions = [
      ...getAllProfileDirectives(DEFAULT_BOT_PROFILE),
      ...SPICE_DIMENSIONS.flatMap((d) => d.options),
    ];
    const weights = SPICE_DIMENSIONS.map((d) => ({ name: d.name, weight: 1.0 }));

    for (let i = 0; i < 50; i++) {
      const results = rollContextualDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3, weights);
      for (const r of results) {
        expect(allOptions).toContain(r.directive);
      }
    }
  });

  it('picks from different dimensions (no duplicates)', () => {
    const weights = SPICE_DIMENSIONS.map((d) => ({ name: d.name, weight: 1.0 }));
    for (let i = 0; i < 50; i++) {
      const results = rollContextualDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3, weights);
      const dims = results.map((r) => r.dimension);
      expect(new Set(dims).size).toBe(dims.length);
    }
  });

  it('returns valid character IDs', () => {
    const charIds = new Set(DEFAULT_BOT_PROFILE.characters.map((c) => c.id));
    const weights = SPICE_DIMENSIONS.map((d) => ({ name: d.name, weight: 1.0 }));
    for (let i = 0; i < 50; i++) {
      const results = rollContextualDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3, weights);
      for (const r of results) {
        expect(charIds).toContain(r.characterId);
      }
    }
  });

  it('falls back to uniform random if weighted selection errors', () => {
    // Pass empty weights array -- should still produce results via fallback
    const result = rollContextualDNASpices(DEFAULT_BOT_PROFILE, SPICE_DIMENSIONS, 3, []);
    expect(result).toHaveLength(3);
  });
});
