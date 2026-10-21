/**
 * Tests for the pure blocker-selection logic behind
 * `/api/cases/[caseId]/approval-blockers`.
 *
 * Focus: `selectApprovalBlockers` must (a) keep only UNSATISFIED
 * preconditions, (b) drop `human_approve_documented` entirely (it's the
 * action the reviewer is about to take, not a blocker), (c) keep only the
 * known blocker ids, and (d) fall back to a humanized id when the evaluator
 * omits a reason.
 *
 * The logic lives in `@/lib/approval-blockers` (not the route module), so the
 * test imports it directly — no Firestore-backed services to mock.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PreconditionId } from '@arbitra/shared';

import { selectApprovalBlockers } from '../../../../../lib/approval-blockers';

type Result = { satisfied: boolean; reason?: string };

function resultsOf(
  entries: Array<[PreconditionId, Result]>,
): ReadonlyMap<PreconditionId, Result> {
  return new Map(entries);
}

describe('selectApprovalBlockers', () => {
  it('drops human_approve_documented even when unsatisfied', () => {
    const ids: PreconditionId[] = [
      'human_approve_documented',
      'all_high_critical_resolved',
    ];
    const results = resultsOf([
      ['human_approve_documented', { satisfied: false, reason: 'No human approve' }],
      ['all_high_critical_resolved', { satisfied: false, reason: '2 unresolved' }],
    ]);

    const blockers = selectApprovalBlockers(ids, results);

    expect(blockers).toEqual([
      { id: 'all_high_critical_resolved', reason: '2 unresolved' },
    ]);
  });

  it('keeps only unsatisfied blocker-ids', () => {
    const ids: PreconditionId[] = [
      'required_evidence_satisfied',
      'four_eyes_if_required',
      'manual_validation_confirmed',
    ];
    const results = resultsOf([
      ['required_evidence_satisfied', { satisfied: true }],
      ['four_eyes_if_required', { satisfied: false, reason: 'need 2 approvers' }],
      ['manual_validation_confirmed', { satisfied: false, reason: 'not confirmed' }],
    ]);

    const blockers = selectApprovalBlockers(ids, results);

    expect(blockers).toEqual([
      { id: 'four_eyes_if_required', reason: 'need 2 approvers' },
      { id: 'manual_validation_confirmed', reason: 'not confirmed' },
    ]);
  });

  it('humanizes the id when the evaluator omits a reason', () => {
    const ids: PreconditionId[] = ['required_evidence_satisfied'];
    const results = resultsOf([
      ['required_evidence_satisfied', { satisfied: false }],
    ]);

    expect(selectApprovalBlockers(ids, results)).toEqual([
      { id: 'required_evidence_satisfied', reason: 'Required evidence satisfied' },
    ]);
  });

  it('treats a missing result as an unsatisfied blocker', () => {
    const ids: PreconditionId[] = ['four_eyes_if_required'];
    const results = resultsOf([]);

    expect(selectApprovalBlockers(ids, results)).toEqual([
      { id: 'four_eyes_if_required', reason: 'Four eyes if required' },
    ]);
  });

  it('ignores ids that are not approval blockers', () => {
    const ids: PreconditionId[] = ['review_run_completed', 'has_artifact_ref'];
    const results = resultsOf([
      ['review_run_completed', { satisfied: false, reason: 'x' }],
      ['has_artifact_ref', { satisfied: false, reason: 'y' }],
    ]);

    expect(selectApprovalBlockers(ids, results)).toEqual([]);
  });

  it('returns empty when everything is satisfied', () => {
    const ids: PreconditionId[] = [
      'all_high_critical_resolved',
      'four_eyes_if_required',
    ];
    const results = resultsOf([
      ['all_high_critical_resolved', { satisfied: true }],
      ['four_eyes_if_required', { satisfied: true }],
    ]);

    expect(selectApprovalBlockers(ids, results)).toEqual([]);
  });
});
