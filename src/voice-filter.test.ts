import { describe, it, expect } from 'vitest';

import {
  buildVoiceFilter,
  VOICE_FILTER_MARKERS,
  detectRegister,
  detectRegisterName,
  type RegisterName,
} from './voice-filter.js';

describe('buildVoiceFilter', () => {
  it('returns a non-empty string', () => {
    const result = buildVoiceFilter();
    expect(result.length).toBeGreaterThan(0);
  });

  it('is wrapped in voice tags', () => {
    const result = buildVoiceFilter();
    expect(result).toContain('[Bot voice');
    expect(result).toContain('[End voice]');
  });

  it('mentions sentence length guidance', () => {
    const result = buildVoiceFilter();
    expect(result).toMatch(/\d+-\d+ words/);
  });

  it('discourages hedging language', () => {
    const result = buildVoiceFilter();
    for (const word of VOICE_FILTER_MARKERS.discouraged) {
      expect(result).toContain(word);
    }
  });

  it('encourages vocabulary flavor', () => {
    const result = buildVoiceFilter();
    for (const word of VOICE_FILTER_MARKERS.encouraged) {
      expect(result).toContain(word);
    }
  });

  it('contains no em dashes', () => {
    const result = buildVoiceFilter();
    expect(result).not.toContain('\u2014'); // em dash
    expect(result).not.toContain('\u2013'); // en dash
  });

  it('contains no AI cliches', () => {
    const cliches = ['certainly', 'great question', "i'd be happy to", 'as an ai'];
    const result = buildVoiceFilter().toLowerCase();
    for (const c of cliches) {
      expect(result).not.toContain(c);
    }
  });

  it('base filter stays under 250 tokens (rough estimate: words / 0.75)', () => {
    const result = buildVoiceFilter();
    const wordCount = result.split(/\s+/).length;
    const estimatedTokens = Math.ceil(wordCount / 0.75);
    expect(estimatedTokens).toBeLessThan(250);
  });

  it('mentions exclamation mark limit', () => {
    const result = buildVoiceFilter();
    expect(result.toLowerCase()).toContain('exclamation');
  });

  it('includes power language directive', () => {
    const result = buildVoiceFilter();
    expect(result).toContain("don't worry");
    expect(result).toContain('business');
  });

  it('includes confidence without narration directive', () => {
    const result = buildVoiceFilter();
    expect(result).toContain('narration');
    expect(result).toContain('Actions speak');
  });
});

describe('buildVoiceFilter with message (register detection)', () => {
  it('returns base filter when no message provided', () => {
    const result = buildVoiceFilter();
    expect(result).not.toContain('[Bot register]');
  });

  it('returns base filter for confident (default) messages', () => {
    const result = buildVoiceFilter('what time is it');
    expect(result).not.toContain('[Bot register]');
  });

  it('appends register block for security threats', () => {
    const result = buildVoiceFilter('we have a breach in the system');
    expect(result).toContain('[Bot register]');
    expect(result).toContain('hostile');
  });

  it('appends register block for family mentions', () => {
    const result = buildVoiceFilter('is Sam safe on that network');
    expect(result).toContain('[Bot register]');
    expect(result).toContain('protective');
  });

  it('appends register block for strategic planning', () => {
    const result = buildVoiceFilter('what strategy should we use for the roadmap');
    expect(result).toContain('[Bot register]');
    expect(result).toContain('strategic');
  });

  it('appends register block for warm moments', () => {
    const result = buildVoiceFilter('thanks, good job on that');
    expect(result).toContain('[Bot register]');
    expect(result).toContain('warm');
  });

  it('combined output stays under 350 tokens', () => {
    const result = buildVoiceFilter('there was a breach detected');
    const wordCount = result.split(/\s+/).length;
    const estimatedTokens = Math.ceil(wordCount / 0.75);
    expect(estimatedTokens).toBeLessThan(350);
  });
});

describe('detectRegister', () => {
  it('returns empty string for neutral messages', () => {
    expect(detectRegister('check the dashboard')).toBe('');
  });

  it('detects hostile register', () => {
    expect(detectRegister('someone hacked the server')).toContain('hostile');
    expect(detectRegister('unauthorized access detected')).toContain('hostile');
    expect(detectRegister('malicious payload found')).toContain('hostile');
  });

  it('detects protective register', () => {
    expect(detectRegister("how's Sam doing")).toContain('protective');
    expect(detectRegister('is the family data safe')).toContain('protective');
    expect(detectRegister('lock down Alice account')).toContain('protective');
  });

  it('detects strategic register', () => {
    expect(detectRegister('compare these two approaches')).toContain('strategic');
    expect(detectRegister("let's plan the next phase")).toContain('strategic');
    expect(detectRegister('weigh the options for portfolio')).toContain('strategic');
  });

  it('detects warm register', () => {
    expect(detectRegister('thanks for that')).toContain('warm');
    expect(detectRegister('good morning')).toContain('warm');
    expect(detectRegister('we finally hit the milestone')).toContain('warm');
  });

  it('hostile takes priority over protective', () => {
    // "Sam" triggers protective, "breach" triggers hostile
    // Hostile should win (higher priority)
    const result = detectRegisterName("Sam's account was breached");
    expect(result).toBe('hostile');
  });

  it('protective takes priority over strategic', () => {
    const result = detectRegisterName("what's the strategy to keep Sam safe");
    expect(result).toBe('protective');
  });
});

