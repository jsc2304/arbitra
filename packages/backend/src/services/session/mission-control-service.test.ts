import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ActiveSessionSummary } from '@arbitra/shared';
import type { Case } from '@arbitra/shared';

/**
 * Tests `buildMissionControlAggregate` (issue #989 / ADR-0001): the read
 * aggregate joining active sessions with repository → project and
 * branch → case, computed on read with no separate storage layer.
 *
 * The three collaborators (`listActiveSessions`, `resolveCaseByBranch`, and
 * the `repositories`/`projects` Firestore doc reads) are mocked at their
 * module boundaries — this test exercises only the join/scoping logic in
 * mission-control-service.ts itself.
 */

const {
  listActiveSessions,
  listSessionsSince,
  resolveCaseByBranch,
  repoGet,
  projectGet,
  projectsGetAll,
  resolveRepositoryForSignal,
} = vi.hoisted(() => ({
  listActiveSessions: vi.fn(),
  listSessionsSince: vi.fn(),
  resolveCaseByBranch: vi.fn(),
  repoGet: vi.fn(),
  projectGet: vi.fn(),
  projectsGetAll: vi.fn(),
  resolveRepositoryForSignal: vi.fn(),
}));

vi.mock('./session-signal-service.js', () => ({ listActiveSessions, listSessionsSince }));
vi.mock('../case/branch-resolution.js', () => ({ resolveCaseByBranch }));
vi.mock('../webhook/webhook-service.js', () => ({
  WebhookService: class {
    resolveRepositoryForSignal = resolveRepositoryForSignal;
  },
}));
vi.mock('../../lib/firestore.js', () => ({
  collections: {
    repositories: () => ({
      doc: (id: string) => {
        // The real Firestore SDK rejects doc ids containing '/'; passing a
        // remote URL here used to surface as a 500. Mirror
        // that contract so a regression fails loudly in tests too.
        if (id.includes('/')) throw new Error(`invalid doc id: ${id}`);
        return { get: () => repoGet(id) };
      },
    }),
    projects: () => ({
      // `.get()` (`projectGet`) is kept only so a revert of the `getAll`
      // batching (issue #1003) still resolves to *some* mock and fails on
      // the call-count assertions below, rather than crashing on a missing
      // method — see the "bounded reads" describe block.
      doc: (id: string) => ({ id, get: () => projectGet(id) }),
      firestore: { getAll: (...refs: { id: string }[]) => projectsGetAll(...refs) },
    }),
  },
}));

import {
  buildMissionControlAggregate,
  buildActiveSessionsPanel,
  applyMissionControlRowCap,
  __resetMissionControlAggregateCache,
} from './mission-control-service.js';
import { MISSION_CONTROL_ROW_CAP, type MissionControlSessionRow, type SessionActivityRecord } from '@arbitra/shared';

