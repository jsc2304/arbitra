import { describe, expect, it } from 'vitest';
import type { Decision, DecisionType } from '@arbitra/shared';
import { selectLastDecision } from '../use-last-decision';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decision_id: 'd_1',
    case_id: 'case_1',
    type: 'approve' as DecisionType,
    actor_id: 'user_1',
    rationale: 'LGTM',
    snapshot: {
      active_rule_set_versions: {},
      evidence_policy_version: 1,
      knowledge_asset_refs: [],
    },
    created_at: '2026-04-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('selectLastDecision', () => {
  it('returns undefined for undefined input', () => {
    expect(selectLastDecision(undefined)).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(selectLastDecision([])).toBeUndefined();
  });

  it('returns the only decision when list has one', () => {
    const d = makeDecision();
    expect(selectLastDecision([d])).toBe(d);
  });

  it('returns the decision with the highest created_at', () => {
    const oldest = makeDecision({ decision_id: 'd_old', created_at: '2026-04-14T10:00:00.000Z' });
    const middle = makeDecision({ decision_id: 'd_mid', created_at: '2026-04-15T10:00:00.000Z' });
    const newest = makeDecision({ decision_id: 'd_new', created_at: '2026-04-16T10:00:00.000Z' });

    expect(selectLastDecision([oldest, middle, newest])).toBe(newest);
    expect(selectLastDecision([newest, oldest, middle])).toBe(newest);
    expect(selectLastDecision([middle, newest, oldest])).toBe(newest);
  });

  it('treats ISO-8601 strings lexicographically (chronological order)', () => {
    const a = makeDecision({ decision_id: 'a', created_at: '2026-01-01T00:00:00.000Z' });
    const b = makeDecision({ decision_id: 'b', created_at: '2026-12-31T23:59:59.000Z' });
    expect(selectLastDecision([a, b])).toBe(b);
  });

  it('returns the first of equal timestamps (stable wrt first-seen)', () => {
    const t = '2026-04-16T10:00:00.000Z';
    const a = makeDecision({ decision_id: 'a', created_at: t });
    const b = makeDecision({ decision_id: 'b', created_at: t });
    expect(selectLastDecision([a, b])).toBe(a);
  });
});
