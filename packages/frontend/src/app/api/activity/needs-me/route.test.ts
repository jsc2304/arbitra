/**
 * @file needs-me aggregation route — coverage for the idle threshold and the
 * non-admin project scope, plus the issue #567 item 14 fix:
 * `failed_builds_24h` / `webhook_rejections` now run as dedicated unbounded
 * Firestore queries (no 200-row cap) instead of a sliced `listActivity` page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  checkIsAdmin,
  authenticateFromHeader,
  getAccessibleProjectIds,
  collectionsActiveCases,
  collectionsCaseEvents,
  collectionsWorkspaceEvents,
  collectionsWorkspaceEventDismissals,
} = vi.hoisted(() => ({
  checkIsAdmin: vi.fn(),
  authenticateFromHeader: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
  collectionsActiveCases: vi.fn(),
  collectionsCaseEvents: vi.fn(),
  collectionsWorkspaceEvents: vi.fn(),
  collectionsWorkspaceEventDismissals: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  checkIsAdmin,
  authenticateFromHeader,
  getAccessibleProjectIds,
  collections: {
    activeCases: collectionsActiveCases,
    caseEvents: collectionsCaseEvents,
    workspaceEvents: collectionsWorkspaceEvents,
    workspaceEventDismissals: collectionsWorkspaceEventDismissals,
  },
  formatError: (error: unknown) => ({
    status: 500,
    body: {
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'error' },
    },
  }),
}));

import { GET } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/activity/needs-me', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

interface PartialCase {
  case_id?: string;
  status: string;
  project_id?: string;
  owner_user_id?: string;
  assigned_reviewer_id?: string;
  updated_at?: string;
}

function casesSnap(cases: PartialCase[]) {
  return {
    get: () => Promise.resolve({ docs: cases.map((c) => ({ data: () => c })) }),
  };
}

/**
 * Chainable Firestore query stub. Every `.where()` returns the same builder so
 * any number of chained filters resolve to the supplied `docs` on `.get()`.
 * The route applies the type/window/scoping logic in memory, so the stub does
 * not need to evaluate the predicates — it just hands back the doc set.
 */
function queryStub(docs: unknown[]) {
  const builder = {
    where: () => builder,
    get: () => Promise.resolve({ docs: docs.map((d) => ({ data: () => d })) }),
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'user_1' });
  // Default empty result sets for the feed-derived counts; individual tests
  // override the ones they assert on.
  collectionsCaseEvents.mockReturnValue(queryStub([]));
  collectionsWorkspaceEvents.mockReturnValue(queryStub([]));
  collectionsWorkspaceEventDismissals.mockReturnValue(queryStub([]));
});

describe('GET /api/activity/needs-me — non-admin project-scoping', () => {
  it('only counts idle detector-opened cases on projects the viewer can access', async () => {
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_in_scope']);

    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();

    collectionsActiveCases.mockReturnValue(
      casesSnap([
        // In-scope, detector-opened, idle → counted.
        {
          status: 'active',
          project_id: 'proj_in_scope',
          owner_user_id: 'system:arbitra-intelligence',
          updated_at: ancient,
        },
        // OUT-of-scope project — must NOT be counted.
        {
          status: 'active',
          project_id: 'proj_other',
          owner_user_id: 'system:arbitra-intelligence',
          updated_at: ancient,
        },
        // In-scope, detector-opened, but FRESH (under threshold) — must NOT
        // be counted (idle-time guard).
        {
          status: 'active',
          project_id: 'proj_in_scope',
          owner_user_id: 'system:arbitra-intelligence',
          updated_at: fresh,
        },
        // In-scope but NOT detector-opened — must NOT be counted.
        {
          status: 'active',
          project_id: 'proj_in_scope',
          owner_user_id: 'user_42',
          updated_at: ancient,
        },
      ]),
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idle_over_threshold.count).toBe(1);
  });

  it('also project-scopes the awaiting_decision count for non-admins', async () => {
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_in_scope']);

    collectionsActiveCases.mockReturnValue(
      casesSnap([
        // In-scope and assigned to the viewer → counted.
        {
          status: 'needs_human_decision',
          project_id: 'proj_in_scope',
          assigned_reviewer_id: 'user_1',
        },
        // In-scope but assigned to someone else → not counted.
        {
          status: 'needs_human_decision',
          project_id: 'proj_in_scope',
          assigned_reviewer_id: 'user_other',
        },
        // OUT-of-scope project → not counted even if assigned to viewer.
        {
          status: 'verification_pending',
          project_id: 'proj_other',
          assigned_reviewer_id: 'user_1',
        },
      ]),
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.awaiting_decision.count).toBe(1);
  });

  it('admins see the global queue (no project filter)', async () => {
    checkIsAdmin.mockResolvedValue(true);
    getAccessibleProjectIds.mockResolvedValue('all');

    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    collectionsActiveCases.mockReturnValue(
      casesSnap([
        {
          status: 'active',
          project_id: 'proj_a',
          owner_user_id: 'system:arbitra-intelligence',
          updated_at: ancient,
        },
        {
          status: 'active',
          project_id: 'proj_b',
          owner_user_id: 'system:arbitra-intelligence',
          updated_at: ancient,
        },
      ]),
    );

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.idle_over_threshold.count).toBe(2);
  });
});

