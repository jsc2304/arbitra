import { describe, expect, it } from 'vitest';
import { DECISION_TYPES } from '../types/decision.js';
import type { CaseStatus } from '../types/case.js';
import { resolveTransitionTarget } from './decision-transitions.js';

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

const LEGACY_NON_NULL_TARGETS = new Map<string, CaseStatus>([
  ['approve:needs_human_decision', 'approved'],
  ['approve:in_review', 'approved'],
  ['approve:verification_pending', 'approved'],
  ['request_changes:in_review', 'in_build'],
  ['request_changes:needs_human_decision', 'in_build'],
  ['request_changes:in_validation', 'in_build'],
  ['request_changes:pending_merge', 'in_build'],
  ['request_changes:verification_pending', 'in_build'],
  ['manual_validation_confirmed:verification_pending', 'approved'],
  ['merge_not_applicable:pending_merge', 'done'],
  ['merge_not_applicable:approved', 'done'],
]);

describe('resolveTransitionTarget', () => {
  it('keeps every existing mapping unchanged', () => {
    for (const decisionType of DECISION_TYPES) {
      for (const status of CASE_STATUSES) {
        const expected = decisionType === 'reject'
          ? 'rejected'
          : LEGACY_NON_NULL_TARGETS.get(`${decisionType}:${status}`) ?? null;

        expect(resolveTransitionTarget(decisionType, status)).toBe(expected);
      }
    }
  });
});
