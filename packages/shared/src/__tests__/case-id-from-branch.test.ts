import { describe, it, expect } from 'vitest';
import { extractCaseIdFromBranch, extractCaseIdFromText } from '../utils/case-id-from-branch.js';

describe('extractCaseIdFromBranch', () => {
  it('extracts from Conventional-Commit prefix with trailing segment', () => {
    expect(extractCaseIdFromBranch('refactor/case-short-rim-x76o-wave4'))
      .toBe('case-short-rim-x76o');
  });

  it('extracts from prefix when nanoid has uppercase and digits', () => {
    expect(extractCaseIdFromBranch('feat/case-smart-ford-QW2U'))
      .toBe('case-smart-ford-QW2U');
  });

  it('returns the bare id when no prefix is present', () => {
    expect(extractCaseIdFromBranch('case-bright-pine-_TOD'))
      .toBe('case-bright-pine-_TOD');
  });

  it('handles trailing segments after a mixed-case nanoid tail', () => {
    expect(extractCaseIdFromBranch('feat/case-smart-ford-QW2U-foo'))
      .toBe('case-smart-ford-QW2U');
  });

  it('returns null for a non-case branch', () => {
    expect(extractCaseIdFromBranch('main')).toBeNull();
  });

  it('returns null when the branch has no case-like segment', () => {
    expect(extractCaseIdFromBranch('fix/nothing-here')).toBeNull();
  });

  it('returns something for an ambiguous all-lowercase body (caller will fail-lookup and fall through)', () => {
    // `case-not-valid-case-structure` has no nanoid-fingerprinted tail.
    // We return the raw regex hit; the Firestore lookup in the webhook
    // handler will miss and the code falls through to auto-create.
    const result = extractCaseIdFromBranch('fix/case-not-valid-case-structure');
    expect(result).toMatch(/^case-/);
  });

  it('returns null for an empty string', () => {
    expect(extractCaseIdFromBranch('')).toBeNull();
  });
});

describe('extractCaseIdFromText', () => {
  it('extracts a case id from a PR body line referencing it', () => {
    expect(extractCaseIdFromText('Arbitra: case-pure-dawn-mQj7'))
      .toBe('case-pure-dawn-mQj7');
  });

  it('extracts a case id buried in multi-line PR body', () => {
    const body = [
      'Implements ATLAS-123',
      '',
      'Arbitra: case-pure-dawn-mQj7',
      '',
      'See linked Jira for details.',
    ].join('\n');
    expect(extractCaseIdFromText(body)).toBe('case-pure-dawn-mQj7');
  });

  it('extracts a case id from a PR title with mixed-case nanoid tail', () => {
    expect(extractCaseIdFromText('feat: implement foo (case-smart-ford-QW2U)'))
      .toBe('case-smart-ford-QW2U');
  });

  it('returns null for text with no case id', () => {
    expect(extractCaseIdFromText('Just a plain PR title.')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(extractCaseIdFromText('')).toBeNull();
  });

  it('returns the same id as extractCaseIdFromBranch for branch-shaped input', () => {
    const branch = 'refactor/case-short-rim-x76o-wave4';
    expect(extractCaseIdFromText(branch)).toBe(extractCaseIdFromBranch(branch));
  });
});

describe('extractCaseIdFromText with preferLabelledLine', () => {
  it('prefers the Arbitra-Case: line over a foreign id mentioned earlier in prose (#813)', () => {
    // Reproduces the shape where the body narrates an outage that names a
    // *different* case before the PR's own labelled line.
    const body = [
      'Root cause: this mirrors the outage tracked in case-prose-aaaa-P111,',
      'where the same race condition surfaced.',
      '',
      'Arbitra-Case: case-label-bbbb-L222',
    ].join('\n');

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-label-bbbb-L222');
  });

  it('falls back to first-mention when no labelled line exists', () => {
    const body = 'Also mentions case-prose-aaaa-P111 in the body for context.';

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-prose-aaaa-P111');
  });

  it('tolerates leading markdown/whitespace decoration around the label', () => {
    const body = [
      'See case-prose-aaaa-P111 for background.',
      '',
      '  - **Arbitra-Case:** `case-label-bbbb-L222`',
    ].join('\n');

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-label-bbbb-L222');
  });

  it('is case-insensitive on the label', () => {
    const body = [
      'Mentions case-prose-aaaa-P111 first.',
      'ARBITRA-CASE: case-label-bbbb-L222',
    ].join('\n');

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-label-bbbb-L222');
  });

  it('without the option, first-mention still wins even when a labelled line is present', () => {
    // Locks in that the new behavior is opt-in only — existing callers that
    // don't pass `preferLabelledLine` keep the old first-match semantics.
    const body = [
      'Mentions case-prose-aaaa-P111 first.',
      'Arbitra-Case: case-label-bbbb-L222',
    ].join('\n');

    expect(extractCaseIdFromText(body)).toBe('case-prose-aaaa-P111');
  });

  it('does not change branch extraction (no labelled-line handling there)', () => {
    // extractCaseIdFromBranch delegates to extractCaseIdFromText WITHOUT
    // preferLabelledLine, so even label-bearing, multi-line input passed
    // through it stays first-match-wins.
    const branchLike = [
      'case-prose-aaaa-P111',
      'Arbitra-Case: case-label-bbbb-L222',
    ].join('\n');
    expect(extractCaseIdFromBranch(branchLike)).toBe('case-prose-aaaa-P111');
  });

  it('extracts a case id from a backtick-wrapped Arbitra-Case: line (whole line wrapped)', () => {
    // Fails if LABELLED_CASE_ID_LABEL reverts from `[`*]*arbitra-case:` to `\**arbitra-case:` —
    // the leading backtick before the label would block the match.
    const body = [
      'Mentions case-prose-aaaa-P111 first.',
      '`Arbitra-Case: case-label-bbbb-L222`',
    ].join('\n');

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-label-bbbb-L222');
  });

  it('extracts a case id when only the label itself (not the case id) is backtick-wrapped', () => {
    // Fails if LABELLED_CASE_ID_LABEL reverts from `[`*]*arbitra-case:` to `\**arbitra-case:` —
    // the leading backtick before the label would block the match even though the id is bare.
    const body = [
      'Mentions case-prose-aaaa-P111 first.',
      '`Arbitra-Case:` case-label-bbbb-L222',
    ].join('\n');

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-label-bbbb-L222');
  });

  it('does not treat an unrelated backtick-wrapped code span (no arbitra-case: text) as a labelled line', () => {
    // Fails if backtick tolerance is loosened into a generic "line starts with a backtick" skip
    // instead of still requiring the literal arbitra-case: label — a buggy version of that would
    // pick up 'case-label-bbbb-L222' here instead of the correct first-mention id.
    const body = [
      'Mentions case-prose-aaaa-P111 first.',
      '`case-label-bbbb-L222` is just inline code, not a label.',
    ].join('\n');

    expect(extractCaseIdFromText(body, { preferLabelledLine: true }))
      .toBe('case-prose-aaaa-P111');
  });
});
