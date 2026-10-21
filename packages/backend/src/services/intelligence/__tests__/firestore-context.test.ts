import { describe, it, expect } from 'vitest';
import type { CaseEvent } from '@arbitra/shared';
import { findLatestTransitionFromEvents } from '../firestore-context.js';

function makeEv(overrides: Partial<CaseEvent>): CaseEvent {
  return {
    event_id: overrides.event_id ?? 'evt_' + Math.random().toString(36).slice(2, 8),
    case_id: overrides.case_id ?? 'case_1',
    type: overrides.type ?? 'comment_added',
    actor_id: overrides.actor_id ?? 'usr_1',
    payload: overrides.payload ?? {},
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
  } as CaseEvent;
}

/**
 * Covers the previous 100-event cap bug: the old implementation only scanned
 * the last 100 events, so a chatty case with >100 comment_added events AFTER
 * the `pending_merge` transition would silently lose the transition timestamp.
 * The new helper is pure + the caller pages through until the match is found.
 */
describe('findLatestTransitionFromEvents', () => {
  it('finds the transition even when it is the 150th event in the stream', () => {
    // Build a descending-by-created_at stream: 149 irrelevant events followed
    // by the status_changed event (event 150). The pure helper just iterates
    // — pagination happens in the caller — so this is how a post-150-scan
    // page would look once the loop reaches it.
    const events: CaseEvent[] = [];
    for (let i = 0; i < 149; i++) {
      events.push(
        makeEv({
          event_id: `evt_noise_${i}`,
          type: 'comment_added',
          payload: { text: 'hi' },
          created_at: `2026-03-${String(20 - Math.floor(i / 10)).padStart(2, '0')}T00:00:00.000Z`,
        }),
      );
    }
    events.push(
      makeEv({
        event_id: 'evt_transition',
        type: 'merge_ready',
        payload: { from_status: 'approved', to_status: 'pending_merge' },
        created_at: '2026-01-15T12:00:00.000Z',
      }),
    );

    const hit = findLatestTransitionFromEvents(events, 'pending_merge');
    expect(hit).toBe('2026-01-15T12:00:00.000Z');
  });

  it('matches on the current `to_status` payload shape', () => {
    const events = [
      makeEv({ payload: { from_status: 'open', to_status: 'in_build' } }),
      makeEv({ payload: { from_status: 'approved', to_status: 'pending_merge' } }),
    ];
    expect(findLatestTransitionFromEvents(events, 'pending_merge')).toBeDefined();
  });

  it('matches legacy payload shapes (`target_status`, `status`, `to`)', () => {
    for (const key of ['target_status', 'status', 'to'] as const) {
      const events = [makeEv({ payload: { [key]: 'pending_merge' } as never })];
      expect(findLatestTransitionFromEvents(events, 'pending_merge')).toBeDefined();
    }
  });

  it('returns undefined when no event matches the target status', () => {
    const events = [
      makeEv({ payload: { to_status: 'in_build' } }),
      makeEv({ payload: { to_status: 'open' } }),
    ];
    expect(findLatestTransitionFromEvents(events, 'pending_merge')).toBeUndefined();
  });
});
