/**
 * `parsePrUrl` (issue #1032, M1): anchoring behavior. See the function's own
 * doc comment in `diff-resolver.ts` for why the regex must accept both
 * `http://` and `https://` (an `http://` ref, e.g. one pasted manually via
 * the MCP `update_case` tool, is treated as the same PR as the `https://`
 * ref GitHub sends — `webhook-service.pr-text-lookup.test.ts` covers that
 * end to end) while rejecting a `github.com/.../pull/...` substring embedded
 * in an unrelated host.
 */
import { describe, it, expect } from 'vitest';
import { parsePrUrl } from './diff-resolver.js';

describe('parsePrUrl', () => {
  it('parses a normal https:// GitHub PR URL', () => {
    expect(parsePrUrl('https://github.com/acme/demo/pull/7')).toEqual({
      owner: 'acme',
      repo: 'demo',
      number: 7,
    });
  });

  it('still parses an http:// ref (manually-typed refs, and refersToSamePr comparisons, rely on this)', () => {
    expect(parsePrUrl('http://github.com/acme/demo/pull/7')).toEqual({
      owner: 'acme',
      repo: 'demo',
      number: 7,
    });
  });

  it('tolerates a trailing query string or fragment', () => {
    expect(parsePrUrl('https://github.com/acme/demo/pull/7?diff=unified')).toEqual({
      owner: 'acme',
      repo: 'demo',
      number: 7,
    });
  });

  it('rejects a github.com/.../pull/... PATTERN embedded in an unrelated host (issue #1032, M1)', () => {
    // Before the anchor, the unanchored regex matched this substring and
    // "resolved" it to acme/demo#1 — letting a crafted URL point the admin
    // re-publish endpoint at an arbitrary repository.
    expect(parsePrUrl('https://evil.example/?x=github.com/acme/demo/pull/1')).toBeNull();
  });

  it('ACCEPTS a bare github.com reference with no scheme (issue #1046)', () => {
    // Deliberate change of contract. `parsePrUrl` now delegates to the one
    // shared `parsePrRef`, because three disagreeing parsers is what let a
    // REJECTED case's own PR turn green: the terminal-case ownership check
    // could not recognise `github.com/…/pull/50` as the PR the case owned,
    // called it a different PR, and published the case-less `success`.
    //
    // Safe because the anchoring property #1032 added is preserved — the
    // crafted-URL case above still returns null. A scheme-less ref names its
    // PR unambiguously; refusing to parse it never made the value safer, it
    // only made two code paths disagree about what it meant.
    expect(parsePrUrl('github.com/acme/demo/pull/7')).toEqual({
      owner: 'acme', repo: 'demo', number: 7,
    });
  });

  it('rejects an unparseable, non-URL ref (e.g. a manually-linked opaque string)', () => {
    expect(parsePrUrl('manually-linked-ref-not-a-url')).toBeNull();
  });
});
