import { describe, it, expect } from 'vitest';
import {
  TRANSITION_MATRIX,
  getTransitionsFrom,
  findTransition,
  findTransitions,
} from '../constants/status-transitions.js';
import type { CaseStatus } from '../types/case.js';

const ALL_STATUSES: CaseStatus[] = [
  'open', 'exploration', 'ready_for_build', 'in_build', 'in_validation',
  'in_review', 'needs_human_decision', 'verification_pending',
  'approved', 'pending_merge', 'done', 'rejected',
];

const TERMINAL_STATUSES: CaseStatus[] = ['done', 'rejected'];

const NON_TERMINAL_STATUSES: CaseStatus[] = ALL_STATUSES.filter(
  (s) => !TERMINAL_STATUSES.includes(s),
);

// ── TRANSITION_MATRIX structure ──────────────────────────────────────

describe('TRANSITION_MATRIX structure', () => {
  it('should contain exactly 42 transition definitions', () => {
    expect(TRANSITION_MATRIX).toHaveLength(42);
  });

  it('every transition should have at least one precondition (except user-confirmed transitions)', () => {
    // ready_for_build -> in_build has no automated preconditions because
    // the build phase requires explicit user confirmation via the UI.
    const USER_CONFIRMED_TRANSITIONS = new Set(['ready_for_build->in_build']);

    for (const t of TRANSITION_MATRIX) {
      const key = `${t.from}->${t.to}`;
      if (USER_CONFIRMED_TRANSITIONS.has(key)) continue;

      expect(
        t.preconditions.length,
        `${t.from} -> ${t.to} has no preconditions`,
      ).toBeGreaterThan(0);
    }
  });

  it('every transition should emit at least one event', () => {
    for (const t of TRANSITION_MATRIX) {
      expect(
        t.events.length,
        `${t.from} -> ${t.to} has no events`,
      ).toBeGreaterThan(0);
    }
  });

  it('should not allow transitions to the same status (no self-loops)', () => {
    for (const t of TRANSITION_MATRIX) {
      if (t.from !== 'any') {
        expect(t.from).not.toBe(t.to);
      }
    }
  });

  it('should have unique from->to pairs except for documented alternative-precondition routes', () => {
    // `in_review → needs_human_decision` intentionally has TWO variants:
    //   1. guarded by `has_high_critical_findings` (any track, blocking findings exist)
    //   2. guarded by `track_is_direct_and_high_critical_risk` (Direct Track + high/critical risk)
    // Both legitimately route to the same target via different precondition sets.
    // `approved → done` has TWO variants (auto-close-on-merge via pr_merged +
    // merge-not-applicable skip for repo-less cases, issue #687), and
    // `pending_merge → done` has TWO variants (pr_merged + merge_not_applicable).
    // `needs_human_decision->rejected` is no longer a duplicate pair: the
    // assistant_task-scoped variant was removed (unreachable —
    // assistant tasks have no route into `needs_human_decision`), leaving
    // only the engineering `explicit_rejection` variant.
    // `open->in_build` and `in_build->done` are each shared by the
    // `assistant_task` and `observed` scoped slices (issue #986).
    const expectedDuplicates = new Set([
      'in_review->needs_human_decision',
      'approved->done',
      'pending_merge->done',
      'needs_human_decision->in_build',
      'in_build->done',
      'open->rejected',
      'in_build->rejected',
      'open->in_build',
    ]);

    const pairs = TRANSITION_MATRIX
      .filter((t) => t.from !== 'any')
      .map((t) => `${t.from}->${t.to}`);

    const seen = new Set<string>();
    const unexpectedDuplicates: string[] = [];
    for (const pair of pairs) {
      if (seen.has(pair) && !expectedDuplicates.has(pair)) {
        unexpectedDuplicates.push(pair);
      }
      seen.add(pair);
    }
    expect(unexpectedDuplicates).toEqual([]);
  });

  it('should only reference valid CaseStatus values in "to"', () => {
    for (const t of TRANSITION_MATRIX) {
      expect(ALL_STATUSES).toContain(t.to);
    }
  });

  it('should only reference valid CaseStatus values or "any" in "from"', () => {
    for (const t of TRANSITION_MATRIX) {
      const validFrom = [...ALL_STATUSES, 'any'];
      expect(validFrom).toContain(t.from);
    }
  });
});

