import { describe, it, expect } from 'vitest';
import { StateMachine } from './state-machine.js';
import { TransitionError } from '@arbitra/shared';
import type { CaseStatus } from '@arbitra/shared';
import type { PreconditionEvaluator } from './preconditions.js';

function makeSatisfiedEvaluator(): PreconditionEvaluator {
  return {
    async evaluate() {
      return { satisfied: true };
    },
  };
}

function makeFailingEvaluator(failIds: string[]): PreconditionEvaluator {
  return {
    async evaluate(id: string) {
      if (failIds.includes(id)) {
        return { satisfied: false, reason: `Precondition '${id}' failed` };
      }
      return { satisfied: true };
    },
  };
}

const sm = new StateMachine();

describe('StateMachine.getValidTransitions', () => {
  it('should return transitions from open (exploration + orphan-cleanup auto-rejection)', () => {
    const transitions = sm.getValidTransitions('open');
    expect(transitions.length).toBe(2);
    expect(transitions.some((t) => t.to === 'exploration')).toBe(true);
    expect(transitions.some(
      (t) => t.to === 'rejected' && t.preconditions.includes('pr_closed_before_exploration'),
    )).toBe(true);
  });

  it('should return transitions from exploration (ready_for_build + rejected)', () => {
    const transitions = sm.getValidTransitions('exploration');
    expect(transitions.length).toBe(2);
    expect(transitions.some((t) => t.to === 'ready_for_build')).toBe(true);
    expect(transitions.some((t) => t.to === 'rejected')).toBe(true);
  });

  it('should return transitions from ready_for_build (in_build + rejected)', () => {
    const transitions = sm.getValidTransitions('ready_for_build');
    expect(transitions.length).toBe(2);
    expect(transitions.some((t) => t.to === 'in_build')).toBe(true);
  });

  it('should return transitions from in_build (in_validation + rejected + done via auto-close-on-merge)', () => {
    const transitions = sm.getValidTransitions('in_build');
    expect(transitions.length).toBe(3);
    expect(transitions.some((t) => t.to === 'in_validation')).toBe(true);
    expect(transitions.some((t) => t.to === 'done')).toBe(true);
  });

  it('should return transitions from in_validation (in_review + in_build via request_changes + rejected + done via auto-close-on-merge)', () => {
    const transitions = sm.getValidTransitions('in_validation');
    expect(transitions.length).toBe(4);
    expect(transitions.some((t) => t.to === 'in_review')).toBe(true);
    expect(transitions.some((t) => t.to === 'in_build')).toBe(true);
    expect(transitions.some((t) => t.to === 'done')).toBe(true);
  });

  it('should return transitions from in_review (approved, needs_human_decision ×2, verification_pending, in_build, rejected, done via auto-close-on-merge)', () => {
    const transitions = sm.getValidTransitions('in_review');
    // Two separate needs_human_decision transitions + auto-close-on-merge shortcut.
    expect(transitions.length).toBe(7);
    expect(transitions.some((t) => t.to === 'approved')).toBe(true);
    expect(transitions.filter((t) => t.to === 'needs_human_decision')).toHaveLength(2);
    expect(transitions.some((t) => t.to === 'verification_pending')).toBe(true);
    expect(transitions.some((t) => t.to === 'in_build')).toBe(true);
    expect(transitions.some((t) => t.to === 'rejected')).toBe(true);
    expect(transitions.some((t) => t.to === 'done')).toBe(true);
  });

  it('should return transitions from needs_human_decision (4 targets)', () => {
    const transitions = sm.getValidTransitions('needs_human_decision');
    expect(transitions.length).toBe(4);
    expect(transitions.some((t) => t.to === 'approved')).toBe(true);
    expect(transitions.some((t) => t.to === 'in_build')).toBe(true);
    expect(transitions.some((t) => t.to === 'verification_pending')).toBe(true);
    expect(transitions.some((t) => t.to === 'rejected')).toBe(true);
  });

  it('should return transitions from verification_pending (approved + in_build + rejected)', () => {
    const transitions = sm.getValidTransitions('verification_pending');
    expect(transitions.length).toBe(3);
    expect(transitions.some((t) => t.to === 'approved')).toBe(true);
    expect(transitions.some((t) => t.to === 'in_build')).toBe(true);
  });

  it('should require four_eyes_if_required on needs_human_decision → approved', () => {
    // Spec: high/critical risk cases must satisfy four-eyes before being approved.
    // Without this guard, the most common approval path (high/critical findings →
    // human decision) could be approved by a single reviewer regardless of risk.
    const transitions = sm.getValidTransitions('needs_human_decision');
    const toApproved = transitions.find((t) => t.to === 'approved');
    expect(toApproved).toBeDefined();
    expect(toApproved!.preconditions).toContain('four_eyes_if_required');
  });

  it('should return transitions from approved (pending_merge + done via auto-close-on-merge + done via merge-not-applicable skip)', () => {
    const transitions = sm.getValidTransitions('approved');
    expect(transitions.length).toBe(3);
    expect(transitions.some((t) => t.to === 'pending_merge')).toBe(true);
    expect(transitions.filter((t) => t.to === 'done')).toHaveLength(2);
  });

  it('should return transitions from pending_merge (done ×2 via pr_merged/merge_not_applicable + in_build via request_changes + rejected)', () => {
    const transitions = sm.getValidTransitions('pending_merge');
    expect(transitions.length).toBe(4);
    expect(transitions.filter((t) => t.to === 'done')).toHaveLength(2);
    expect(transitions.some((t) => t.to === 'in_build')).toBe(true);
    expect(transitions.some((t) => t.to === 'rejected')).toBe(true);
  });

  it('should return no transitions for done (terminal state)', () => {
    const transitions = sm.getValidTransitions('done');
    expect(transitions.length).toBe(0);
  });

  it('should return no transitions for rejected (terminal state)', () => {
    const transitions = sm.getValidTransitions('rejected');
    expect(transitions.length).toBe(0);
  });
});

