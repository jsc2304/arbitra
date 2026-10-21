import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Case } from '@arbitra/shared';
import {
  collectPendingMergeCases,
  composeDashboard,
  dashboardRefreshInterval,
  dashboardSwrConfig,
  type DashboardAggregatePayload,
} from '../use-dashboard';
import type { ObservatoryResponse } from '../../lib/api-client';

// ---------------------------------------------------------------------------
// `composeDashboard` is the pure core of `useDashboard` — given the raw
// /api/dashboard payload, it produces the same shape the hook returns. The
// hook just wraps this in SWR + auth. Testing the pure function sidesteps
// the need for a DOM/react-testing-library setup and keeps coverage honest.
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    project_id: 'proj_1',
    title: 'Sample',
    description: '',
    owner_user_id: 'user_1',
    status: 'open',
    risk_level: 'low',
    validation_track: 'direct',
    case_type: 'feature',
    current_branch: 'main',
    evidence_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    ...overrides,
  } as Case;
}

function makeObservatory(): ObservatoryResponse {
  return {
    summary: {
      total_cases: 3,
      pending_reviews: 1,
      approval_rate: 66,
      avg_findings_per_case: 1.2,
      total_findings: 4,
      open_findings: 2,
      total_knowledge_assets: 0,
    },
    cases_by_status: {},
    risk_distribution: {},
    track_distribution: {},
    findings_by_severity: {},
    recent_activity: [
      {
        case_id: 'case_1',
        case_title: 'Sample',
        type: 'case_created',
        summary: 'Case created with status open',
        created_at: '2026-04-16T00:00:00.000Z',
      },
    ],
    top_contributors: [],
    top_reviewers: [],
    top_repositories: [],
    top_projects: [],
    throughput_leaderboard: [],
    top_referenced_assets: [],
  };
}

function makePayload(overrides: Partial<DashboardAggregatePayload> = {}): DashboardAggregatePayload {
  return {
    myCases: { ok: true, data: { cases: [makeCase()] } },
    needs_human_decision: { ok: true, data: { cases: [] } },
    verification_pending: { ok: true, data: { cases: [] } },
    observatory: { ok: true, data: makeObservatory() },
    ...overrides,
  };
}

describe('composeDashboard', () => {
  it('returns empty defaults when data is undefined', () => {
    const result = composeDashboard(undefined);
    expect(result.myCases).toEqual([]);
    expect(result.attentionCases).toEqual([]);
    expect(result.staleCases).toEqual([]);
    expect(result.metrics).toBeNull();
    expect(result.recentActivity).toEqual([]);
    expect(result.firstError).toBeNull();
  });

  it('surfaces all four sections when all succeed', () => {
    const result = composeDashboard(
      makePayload({
        myCases: { ok: true, data: { cases: [makeCase({ case_id: 'mine' })] } },
        needs_human_decision: { ok: true, data: { cases: [makeCase({ case_id: 'nhd' })] } },
        verification_pending: { ok: true, data: { cases: [makeCase({ case_id: 'vp' })] } },
      }),
    );

    expect(result.myCases.map((c) => c.case_id)).toEqual(['mine']);
    expect(result.attentionCases.map((c) => c.case_id)).toEqual(['nhd', 'vp']);
    expect(result.metrics?.total_cases).toBe(3);
    expect(result.recentActivity).toHaveLength(1);
    expect(result.firstError).toBeNull();
    expect(result.sectionErrors).toEqual({
      myCases: null,
      needs_human_decision: null,
      verification_pending: null,
      observatory: null,
    });
  });

  it('derives decidedCount from terminal statuses in cases_by_status (#664)', () => {
    // No data yet → 0 (lets the UI render a 0% rate as neutral, not red).
    expect(composeDashboard(makePayload()).decidedCount).toBe(0);

    // approved + rejected + done are the decided cases; open/in_review are not.
    const observatory = makeObservatory();
    observatory.cases_by_status = {
      approved: 5,
      rejected: 2,
      done: 3,
      open: 7,
      in_review: 1,
    };
    const result = composeDashboard(
      makePayload({ observatory: { ok: true, data: observatory } }),
    );
    expect(result.decidedCount).toBe(10);
  });

  it('defaults decidedCount to 0 when observatory section failed', () => {
    const result = composeDashboard(
      makePayload({ observatory: { ok: false, error: 'firestore down' } }),
    );
    expect(result.decidedCount).toBe(0);
  });

  it('filters terminal statuses out of myCases', () => {
    const result = composeDashboard(
      makePayload({
        myCases: {
          ok: true,
          data: {
            cases: [
              makeCase({ case_id: 'active', status: 'open' }),
              makeCase({ case_id: 'done', status: 'done' }),
              makeCase({ case_id: 'rejected', status: 'rejected' }),
            ],
          },
        },
      }),
    );
    expect(result.myCases.map((c) => c.case_id)).toEqual(['active']);
  });

  it('surfaces partial data when one section failed', () => {
    const result = composeDashboard(
      makePayload({
        observatory: { ok: false, error: 'firestore down' },
      }),
    );

    // Other sections unaffected.
    expect(result.myCases).toHaveLength(1);
    // Observatory-derived fields safely fall back.
    expect(result.metrics).toBeNull();
    expect(result.recentActivity).toEqual([]);

    expect(result.sectionErrors.observatory).toBe('firestore down');
    expect(result.sectionErrors.myCases).toBeNull();
    expect(result.firstError).toBe('firestore down');
  });

  it('reports the first failing section via firstError', () => {
    const result = composeDashboard(
      makePayload({
        myCases: { ok: false, error: 'my-cases failed' },
        needs_human_decision: { ok: false, error: 'nhd failed' },
      }),
    );
    // Priority order follows the object literal: myCases first.
    expect(result.firstError).toBe('my-cases failed');
    expect(result.sectionErrors.myCases).toBe('my-cases failed');
    expect(result.sectionErrors.needs_human_decision).toBe('nhd failed');
  });
});

