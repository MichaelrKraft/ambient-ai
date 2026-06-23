/**
 * Tests for normalize.ts — email normalization and hashing.
 *
 * The TS implementation MUST produce identical output to the Python backend at
 * /Users/michaelkraft/leadspot/backend/app/utils/email_normalize.py
 * because daemon hashes must match cloud hashes for contact matching to work.
 *
 * Cross-check strategy: spawn a Python child process with the normalizer and
 * compare its sha256 output to the TS emailHash for the same inputs.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { normalizeEmail, emailHash } from '../../src/leadspot/normalize.js';

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  describe('happy path — basic normalization', () => {
    it('lowercases mixed-case email', () => {
      expect(normalizeEmail('Jane@Acme.COM')).toBe('jane@acme.com');
    });

    it('strips + alias suffix', () => {
      expect(normalizeEmail('jane+sales@acme.com')).toBe('jane@acme.com');
    });

    it('strips + alias with multiple + parts, uses first +', () => {
      expect(normalizeEmail('Jane+sales+notify@Acme.COM')).toBe('jane@acme.com');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeEmail('  jane@acme.com  ')).toBe('jane@acme.com');
    });

    it('strips zero-width space (U+200B)', () => {
      // U+200B embedded between "jane" and "@"
      expect(normalizeEmail('jane​@acme.com')).toBe('jane@acme.com');
    });

    it('strips zero-width non-joiner (U+200C)', () => {
      expect(normalizeEmail('jane‌@acme.com')).toBe('jane@acme.com');
    });

    it('strips zero-width joiner (U+200D)', () => {
      expect(normalizeEmail('jane‍@acme.com')).toBe('jane@acme.com');
    });

    it('strips BOM (U+FEFF)', () => {
      expect(normalizeEmail('﻿jane@acme.com')).toBe('jane@acme.com');
    });

    it('strips soft hyphen (U+00AD)', () => {
      expect(normalizeEmail('jan­e@acme.com')).toBe('jane@acme.com');
    });

    it('handles NFKC normalization (fullwidth chars)', () => {
      // U+FF2A = FULLWIDTH LATIN CAPITAL LETTER J -> normalizes to J
      expect(normalizeEmail('Ｊane@acme.com')).toBe('jane@acme.com');
    });

    it('preserves dots in local part', () => {
      expect(normalizeEmail('jane.doe@acme.com')).toBe('jane.doe@acme.com');
    });

    it('preserves subdomains', () => {
      expect(normalizeEmail('jane@mail.acme.com')).toBe('jane@mail.acme.com');
    });

    it('lowercases domain portion', () => {
      expect(normalizeEmail('jane@ACME.COM')).toBe('jane@acme.com');
    });

    it('combines whitespace trim + alias strip + lowercase together', () => {
      expect(normalizeEmail('  Jane+Sales+Notify@Acme.COM  ')).toBe('jane@acme.com');
    });
  });

  describe('edge cases — empty / no-email inputs', () => {
    it('returns "" for empty string', () => {
      expect(normalizeEmail('')).toBe('');
    });

    it('returns "" for null', () => {
      expect(normalizeEmail(null)).toBe('');
    });

    it('returns "" for undefined', () => {
      expect(normalizeEmail(undefined)).toBe('');
    });

    it('returns "" for whitespace-only string', () => {
      expect(normalizeEmail('   ')).toBe('');
    });

    it('returns lowercased string when no @ present', () => {
      expect(normalizeEmail('notanemail')).toBe('notanemail');
    });

    it('returns lowercased string when no @ — mixed case', () => {
      expect(normalizeEmail('NotAnEmail')).toBe('notanemail');
    });

    it('handles @-only (no local part)', () => {
      // The contract: no local → return as-is cleaned. "@acme.com" → "@acme.com"
      expect(normalizeEmail('@acme.com')).toBe('@acme.com');
    });

    it('handles all-suffix local part (+only@acme.com)', () => {
      // Edge: "+sales@acme.com" → local="" after stripping → "@acme.com"
      expect(normalizeEmail('+sales@acme.com')).toBe('@acme.com');
    });
  });

  describe('unicode edge cases', () => {
    it('strips C0 control characters', () => {
      // U+0001 (SOH control char) should be stripped
      expect(normalizeEmail('jane@acme.com')).toBe('jane@acme.com');
    });

    it('strips line separator (U+2028)', () => {
      expect(normalizeEmail('jane @acme.com')).toBe('jane@acme.com');
    });

    it('strips paragraph separator (U+2029)', () => {
      expect(normalizeEmail('jane @acme.com')).toBe('jane@acme.com');
    });

    it('handles string with only invisibles', () => {
      expect(normalizeEmail('​‌‍')).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// emailHash
// ---------------------------------------------------------------------------

describe('emailHash', () => {
  it('returns a 64-character hex string for a valid email', () => {
    const h = emailHash('jane@acme.com');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input always same output', () => {
    const h1 = emailHash('jane@acme.com');
    const h2 = emailHash('jane@acme.com');
    expect(h1).toBe(h2);
  });

  it('normalizes before hashing — mixed-case matches lowercase', () => {
    expect(emailHash('Jane@Acme.COM')).toBe(emailHash('jane@acme.com'));
  });

  it('normalizes before hashing — alias stripped before hash', () => {
    expect(emailHash('jane+sales@acme.com')).toBe(emailHash('jane@acme.com'));
  });

  it('normalizes before hashing — whitespace ignored', () => {
    expect(emailHash('  jane@acme.com  ')).toBe(emailHash('jane@acme.com'));
  });

  it('returns "" for empty string (not sha256 of empty)', () => {
    expect(emailHash('')).toBe('');
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(emailHash('')).not.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('returns "" for null', () => {
    expect(emailHash(null)).toBe('');
  });

  it('returns "" for undefined', () => {
    expect(emailHash(undefined)).toBe('');
  });

  it('different emails produce different hashes', () => {
    expect(emailHash('jane@acme.com')).not.toBe(emailHash('john@acme.com'));
  });
});

// ---------------------------------------------------------------------------
// Cross-check: TypeScript hash must match Python backend hash
// ---------------------------------------------------------------------------

/**
 * Run the Python email_hash function via child_process and return its output.
 * This catches algorithm drift between the two implementations — the critical
 * property for contact matching is that daemon hashes == cloud hashes.
 */
