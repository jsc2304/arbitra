import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, UserRole } from '@arbitra/shared';
import {
  TRIAGE_VIEWS,
  TRIAGE_VIEW_LABELS,
  blocked,
  getTriageViewPredicate,
  myActive,
  needsMe,
  readyToApprove,
  recentlyUpdated,
  waitingOnOthers,
  type TriageView,
} from '../triage-views';

// --- Fixtures --------------------------------------------------------------

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Sample Case',
    description: 'desc',
    source_type: 'manual',
    source_ref: 'ref',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'user_owner',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    ...overrides,
  };
}

// --- TRIAGE_VIEWS / labels -------------------------------------------------

describe('TRIAGE_VIEWS', () => {
  it('lists all seven views in order', () => {
    expect(TRIAGE_VIEWS).toEqual([
      'needs-me',
      'ready-to-approve',
      'blocked',
      'waiting-on-others',
      'recently-updated',
      'my-active',
      'all',
    ]);
  });

  it('has a label for every view', () => {
    for (const v of TRIAGE_VIEWS) {
      expect(TRIAGE_VIEW_LABELS[v]).toBeTypeOf('string');
      expect(TRIAGE_VIEW_LABELS[v].length).toBeGreaterThan(0);
    }
  });
});

// --- needsMe ---------------------------------------------------------------

describe('needsMe', () => {
  const userId = 'user_me';
  const reviewerRoles: UserRole[] = ['reviewer'];
  const devRoles: UserRole[] = ['developer'];

  it('returns true when the user is the assigned reviewer', () => {
    const c = makeCase({ assigned_reviewer_id: userId, status: 'in_review' });
    expect(needsMe(c, userId, devRoles)).toBe(true);
  });

  it('returns true for gate-confirmable when user is not the owner', () => {
    const c = makeCase({
      owner_user_id: 'user_other',
      pending_gate: {
        gate_id: 'ready_to_build',
        target_status: 'ready_for_build',
        since: '2026-04-15T00:00:00.000Z',
      },
    });
    expect(needsMe(c, userId, devRoles)).toBe(true);
  });

  it('returns true for queue pickup when reviewer role and no assignee', () => {
    const c = makeCase({
      status: 'needs_human_decision',
      assigned_reviewer_id: undefined,
    });
    expect(needsMe(c, userId, reviewerRoles)).toBe(true);
  });

  it('returns false when owner tries to self-confirm their own gate (anti-gaming)', () => {
    const c = makeCase({
      owner_user_id: userId,
      pending_gate: {
        gate_id: 'ready_to_build',
        target_status: 'ready_for_build',
        since: '2026-04-15T00:00:00.000Z',
      },
      status: 'exploration',
    });
    expect(needsMe(c, userId, devRoles)).toBe(false);
  });

  it('returns false for queue pickup when user lacks reviewer-class role', () => {
    const c = makeCase({
      status: 'needs_human_decision',
      assigned_reviewer_id: undefined,
    });
    expect(needsMe(c, userId, devRoles)).toBe(false);
  });

  it('returns false when userId is empty', () => {
    const c = makeCase({ assigned_reviewer_id: '' });
    expect(needsMe(c, '', reviewerRoles)).toBe(false);
  });

  it('accepts tech_lead and admin as reviewer-class roles', () => {
    const c = makeCase({
      status: 'verification_pending',
      assigned_reviewer_id: undefined,
    });
    expect(needsMe(c, userId, ['tech_lead'])).toBe(true);
    expect(needsMe(c, userId, ['admin'])).toBe(true);
  });
});

// --- readyToApprove --------------------------------------------------------

describe('readyToApprove', () => {
  it('returns true for needs_human_decision', () => {
    expect(readyToApprove(makeCase({ status: 'needs_human_decision' }))).toBe(true);
  });

  it('returns true for verification_pending regardless of assignment', () => {
    expect(
      readyToApprove(
        makeCase({ status: 'verification_pending', assigned_reviewer_id: undefined }),
      ),
    ).toBe(true);
  });

  it('returns false for in_review (still being reviewed, not yet decision-ready)', () => {
    expect(readyToApprove(makeCase({ status: 'in_review' }))).toBe(false);
  });

  it('returns false for terminal statuses', () => {
    expect(readyToApprove(makeCase({ status: 'done' }))).toBe(false);
    expect(readyToApprove(makeCase({ status: 'rejected' }))).toBe(false);
  });
});

// --- blocked ---------------------------------------------------------------

describe('blocked', () => {
  it('returns true when findingCount > 0', () => {
    expect(blocked(makeCase({ status: 'in_build' }), 2)).toBe(true);
  });

  it('returns true for rejected status regardless of findingCount', () => {
    expect(blocked(makeCase({ status: 'rejected' }), 0)).toBe(true);
    expect(blocked(makeCase({ status: 'rejected' }), undefined)).toBe(true);
  });

  it('returns false when findingCount is 0 and status is not rejected', () => {
    expect(blocked(makeCase({ status: 'in_build' }), 0)).toBe(false);
  });

  it('returns false when findingCount is omitted and status is not rejected', () => {
    expect(blocked(makeCase({ status: 'in_build' }))).toBe(false);
  });
});