// ── Valid transitions (every edge in the graph) ─────────────────────

describe('valid transitions', () => {
  const validEdges: [CaseStatus, CaseStatus][] = [
    ['open', 'exploration'],
    ['exploration', 'ready_for_build'],
    ['ready_for_build', 'in_build'],
    ['in_build', 'in_validation'],
    ['in_validation', 'in_review'],
    ['in_review', 'approved'],
    ['in_review', 'needs_human_decision'],
    ['in_review', 'verification_pending'],
    ['needs_human_decision', 'approved'],
    ['needs_human_decision', 'in_build'],
    ['needs_human_decision', 'verification_pending'],
    ['needs_human_decision', 'rejected'],
    ['verification_pending', 'approved'],
    ['approved', 'pending_merge'],
    ['pending_merge', 'done'],
    ['pending_merge', 'rejected'],
    // Explicit rejection transitions (from exploration onwards)
    ['exploration', 'rejected'],
    ['ready_for_build', 'rejected'],
    ['in_build', 'rejected'],
    ['in_validation', 'rejected'],
    ['in_review', 'rejected'],
    ['verification_pending', 'rejected'],
  ];

  for (const [from, to] of validEdges) {
    it(`should allow ${from} -> ${to}`, () => {
      const t = findTransition(from, to);
      expect(t).toBeDefined();
      expect(t!.to).toBe(to);
    });
  }

  it('every non-terminal status except open and approved can reach rejected', () => {
    const rejectableStatuses = NON_TERMINAL_STATUSES.filter((s) => s !== 'open' && s !== 'approved' && s !== 'pending_merge');
    for (const status of rejectableStatuses) {
      const t = findTransition(status, 'rejected');
      expect(t, `${status} should be able to transition to rejected`).toBeDefined();
    }
  });

  it('open can transition to rejected via the orphan-cleanup route only', () => {
    // Auto-reject orphan: when a PR opened against a brand-new `open` case is
    // closed unmerged before exploration starts, we synthesize the transition
    // via `pr_closed_before_exploration`. There is still no `explicit_rejection`
    // edge from `open` — that path keeps deleting open cases.
    const t = findTransition('open', 'rejected');
    expect(t).toBeDefined();
    expect(t!.preconditions).toEqual(['pr_closed_before_exploration']);
  });
});

// ── Invalid transitions ─────────────────────────────────────────────

describe('invalid transitions', () => {
  const invalidEdges: [CaseStatus, CaseStatus][] = [
    ['open', 'done'],
    ['open', 'in_review'],
    ['open', 'approved'],
    ['open', 'in_build'],
    ['open', 'in_validation'],
    ['exploration', 'in_build'],
    ['exploration', 'done'],
    ['ready_for_build', 'in_review'],
    ['ready_for_build', 'done'],
    ['in_build', 'approved'],
    // in_build → done, in_validation → done, in_review → done, approved → done
    // are valid auto-close-on-merge shortcuts; see status-transitions.ts.
    ['in_validation', 'approved'],
    ['in_review', 'open'],
    ['approved', 'open'],
    ['approved', 'in_review'],
    ['done', 'open'],
    ['done', 'exploration'],
    ['done', 'in_build'],
    ['rejected', 'open'],
    ['rejected', 'exploration'],
  ];

  for (const [from, to] of invalidEdges) {
    it(`should reject ${from} -> ${to}`, () => {
      const t = findTransition(from, to);
      expect(t).toBeUndefined();
    });
  }
});