describe('dashboardRefreshInterval', () => {
  it('returns slow interval (60s) when data is undefined', () => {
    expect(dashboardRefreshInterval(undefined)).toBe(60000);
  });

  it('returns fast interval (1500ms) when any case is non-terminal', () => {
    const payload = makePayload({
      myCases: {
        ok: true,
        data: { cases: [makeCase({ case_id: 'moving', status: 'in_build' })] },
      },
    });
    expect(dashboardRefreshInterval(payload)).toBe(1500);
  });

  it('returns fast interval when non-terminal case is in needs_human_decision', () => {
    const payload = makePayload({
      myCases: { ok: true, data: { cases: [] } },
      needs_human_decision: {
        ok: true,
        data: { cases: [makeCase({ case_id: 'nhd', status: 'needs_human_decision' })] },
      },
    });
    expect(dashboardRefreshInterval(payload)).toBe(1500);
  });

  it('returns fast interval when non-terminal case is in verification_pending', () => {
    const payload = makePayload({
      myCases: { ok: true, data: { cases: [] } },
      verification_pending: {
        ok: true,
        data: { cases: [makeCase({ case_id: 'vp', status: 'verification_pending' })] },
      },
    });
    expect(dashboardRefreshInterval(payload)).toBe(1500);
  });

  it('returns slow interval (60s) when every case is terminal', () => {
    const payload = makePayload({
      myCases: {
        ok: true,
        data: {
          cases: [
            makeCase({ case_id: 'd', status: 'done' }),
            makeCase({ case_id: 'r', status: 'rejected' }),
          ],
        },
      },
      needs_human_decision: { ok: true, data: { cases: [] } },
      verification_pending: { ok: true, data: { cases: [] } },
    });
    expect(dashboardRefreshInterval(payload)).toBe(60000);
  });

  it('ignores failed sections when deciding cadence', () => {
    const payload = makePayload({
      myCases: { ok: false, error: 'boom' },
      needs_human_decision: { ok: true, data: { cases: [] } },
      verification_pending: { ok: true, data: { cases: [] } },
    });
    // No non-terminal cases visible → slow cadence.
    expect(dashboardRefreshInterval(payload)).toBe(60000);
  });
});

describe('dashboardSwrConfig', () => {
  it('enables revalidateOnFocus', () => {
    expect(dashboardSwrConfig.revalidateOnFocus).toBe(true);
  });

  it('wires refreshInterval to dashboardRefreshInterval', () => {
    // Idle → slow cadence.
    expect(dashboardSwrConfig.refreshInterval(undefined)).toBe(60000);
    // Non-terminal visible → fast cadence.
    const payload = makePayload({
      myCases: {
        ok: true,
        data: { cases: [makeCase({ status: 'in_build' })] },
      },
    });
    expect(dashboardSwrConfig.refreshInterval(payload)).toBe(1500);
  });
});

describe('collectPendingMergeCases', () => {
  it('returns empty when data is undefined', () => {
    expect(collectPendingMergeCases(undefined)).toEqual([]);
  });

  it('collects pending_merge cases with current_pr_ref across all sections', () => {
    const a = makeCase({
      case_id: 'a',
      status: 'pending_merge',
      current_pr_ref: 'https://github.com/x/y/pull/1',
    });
    const b = makeCase({
      case_id: 'b',
      status: 'pending_merge',
      current_pr_ref: 'https://github.com/x/y/pull/2',
    });
    const payload = makePayload({
      myCases: { ok: true, data: { cases: [a] } },
      needs_human_decision: { ok: true, data: { cases: [b] } },
    });
    expect(collectPendingMergeCases(payload).map((c) => c.case_id)).toEqual(['a', 'b']);
  });

  it('dedupes a case appearing in multiple sections', () => {
    const c = makeCase({
      case_id: 'dup',
      status: 'pending_merge',
      current_pr_ref: 'https://github.com/x/y/pull/1',
    });
    const payload = makePayload({
      myCases: { ok: true, data: { cases: [c] } },
      needs_human_decision: { ok: true, data: { cases: [c] } },
      verification_pending: { ok: true, data: { cases: [c] } },
    });
    const result = collectPendingMergeCases(payload);
    expect(result).toHaveLength(1);
    expect(result[0]?.case_id).toBe('dup');
  });

  it('skips pending_merge cases without current_pr_ref', () => {
    const c = makeCase({ case_id: 'no-pr', status: 'pending_merge' });
    const payload = makePayload({
      myCases: { ok: true, data: { cases: [c] } },
    });
    expect(collectPendingMergeCases(payload)).toEqual([]);
  });

  it('ignores failed sections', () => {
    const payload = makePayload({
      myCases: { ok: false, error: 'boom' },
    });
    expect(collectPendingMergeCases(payload)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: the client calls /api/dashboard exactly once.
//
// Mocks `getToken` to bypass firebase import, stubs `fetch`, calls
// `api.dashboard.get()`, and asserts both the URL and request count.
// ---------------------------------------------------------------------------

vi.mock('../../lib/firebase-client', () => ({
  getIdToken: async () => 'test-token',
}));

describe('api.dashboard.get', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fires a single GET to /api/dashboard with auth header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makePayload()), { status: 200 }),
    );

    const { api } = await import('../../lib/api-client');
    const result = await api.dashboard.get();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('/api/dashboard');
    expect(init.method).toBeUndefined(); // defaults to GET
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBe('Bearer test-token');

    // Payload round-trips.
    expect(result.myCases.ok).toBe(true);
    expect(result.observatory.ok).toBe(true);
  });
});