function session(overrides: Partial<ActiveSessionSummary> = {}): ActiveSessionSummary {
  return {
    session_id: 'sess_1',
    agent_name: 'claude-code',
    repository: 'repo_a',
    branch: 'feat/foo',
    last_seen_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function activityRecord(overrides: Partial<SessionActivityRecord> = {}): SessionActivityRecord {
  return {
    session_id: 'sess_1',
    repository: 'repo_a',
    last_seen_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Some case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_a',
    repository_id: 'repo_a',
    owner_user_id: 'usr_1',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    case_type: 'other',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as Case;
}

/** Shared by both the individual-`get()` mock and the `getAll` mock below, so a revert from one to the other stays behaviorally equivalent — only the call-count assertions tell them apart. */
function projectSnapshot(id: string) {
  if (id === 'proj_a') return { exists: true, id, data: () => ({ project_id: 'proj_a', name: 'Project A' }) };
  if (id === 'proj_b') return { exists: true, id, data: () => ({ project_id: 'proj_b', name: 'Project B' }) };
  return { exists: false, id, data: () => undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The unscoped-rows cache (issue #1003) is process-wide and outlives
  // `vi.clearAllMocks()` — reset it explicitly so a cache hit from a prior
  // test never serves stale rows / mock-not-called into this one.
  __resetMissionControlAggregateCache();
  resolveRepositoryForSignal.mockReset();
  resolveRepositoryForSignal.mockResolvedValue(null);
  repoGet.mockImplementation((id: string) => {
    if (id === 'repo_a') {
      return Promise.resolve({ exists: true, data: () => ({ repository_id: 'repo_a', project_id: 'proj_a', name: 'arbitra-app' }) });
    }
    if (id === 'repo_b') {
      return Promise.resolve({ exists: true, data: () => ({ repository_id: 'repo_b', project_id: 'proj_b', name: 'other-repo' }) });
    }
    return Promise.resolve({ exists: false, data: () => undefined });
  });
  projectGet.mockImplementation((id: string) => Promise.resolve(projectSnapshot(id)));
  projectsGetAll.mockImplementation((...refs: { id: string }[]) =>
    Promise.resolve(refs.map((ref) => projectSnapshot(ref.id))),
  );
  resolveCaseByBranch.mockResolvedValue({ case: null, ambiguous: false });
});

describe('buildMissionControlAggregate', () => {
  it('returns an empty list when there are no active sessions', async () => {
    // Reverting the `sessions.length === 0` early return to always continue
    // would still produce `[]` here (nothing to iterate), so this alone
    // isn't the strongest signal — paired with the next test it pins the
    // early-return branch's presence.
    listActiveSessions.mockResolvedValue([]);
    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });
    expect(rows).toEqual([]);
    expect(repoGet).not.toHaveBeenCalled();
  });

  it('joins an active session with its case, project, and repository', async () => {
    // Reverting the case-summary projection (case_id/title/status) in
    // mission-control-service.ts would drop or rename these fields, failing
    // this assertion.
    listActiveSessions.mockResolvedValue([session()]);
    resolveCaseByBranch.mockResolvedValue({
      case: makeCase({ case_id: 'case_bound', title: 'Bound case', status: 'in_review' }),
      ambiguous: false,
    });

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows).toEqual([
      {
        session_id: 'sess_1',
        agent_name: 'claude-code',
        repository_id: 'repo_a',
        repository_name: 'arbitra-app',
        project_id: 'proj_a',
        project_name: 'Project A',
        branch: 'feat/foo',
        case: { case_id: 'case_bound', title: 'Bound case', status: 'in_review', case_type: 'other' },
        last_seen_at: '2026-08-27T00:00:00.000Z',
      },
    ]);
  });

  it('threads case_type through the case summary (issue #1018)', async () => {
    // The Mission Control session row must carry `case_type` alongside
    // `status` so the frontend can render the same "Observing" label an
    // Observed Case's detail page shows — losing this field would silently
    // fall the row back to the generic "Building" label.
    listActiveSessions.mockResolvedValue([session()]);
    resolveCaseByBranch.mockResolvedValue({
      case: makeCase({ case_id: 'case_observed', title: 'Observed: main', status: 'in_build', case_type: 'observed' }),
      ambiguous: false,
    });

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows[0]?.case?.case_type).toBe('observed');
  });

  it('shows a session on a branch with no bound case as case: null ("no case yet")', async () => {
    // Reverting the `matchedCase ? {...} : null` mapping to always build a
    // case object (e.g. from `undefined` fields) would fail this exact
    // `toBeNull()` assertion.
    listActiveSessions.mockResolvedValue([session()]);
    resolveCaseByBranch.mockResolvedValue({ case: null, ambiguous: false });

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows[0]!.case).toBeNull();
  });

  it('drops a session whose repository cannot be resolved, even for an admin (fail closed)', async () => {
    // Reverting the `if (!repo) continue` fail-closed branch (e.g. falling
    // back to a placeholder repo/project name) would keep this row in the
    // result instead of dropping it, failing the `toHaveLength(0)` assertion.
    listActiveSessions.mockResolvedValue([session({ repository: 'repo_unknown' })]);

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows).toHaveLength(0);
  });

  it('resolves a session whose repository is a remote URL via webhook name-matching', async () => {
    // Session Signals carry the git remote URL, not a repository doc id.
    // Reverting the ref-resolution step (passing session.repository straight
    // into collections.repositories().doc()) throws on the '/' in the URL —
    // surfacing as a Mission Control 500.
    listActiveSessions.mockResolvedValue([
      session({ repository: 'https://github.com/acme/acme-archive-poc' }),
    ]);
    resolveRepositoryForSignal.mockResolvedValue({
      repository_id: 'repo_a',
      project_id: 'proj_a',
      name: 'arbitra-app',
    });
    resolveCaseByBranch.mockResolvedValue({ case: null, ambiguous: false });

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.repository_id).toBe('repo_a');
    expect(rows[0]!.project_name).toBe('Project A');
    // Case resolution must use the RESOLVED repository id, not the raw URL.
    expect(resolveCaseByBranch).toHaveBeenCalledWith({ repositoryId: 'repo_a', branch: 'feat/foo' });
  });

  it('drops a session whose repository ref is a bare name unresolvable via strict matching (issue #1013)', async () => {
    // `resolveSessionRepositories` calls `resolveRepositoryForSignal`, which
    // does exact matching only — a bare name that only substring-matches a
    // stored repo URL (a container folder named "arbitra") must resolve
    // to nothing here too, since `resolveRepositoryForSignal` itself owns
    // that guarantee (tested directly in webhook-service.repo-match.test.ts).
    // This test pins that `resolveSessionRepositories` doesn't silently fall
    // back to a looser matcher when the strict one returns null.
    listActiveSessions.mockResolvedValue([session({ repository: 'arbitra' })]);
    resolveRepositoryForSignal.mockResolvedValue(null);

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows).toHaveLength(0);
  });

  it('scopes to the accessible project set for a non-admin caller', async () => {
    // Reverting the `accessibleProjectIds.has(projectId)` filter (or the
    // `!== 'all'` guard around it) would let the repo_b/proj_b session
    // through even though it's not in the accessible set, failing this
    // assertion.
    listActiveSessions.mockResolvedValue([
      session({ session_id: 'sess_a', repository: 'repo_a', branch: 'feat/a' }),
      session({ session_id: 'sess_b', repository: 'repo_b', branch: 'feat/b' }),
    ]);

    const rows = await buildMissionControlAggregate({
      accessibleProjectIds: new Set(['proj_a']),
    });

    expect(rows.map((r) => r.session_id)).toEqual(['sess_a']);
  });

  it("lets an admin ('all') see sessions across every project", async () => {
    // Reverting the `accessibleProjectIds !== 'all'` guard (always applying
    // the membership filter) would drop the proj_b session for an admin
    // too, failing this length assertion.
    listActiveSessions.mockResolvedValue([
      session({ session_id: 'sess_a', repository: 'repo_a', branch: 'feat/a' }),
      session({ session_id: 'sess_b', repository: 'repo_b', branch: 'feat/b' }),
    ]);

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows.map((r) => r.session_id).sort()).toEqual(['sess_a', 'sess_b']);
  });

  it('resolves the case for two sessions sharing the same repository+branch only once', async () => {
    // Reverting the `caseByRepoBranch` memoization (calling
    // `resolveCaseByBranch` unconditionally per session again) would call it
    // twice here instead of once, failing this assertion.
    listActiveSessions.mockResolvedValue([
      session({ session_id: 'sess_a', repository: 'repo_a', branch: 'feat/shared' }),
      session({ session_id: 'sess_b', repository: 'repo_a', branch: 'feat/shared' }),
    ]);

    await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(resolveCaseByBranch).toHaveBeenCalledTimes(1);
  });
});