// --- waitingOnOthers -------------------------------------------------------

describe('waitingOnOthers', () => {
  const userId = 'user_owner';

  it('returns true when owner and status is in_build', () => {
    expect(waitingOnOthers(makeCase({ status: 'in_build' }), userId)).toBe(true);
  });

  it('returns true when owner and status is in_validation', () => {
    expect(waitingOnOthers(makeCase({ status: 'in_validation' }), userId)).toBe(true);
  });

  it('returns true when owner and status is in_review', () => {
    expect(waitingOnOthers(makeCase({ status: 'in_review' }), userId)).toBe(true);
  });

  it('returns false when not the owner', () => {
    expect(
      waitingOnOthers(makeCase({ owner_user_id: 'someone_else', status: 'in_build' }), userId),
    ).toBe(false);
  });

  it('returns false when owner but status is not in the waiting set', () => {
    expect(waitingOnOthers(makeCase({ status: 'open' }), userId)).toBe(false);
    expect(waitingOnOthers(makeCase({ status: 'done' }), userId)).toBe(false);
  });
});

// --- recentlyUpdated -------------------------------------------------------

describe('recentlyUpdated', () => {
  const NOW = new Date('2026-04-16T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true when updated_at (ISO string) is within the default 24h window', () => {
    const c = makeCase({ updated_at: new Date(NOW - 60 * 60 * 1000).toISOString() });
    expect(recentlyUpdated(c)).toBe(true);
  });

  it('returns false when updated_at is older than the default window', () => {
    const c = makeCase({ updated_at: new Date(NOW - 48 * 60 * 60 * 1000).toISOString() });
    expect(recentlyUpdated(c)).toBe(false);
  });

  it('accepts a numeric timestamp input', () => {
    // `Case.updated_at` is typed as string, but the selector normalizes both
    // strings and numbers — simulate a numeric feed by widening at the boundary.
    const c = makeCase();
    (c as unknown as { updated_at: number }).updated_at = NOW - 10 * 60 * 1000;
    expect(recentlyUpdated(c)).toBe(true);
  });

  it('honors a custom sinceMs window', () => {
    const c = makeCase({ updated_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() });
    expect(recentlyUpdated(c, 60 * 60 * 1000)).toBe(false); // 1h window
    expect(recentlyUpdated(c, 3 * 60 * 60 * 1000)).toBe(true); // 3h window
  });

  it('returns false for invalid/unparseable timestamps', () => {
    const c = makeCase({ updated_at: 'not-a-date' });
    expect(recentlyUpdated(c)).toBe(false);
  });
});

// --- myActive --------------------------------------------------------------

describe('myActive', () => {
  const userId = 'user_owner';

  it('returns true when owner and status is in flight', () => {
    expect(myActive(makeCase({ status: 'in_build' }), userId)).toBe(true);
    expect(myActive(makeCase({ status: 'open' }), userId)).toBe(true);
  });

  it('returns false when owner but status is done', () => {
    expect(myActive(makeCase({ status: 'done' }), userId)).toBe(false);
  });

  it('returns false when owner but status is rejected', () => {
    expect(myActive(makeCase({ status: 'rejected' }), userId)).toBe(false);
  });

  it('returns false when not the owner', () => {
    expect(
      myActive(makeCase({ owner_user_id: 'someone_else', status: 'in_build' }), userId),
    ).toBe(false);
  });
});

// --- getTriageViewPredicate -----------------------------------------------

describe('getTriageViewPredicate', () => {
  const ctx = { userId: 'user_me', roles: ['reviewer'] as UserRole[] };

  it('routes each view id to a matching selector', () => {
    const cases: Record<TriageView, Case> = {
      all: makeCase({}),
      'needs-me': makeCase({ assigned_reviewer_id: 'user_me' }),
      'ready-to-approve': makeCase({ status: 'needs_human_decision' }),
      blocked: makeCase({ status: 'rejected' }),
      'waiting-on-others': makeCase({ owner_user_id: 'user_me', status: 'in_build' }),
      'recently-updated': makeCase({ updated_at: new Date().toISOString() }),
      'my-active': makeCase({ owner_user_id: 'user_me', status: 'in_build' }),
    };
    for (const view of TRIAGE_VIEWS) {
      const predicate = getTriageViewPredicate(view, ctx);
      expect(predicate(cases[view])).toBe(true);
    }
  });

  it('threads findingCounts through to the blocked selector', () => {
    const c = makeCase({ case_id: 'case_has_findings', status: 'in_build' });
    const predicateWithCounts = getTriageViewPredicate('blocked', {
      ...ctx,
      findingCounts: { case_has_findings: 3 },
    });
    expect(predicateWithCounts(c)).toBe(true);

    const predicateWithoutCounts = getTriageViewPredicate('blocked', ctx);
    expect(predicateWithoutCounts(c)).toBe(false);
  });

  it('returns a predicate that rejects unrelated cases', () => {
    const predicate = getTriageViewPredicate('my-active', ctx);
    expect(predicate(makeCase({ owner_user_id: 'someone_else' }))).toBe(false);
  });
});
