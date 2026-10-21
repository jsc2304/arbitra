import { describe, expect, it } from 'vitest';
import { assistantFeedbackRequestSchema } from './assistant-validators.js';

describe('assistantFeedbackRequestSchema', () => {
  it('accepts both ratings and trims the required reason', () => {
    expect(assistantFeedbackRequestSchema.parse({
      rating: 'useful',
      reason: '  It answered the exact question.  ',
    })).toEqual({
      rating: 'useful',
      reason: 'It answered the exact question.',
    });

    expect(assistantFeedbackRequestSchema.parse({
      rating: 'not_useful',
      reason: 'It used the wrong reporting period.',
    }).rating).toBe('not_useful');
  });

  it('rejects an empty reason and caller-owned provenance', () => {
    expect(() => assistantFeedbackRequestSchema.parse({
      rating: 'not_useful',
      reason: '   ',
    })).toThrow();

    expect(() => assistantFeedbackRequestSchema.parse({
      rating: 'useful',
      reason: 'Clear and actionable.',
      run_id: 'run_forged',
    })).toThrow();
  });
});
