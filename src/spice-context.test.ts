import { describe, it, expect, vi } from 'vitest';

vi.mock('./voice-filter.js', () => ({
  detectRegisterName: vi.fn(() => 'confident'),
}));

import {
  getTimeSlot,
  detectTopic,
  computeDimensionWeights,
  weightedPickRandom,
  type TimeSlot,
  type TopicCategory,
  type WeightedDimension,
} from './spice-context.js';

import { detectRegisterName } from './voice-filter.js';

const mockDetectRegister = vi.mocked(detectRegisterName);

const TEST_DIMENSIONS = [
  'cadence', 'warmth', 'curiosity', 'texture', 'energy',
  'perspective', 'pacing', 'humor', 'formality', 'depth',
];

describe('getTimeSlot', () => {
  it('returns overnight for 0-5', () => {
    expect(getTimeSlot(0)).toBe('overnight');
    expect(getTimeSlot(3)).toBe('overnight');
    expect(getTimeSlot(5)).toBe('overnight');
  });

  it('returns morning for 6-11', () => {
    expect(getTimeSlot(6)).toBe('morning');
    expect(getTimeSlot(9)).toBe('morning');
    expect(getTimeSlot(11)).toBe('morning');
  });

  it('returns afternoon for 12-17', () => {
    expect(getTimeSlot(12)).toBe('afternoon');
    expect(getTimeSlot(15)).toBe('afternoon');
    expect(getTimeSlot(17)).toBe('afternoon');
  });

  it('returns evening for 18-23', () => {
    expect(getTimeSlot(18)).toBe('evening');
    expect(getTimeSlot(21)).toBe('evening');
    expect(getTimeSlot(23)).toBe('evening');
  });

  it('defaults to current hour when no arg provided', () => {
    const slot = getTimeSlot();
    expect(['overnight', 'morning', 'afternoon', 'evening']).toContain(slot);
  });
});

describe('detectTopic', () => {
  it('detects crypto topics', () => {
    expect(detectTopic('check the BTC chart')).toBe('crypto');
    expect(detectTopic('any good defi plays?')).toBe('crypto');
    expect(detectTopic('solana memecoin trading')).toBe('crypto');
    expect(detectTopic('portfolio swap token')).toBe('crypto');
  });

  it('detects family topics', () => {
    expect(detectTopic('how is Bob doing at school')).toBe('family');
    expect(detectTopic('Alice birthday plans')).toBe('family');
    expect(detectTopic('need to fix something at the house')).toBe('family');
  });

  it('detects technical topics', () => {
    expect(detectTopic('refactor the database query')).toBe('technical');
    expect(detectTopic('fix the TypeScript build error')).toBe('technical');
    expect(detectTopic('deploy the docker container')).toBe('technical');
    expect(detectTopic('debug the API endpoint')).toBe('technical');
  });

  it('detects planning topics', () => {
    expect(detectTopic('what is the strategy for next quarter')).toBe('planning');
    expect(detectTopic('compare these options and evaluate')).toBe('planning');
    expect(detectTopic('roadmap and timeline for the project')).toBe('planning');
  });

  it('returns general for unmatched messages', () => {
    expect(detectTopic('hello how are you')).toBe('general');
    expect(detectTopic('what is the weather')).toBe('general');
    expect(detectTopic('tell me a joke')).toBe('general');
  });
});

