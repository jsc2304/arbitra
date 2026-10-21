import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Case } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Mocks — wired before importing the route.
//
// The route calls:
//   - CaseService.listCases (three times, once per case-section)
//   - buildObservatoryAggregate (once, for the observatory section)
//   - checkIsAdmin / getAccessibleProjectIds / isEffectiveMember / collections
//     for project-access filtering (matches /api/cases and /api/observatory)
//
// We mock @arbitra/backend at module level and buildObservatoryAggregate via
// a relative mock on the helpers file.
// ---------------------------------------------------------------------------

const {
  listCases,
  checkIsAdmin,
  getAccessibleProjectIds,
  isEffectiveMember,
  projectsDocGet,
  authenticateFromHeader,
} = vi.hoisted(() => ({
  listCases: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
  isEffectiveMember: vi.fn(),
  projectsDocGet: vi.fn(),
  authenticateFromHeader: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseService: vi.fn().mockImplementation(() => ({
    listCases,
  })),
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown) => schema.parse(body),
  authenticateFromHeader,
  formatError: (error: unknown) => ({
    status: 500,
    body: { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'error' } },
  }),
  checkIsAdmin,
  getAccessibleProjectIds,
  isEffectiveMember,
  collections: {
    projects: () => ({
      doc: () => ({ get: projectsDocGet }),
    }),
  },
}));

const { buildObservatoryAggregate } = vi.hoisted(() => ({
  buildObservatoryAggregate: vi.fn(),
}));

vi.mock('../observatory/observatory-helpers', () => ({
  buildObservatoryAggregate,
}));

import { GET } from './route';

function makeRequest(token = 'test-token'): NextRequest {
  return new NextRequest('http://localhost/api/dashboard', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

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

const OBSERVATORY_FIXTURE = {
  summary: {
    total_cases: 2,
    pending_reviews: 0,
    approval_rate: 50,
    avg_findings_per_case: 0,
    total_findings: 0,
    open_findings: 0,
    total_knowledge_assets: 0,
  },
  cases_by_status: {},
  risk_distribution: {},
  track_distribution: {},
  findings_by_severity: {},
  recent_activity: [],
  top_contributors: [],
  top_reviewers: [],
  top_repositories: [],
  top_projects: [],
  throughput_leaderboard: [],
  top_referenced_assets: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'user_1' });
  checkIsAdmin.mockResolvedValue(true);
  getAccessibleProjectIds.mockResolvedValue('all');
  isEffectiveMember.mockReturnValue(true);
  projectsDocGet.mockResolvedValue({ exists: false });
  listCases.mockResolvedValue({ cases: [makeCase()] });
  buildObservatoryAggregate.mockResolvedValue(OBSERVATORY_FIXTURE);
});

describe('GET /api/dashboard', () => {
  it('requires authentication', async () => {
    authenticateFromHeader.mockRejectedValueOnce(new Error('unauthorized'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500); // formatError stub returns 500 for unknown errors
    expect(listCases).not.toHaveBeenCalled();
    expect(buildObservatoryAggregate).not.toHaveBeenCalled();
  });

  it('returns all four sections composed from the backend', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.myCases.ok).toBe(true);
    expect(body.needs_human_decision.ok).toBe(true);
    expect(body.verification_pending.ok).toBe(true);
    expect(body.observatory.ok).toBe(true);

    // Three list calls (one per case section), one observatory call.
    expect(listCases).toHaveBeenCalledTimes(3);
    expect(buildObservatoryAggregate).toHaveBeenCalledTimes(1);

    // Filter shapes: my-cases uses owner_user_id, attention lists use status.
    const filterArgs = listCases.mock.calls.map(([f]) => f);
    expect(filterArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner_user_id: 'user_1' }),
        expect.objectContaining({ status: 'needs_human_decision' }),
        expect.objectContaining({ status: 'verification_pending' }),
      ]),
    );

    expect(body.observatory.data.summary.total_cases).toBe(2);
  });

  it('surfaces partial failure instead of failing the whole response', async () => {
    // Observatory blows up; three case-lists succeed.
    buildObservatoryAggregate.mockRejectedValueOnce(new Error('firestore unavailable'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.myCases.ok).toBe(true);
    expect(body.needs_human_decision.ok).toBe(true);
    expect(body.verification_pending.ok).toBe(true);

    expect(body.observatory.ok).toBe(false);
    expect(body.observatory.error).toBe('firestore unavailable');
  });

  it('isolates a failing case-list from other sections', async () => {
    // Second listCases invocation (needs_human_decision) rejects; others succeed.
    listCases
      .mockResolvedValueOnce({ cases: [makeCase({ case_id: 'mine_1' })] })
      .mockRejectedValueOnce(new Error('firestore permission denied'))
      .mockResolvedValueOnce({ cases: [makeCase({ case_id: 'verify_1' })] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.myCases.ok).toBe(true);
    expect(body.verification_pending.ok).toBe(true);
    expect(body.observatory.ok).toBe(true);
    expect(body.needs_human_decision.ok).toBe(false);
    expect(body.needs_human_decision.error).toBe('firestore permission denied');
  });

  it('applies project-access filtering for non-admins', async () => {
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue(['proj_accessible']);
    listCases.mockResolvedValue({
      cases: [
        makeCase({ case_id: 'in_scope', project_id: 'proj_accessible' }),
        makeCase({ case_id: 'out_of_scope', project_id: 'proj_hidden' }),
      ],
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();

    // Only cases in the accessible project survive the filter.
    expect(body.myCases.ok).toBe(true);
    expect(body.myCases.data.cases.map((c: Case) => c.case_id)).toEqual(['in_scope']);

    // Observatory is passed admin=false so it can do its own filtering.
    expect(buildObservatoryAggregate).toHaveBeenCalledWith('user_1', false, null);
  });
});