describe('StateMachine.validateTransition – valid transitions', () => {
  it('should return transition definition for open → exploration', async () => {
    const result = await sm.validateTransition('open', 'exploration', makeSatisfiedEvaluator());
    expect(result).toBeDefined();
    expect(result.from).toBe('open');
    expect(result.to).toBe('exploration');
  });

  it('should return transition for in_review → approved with all preconditions met', async () => {
    const result = await sm.validateTransition('in_review', 'approved', makeSatisfiedEvaluator());
    expect(result.to).toBe('approved');
  });

  it('should return transition for needs_human_decision → in_build', async () => {
    const result = await sm.validateTransition('needs_human_decision', 'in_build', makeSatisfiedEvaluator());
    expect(result.to).toBe('in_build');
  });

  it('should return transition for approved → pending_merge', async () => {
    const result = await sm.validateTransition('approved', 'pending_merge', makeSatisfiedEvaluator());
    expect(result.to).toBe('pending_merge');
  });

  it('should return transition for pending_merge → done', async () => {
    const result = await sm.validateTransition('pending_merge', 'done', makeSatisfiedEvaluator());
    expect(result.to).toBe('done');
  });
});

describe('StateMachine.validateTransition – invalid transitions', () => {
  it('should throw TransitionError for open → done', async () => {
    await expect(
      sm.validateTransition('open', 'done', makeSatisfiedEvaluator()),
    ).rejects.toThrow(TransitionError);
  });

  it('should throw TransitionError for open → in_review', async () => {
    await expect(
      sm.validateTransition('open', 'in_review', makeSatisfiedEvaluator()),
    ).rejects.toThrow(TransitionError);
  });

  it('should throw TransitionError for done → open', async () => {
    await expect(
      sm.validateTransition('done', 'open', makeSatisfiedEvaluator()),
    ).rejects.toThrow(TransitionError);
  });

  it('should include no_transition_defined in failed preconditions', async () => {
    try {
      await sm.validateTransition('open', 'done', makeSatisfiedEvaluator());
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const te = err as TransitionError;
      expect(te.failedPreconditions[0]!.id).toBe('no_transition_defined');
    }
  });
});

