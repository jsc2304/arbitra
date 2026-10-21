import { describe, it, expect } from 'vitest';
import type { CaseEvent } from '@arbitra/shared';
import { mostRecentIterationBoundary } from './iteration-boundary.js';

function makeEvent(
  type: string,
  createdAt: string,
  overrides: Partial<CaseEvent> = {},
): CaseEvent {
  return {
    event_id: `evt_${type}_${createdAt}`,
    case_id: 'case_1',
    type,
    actor_id: 'system',
    payload: {},
    created_at: createdAt,
    ...overrides,
  };
}

describe('mostRecentIterationBoundary', () => {
  it('returns null when no boundary events fired', () => {
    const events: CaseEvent[] = [
      makeEvent('case_created', '2026-04-30T10:00:00Z'),
      makeEvent('run_started', '2026-04-30T10:05:00Z'),
      makeEvent('run_completed', '2026-04-30T10:06:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBeNull();
  });

  it('returns the changes_requested timestamp when only changes_requested fired', () => {
    const events: CaseEvent[] = [
      makeEvent('case_created', '2026-04-30T10:00:00Z'),
      makeEvent('changes_requested', '2026-04-30T11:00:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBe('2026-04-30T11:00:00Z');
  });

  it('returns the manual_verification_requested timestamp when only verification_pending entry fired', () => {
    const events: CaseEvent[] = [
      makeEvent('case_created', '2026-04-30T10:00:00Z'),
      makeEvent('manual_verification_requested', '2026-04-30T11:30:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBe('2026-04-30T11:30:00Z');
  });

  it('returns the most recent of (changes_requested, manual_verification_requested) when both fired', () => {
    // changes_requested first, then re-entry to verification_pending: latest wins.
    const events: CaseEvent[] = [
      makeEvent('changes_requested', '2026-04-30T11:00:00Z'),
      makeEvent('manual_verification_requested', '2026-04-30T12:00:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBe('2026-04-30T12:00:00Z');
  });

  it('returns the changes_requested timestamp when it is more recent than verification_pending entry', () => {
    const events: CaseEvent[] = [
      makeEvent('manual_verification_requested', '2026-04-30T11:00:00Z'),
      makeEvent('changes_requested', '2026-04-30T12:00:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBe('2026-04-30T12:00:00Z');
  });

  it('handles multiple boundary events of the same type and returns the most recent', () => {
    const events: CaseEvent[] = [
      makeEvent('manual_verification_requested', '2026-04-30T11:00:00Z'),
      makeEvent('manual_verification_requested', '2026-04-30T13:00:00Z'),
      makeEvent('manual_verification_requested', '2026-04-30T12:00:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBe('2026-04-30T13:00:00Z');
  });

  it('ignores non-boundary event types regardless of how recent they are', () => {
    const events: CaseEvent[] = [
      makeEvent('changes_requested', '2026-04-30T11:00:00Z'),
      makeEvent('run_completed', '2026-04-30T20:00:00Z'),
      makeEvent('decision_created', '2026-04-30T21:00:00Z'),
    ];
    expect(mostRecentIterationBoundary(events)).toBe('2026-04-30T11:00:00Z');
  });

  it('returns null for an empty event list', () => {
    expect(mostRecentIterationBoundary([])).toBeNull();
  });
});
