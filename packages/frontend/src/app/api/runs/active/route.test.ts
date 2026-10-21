import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentPresence, Case, Run } from '@arbitra/shared';

const {
  authenticate,
  checkIsAdmin,
  getAccessibleProjectIds,
  activeCasesGet,
  pendingRunsGet,
  runningRunsGet,
  presenceGet,
  presenceWhere,
  caseStore,
} = vi.hoisted(() => ({
  authenticate: vi.fn(),
  checkIsAdmin: vi.fn(),
  getAccessibleProjectIds: vi.fn(),
  activeCasesGet: vi.fn(),
  pendingRunsGet: vi.fn(),
  runningRunsGet: vi.fn(),
  presenceGet: vi.fn(),
  presenceWhere: vi.fn(),
  caseStore: new Map<string, unknown>(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'error';
      const status = err instanceof Error && 'status' in err ? (err as Error & { status: number }).status : 500;
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

vi.mock('@arbitra/backend', () => ({
  checkIsAdmin,
  getAccessibleProjectIds,
  collections: {
    activeCases: () => ({
      get: activeCasesGet,
    }),
    cases: () => ({
      doc: (id: string) => ({ id }),
      firestore: {
        getAll: async (...refs: { id: string }[]) =>
          refs.map((ref) => {
            const data = caseStore.get(ref.id);
            return data
              ? { exists: true, id: ref.id, data: () => data }
              : { exists: false, id: ref.id, data: () => undefined };
          }),
      },
    }),
    runs: () => ({
      where: (_field: string, _op: string, value: string) => ({
        get: value === 'pending' ? pendingRunsGet : runningRunsGet,
      }),
    }),
    agentPresence: () => ({
      where: (field: string, op: string, value: string) => {
        presenceWhere(field, op, value);
        return { get: presenceGet };
      },
    }),
  },
}));

import { GET } from './route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/runs/active', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

function doc<T>(value: T) {
  return { data: () => value };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Case 1',
    description: '',
    source_type: 'manual',
    source_ref: 'test',
    project_id: 'proj_a',
    repository_id: 'repo_1',
    owner_user_id: 'user_1',
    status: 'in_review',
    priority: 'normal',
    risk_level: 'medium',
    validation_track: 'direct',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-04-27T10:00:00.000Z',
    updated_at: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: 'case_1',
    run_type: 'review_run',
    trigger_source: 'system:pipeline',
    status: 'running',
    input_refs: [],
    output_refs: [],
    created_at: '2026-04-27T10:00:00.000Z',
    updated_at: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

function makePresence(overrides: Partial<AgentPresence> = {}): AgentPresence {
  return {
    presence_id: 'case_allowed__usr_1',
    case_id: 'case_allowed',
    actor_user_id: 'usr_1',
    actor_display: 'Agent One',
    source: 'ide_agent',
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  checkIsAdmin.mockResolvedValue(false);
  getAccessibleProjectIds.mockResolvedValue(['proj_a']);
  activeCasesGet.mockResolvedValue({
    docs: [
      doc(makeCase({ case_id: 'case_allowed', project_id: 'proj_a' })),
      doc(makeCase({ case_id: 'case_hidden', project_id: 'proj_b' })),
    ],
  });
  pendingRunsGet.mockResolvedValue({ docs: [] });
  runningRunsGet.mockResolvedValue({
    docs: [
      doc(makeRun({ run_id: 'run_allowed', case_id: 'case_allowed' })),
      doc(makeRun({ run_id: 'run_hidden', case_id: 'case_hidden' })),
    ],
  });
  presenceGet.mockResolvedValue({ docs: [] });
  caseStore.clear();
  // Seed default case lookups for presence-status filtering. Tests that need a
  // terminal/soft-deleted variant override the relevant entry.
  caseStore.set(
    'case_allowed',
    makeCase({ case_id: 'case_allowed', project_id: 'proj_a', status: 'in_review', deleted_at: null }),
  );
  caseStore.set(
    'case_hidden',
    makeCase({ case_id: 'case_hidden', project_id: 'proj_b', status: 'in_review', deleted_at: null }),
  );
});

describe('GET /api/runs/active', () => {
  it('scopes non-admin active runs to cases in accessible projects', async () => {
    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeRunsByCase).toEqual({
      case_allowed: [expect.objectContaining({ run_id: 'run_allowed' })],
    });
    expect(body.presenceByCase).toEqual({});
    expect(getAccessibleProjectIds).toHaveBeenCalledWith('user_1', false);
    expect(activeCasesGet).toHaveBeenCalledOnce();
  });

  it('does not filter admins', async () => {
    checkIsAdmin.mockResolvedValue(true);

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.activeRunsByCase).sort()).toEqual(['case_allowed', 'case_hidden']);
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
    expect(activeCasesGet).not.toHaveBeenCalled();
  });

  it('does not filter when project access resolves to all', async () => {
    getAccessibleProjectIds.mockResolvedValue('all');

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.activeRunsByCase).sort()).toEqual(['case_allowed', 'case_hidden']);
    expect(activeCasesGet).not.toHaveBeenCalled();
  });

  it('propagates authentication failures before reading runs', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(runningRunsGet).not.toHaveBeenCalled();
    expect(pendingRunsGet).not.toHaveBeenCalled();
    expect(presenceGet).not.toHaveBeenCalled();
  });

  it('returns presence rows grouped by case and applies the same project filter', async () => {
    presenceGet.mockResolvedValue({
      docs: [
        doc(makePresence({ presence_id: 'case_allowed__u1', case_id: 'case_allowed' })),
        doc(makePresence({ presence_id: 'case_hidden__u1', case_id: 'case_hidden' })),
      ],
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.presenceByCase)).toEqual(['case_allowed']);
    expect(body.presenceByCase.case_allowed).toHaveLength(1);
    // Verifies the route used a `last_seen_at >= cutoff` window query.
    expect(presenceWhere).toHaveBeenCalledWith('last_seen_at', '>=', expect.any(String));
  });

  it('uses a 5-minute lookback window for the presence query', async () => {
    const before = Date.now();
    await GET(makeReq());
    const after = Date.now();

    expect(presenceWhere).toHaveBeenCalledTimes(1);
    const cutoffArg = presenceWhere.mock.calls[0]![2] as string;
    const cutoffMs = new Date(cutoffArg).getTime();
    // Cutoff sits ~5 minutes (300_000 ms) before "now".
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 300_000 - 50);
    expect(cutoffMs).toBeLessThanOrEqual(after - 300_000 + 50);
  });

  it('drops presence rows for cases in a terminal status', async () => {
    caseStore.set(
      'case_allowed',
      makeCase({ case_id: 'case_allowed', project_id: 'proj_a', status: 'done', deleted_at: null }),
    );
    presenceGet.mockResolvedValue({
      docs: [doc(makePresence({ case_id: 'case_allowed' }))],
    });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presenceByCase).toEqual({});
  });

  it('keeps presence rows for cases in an active status', async () => {
    caseStore.set(
      'case_allowed',
      makeCase({ case_id: 'case_allowed', project_id: 'proj_a', status: 'in_build', deleted_at: null }),
    );
    presenceGet.mockResolvedValue({
      docs: [doc(makePresence({ case_id: 'case_allowed' }))],
    });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.presenceByCase)).toEqual(['case_allowed']);
    expect(body.presenceByCase.case_allowed).toHaveLength(1);
  });

  it('drops presence rows for soft-deleted cases', async () => {
    caseStore.set(
      'case_allowed',
      makeCase({
        case_id: 'case_allowed',
        project_id: 'proj_a',
        status: 'in_review',
        deleted_at: '2026-04-26T09:00:00.000Z',
      }),
    );
    presenceGet.mockResolvedValue({
      docs: [doc(makePresence({ case_id: 'case_allowed' }))],
    });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presenceByCase).toEqual({});
  });

  it('returns only the active case when one of two presence rows is terminal', async () => {
    // Admin path so both case_ids reach the status-filter step (the non-admin
    // project filter would otherwise drop case_hidden before status checks).
    checkIsAdmin.mockResolvedValue(true);
    caseStore.set(
      'case_allowed',
      makeCase({ case_id: 'case_allowed', project_id: 'proj_a', status: 'in_review', deleted_at: null }),
    );
    caseStore.set(
      'case_hidden',
      makeCase({ case_id: 'case_hidden', project_id: 'proj_b', status: 'rejected', deleted_at: null }),
    );
    presenceGet.mockResolvedValue({
      docs: [
        doc(makePresence({ presence_id: 'p_active', case_id: 'case_allowed' })),
        doc(makePresence({ presence_id: 'p_terminal', case_id: 'case_hidden' })),
      ],
    });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.presenceByCase)).toEqual(['case_allowed']);
    expect(body.presenceByCase.case_allowed).toHaveLength(1);
  });

  it('drops presence rows when the case document is missing entirely', async () => {
    // A presence heartbeat for a case that no longer exists (hard-deleted in
    // dev / data-pipeline glitch) should not surface as live activity.
    checkIsAdmin.mockResolvedValue(true);
    caseStore.clear();
    presenceGet.mockResolvedValue({
      docs: [doc(makePresence({ case_id: 'case_missing' }))],
    });

    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.presenceByCase).toEqual({});
  });
});