describe('bounded reads (issue #1003)', () => {
  it('batches project doc reads into a single getAll call regardless of how many distinct projects are involved', async () => {
    // Reverting the `getAll(...)` batch in `computeUnscopedRows` back to
    // `Promise.all(projectIds.map((id) => collections.projects().doc(id).get()))`
    // (mission-control-service.ts) would call the mock's `.doc(id).get()`
    // path (`projectGet`) instead of `projectsGetAll`, so `projectsGetAll`
    // would never be called — failing the `toHaveBeenCalledTimes(1)`
    // assertion below.
    listActiveSessions.mockResolvedValue([
      session({ session_id: 'sess_a', repository: 'repo_a', branch: 'feat/a' }),
      session({ session_id: 'sess_b', repository: 'repo_b', branch: 'feat/b' }),
    ]);

    const rows = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(rows.map((r) => r.project_name).sort()).toEqual(['Project A', 'Project B']);
    expect(projectsGetAll).toHaveBeenCalledTimes(1);
    expect(projectGet).not.toHaveBeenCalled();
  });

  it('does not recompute the join on a second call within the cache window (shared across callers)', async () => {
    // Reverting the cache short-circuit in `buildMissionControlAggregate`
    // (e.g. always calling `computeUnscopedRows` instead of
    // `getUnscopedRowsCached` when `referenceTime` is undefined) would make
    // `listActiveSessions` run again on the second call, failing the
    // `toHaveBeenCalledTimes(1)` assertion — both calls omit
    // `referenceTime`, exactly like the real route.
    listActiveSessions.mockResolvedValue([session()]);
    resolveCaseByBranch.mockResolvedValue({
      case: { case_id: 'case_1', title: 'A case', status: 'in_build', case_type: 'other' },
      ambiguous: false,
    });

    const first = await buildMissionControlAggregate({ accessibleProjectIds: 'all' });
    // A second, differently-scoped caller (admin vs. non-admin) within the
    // same cache window must reuse the same underlying join.
    const second = await buildMissionControlAggregate({ accessibleProjectIds: new Set(['proj_a']) });

    expect(listActiveSessions).toHaveBeenCalledTimes(1);
    expect(projectsGetAll).toHaveBeenCalledTimes(1);
    expect(resolveCaseByBranch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('recomputes once the cache window has elapsed', async () => {
    // Reverting the TTL comparison in `getUnscopedRowsCached` (e.g. an
    // always-true or inverted staleness check) would make this second call,
    // 9s later, reuse the first call's cached rows instead of recomputing —
    // failing the `toHaveBeenCalledTimes(2)` assertion.
    listActiveSessions.mockResolvedValue([session()]);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);

    await buildMissionControlAggregate({ accessibleProjectIds: 'all' });
    nowSpy.mockReturnValue(1_000_000 + 9_000); // past the 8s TTL
    await buildMissionControlAggregate({ accessibleProjectIds: 'all' });

    expect(listActiveSessions).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});

describe('applyMissionControlRowCap (issue #1003)', () => {
  function row(id: string): MissionControlSessionRow {
    return {
      session_id: id,
      agent_name: 'claude-code',
      repository_id: 'repo_a',
      repository_name: 'arbitra-app',
      project_id: 'proj_a',
      project_name: 'Project A',
      branch: 'feat/foo',
      case: null,
      last_seen_at: '2026-08-27T00:00:00.000Z',
    };
  }

  it('passes rows through unchanged and reports zero truncation when under the cap', () => {
    // Reverting the `rows.length <= MISSION_CONTROL_ROW_CAP` short circuit
    // (e.g. always slicing) would still produce a length-1 array here, so
    // pair this with the over-cap test — but on its own, reverting the
    // `truncated_session_count: 0` branch to always compute
    // `rows.length - MISSION_CONTROL_ROW_CAP` would report a negative
    // count instead of 0, failing this assertion.
    const result = applyMissionControlRowCap([row('s1')]);
    expect(result.sessions).toEqual([row('s1')]);
    expect(result.truncated_session_count).toBe(0);
  });

  it('caps the list and reports how many rows were dropped when over the cap', () => {
    // Reverting the `.slice(0, MISSION_CONTROL_ROW_CAP)` (e.g. returning
    // `rows` unsliced) would fail the `toHaveLength(MISSION_CONTROL_ROW_CAP)`
    // assertion; reverting the truncated-count arithmetic would fail the
    // `toBe(3)` assertion.
    const rows = Array.from({ length: MISSION_CONTROL_ROW_CAP + 3 }, (_, i) => row(`s${i}`));

    const result = applyMissionControlRowCap(rows);

    expect(result.sessions).toHaveLength(MISSION_CONTROL_ROW_CAP);
    expect(result.truncated_session_count).toBe(3);
  });
});

describe('buildActiveSessionsPanel (issue #990)', () => {
  const NOW = new Date('2026-08-27T00:00:00.000Z');
  const isoHoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

  it('returns all-zero windows when there is no session activity', async () => {
    // Reverting the empty-input short circuit to instead skip straight to
    // bucketing an empty array happens to produce the same zeros, so this
    // test alone is weak — paired with the bucketing tests below it pins
    // the shape of the empty result.
    listSessionsSince.mockResolvedValue([]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel).toEqual({
      window_24h: { sessions: 0, distinct_users: 0 },
      window_7d: { sessions: 0, distinct_users: 0 },
      window_30d: { sessions: 0, distinct_users: 0 },
    });
  });

  it('buckets a session into every window whose cutoff it falls inside', async () => {
    // Reverting the per-window `last_seen_at >= cutoff` comparison (e.g.
    // bucketing into exactly one window instead of every window the
    // timestamp qualifies for) would leave window_7d/window_30d at 0
    // instead of 1, failing those assertions.
    listSessionsSince.mockResolvedValue([activityRecord({ last_seen_at: isoHoursAgo(1) })]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel.window_24h.sessions).toBe(1);
    expect(panel.window_7d.sessions).toBe(1);
    expect(panel.window_30d.sessions).toBe(1);
  });

  it('excludes a session from 24h but keeps it in 7d/30d when it is 2 days old', async () => {
    // Reverting the 24h cutoff arithmetic (e.g. using the 7d window's
    // duration for all three windows) would count this session in
    // window_24h too, failing that assertion.
    listSessionsSince.mockResolvedValue([activityRecord({ last_seen_at: isoHoursAgo(48) })]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel.window_24h.sessions).toBe(0);
    expect(panel.window_7d.sessions).toBe(1);
    expect(panel.window_30d.sessions).toBe(1);
  });

  it('excludes a session from every window when it is older than 30 days', async () => {
    // Reverting the 30d cutoff (e.g. dropping it and treating every session
    // `listSessionsSince` returns as always in-window) would count this
    // session in window_30d too, failing that assertion.
    listSessionsSince.mockResolvedValue([activityRecord({ last_seen_at: isoHoursAgo(31 * 24) })]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel.window_30d.sessions).toBe(0);
  });

  it('counts distinct users, not sessions, when one user runs multiple sessions', async () => {
    // Reverting distinct-user counting to `sessions.length` (or to counting
    // every session's user_id without deduping) would report 3 here instead
    // of 2, failing this assertion.
    listSessionsSince.mockResolvedValue([
      activityRecord({ session_id: 's1', last_seen_at: isoHoursAgo(1), user_id: 'usr_alice' }),
      activityRecord({ session_id: 's2', last_seen_at: isoHoursAgo(2), user_id: 'usr_alice' }),
      activityRecord({ session_id: 's3', last_seen_at: isoHoursAgo(3), user_id: 'usr_bob' }),
    ]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel.window_24h.sessions).toBe(3);
    expect(panel.window_24h.distinct_users).toBe(2);
  });

  it('counts a session toward `sessions` but not `distinct_users` when it has no user_id', async () => {
    // Reverting the "only sessions carrying user_id contribute to
    // distinct_users" rule (e.g. counting an undefined user_id as its own
    // distinct value) would report 1 here instead of 0, failing this
    // assertion.
    listSessionsSince.mockResolvedValue([activityRecord({ last_seen_at: isoHoursAgo(1), user_id: undefined })]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel.window_24h.sessions).toBe(1);
    expect(panel.window_24h.distinct_users).toBe(0);
  });

  it('scopes the panel to the accessible project set for a non-admin caller', async () => {
    // Reverting the project-scoping filter in the panel path (mirroring
    // `buildMissionControlAggregate`'s) would count the repo_b session too,
    // failing the `sessions: 1` assertion.
    listSessionsSince.mockResolvedValue([
      activityRecord({ session_id: 's1', repository: 'repo_a', last_seen_at: isoHoursAgo(1) }),
      activityRecord({ session_id: 's2', repository: 'repo_b', last_seen_at: isoHoursAgo(1) }),
    ]);

    const panel = await buildActiveSessionsPanel({
      accessibleProjectIds: new Set(['proj_a']),
      referenceTime: NOW,
    });

    expect(panel.window_24h.sessions).toBe(1);
  });

  it('drops a session whose repository cannot be resolved, even for an admin (fail closed)', async () => {
    // Reverting the fail-closed drop for an unresolvable repository would
    // count this session anyway, failing the `sessions: 0` assertion.
    listSessionsSince.mockResolvedValue([
      activityRecord({ repository: 'repo_unknown', last_seen_at: isoHoursAgo(1) }),
    ]);

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: 'all', referenceTime: NOW });

    expect(panel.window_24h.sessions).toBe(0);
  });

  it('counts a session whose repository is a remote URL via webhook name-matching', async () => {
    // Same class as the aggregate: the panel's scoping used the raw
    // session.repository as a Firestore doc id. Reverting the shared
    // ref-resolution drops (or crashes on) this URL-keyed session.
    listSessionsSince.mockResolvedValue([
      activityRecord({
        repository: 'https://github.com/acme/acme-archive-poc',
        last_seen_at: isoHoursAgo(1),
        user_id: 'usr_1',
      }),
    ]);
    resolveRepositoryForSignal.mockResolvedValue({
      repository_id: 'repo_a',
      project_id: 'proj_a',
      name: 'arbitra-app',
    });

    const panel = await buildActiveSessionsPanel({ accessibleProjectIds: new Set(['proj_a']), referenceTime: NOW });

    expect(panel.window_24h.sessions).toBe(1);
    expect(panel.window_24h.distinct_users).toBe(1);
  });
});