describe('StateMachine.validateTransition – explicit rejection transitions', () => {
  it('should allow in_build → rejected via explicit transition', async () => {
    const result = await sm.validateTransition('in_build', 'rejected', makeSatisfiedEvaluator());
    expect(result).toBeDefined();
    expect(result.from).toBe('in_build');
    expect(result.to).toBe('rejected');
  });

  it('should allow open → rejected only via the orphan-cleanup precondition (pr_closed_before_exploration)', async () => {
    // The transition exists for the auto-reject orphan flow. Standard
    // explicit_rejection precondition does NOT apply here — that path still
    // deletes open cases. With a fully satisfied evaluator the transition
    // resolves; with the precondition failing it must throw.
    const result = await sm.validateTransition('open', 'rejected', makeSatisfiedEvaluator());
    expect(result.preconditions).toEqual(['pr_closed_before_exploration']);

    const failing = makeFailingEvaluator(['pr_closed_before_exploration']);
    await expect(
      sm.validateTransition('open', 'rejected', failing),
    ).rejects.toThrow(TransitionError);
  });
});

describe('StateMachine.validateTransition – multi-variant transitions (issue #687)', () => {
  it('pending_merge → done passes via the pr_merged variant when merge_not_applicable fails', async () => {
    const evaluator = makeFailingEvaluator(['merge_not_applicable']);
    const result = await sm.validateTransition('pending_merge', 'done', evaluator);
    expect(result.preconditions).toEqual(['pr_merged']);
  });

  it('pending_merge → done passes via the merge_not_applicable variant when pr_merged fails', async () => {
    // Recovery path for cases stuck in pending_merge without a PR: the
    // explicit merge_not_applicable decision satisfies the SECOND variant
    // even though the canonical pr_merged gate fails.
    const evaluator = makeFailingEvaluator(['pr_merged']);
    const result = await sm.validateTransition('pending_merge', 'done', evaluator);
    expect(result.preconditions).toEqual(['merge_not_applicable']);
    expect(result.events).toContain('human_decision_recorded');
    expect(result.events).toContain('case_completed');
  });

  it('pending_merge → done WITHOUT pr_merged AND without the decision fails with TransitionError aggregating both variants', async () => {
    const evaluator = makeFailingEvaluator(['pr_merged', 'merge_not_applicable']);
    try {
      await sm.validateTransition('pending_merge', 'done', evaluator);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const te = err as TransitionError;
      const ids = te.failedPreconditions.map((p) => p.id);
      expect(ids).toContain('pr_merged');
      expect(ids).toContain('merge_not_applicable');
    }
  });

  it('in_review → needs_human_decision passes via the second variant when the first fails (latent multi-variant fix)', async () => {
    // Before the multi-variant validateTransition, the second
    // `in_review → needs_human_decision` route (Direct Track high/critical
    // risk, no blocking findings) was unreachable for manual transitions —
    // findTransition always returned the first variant.
    const evaluator = makeFailingEvaluator(['has_high_critical_findings']);
    const result = await sm.validateTransition('in_review', 'needs_human_decision', evaluator);
    expect(result.preconditions).toContain('track_is_direct_and_high_critical_risk');
  });
});

describe('StateMachine.validateTransition – precondition failures', () => {
  it('should throw when preconditions fail', async () => {
    const evaluator = makeFailingEvaluator(['has_minimum_fields']);
    await expect(
      sm.validateTransition('open', 'exploration', evaluator),
    ).rejects.toThrow(TransitionError);
  });

  it('should collect all failed preconditions', async () => {
    const evaluator = makeFailingEvaluator(['has_minimum_fields', 'has_scope_and_track']);
    try {
      await sm.validateTransition('open', 'exploration', evaluator);
      expect.fail('Should have thrown');
    } catch (err) {
      const te = err as TransitionError;
      expect(te.failedPreconditions.length).toBe(2);
      expect(te.failedPreconditions.map((p) => p.id)).toContain('has_minimum_fields');
      expect(te.failedPreconditions.map((p) => p.id)).toContain('has_scope_and_track');
    }
  });

  it('should pass when only some preconditions fail but not the ones for this transition', async () => {
    // open → exploration requires has_minimum_fields and has_scope_and_track
    // Failing a precondition not on this transition should not block it
    const evaluator = makeFailingEvaluator(['auto_approve_criteria_met']);
    const result = await sm.validateTransition('open', 'exploration', evaluator);
    expect(result.to).toBe('exploration');
  });
});
