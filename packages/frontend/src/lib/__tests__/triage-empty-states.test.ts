import { describe, expect, it } from 'vitest';
import { TRIAGE_EMPTY_STATES } from '../triage-empty-states';
import { TRIAGE_VIEWS, type TriageView } from '../triage-views';

describe('TRIAGE_EMPTY_STATES', () => {
  it('has an entry for every triage view', () => {
    for (const view of TRIAGE_VIEWS) {
      expect(TRIAGE_EMPTY_STATES[view]).toBeDefined();
    }
  });

  it('provides a non-empty title + description for every view', () => {
    for (const view of TRIAGE_VIEWS) {
      const entry = TRIAGE_EMPTY_STATES[view];
      expect(entry.title).toBeTypeOf('string');
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description).toBeTypeOf('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('nextView (when set) points to a valid TriageView literal', () => {
    const valid = new Set<TriageView>(TRIAGE_VIEWS);
    for (const view of TRIAGE_VIEWS) {
      const entry = TRIAGE_EMPTY_STATES[view];
      if (entry.nextView !== undefined) {
        expect(valid.has(entry.nextView)).toBe(true);
      }
    }
  });

  it('nextViewLabel is present whenever nextView is set', () => {
    for (const view of TRIAGE_VIEWS) {
      const entry = TRIAGE_EMPTY_STATES[view];
      if (entry.nextView !== undefined) {
        expect(entry.nextViewLabel).toBeTypeOf('string');
        expect((entry.nextViewLabel ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('nextView never points to itself (always links to a different view)', () => {
    for (const view of TRIAGE_VIEWS) {
      const entry = TRIAGE_EMPTY_STATES[view];
      if (entry.nextView !== undefined) {
        expect(entry.nextView).not.toBe(view);
      }
    }
  });
});
