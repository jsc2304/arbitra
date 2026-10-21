/**
 * Tests for the shared PR-ref parser and comparison (issue #1046).
 *
 * Every ref shape below was found to defeat the original strict
 * `^https://github\.com/o/r/pull/N` matcher and, through it, the
 * terminal-case ownership check — a REJECTED case's own PR published
 * `success` on the next push because its stored `current_pr_ref` happened to
 * be written in one of these forms.
 */
import { describe, it, expect } from 'vitest';
import { parsePrRef, comparePrRefs, isValidPrRef } from './pr-ref.js';

const CANONICAL = 'https://github.com/acme/primary/pull/50';

/** The shapes the reviewer reproduced the #1046 exploit through. */
const EQUIVALENT_REFS = [
  'https://github.com/acme/primary/pull/50',
  'github.com/acme/primary/pull/50',                   // no scheme
  'http://github.com/acme/primary/pull/50',            // http
  'https://www.github.com/acme/primary/pull/50',       // www.
  'https://GitHub.com/acme/primary/pull/50',           // host casing
  'HTTPS://GITHUB.COM/acme/primary/pull/50',           // scheme casing
  'https://api.github.com/repos/acme/primary/pulls/50', // REST API form
  'https://github.com/acme/primary/pull/50/',          // trailing slash
  'https://github.com/acme/primary/pull/50?foo=1',     // query string
  'https://github.com/acme/primary/pull/50#issuecomment-1', // fragment
  'https://github.com/acme/primary/pull/50/files',     // sub-path
  'https://github.com/ACME/Primary/pull/50',           // owner/repo casing
  '  https://github.com/acme/primary/pull/50  ',       // surrounding space
];

describe('parsePrRef', () => {
  for (const ref of EQUIVALENT_REFS) {
    it(`resolves ${JSON.stringify(ref)} to acme/primary#50`, () => {
      expect(parsePrRef(ref)).toEqual({ owner: 'acme', repo: 'primary', number: 50 });
    });
  }

  it('returns null for refs that name no pull request', () => {
    for (const ref of [
      undefined,
      null,
      '',
      '   ',
      'not-a-url',
      'https://github.com/acme/primary',              // repo, not a PR
      'https://github.com/acme/primary/issues/50',    // issue, not a PR
      'https://gitlab.com/acme/primary/pull/50',      // wrong host
      'https://github.com/acme/primary/pull/abc',     // non-numeric
      'https://github.com/acme/primary/pull/0',       // PR numbers start at 1
      'https://notgithub.com/acme/primary/pull/50',   // host must match exactly
    ]) {
      expect(parsePrRef(ref), `expected null for ${JSON.stringify(ref)}`).toBeNull();
    }
  });
});

describe('comparePrRefs', () => {
  for (const ref of EQUIVALENT_REFS) {
    it(`reports 'same' for the canonical ref vs ${JSON.stringify(ref)}`, () => {
      expect(comparePrRefs(CANONICAL, ref)).toBe('same');
      expect(comparePrRefs(ref, CANONICAL)).toBe('same');
    });
  }

  it("reports 'different' for another PR number, repo, or owner", () => {
    expect(comparePrRefs(CANONICAL, 'https://github.com/acme/primary/pull/77')).toBe('different');
    expect(comparePrRefs(CANONICAL, 'https://github.com/acme/other/pull/50')).toBe('different');
    expect(comparePrRefs(CANONICAL, 'https://github.com/other/primary/pull/50')).toBe('different');
  });

  it("reports 'unknown' — never 'different' — when either side does not parse", () => {
    // This is the member that carries the fix: collapsing it into
    // 'different' is what made the terminal-case check fail open.
    expect(comparePrRefs(CANONICAL, 'garbage')).toBe('unknown');
    expect(comparePrRefs('garbage', CANONICAL)).toBe('unknown');
    expect(comparePrRefs('garbage', 'garbage')).toBe('unknown');
    expect(comparePrRefs(undefined, CANONICAL)).toBe('unknown');
    expect(comparePrRefs(CANONICAL, undefined)).toBe('unknown');
  });
});

describe('isValidPrRef', () => {
  it('accepts every shape a human or agent plausibly types', () => {
    for (const ref of EQUIVALENT_REFS) {
      expect(isValidPrRef(ref), ref).toBe(true);
    }
  });

  it('rejects values that name no pull request', () => {
    for (const ref of ['', 'not-a-url', 'https://github.com/acme/primary']) {
      expect(isValidPrRef(ref), ref).toBe(false);
    }
  });
});