// ── Terminal states ─────────────────────────────────────────────────

describe('terminal states', () => {
  it('done has no outgoing transitions', () => {
    const transitions = getTransitionsFrom('done');
    expect(transitions).toHaveLength(0);
  });

  it('rejected has no outgoing transitions', () => {
    const transitions = getTransitionsFrom('rejected');
    expect(transitions).toHaveLength(0);
  });
});

// ── getTransitionsFrom ──────────────────────────────────────────────

describe('getTransitionsFrom', () => {
  it('open has 2 transitions (exploration + orphan-cleanup auto-rejection)', () => {
    const transitions = getTransitionsFrom('open');
    expect(transitions).toHaveLength(2);
    const targets = transitions.map((t) => t.to);
    expect(targets).toContain('exploration');
    expect(targets).toContain('rejected');
  });

  it('in_review has 7 transitions (two distinct needs_human_decision routes + auto-close-on-merge)', () => {
    const transitions = getTransitionsFrom('in_review');
    // Two separate needs_human_decision transitions: one guarded by
    // has_high_critical_findings, one guarded by track_is_direct_and_high_critical_risk.
    // Plus the auto-close-on-merge shortcut (in_review → done).
    expect(transitions).toHaveLength(7);
    const targets = transitions.map((t) => t.to);
    expect(targets).toContain('approved');
    expect(targets.filter((t) => t === 'needs_human_decision')).toHaveLength(2);
    expect(targets).toContain('verification_pending');
    expect(targets).toContain('in_build');
    expect(targets).toContain('rejected');
    expect(targets).toContain('done');
  });

  it('needs_human_decision has 4 transitions', () => {
    const transitions = getTransitionsFrom('needs_human_decision');
    expect(transitions).toHaveLength(4);
    const targets = transitions.map((t) => t.to);
    expect(targets).toContain('approved');
    expect(targets).toContain('in_build');
    expect(targets).toContain('verification_pending');
    expect(targets).toContain('rejected');
  });

  it('approved has 3 transitions (pending_merge + auto-close-on-merge → done + merge-not-applicable skip → done)', () => {
    const transitions = getTransitionsFrom('approved');
    expect(transitions).toHaveLength(3);
    const targets = transitions.map((t) => t.to);
    expect(targets).toContain('pending_merge');
    expect(targets.filter((t) => t === 'done')).toHaveLength(2);
  });

  it('pending_merge has exactly 4 transitions (done ×2 via pr_merged/merge_not_applicable, in_build via request_changes, and rejected)', () => {
    const transitions = getTransitionsFrom('pending_merge');
    expect(transitions).toHaveLength(4);
    const targets = transitions.map((t) => t.to);
    expect(targets.filter((t) => t === 'done')).toHaveLength(2);
    expect(targets).toContain('in_build');
    expect(targets).toContain('rejected');
  });
});

// ── findTransition preconditions ────────────────────────────────────

