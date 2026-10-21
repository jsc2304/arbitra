/**
 * Unit tests for the dismiss + resolve service methods. The Firestore
 * surface is stubbed with a per-collection in-memory map so we can assert
 * exact doc ids, merge semantics, and idempotent re-writes without a real
 * backend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceEvent } from '@arbitra/shared';

// In-memory stores.
const events = new Map<string, WorkspaceEvent>();
const dismissals = new Map<string, { user_id: string; event_id: string; dismissed_at: string }>();

function makeEventsCollection() {
  return {
    doc(id: string) {
      return {
        async get() {
          const data = events.get(id);
          return { exists: data !== undefined, data: () => data };
        },
        async set(
          value: Partial<WorkspaceEvent>,
          opts?: { merge?: boolean },
        ) {
          const prev = events.get(id);
          if (opts?.merge && prev) {
            events.set(id, { ...prev, ...value } as WorkspaceEvent);
          } else {
            events.set(id, value as WorkspaceEvent);
          }
        },
      };
    },
  };
}

function makeDismissalsCollection() {
  return {
    doc(id: string) {
      return {
        async set(value: { user_id: string; event_id: string; dismissed_at: string }) {
          dismissals.set(id, value);
        },
      };
    },
    where(field: string, op: string, value: string) {
      return {
        async get() {
          const docs = [...dismissals.values()]
            .filter((d) => op === '==' && (d as Record<string, unknown>)[field] === value)
            .map((d) => ({ data: () => d }));
          return { docs };
        },
      };
    },
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    workspaceEvents: () => makeEventsCollection(),
    workspaceEventDismissals: () => makeDismissalsCollection(),
  },
}));

import { WorkspaceEventService, dismissalDocId } from './workspace-event-service.js';

const baseEvent: WorkspaceEvent = {
  event_id: 'workspaceEvent_1',
  type: 'intelligence_run',
  actor_user_id: 'system:arbitra-intelligence',
  timestamp: '2026-04-20T10:00:00.000Z',
  summary: 'Ran 2 detectors',
};

beforeEach(() => {
  events.clear();
  dismissals.clear();
});

describe('WorkspaceEventService.resolve', () => {
  it('returns null when the event does not exist (caller maps to 404)', async () => {
    const svc = new WorkspaceEventService();
    const result = await svc.resolve('workspaceEvent_missing', 'usr_admin');
    expect(result).toBeNull();
  });

  it('writes resolved_at + resolved_by and returns the updated event', async () => {
    events.set(baseEvent.event_id, baseEvent);
    const svc = new WorkspaceEventService();
    const result = await svc.resolve(baseEvent.event_id, 'usr_admin');
    expect(result).not.toBeNull();
    expect(result!.resolved_by).toBe('usr_admin');
    expect(result!.resolved_at).toBeDefined();
    // Unrelated fields are preserved (merge semantics).
    expect(result!.summary).toBe('Ran 2 detectors');
  });

  it('is idempotent — a second call just refreshes resolved_at', async () => {
    events.set(baseEvent.event_id, baseEvent);
    const svc = new WorkspaceEventService();
    const first = await svc.resolve(baseEvent.event_id, 'usr_admin');
    // Sleep a microtask; bump the clock forward so the ISO strings differ.
    await new Promise((r) => setTimeout(r, 5));
    const second = await svc.resolve(baseEvent.event_id, 'usr_lead');
    expect(first!.resolved_by).toBe('usr_admin');
    expect(second!.resolved_by).toBe('usr_lead');
    // The persisted document reflects the last write.
    expect(events.get(baseEvent.event_id)!.resolved_by).toBe('usr_lead');
  });
});

describe('WorkspaceEventService.dismissForUser', () => {
  it('upserts a dismissal doc keyed by ${userId}_${eventId}', async () => {
    const svc = new WorkspaceEventService();
    const result = await svc.dismissForUser('workspaceEvent_1', 'usr_7');
    expect(result.user_id).toBe('usr_7');
    expect(result.event_id).toBe('workspaceEvent_1');
    expect(result.dismissed_at).toBeDefined();
    expect(dismissals.has(dismissalDocId('usr_7', 'workspaceEvent_1'))).toBe(true);
  });

  it('is idempotent — re-dismissing just refreshes dismissed_at', async () => {
    const svc = new WorkspaceEventService();
    const first = await svc.dismissForUser('workspaceEvent_1', 'usr_7');
    await new Promise((r) => setTimeout(r, 5));
    const second = await svc.dismissForUser('workspaceEvent_1', 'usr_7');
    expect(dismissals.size).toBe(1);
    expect(Date.parse(second.dismissed_at)).toBeGreaterThanOrEqual(Date.parse(first.dismissed_at));
  });

  it('is per-user — two users dismissing the same event yields two docs', async () => {
    const svc = new WorkspaceEventService();
    await svc.dismissForUser('workspaceEvent_1', 'usr_a');
    await svc.dismissForUser('workspaceEvent_1', 'usr_b');
    expect(dismissals.size).toBe(2);
  });
});

describe('WorkspaceEventService.listDismissedEventIdsForUser', () => {
  it('returns an empty set when the user has no dismissals', async () => {
    const svc = new WorkspaceEventService();
    const ids = await svc.listDismissedEventIdsForUser('usr_nobody');
    expect(ids.size).toBe(0);
  });

  it('returns only the ids dismissed by the queried user', async () => {
    const svc = new WorkspaceEventService();
    await svc.dismissForUser('we_1', 'usr_a');
    await svc.dismissForUser('we_2', 'usr_a');
    await svc.dismissForUser('we_3', 'usr_b');
    const idsA = await svc.listDismissedEventIdsForUser('usr_a');
    expect([...idsA].sort()).toEqual(['we_1', 'we_2']);
    const idsB = await svc.listDismissedEventIdsForUser('usr_b');
    expect([...idsB]).toEqual(['we_3']);
  });
});
