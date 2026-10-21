import { describe, expect, it } from 'vitest';
import { parseRunErrors, parseRunSummary } from '../activity-parsers';

const SAMPLE =
  'Ran 12 detectors — 3 new nudges, 5 deduped, 2 errors (duration 1840ms)';

describe('parseRunSummary', () => {
  it('parses all counters from a well-formed run summary', () => {
    expect(parseRunSummary(SAMPLE)).toEqual({
      detectors: 12,
      newNudges: 3,
      deduped: 5,
      errors: 2,
      durationMs: 1840,
    });
  });

  it('handles singular detector / nudge / error wording', () => {
    expect(
      parseRunSummary('Ran 1 detector — 1 new nudge, 0 deduped, 1 error (duration 90ms)'),
    ).toEqual({
      detectors: 1,
      newNudges: 1,
      deduped: 0,
      errors: 1,
      durationMs: 90,
    });
  });

  it('returns null for non-run summaries', () => {
    expect(parseRunSummary('opened')).toBeNull();
    expect(parseRunSummary('')).toBeNull();
  });
});

describe('parseRunErrors', () => {
  it('extracts the error count', () => {
    expect(parseRunErrors(SAMPLE)).toBe(2);
    expect(
      parseRunErrors('Ran 8 detectors — 0 new nudges, 0 deduped, 0 errors (duration 12ms)'),
    ).toBe(0);
  });

  it('returns null for non-run summaries', () => {
    expect(parseRunErrors('commented on')).toBeNull();
  });
});