describe('computeDimensionWeights', () => {
  it('returns weights for all dimensions', () => {
    const weights = computeDimensionWeights(TEST_DIMENSIONS);
    expect(weights).toHaveLength(TEST_DIMENSIONS.length);
    for (const w of weights) {
      expect(w.name).toBeDefined();
      expect(w.weight).toBeGreaterThan(0);
    }
  });

  it('applies time-of-day biases (overnight suppresses energy)', () => {
    const weights = computeDimensionWeights(TEST_DIMENSIONS, undefined, 2); // 2am
    const energyWeight = weights.find((w) => w.name === 'energy')!.weight;
    const warmthWeight = weights.find((w) => w.name === 'warmth')!.weight;

    // Energy should be suppressed overnight
    expect(energyWeight).toBeLessThan(1.0);
    // Warmth should be boosted overnight
    expect(warmthWeight).toBeGreaterThan(1.0);
  });

  it('applies topic biases for crypto messages', () => {
    const weights = computeDimensionWeights(TEST_DIMENSIONS, 'check the BTC chart', 14);
    const perspWeight = weights.find((w) => w.name === 'perspective')!.weight;
    const humorWeight = weights.find((w) => w.name === 'humor')!.weight;

    // Perspective should be boosted for crypto
    expect(perspWeight).toBeGreaterThan(1.0);
    // Humor should be suppressed for crypto
    expect(humorWeight).toBeLessThan(1.0);
  });

  it('applies register biases for hostile messages', () => {
    mockDetectRegister.mockReturnValue('hostile');

    const weights = computeDimensionWeights(TEST_DIMENSIONS, 'breach detected unauthorized access');
    const humorWeight = weights.find((w) => w.name === 'humor')!.weight;
    const energyWeight = weights.find((w) => w.name === 'energy')!.weight;

    // Humor should be heavily suppressed in hostile mode
    expect(humorWeight).toBeLessThan(0.5);
    // Energy should be boosted
    expect(energyWeight).toBeGreaterThan(1.0);

    mockDetectRegister.mockReturnValue('confident');
  });

  it('multiplies time + topic + register together', () => {
    mockDetectRegister.mockReturnValue('warm');

    // Evening (humor 1.3) + general topic (no change) + warm register (humor 1.3) = 1.69
    const weights = computeDimensionWeights(TEST_DIMENSIONS, 'good evening', 20);
    const humorWeight = weights.find((w) => w.name === 'humor')!.weight;
    expect(humorWeight).toBeGreaterThan(1.5);

    mockDetectRegister.mockReturnValue('confident');
  });

  it('returns uniform weights for afternoon + general topic + confident register', () => {
    const weights = computeDimensionWeights(TEST_DIMENSIONS, 'hello', 14);
    // Most dimensions should be near 1.0 (no biases)
    const curiosityWeight = weights.find((w) => w.name === 'curiosity')!.weight;
    expect(curiosityWeight).toBe(1.0);
  });
});

describe('weightedPickRandom', () => {
  it('returns the requested count of indices', () => {
    const weights: WeightedDimension[] = TEST_DIMENSIONS.map((name) => ({ name, weight: 1.0 }));
    const result = weightedPickRandom(weights, 3);
    expect(result).toHaveLength(3);
  });

  it('returns unique indices', () => {
    const weights: WeightedDimension[] = TEST_DIMENSIONS.map((name) => ({ name, weight: 1.0 }));
    for (let i = 0; i < 50; i++) {
      const result = weightedPickRandom(weights, 3);
      expect(new Set(result).size).toBe(result.length);
    }
  });

  it('all indices are within range', () => {
    const weights: WeightedDimension[] = TEST_DIMENSIONS.map((name) => ({ name, weight: 1.0 }));
    for (let i = 0; i < 50; i++) {
      const result = weightedPickRandom(weights, 3);
      for (const idx of result) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(TEST_DIMENSIONS.length);
      }
    }
  });

  it('heavily weighted dimension is selected frequently', () => {
    // Give dimension 0 a weight of 100, all others 1
    const weights: WeightedDimension[] = TEST_DIMENSIONS.map((name, i) => ({
      name,
      weight: i === 0 ? 100 : 1,
    }));

    let countZero = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      const result = weightedPickRandom(weights, 3);
      if (result.includes(0)) countZero++;
    }

    // With weight 100 vs 1, dimension 0 should appear in almost all selections
    expect(countZero).toBeGreaterThan(N * 0.9);
  });

  it('handles count > total gracefully', () => {
    const weights: WeightedDimension[] = [
      { name: 'a', weight: 1 },
      { name: 'b', weight: 1 },
    ];
    const result = weightedPickRandom(weights, 5);
    expect(result).toHaveLength(2);
  });
});