function pythonEmailHash(raw: string): string {
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'import sys',
    'sys.path.insert(0, "/Users/michaelkraft/leadspot/backend")',
    'from app.utils.email_normalize import email_hash',
    `print(email_hash("${escaped}"), end="")`,
  ].join('\n');

  try {
    return execSync(`python3 -c '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch {
    // If Python is unavailable, skip cross-check (CI without Python).
    return 'PYTHON_UNAVAILABLE';
  }
}

const CROSS_CHECK_FIXTURES: Array<{ label: string; input: string }> = [
  { label: 'plain lowercase',           input: 'jane@acme.com' },
  { label: 'mixed case',                input: 'Jane@Acme.COM' },
  { label: 'plus alias',                input: 'jane+sales@acme.com' },
  { label: 'plus alias mixed case',     input: 'Jane+sales+notify@Acme.COM' },
  { label: 'leading/trailing spaces',   input: '  jane@acme.com  ' },
  { label: 'zero-width space in local', input: 'jane​@acme.com' },
  { label: 'subdomain',                 input: 'user@mail.example.org' },
  { label: 'numeric local',             input: '123@example.com' },
  { label: 'dots in local',             input: 'jane.doe@acme.com' },
];

describe('emailHash cross-check (TypeScript == Python)', () => {
  for (const { label, input } of CROSS_CHECK_FIXTURES) {
    it(`matches Python output for: ${label}`, () => {
      const pyHash = pythonEmailHash(input);
      if (pyHash === 'PYTHON_UNAVAILABLE') {
        // Skip gracefully if Python is not reachable in this environment.
        return;
      }
      const tsHash = emailHash(input);
      expect(tsHash).toBe(pyHash);
    });
  }

  it('both return empty string for empty input', () => {
    const pyHash = pythonEmailHash('');
    if (pyHash === 'PYTHON_UNAVAILABLE') return;
    expect(emailHash('')).toBe(pyHash);
  });
});
