/**
 * Focused test for the workspace-event visibility filter inside
 * `listActivity`. Verifies that:
 *
 *   1. Events with `resolved_at` set are hidden from every viewer.
 *   2. Events in the viewer's dismissal set are hidden from that viewer
 *      only — another viewer still sees them.
 *
 * The full Firestore surface is stubbed with per-collection fakes so we can
 * drive the branching without a real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, WorkspaceEvent } from '@arbitra/shared';

type Row = { data: () => unknown };

function fakeSnap(rows: unknown[]): { docs: Row[] } {
  return { docs: rows.map((r) => ({ data: () => r })) };
}

/** Build a thin collection fake that supports `.get()` + the chain used in
 *  `listActivity` (orderBy / limit / where).  */
function listCollection(rows: unknown[]) {
  const snap = fakeSnap(rows);
  const chain = {
    orderBy: () => chain,
    limit: () => chain,
    where: () => chain,
    get: async () => snap,
  };
  return chain;
}

const cases: Case[] = [
  {
    case_id: 'c1',
    title: 'x',
    description: '',
    project_id: 'p1',
    owner_user_id: 'u',
    status: 'open',
    risk_level: 'low',
    validation_track: 'direct',
    case_type: 'bugfix',
    current_branch: 'b',
    evidence_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
  } as Case,
];

const workspaceEvents: WorkspaceEvent[] = [
  {
    event_id: 'we_live',
    type: 'intelligence_run',
    actor_user_id: 'system:arbitra-intelligence',
    timestamp: '2026-04-20T10:00:00.000Z',
    summary: 'live run',
  },
  {
    event_id: 'we_resolved',
    type: 'intelligence_run',
    actor_user_id: 'system:arbitra-intelligence',
    timestamp: '2026-04-20T11:00:00.000Z',
    summary: 'resolved run',
    resolved_at: '2026-04-22T00:00:00.000Z',
    resolved_by: 'usr_admin',
  },
  {
    event_id: 'we_dismissed_by_alice',
    type: 'intelligence_run',
    actor_user_id: 'system:arbitra-intelligence',
    timestamp: '2026-04-20T12:00:00.000Z',
    summary: 'dismissed by alice',
  },
];

// `dismissedIdsByUser` drives the dismissals collection mock per-test.
const dismissedIdsByUser: Record<string, string[]> = {};

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      get: async () => fakeSnap(cases),
    }),
    activeCases: () => ({
      get: async () => fakeSnap(cases),
    }),
    caseEvents: () => listCollection([]),
    comments: () => listCollection([]),
    evidence: () => listCollection([]),
    findings: () => listCollection([]),
    decisions: () => listCollection([]),
    projects: () => ({ get: async () => fakeSnap([]) }),
    workspaceEvents: () => listCollection(workspaceEvents),
    workspaceEventDismissals: () => ({
      where: (_field: string, _op: string, userId: string) => ({
        get: async () => {
          const ids = dismissedIdsByUser[userId] ?? [];
          return fakeSnap(ids.map((event_id) => ({ user_id: userId, event_id, dismissed_at: 't' })));
        },
      }),
    }),
  },
}));

vi.mock('../../lib/project-access.js', () => ({
  getAccessibleProjectIds: async () => 'all',
  isEffectiveMember: () => true,
}));

import { listActivity } from './activity-service.js';

beforeEach(() => {
  for (const k of Object.keys(dismissedIdsByUser)) delete dismissedIdsByUser[k];
});

describe('listActivity — workspace-event visibility filter', () => {
  it('hides resolved events from every viewer and dismissed events from the dismisser only', async () => {
    dismissedIdsByUser['alice'] = ['we_dismissed_by_alice'];

    const aliceResult = await listActivity('alice', true);
    const aliceIds = aliceResult.entries
      .filter((e) => e.kind === 'workspace_event')
      .map((e) => e.id);
    // Alice sees only the live event — resolved hidden globally, her own
    // dismissal hides `we_dismissed_by_alice`.
    expect(aliceIds).toEqual(['workspace_event:we_live']);

    const bobResult = await listActivity('bob', true);
    const bobIds = bobResult.entries
      .filter((e) => e.kind === 'workspace_event')
      .map((e) => e.id)
      .sort();
    // Bob has no dismissals, but the resolved event is still hidden from him.
    expect(bobIds).toEqual(['workspace_event:we_dismissed_by_alice', 'workspace_event:we_live']);
  });
});
