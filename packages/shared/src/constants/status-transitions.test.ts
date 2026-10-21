import { describe, it, expect } from 'vitest';
import {
  TRANSITION_MATRIX,
  getTransitionsFrom,
  getAutoTransitionsFrom,
  findTransition,
  findTransitions,
  lifecycleStationsForCaseType,
} from './status-transitions.js';
import type { CaseStatus, CaseType } from '../types/case.js';

const CASE_STATUSES: CaseStatus[] = [
  'open',
  'exploration',
  'ready_for_build',
  'in_build',
  'in_validation',
  'in_review',
  'needs_human_decision',
  'verification_pending',
  'approved',
  'pending_merge',
  'done',
  'rejected',
];

const ENGINEERING_CASE_TYPES: Array<CaseType | undefined> = [
  undefined,
  'ticket_implementation',
  'bugfix',
  'refactoring',
  'security_review',
  'pr_review',
  'manual_verification',
  'other',
];

describe('TRANSITION_MATRIX', () => {
  it('should define 42 transitions', () => {
    expect(TRANSITION_MATRIX.length).toBe(42);
  });

  it('should have unique from→to pairs except for documented alternative-precondition routes', () => {
    // `in_review → needs_human_decision` intentionally has TWO variants:
    //   1. guarded by `has_high_critical_findings` (any track, blocking findings exist)
    //   2. guarded by `track_is_direct_and_high_critical_risk` (Direct Track + high/critical risk)
    // `approved → done` and `pending_merge → done` each have TWO variants:
    // the pr_merged route and the merge-not-applicable route for repo-less
    // cases (issue #687).
    // `needs_human_decision→rejected` is no longer a duplicate pair: the
    // assistant_task-scoped variant was removed (unreachable —
    // assistant tasks have no route into `needs_human_decision`), leaving
    // only the engineering `explicit_rejection` variant.
    // `open→in_build` and `in_build→done` are each shared by the
    // `assistant_task` and `observed` scoped slices (issue #986) — two
    // independent case-type-scoped lifecycles that both happen to use the
    // same status names for their fast path.
    const expectedDuplicates = new Set([
      'in_review→needs_human_decision',
      'approved→done',
      'pending_merge→done',
      'open→rejected',
      'in_build→rejected',
      'in_build→done',
      'open→in_build',
    ]);

    const pairs = TRANSITION_MATRIX
      .filter((t) => t.from !== 'any')
      .map((t) => `${t.from}→${t.to}`);

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

  it('emits case_completed for every transition into done across all case-type scopes', () => {
    const missingCompletionEvents = TRANSITION_MATRIX
      .filter((transition) => (
        transition.to === 'done' && !transition.events.includes('case_completed')
      ))
      .map((transition) => ({
        from: transition.from,
        case_types: transition.case_types ?? ['engineering'],
      }));

    expect(missingCompletionEvents).toEqual([]);
  });
});

describe('case-type transition isolation', () => {
  const assistantTransitions = TRANSITION_MATRIX.filter(
    (transition) => transition.case_types?.includes('assistant_task'),
  );
  const assistantTransitionSet = new Set(assistantTransitions);
  const observedTransitions = TRANSITION_MATRIX.filter(
    (transition) => transition.case_types?.includes('observed'),
  );
  const observedTransitionSet = new Set(observedTransitions);
  const engineeringTransitionSet = new Set(
    TRANSITION_MATRIX.filter((transition) => !transition.case_types),
  );

  function allFindTransitionResults(caseType?: CaseType) {
    return CASE_STATUSES.flatMap((from) =>
      CASE_STATUSES.map((to) => findTransition(from, to, caseType))
        .filter((transition): transition is NonNullable<typeof transition> => transition !== undefined),
    );
  }

  function allFindTransitionsResults(caseType?: CaseType) {
    return CASE_STATUSES.flatMap((from) =>
      CASE_STATUSES.flatMap((to) => findTransitions(from, to, caseType)),
    );
  }

  it.each(ENGINEERING_CASE_TYPES)(
    'never exposes assistant or observed transitions for engineering scope %s',
    (caseType) => {
      const returnedByHelper = [
        ['getTransitionsFrom', CASE_STATUSES.flatMap((status) => getTransitionsFrom(status, caseType))],
        ['getAutoTransitionsFrom', CASE_STATUSES.flatMap((status) => getAutoTransitionsFrom(status, caseType))],
        ['findTransition', allFindTransitionResults(caseType)],
        ['findTransitions', allFindTransitionsResults(caseType)],
      ] as const;

      for (const [helper, transitions] of returnedByHelper) {
        expect(
          transitions.filter((transition) => assistantTransitionSet.has(transition)),
          `${helper} leaked an assistant transition`,
        ).toEqual([]);
        expect(
          transitions.filter((transition) => observedTransitionSet.has(transition)),
          `${helper} leaked an observed transition`,
        ).toEqual([]);
      }
    },
  );

  it('never exposes engineering or observed transitions for assistant_task scope', () => {
    const returnedByHelper = [
      ['getTransitionsFrom', CASE_STATUSES.flatMap((status) => getTransitionsFrom(status, 'assistant_task'))],
      ['getAutoTransitionsFrom', CASE_STATUSES.flatMap((status) => getAutoTransitionsFrom(status, 'assistant_task'))],
      ['findTransition', allFindTransitionResults('assistant_task')],
      ['findTransitions', allFindTransitionsResults('assistant_task')],
    ] as const;

    for (const [helper, transitions] of returnedByHelper) {
      expect(
        transitions.filter((transition) => observedTransitionSet.has(transition)),
        `${helper} leaked an observed transition`,
      ).toEqual([]);
    }
  });

  it('never exposes engineering or assistant transitions for observed scope', () => {
    const returnedByHelper = [
      ['getTransitionsFrom', CASE_STATUSES.flatMap((status) => getTransitionsFrom(status, 'observed'))],
      ['getAutoTransitionsFrom', CASE_STATUSES.flatMap((status) => getAutoTransitionsFrom(status, 'observed'))],
      ['findTransition', allFindTransitionResults('observed')],
      ['findTransitions', allFindTransitionsResults('observed')],
    ] as const;

    for (const [helper, transitions] of returnedByHelper) {
      expect(
        transitions.filter((transition) => engineeringTransitionSet.has(transition)),
        `${helper} leaked an engineering transition`,
      ).toEqual([]);
      expect(
        transitions.filter((transition) => assistantTransitionSet.has(transition)),
        `${helper} leaked an assistant transition`,
      ).toEqual([]);
    }
  });

  it('exposes exactly the observed transition slice for observed', () => {
    // Reverting either `case_types: ['observed']` entry back to unscoped, or
    // dropping 'observed' from `SCOPED_CASE_TYPES`, changes this count and
    // fails the assertion below.
    expect(observedTransitions).toHaveLength(2);

    const transitionsFrom = CASE_STATUSES.flatMap(
      (status) => getTransitionsFrom(status, 'observed'),
    );
    const autoTransitionsFrom = CASE_STATUSES.flatMap(
      (status) => getAutoTransitionsFrom(status, 'observed'),
    );
    const singleTransitions = allFindTransitionResults('observed');
    const multipleTransitions = allFindTransitionsResults('observed');

    expect(transitionsFrom).toHaveLength(observedTransitions.length);
    expect(new Set(transitionsFrom)).toEqual(new Set(observedTransitions));
    expect(singleTransitions).toHaveLength(observedTransitions.length);
    expect(new Set(singleTransitions)).toEqual(new Set(observedTransitions));
    expect(multipleTransitions).toHaveLength(observedTransitions.length);
    expect(new Set(multipleTransitions)).toEqual(new Set(observedTransitions));

    // Both edges of the slice are auto_trigger — no human action required
    // anywhere in the observed lifecycle.
    expect(autoTransitionsFrom).toHaveLength(observedTransitions.length);
    expect(new Set(autoTransitionsFrom)).toEqual(new Set(observedTransitions));

    expect(findTransition('open', 'in_build', 'observed')?.preconditions).toEqual([
      'observed_case_signal_present',
    ]);
    expect(findTransition('in_build', 'done', 'observed')?.preconditions).toEqual([
      'pr_merged',
    ]);
    // The engineering `ready_for_build → in_build` gate and the assistant
    // `assistant_run_claimed` gate must not leak into the observed scope.
    expect(findTransition('ready_for_build', 'in_build', 'observed')).toBeUndefined();
  });

  it('exposes exactly the assistant transition slice for assistant_task', () => {
    expect(assistantTransitions).toHaveLength(6);

    const transitionsFrom = CASE_STATUSES.flatMap(
      (status) => getTransitionsFrom(status, 'assistant_task'),
    );
    const autoTransitionsFrom = CASE_STATUSES.flatMap(
      (status) => getAutoTransitionsFrom(status, 'assistant_task'),
    );
    const singleTransitions = allFindTransitionResults('assistant_task');
    const multipleTransitions = allFindTransitionsResults('assistant_task');

    for (const transitions of [
      transitionsFrom,
      autoTransitionsFrom,
      singleTransitions,
      multipleTransitions,
    ]) {
      expect(
        transitions.filter((transition) => engineeringTransitionSet.has(transition)),
      ).toEqual([]);
    }

    expect(transitionsFrom).toHaveLength(assistantTransitions.length);
    expect(new Set(transitionsFrom)).toEqual(new Set(assistantTransitions));
    // `findTransition` resolves ONE variant per (from, to) pair, and the
    // assistant slice has two pairs with two variants each — cancellation
    // (`assistant_no_active_run`) and terminal failure. It must therefore
    // return one transition per distinct pair, all from the assistant slice,
    // and the canonical variant must stay the cancellation one.
    const assistantPairs = new Set(
      assistantTransitions.map((transition) => `${transition.from}→${transition.to}`),
    );
    expect(singleTransitions).toHaveLength(assistantPairs.size);
    for (const transition of singleTransitions) {
      expect(assistantTransitionSet.has(transition)).toBe(true);
    }
    for (const from of ['open', 'in_build'] as CaseStatus[]) {
      expect(findTransition(from, 'rejected', 'assistant_task')?.preconditions).toEqual([
        'assistant_no_active_run',
      ]);
    }
    // Reintroducing the dead Clerk resume edge is the only matrix change that
    // makes this assertion fail; engineering request-changes remains intact.
    expect(findTransition('needs_human_decision', 'in_build', 'assistant_task')).toBeUndefined();
    // Reverted change: `needs_human_decision → rejected` for
    // assistant_task scope was removed as unreachable — assistant tasks have
    // no transition that puts a case into `needs_human_decision` in the
    // first place, so this pair is not a valid assistant_task transition.
    expect(findTransition('needs_human_decision', 'rejected', 'assistant_task')).toBeUndefined();
    expect(multipleTransitions).toHaveLength(assistantTransitions.length);
    expect(new Set(multipleTransitions)).toEqual(new Set(assistantTransitions));

    const autoAssistantTransitions = assistantTransitions.filter(
      (transition) => transition.auto_trigger === true,
    );
    expect(autoTransitionsFrom).toHaveLength(autoAssistantTransitions.length);
    expect(new Set(autoTransitionsFrom)).toEqual(new Set(autoAssistantTransitions));
  });
});

describe('getTransitionsFrom', () => {
  it('should return transitions from open', () => {
    const transitions = getTransitionsFrom('open');
    // open → exploration (manual progression) and open → rejected
    // (auto, gated by pr_closed_before_exploration) for orphan cleanup.
    expect(transitions.length).toBe(2);
    expect(transitions.some((t) => t.to === 'exploration')).toBe(true);
    expect(transitions.some(
      (t) => t.to === 'rejected'
        && t.preconditions.includes('pr_closed_before_exploration'),
    )).toBe(true);
  });

  it('should return transitions from in_review', () => {
    const transitions = getTransitionsFrom('in_review');
    // in_review → approved, needs_human_decision ×2, verification_pending, in_build, rejected, done (auto-close on merge)
    // Two needs_human_decision routes: one for blocking findings, one for Direct Track high/critical risk.
    expect(transitions.length).toBe(7);
  });

  it('should return transitions from needs_human_decision', () => {
    const transitions = getTransitionsFrom('needs_human_decision');
    // → approved, in_build, verification_pending, rejected
    expect(transitions.length).toBe(4);
  });

  it('should include rejected transition for non-terminal states except open', () => {
    const rejectableStates: CaseStatus[] = [
      'exploration', 'ready_for_build', 'in_build',
      'in_validation', 'in_review', 'needs_human_decision', 'verification_pending',
    ];
    for (const status of rejectableStates) {
      const transitions = getTransitionsFrom(status);
      expect(
        transitions.some((t) => t.to === 'rejected'),
        `${status} should allow transition to rejected`,
      ).toBe(true);
    }
  });

  it('should not allow open → rejected via explicit_rejection (open cases are deleted on explicit rejection)', () => {
    const transitions = getTransitionsFrom('open');
    expect(transitions.some(
      (t) => t.to === 'rejected' && t.preconditions.includes('explicit_rejection'),
    )).toBe(false);
  });

  it('should allow open → rejected via pr_closed_before_exploration (orphan cleanup)', () => {
    const t = findTransition('open', 'rejected');
    expect(t).toBeDefined();
    expect(t!.preconditions).toEqual(['pr_closed_before_exploration']);
    expect(t!.auto_trigger).toBe(true);
    expect(t!.events).toContain('case_rejected');
  });
});

describe('findTransition', () => {
  it('should find open → exploration', () => {
    const t = findTransition('open', 'exploration');
    expect(t).toBeDefined();
    expect(t!.preconditions).toContain('has_minimum_fields');
    expect(t!.preconditions).toContain('has_scope_and_track');
  });

  it('should find in_review → approved (auto-approve)', () => {
    const t = findTransition('in_review', 'approved');
    expect(t).toBeDefined();
    expect(t!.preconditions).toContain('auto_approve_criteria_met');
  });

  it('should find needs_human_decision → in_build (request_changes)', () => {
    const t = findTransition('needs_human_decision', 'in_build');
    expect(t).toBeDefined();
    expect(t!.preconditions).toContain('human_request_changes');
  });

  it('should find verification_pending → in_build (request_changes)', () => {
    const t = findTransition('verification_pending', 'in_build');
    expect(t).toBeDefined();
    expect(t!.preconditions).toContain('human_request_changes');
  });

  // Manual-track cases could reach `approved` with
  // open high/critical findings via needs_human_decision -> verification_pending
  // -> approved, because neither edge required `all_high_critical_resolved`.
  // Belt-and-suspenders alongside the `human_review_documented_manual_pending`
  // precondition fix in preconditions.ts — both edges must carry the gate so a
  // future new edge/precondition change can't silently reopen the bypass.
  it('should require all_high_critical_resolved on needs_human_decision → verification_pending', () => {
    const t = findTransition('needs_human_decision', 'verification_pending');
    expect(t).toBeDefined();
    expect(t!.preconditions).toContain('all_high_critical_resolved');
    expect(t!.preconditions).toContain('human_review_documented_manual_pending');
  });

  it('should require all_high_critical_resolved on verification_pending → approved', () => {
    const t = findTransition('verification_pending', 'approved');
    expect(t).toBeDefined();
    expect(t!.preconditions).toContain('all_high_critical_resolved');
    expect(t!.preconditions).toContain('manual_validation_confirmed');
    expect(t!.preconditions).toContain('four_eyes_if_required');
  });

  it('should return undefined for invalid transitions', () => {
    expect(findTransition('open', 'done')).toBeUndefined();
    expect(findTransition('open', 'in_review')).toBeUndefined();
    expect(findTransition('done', 'open')).toBeUndefined();
  });

  it('should find explicit rejection transitions', () => {
    const t = findTransition('in_build', 'rejected');
    expect(t).toBeDefined();
    expect(t!.from).toBe('in_build');
  });
});

describe('auto-close on PR merge', () => {
  const AUTO_CLOSE_SOURCES: CaseStatus[] = ['in_build', 'in_validation', 'in_review', 'approved'];

  it.each(AUTO_CLOSE_SOURCES)('defines %s → done with pr_merged + escalation-gate preconditions and auto_trigger', (from) => {
    // `approved → done` has a second variant (merge-not-applicable skip,
    // issue #687) — search all variants for the pr_merged-gated one.
    const t = findTransitions(from, 'done').find((v) => v.preconditions.includes('pr_merged'));
    expect(t, `expected auto-close transition from ${from} to done`).toBeDefined();
    // Issue #1000: AND-combined with a second gate so an escalated/high-critical
    // case with unmet evidence cannot take this shortcut just because its PR
    // merged — see preconditions.ts's `all_steps_completed_or_not_high_critical_risk`.
    expect(t!.preconditions).toEqual(['pr_merged', 'all_steps_completed_or_not_high_critical_risk']);
    expect(t!.auto_trigger).toBe(true);
    expect(t!.events).toContain('case_auto_closed_on_merge');
    expect(t!.events).toContain('case_completed');
  });

  it.each<CaseStatus>(['verification_pending', 'needs_human_decision', 'open', 'exploration', 'ready_for_build'])(
    'does NOT define auto-close transition from %s (anomaly source)',
    (from) => {
      expect(findTransition(from, 'done')).toBeUndefined();
    },
  );

  it('does NOT add the escalation gate to the observed-scoped in_build → done duplicate (issue #1000 AC: Observed Cases keep auto-closing unchanged)', () => {
    // This is a SEPARATE transition (`case_types: ['observed']`), not the
    // unscoped one asserted above — `isInScope` makes it the only `in_build →
    // done` transition an Observed Case ever sees. It must stay gated by
    // `pr_merged` alone or every Observed Case would need a full approval
    // decision (which the observed lifecycle never produces) to ever close.
    expect(findTransition('in_build', 'done', 'observed')?.preconditions).toEqual(['pr_merged']);
  });
});

describe('lifecycleStationsForCaseType', () => {
  // Pins the Observed Case lifecycle (issue #986 / ADR-0001) to exactly the
  // three-station rail issue #1018 asks the UI to render — this is the
  // single source of truth the frontend rail must derive from rather than
  // hardcoding a second copy.
  it('pins observed = open → in_build → done', () => {
    expect(lifecycleStationsForCaseType('observed')).toEqual(['open', 'in_build', 'done']);
  });

  it('pins assistant_task = open → in_build → done', () => {
    expect(lifecycleStationsForCaseType('assistant_task')).toEqual(['open', 'in_build', 'done']);
  });

  it('is well-defined for an unscoped case type too (falls through to the engineering matrix)', () => {
    // 'other' resolves to the unscoped engineering matrix, which does have a
    // forward BFS path to 'done' (via auto-approve), so this does not throw
    // — but the frontend keeps its own curated `MAIN_STAGES` list for the
    // engineering rail rather than switching to this derived one, since a
    // plain BFS main line does not model real branch statuses like
    // `needs_human_decision`. This function's real contract is
    // SCOPED_CASE_TYPES (`observed`, `assistant_task`), pinned above.
    expect(() => lifecycleStationsForCaseType('other')).not.toThrow();
  });
});