describe('GET /api/activity/needs-me — feed-derived counts (item 14)', () => {
  beforeEach(() => {
    // Admin path keeps project-scoping out of the way unless a test opts in.
    checkIsAdmin.mockResolvedValue(true);
    getAccessibleProjectIds.mockResolvedValue('all');
    collectionsActiveCases.mockReturnValue(casesSnap([]));
  });

  it('counts ALL matching failed-build events — not capped at 200', async () => {
    // 250 rows would have been silently truncated by the old limit:200 scan.
    const events = Array.from({ length: 250 }, (_, i) => ({
      event_id: `evt_${i}`,
      case_id: 'case_1',
      type: i % 2 === 0 ? 'run_failed' : 'build_failed',
      created_at: new Date().toISOString(),
    }));
    collectionsActiveCases.mockReturnValue(casesSnap([{ case_id: 'case_1', status: 'active' }]));
    collectionsCaseEvents.mockReturnValue(queryStub(events));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.failed_builds_24h.count).toBe(250);
  });

  it('project-scopes failed-build events for non-admins via case_id join', async () => {
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_in_scope']);

    collectionsActiveCases.mockReturnValue(
      casesSnap([
        { case_id: 'case_in', status: 'active', project_id: 'proj_in_scope' },
        { case_id: 'case_out', status: 'active', project_id: 'proj_other' },
      ]),
    );
    collectionsCaseEvents.mockReturnValue(
      queryStub([
        { event_id: 'e1', case_id: 'case_in', type: 'run_failed', created_at: new Date().toISOString() },
        { event_id: 'e2', case_id: 'case_out', type: 'run_failed', created_at: new Date().toISOString() },
        // Event whose case isn't in the active set at all → excluded.
        { event_id: 'e3', case_id: 'case_unknown', type: 'build_failed', created_at: new Date().toISOString() },
      ]),
    );

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.failed_builds_24h.count).toBe(1);
  });

  it('excludes resolved, viewer-dismissed, and out-of-window webhook rejections', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    collectionsWorkspaceEvents.mockReturnValue(
      queryStub([
        { event_id: 'we_live', type: 'webhook_rejected', timestamp: new Date().toISOString() },
        // Globally resolved → excluded.
        {
          event_id: 'we_resolved',
          type: 'webhook_rejected',
          timestamp: new Date().toISOString(),
          resolved_at: new Date().toISOString(),
        },
        // Dismissed by this viewer → excluded.
        { event_id: 'we_dismissed', type: 'webhook_rejected', timestamp: new Date().toISOString() },
        // Older than the 24h window (in-memory timestamp filter) → excluded.
        { event_id: 'we_old', type: 'webhook_rejected', timestamp: old },
      ]),
    );
    collectionsWorkspaceEventDismissals.mockReturnValue(
      queryStub([{ user_id: 'user_1', event_id: 'we_dismissed' }]),
    );

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.webhook_rejections.count).toBe(1);
  });

  it('counts webhook rejections beyond the old 200-row cap', async () => {
    const events = Array.from({ length: 220 }, (_, i) => ({
      event_id: `we_${i}`,
      type: 'webhook_rejected',
      timestamp: new Date().toISOString(),
    }));
    collectionsWorkspaceEvents.mockReturnValue(queryStub(events));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.webhook_rejections.count).toBe(220);
  });
});