describe('findTransition preconditions', () => {
  it('open -> exploration requires has_minimum_fields and has_scope_and_track', () => {
    const t = findTransition('open', 'exploration')!;
    expect(t.preconditions).toContain('has_minimum_fields');
    expect(t.preconditions).toContain('has_scope_and_track');
  });

  it('exploration -> ready_for_build requires exploration_run_completed', () => {
    const t = findTransition('exploration', 'ready_for_build')!;
    expect(t.preconditions).toContain('exploration_run_completed');
  });

  it('in_build -> in_validation requires required_evidence_satisfied', () => {
    const t = findTransition('in_build', 'in_validation')!;
    expect(t.preconditions).toContain('required_evidence_satisfied');
  });

  it('in_review -> approved requires auto_approve_criteria_met', () => {
    const t = findTransition('in_review', 'approved')!;
    expect(t.preconditions).toContain('auto_approve_criteria_met');
  });

  it('in_review -> needs_human_decision requires has_high_critical_findings', () => {
    const t = findTransition('in_review', 'needs_human_decision')!;
    expect(t.preconditions).toContain('has_high_critical_findings');
  });

  it('needs_human_decision -> approved requires human_approve_documented', () => {
    const t = findTransition('needs_human_decision', 'approved')!;
    expect(t.preconditions).toContain('human_approve_documented');
    expect(t.preconditions).toContain('all_high_critical_resolved');
    expect(t.preconditions).toContain('required_evidence_satisfied');
  });

  it('needs_human_decision -> in_build requires human_request_changes', () => {
    const t = findTransition('needs_human_decision', 'in_build')!;
    expect(t.preconditions).toContain('human_request_changes');
  });

  it('verification_pending -> approved requires manual_validation_confirmed and four_eyes_if_required', () => {
    const t = findTransition('verification_pending', 'approved')!;
    expect(t.preconditions).toContain('manual_validation_confirmed');
    expect(t.preconditions).toContain('four_eyes_if_required');
  });

  it('approved -> pending_merge requires all_steps_completed', () => {
    const t = findTransition('approved', 'pending_merge')!;
    expect(t.preconditions).toContain('all_steps_completed');
  });

  it('pending_merge -> done requires pr_merged (canonical first variant)', () => {
    const t = findTransition('pending_merge', 'done')!;
    expect(t.preconditions).toContain('pr_merged');
  });

  it('pending_merge -> done has a second, non-auto variant gated by merge_not_applicable (issue #687)', () => {
    const variants = findTransitions('pending_merge', 'done');
    expect(variants).toHaveLength(2);
    // Canonical pr_merged variant stays FIRST so single-match callers
    // (findTransition, gate confirmation) keep resolving the merge route.
    expect(variants[0]!.preconditions).toEqual(['pr_merged']);
    expect(variants[0]!.auto_trigger).toBe(true);
    const skip = variants[1]!;
    expect(skip.preconditions).toEqual(['merge_not_applicable']);
    expect(skip.auto_trigger).toBeUndefined();
    expect(skip.events).toContain('human_decision_recorded');
    expect(skip.events).toContain('case_completed');
  });

  it('approved -> done has a merge-not-applicable skip variant BEFORE approved -> pending_merge (issue #687)', () => {
    // Pipeline auto-trigger fanout walks the matrix in order: for a truly
    // repo-less approved case the skip must win over approved → pending_merge,
    // otherwise the case parks at the unsatisfiable pr_merged gate.
    const approvedTransitions = getTransitionsFrom('approved');
    const skipIndex = approvedTransitions.findIndex(
      (t) => t.to === 'done' && t.preconditions.includes('merge_not_applicable'),
    );
    const pendingMergeIndex = approvedTransitions.findIndex((t) => t.to === 'pending_merge');
    expect(skipIndex).toBeGreaterThanOrEqual(0);
    expect(skipIndex).toBeLessThan(pendingMergeIndex);

    const skip = approvedTransitions[skipIndex]!;
    expect(skip.preconditions).toEqual(['all_steps_completed', 'merge_not_applicable']);
    expect(skip.auto_trigger).toBe(true);
    expect(skip.events).toContain('merge_skipped_not_applicable');
    expect(skip.events).toContain('case_completed');
  });

  it('explicit rejection transitions require explicit_rejection', () => {
    const t = findTransition('in_build', 'rejected')!;
    expect(t.preconditions).toContain('explicit_rejection');
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('edge cases', () => {
  it('findTransition returns undefined for same-status transitions', () => {
    for (const status of ALL_STATUSES) {
      const t = findTransition(status, status);
      expect(t, `${status} -> ${status} should not exist`).toBeUndefined();
    }
  });

  it('getTransitionsFrom returns an array (never undefined) for every status', () => {
    for (const status of ALL_STATUSES) {
      const transitions = getTransitionsFrom(status);
      expect(Array.isArray(transitions)).toBe(true);
    }
  });
});