describe('detectRegisterName', () => {
  it('returns confident for neutral messages', () => {
    expect(detectRegisterName('run the build')).toBe('confident');
  });

  it('returns hostile for threats', () => {
    expect(detectRegisterName('exploit detected in logs')).toBe('hostile');
  });

  it('returns protective for family', () => {
    expect(detectRegisterName('check on Sam')).toBe('protective');
  });

  it('returns strategic for planning', () => {
    expect(detectRegisterName("let's evaluate the tradeoff")).toBe('strategic');
  });

  it('returns warm for appreciation', () => {
    expect(detectRegisterName('appreciate you handling that')).toBe('warm');
  });
});

/**
 * Validation Pairs -- register detection coverage.
 * These match the 23 tuning pairs in Projects/Bot Voice/Voice Tuning Pairs.md.
 * Tests register detection accuracy (not response quality -- that's manual).
 */
describe('Validation Pairs (register detection)', () => {
  const pairs: { prompt: string; expected: RegisterName; id: number }[] = [
    // Confident (default)
    { id: 1, prompt: 'check pm2 status', expected: 'confident' },
    { id: 2, prompt: "what's the current trader-1 status", expected: 'confident' },
    { id: 3, prompt: 'did the build pass', expected: 'confident' },
    // Warm (light)
    { id: 4, prompt: 'nice, that worked perfectly', expected: 'confident' }, // no warm trigger in "nice"
    // Protective
    { id: 5, prompt: "is Sam's network isolated properly", expected: 'protective' },
    { id: 6, prompt: 'is our family data touching any external servers', expected: 'protective' },
    { id: 7, prompt: 'what can Sam access from his VLAN', expected: 'protective' },
    // Strategic
    { id: 8, prompt: 'should we use Docker or bare metal for the trading bots', expected: 'strategic' },
    { id: 9, prompt: "let's plan the Dashboard build phases", expected: 'strategic' },
    { id: 10, prompt: 'evaluate this portfolio allocation for next month', expected: 'strategic' },
    { id: 11, prompt: 'compare Suricata vs Snort for our network', expected: 'strategic' },
    // Hostile
    { id: 12, prompt: 'unauthorized access detected on VLAN 30', expected: 'hostile' },
    { id: 13, prompt: 'this skill tried to exfiltrate API keys to an external URL', expected: 'hostile' },
    { id: 14, prompt: "someone's been trying to hack the dashboard endpoint", expected: 'hostile' },
    // Warm
    { id: 15, prompt: "thanks, you've been crushing it today", expected: 'warm' },
    { id: 16, prompt: 'we finally got all VLANs working. the whole house is online', expected: 'warm' },
    { id: 17, prompt: 'good morning', expected: 'warm' },
    // Power language (confident)
    { id: 19, prompt: 'the arbitrage scanner found a $400 flip on a PS5', expected: 'confident' },
    { id: 20, prompt: 'restart the dashboard', expected: 'confident' },
    // Mixed -- family + strategy -> protective wins
    { id: 21, prompt: "what's the best way to set up parental controls for Sam", expected: 'protective' },
    // Mixed -- family + ambiguous access (no explicit hostile keyword) -> protective wins
    { id: 22, prompt: "someone tried to access Sam's device from outside the network", expected: 'protective' },
    // Mixed -- casual with strategy keyword -> strategic
    { id: 23, prompt: 'what phase is the voice project on', expected: 'strategic' },
  ];

  for (const pair of pairs) {
    it(`Pair ${pair.id}: "${pair.prompt}" -> ${pair.expected}`, () => {
      expect(detectRegisterName(pair.prompt)).toBe(pair.expected);
    });
  }
});

describe('VOICE_FILTER_MARKERS', () => {
  it('has encouraged vocabulary', () => {
    expect(VOICE_FILTER_MARKERS.encouraged.length).toBeGreaterThanOrEqual(3);
  });

  it('has discouraged vocabulary', () => {
    expect(VOICE_FILTER_MARKERS.discouraged.length).toBeGreaterThanOrEqual(3);
  });

  it('sentence length range is valid', () => {
    expect(VOICE_FILTER_MARKERS.sentenceLength.min).toBeLessThan(
      VOICE_FILTER_MARKERS.sentenceLength.max,
    );
  });

  it('max exclamations is 1', () => {
    expect(VOICE_FILTER_MARKERS.maxExclamations).toBe(1);
  });
});
