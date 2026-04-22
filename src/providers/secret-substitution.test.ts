/**
 * Secret Substitution Layer -- Unit Tests
 *
 * Tests all pattern categories, substitution + restoration round-trip,
 * edge cases (nested secrets, partial matches, overlapping detections).
 *
 * Uses vitest (project test runner).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SecretSubstitution } from './secret-substitution.js';
import { PATTERN_COUNT } from './secret-patterns.js';

let sub: SecretSubstitution;

beforeAll(() => {
  sub = new SecretSubstitution();
});

// ── Pattern count sanity check ──────────────────────────────────────

describe('SecretSubstitution - pattern loading', () => {
  it('loads a large number of patterns', () => {
    expect(sub.getPatternCount()).toBeGreaterThan(50);
    expect(PATTERN_COUNT).toBeGreaterThan(50);
  });
});

// ── AWS patterns ────────────────────────────────────────────────────

describe('SecretSubstitution - AWS', () => {
  it('detects AWS access key IDs', () => {
    const matches = sub.scan('My key is AKIAIOSFODNN7EXAMPLE');
    expect(matches.some(m => m.category === 'aws' && m.pattern === 'aws-access-key-id')).toBe(true);
  });

  it('detects AWS secret access key in env format', () => {
    const matches = sub.scan('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1');
    expect(matches.some(m => m.category === 'aws' && m.pattern === 'aws-secret-access-key')).toBe(true);
  });
});

// ── GCP patterns ────────────────────────────────────────────────────

describe('SecretSubstitution - GCP', () => {
  it('detects GCP API keys', () => {
    const matches = sub.scan('Use this key AIzaSyA0abcdefghijklmnopqrstuvwxyz12345');
    expect(matches.some(m => m.category === 'gcp' && m.pattern === 'gcp-api-key')).toBe(true);
  });

  it('detects GCP OAuth tokens', () => {
    const matches = sub.scan('Token: ya29.a0ARrdaM_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    expect(matches.some(m => m.category === 'gcp')).toBe(true);
  });
});

// ── Azure patterns ──────────────────────────────────────────────────

describe('SecretSubstitution - Azure', () => {
  it('detects Azure storage connection strings', () => {
    const connStr = 'DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMn==;';
    const matches = sub.scan(connStr);
    expect(matches.some(m => m.category === 'azure')).toBe(true);
  });
});

// ── Generic API key patterns ────────────────────────────────────────

describe('SecretSubstitution - Generic API keys', () => {
  it('detects api_key assignments', () => {
    const matches = sub.scan('api_key = "sk_test_abcdefghij1234567890"');
    expect(matches.some(m => m.category === 'api-key')).toBe(true);
  });

  it('detects Bearer token assignments', () => {
    const matches = sub.scan('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test-token-value');
    expect(matches.some(m => m.pattern.includes('bearer') || m.category === 'jwt')).toBe(true);
  });

  it('detects password assignments in quotes', () => {
    const matches = sub.scan('password = "my_super_secret_password_123"');
    expect(matches.some(m => m.pattern.includes('password'))).toBe(true);
  });
});

// ── Database patterns ───────────────────────────────────────────────

describe('SecretSubstitution - Database', () => {
  it('detects PostgreSQL connection strings', () => {
    const matches = sub.scan('postgres://admin:p4ssw0rd@db.example.com:5432/mydb');
    expect(matches.some(m => m.category === 'database' && m.pattern === 'postgres-connection-string')).toBe(true);
  });

  it('detects MongoDB connection strings', () => {
    const matches = sub.scan('mongodb+srv://user:pass@cluster0.abc.mongodb.net/mydb');
    expect(matches.some(m => m.category === 'database' && m.pattern === 'mongodb-connection-string')).toBe(true);
  });

  it('detects MySQL connection strings', () => {
    const matches = sub.scan('mysql://root:secretpass@localhost:3306/appdb');
    expect(matches.some(m => m.category === 'database' && m.pattern === 'mysql-connection-string')).toBe(true);
  });

  it('detects Redis connection strings', () => {
    const matches = sub.scan('redis://default:myredispass@redis.example.com:6379/0');
    expect(matches.some(m => m.category === 'database')).toBe(true);
  });

  it('detects DB_PASSWORD env vars', () => {
    const matches = sub.scan('DB_PASSWORD=my_database_pass_2024');
    expect(matches.some(m => m.category === 'database' && m.pattern === 'db-password-config')).toBe(true);
  });
});

// ── JWT patterns ────────────────────────────────────────────────────

describe('SecretSubstitution - JWT', () => {
  it('detects JWT tokens', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const matches = sub.scan(`Bearer ${token}`);
    expect(matches.some(m => m.category === 'jwt' && m.pattern === 'jwt-token')).toBe(true);
  });
});

// ── SSH/PGP private keys ────────────────────────────────────────────

describe('SecretSubstitution - Private keys', () => {
  it('detects RSA private keys', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z...\n-----END RSA PRIVATE KEY-----';
    const matches = sub.scan(key);
    expect(matches.some(m => m.category === 'private-key' && m.pattern === 'rsa-private-key')).toBe(true);
  });

  it('detects OpenSSH private keys', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE...\n-----END OPENSSH PRIVATE KEY-----';
    const matches = sub.scan(key);
    expect(matches.some(m => m.category === 'private-key' && m.pattern === 'openssh-private-key')).toBe(true);
  });

  it('detects PGP private keys', () => {
    const key = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBF...\n-----END PGP PRIVATE KEY BLOCK-----';
    const matches = sub.scan(key);
    expect(matches.some(m => m.category === 'private-key' && m.pattern === 'pgp-private-key')).toBe(true);
  });
});

// ── Messaging / bot tokens ──────────────────────────────────────────

describe('SecretSubstitution - Messaging tokens', () => {
  it('detects Telegram bot tokens', () => {
    // Format: 8-10 digits : 35 alphanumeric/underscore/dash chars
    const matches = sub.scan('TELEGRAM_BOT_TOKEN=1234567890:ABCDefghIJKLmnoPQRSTuvwxyz123456789');
    expect(matches.some(m => m.category === 'messaging')).toBe(true);
  });

  it('detects Slack bot tokens', () => {
    // Format: xoxb-{10-13 digits}-{10-13 digits}-{24 alphanum}
    const matches = sub.scan('Token: xoxb-1234567890-1234567890-ABCDefghIJKLmnoPQRSTuvwx');
    expect(matches.some(m => m.category === 'messaging' && m.pattern === 'slack-bot-token')).toBe(true);
  });

  it('detects Slack webhook URLs', () => {
    const matches = sub.scan('https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX');
    expect(matches.some(m => m.category === 'messaging' && m.pattern === 'slack-webhook-url')).toBe(true);
  });
});

// ── GitHub tokens ───────────────────────────────────────────────────

describe('SecretSubstitution - GitHub', () => {
  it('detects GitHub personal access tokens (ghp_)', () => {
    // Format: ghp_ + 36 alphanumeric chars
    const matches = sub.scan('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(matches.some(m => m.category === 'source-control' && m.pattern === 'github-personal-access-token')).toBe(true);
  });

  it('detects GitHub OAuth tokens (gho_)', () => {
    // Format: gho_ + 36 alphanumeric chars
    const matches = sub.scan('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(matches.some(m => m.category === 'source-control' && m.pattern === 'github-oauth-token')).toBe(true);
  });

  it('detects GitHub app tokens (ghs_)', () => {
    // Format: ghs_ + 36 alphanumeric chars
    const matches = sub.scan('ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(matches.some(m => m.category === 'source-control' && m.pattern === 'github-app-token')).toBe(true);
  });
});

// ── AI provider keys ────────────────────────────────────────────────

describe('SecretSubstitution - AI providers', () => {
  it('detects Anthropic API keys', () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(90) + 'AA';
    const matches = sub.scan(key);
    expect(matches.some(m => m.category === 'ai-provider' && m.pattern === 'anthropic-api-key')).toBe(true);
  });

  it('detects Groq API keys', () => {
    const key = 'gsk_' + 'A'.repeat(50);
    const matches = sub.scan(key);
    expect(matches.some(m => m.category === 'ai-provider' && m.pattern === 'groq-api-key')).toBe(true);
  });

  it('detects HuggingFace tokens', () => {
    const matches = sub.scan('hf_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh');
    expect(matches.some(m => m.category === 'ai-provider' && m.pattern === 'huggingface-token')).toBe(true);
  });
});

// ── SaaS provider keys ──────────────────────────────────────────────

describe('SecretSubstitution - SaaS providers', () => {
  it('detects Stripe secret keys', () => {
    const matches = sub.scan('sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZab');
    expect(matches.some(m => m.category === 'saas' && m.pattern === 'stripe-secret-key')).toBe(true);
  });

  it('detects SendGrid API keys', () => {
    // Format: SG.{22 chars}.{43 chars}
    const key = 'SG.' + 'A'.repeat(22) + '.' + 'B'.repeat(43);
    const matches = sub.scan(key);
    expect(matches.some(m => m.category === 'saas' && m.pattern === 'sendgrid-api-key')).toBe(true);
  });
});

// ── URL-embedded credentials ────────────────────────────────────────

describe('SecretSubstitution - URL credentials', () => {
  it('detects basic auth in URLs', () => {
    const matches = sub.scan('https://admin:password123@api.example.com/v1');
    expect(matches.some(m => m.category === 'url-credential' && m.pattern === 'basic-auth-in-url')).toBe(true);
  });

  it('detects FTP credentials', () => {
    const matches = sub.scan('ftp://deploy:s3cr3t@ftp.example.com/public');
    expect(matches.some(m => m.category === 'url-credential' && m.pattern === 'ftp-credentials')).toBe(true);
  });
});

// ── SMTP credentials ────────────────────────────────────────────────

describe('SecretSubstitution - SMTP', () => {
  it('detects SMTP password env vars', () => {
    const matches = sub.scan('SMTP_PASSWORD=my_email_password_2024');
    expect(matches.some(m => m.category === 'smtp' && m.pattern === 'smtp-password')).toBe(true);
  });

  it('detects SMTP connection URLs', () => {
    const matches = sub.scan('smtps://user:pass@smtp.gmail.com:465');
    expect(matches.some(m => m.category === 'smtp' && m.pattern === 'smtp-connection-url')).toBe(true);
  });
});

// ── Environment variable patterns ───────────────────────────────────

describe('SecretSubstitution - .env format', () => {
  it('detects secret env vars', () => {
    const matches = sub.scan('MY_API_SECRET=abcdefghijklmnop1234567890');
    expect(matches.some(m => m.category === 'env')).toBe(true);
  });

  it('detects DATABASE_URL env vars', () => {
    const matches = sub.scan('DATABASE_URL=postgres://user:pass@host:5432/db');
    expect(matches.some(m => m.category === 'env' || m.category === 'database')).toBe(true);
  });
});

// ── Misc patterns ───────────────────────────────────────────────────

describe('SecretSubstitution - Misc', () => {
  it('detects age secret keys', () => {
    const key = 'AGE-SECRET-KEY-' + 'A'.repeat(59);
    const matches = sub.scan(key);
    expect(matches.some(m => m.pattern === 'age-secret-key')).toBe(true);
  });

  it('detects npm access tokens', () => {
    const matches = sub.scan('npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    expect(matches.some(m => m.pattern === 'npm-access-token')).toBe(true);
  });
});

// ── Substitution + Restoration round-trip ───────────────────────────

describe('SecretSubstitution - round-trip', () => {
  it('substitutes and restores a single secret', () => {
    const original = 'Connect to postgres://admin:p4ssw0rd@db.example.com:5432/mydb for the API';
    const { sanitized, map, matchCount } = sub.substitute(original);

    expect(matchCount).toBeGreaterThan(0);
    expect(sanitized).not.toContain('p4ssw0rd');
    expect(sanitized).toMatch(/\{\{SECRET_\d{3}\}\}/);

    const restored = sub.restore(sanitized, map);
    expect(restored).toBe(original);
  });

  it('substitutes and restores multiple secrets', () => {
    const original = [
      'DB_PASSWORD=my_super_secret',
      'api_key = "sk_test_abcdefghij1234567890"',
      'SMTP_PASSWORD=email_pass_2024',
    ].join('\n');

    const { sanitized, map, matchCount } = sub.substitute(original);

    expect(matchCount).toBeGreaterThanOrEqual(3);
    expect(sanitized).not.toContain('my_super_secret');
    expect(sanitized).not.toContain('sk_test_abcdefghij1234567890');
    expect(sanitized).not.toContain('email_pass_2024');

    const restored = sub.restore(sanitized, map);
    expect(restored).toBe(original);
  });

  it('returns unchanged text when no secrets found', () => {
    const text = 'Hello world, this is a normal message with no secrets.';
    const { sanitized, map, matchCount } = sub.substitute(text);

    expect(sanitized).toBe(text);
    expect(matchCount).toBe(0);
    expect(map.size).toBe(0);
  });

  it('handles restoration when LLM repeats a placeholder', () => {
    const original = 'Use key AKIAIOSFODNN7EXAMPLE for auth';
    const { sanitized, map } = sub.substitute(original);

    // Simulate LLM repeating the placeholder
    const llmOutput = `I'll use ${sanitized.match(/\{\{SECRET_\d{3}\}\}/)?.[0]} in the code. And again: ${sanitized.match(/\{\{SECRET_\d{3}\}\}/)?.[0]}`;
    const restored = sub.restore(llmOutput, map);

    expect(restored).not.toContain('SECRET_');
    expect(restored).toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('SecretSubstitution - edge cases', () => {
  it('handles empty text', () => {
    const { sanitized, matchCount } = sub.substitute('');
    expect(sanitized).toBe('');
    expect(matchCount).toBe(0);
  });

  it('handles text with only whitespace', () => {
    const { sanitized, matchCount } = sub.substitute('   \n\t  ');
    expect(sanitized).toBe('   \n\t  ');
    expect(matchCount).toBe(0);
  });

  it('does not false-positive on normal text', () => {
    const normalText = 'Please update the configuration file to use the new database. The API documentation is at docs.example.com.';
    const { matchCount } = sub.substitute(normalText);
    expect(matchCount).toBe(0);
  });

  it('handles secrets adjacent to each other', () => {
    // Use correctly-sized tokens: ghp_ + 36 chars, xoxb format with 24 char suffix
    const text = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij xoxb-1234567890-1234567890-ABCDefghIJKLmnoPQRSTuvwx';
    const { sanitized, map, matchCount } = sub.substitute(text);
    expect(matchCount).toBeGreaterThanOrEqual(2);

    const restored = sub.restore(sanitized, map);
    expect(restored).toBe(text);
  });

  it('restore() is a no-op with empty map', () => {
    const text = 'Some text {{SECRET_001}} here';
    const restored = sub.restore(text, new Map());
    expect(restored).toBe(text);
  });
});
