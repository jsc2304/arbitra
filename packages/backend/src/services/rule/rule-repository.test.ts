import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuleResult } from '@arbitra/shared';

// Minimal in-memory Firestore stand-in for `collections.ruleResults()` —
// supports `.doc(id).get()/.update()` and chained `.where(...).where(...).get()`
// so `RuleRepository.updateRuleResult` / `getRuleResultsByCaseAndRule` can
// be exercised without a real Firestore.
const store: { value: Record<string, RuleResult> } = { value: {} };

function reset() {
  store.value = {};
}

function makeQuery(predicates: Array<(r: RuleResult) => boolean>) {
  return {
    where: (field: keyof RuleResult, _op: string, value: unknown) =>
      makeQuery([...predicates, (r: RuleResult) => r[field] === value]),
    get: async () => ({
      docs: Object.values(store.value)
        .filter((r) => predicates.every((p) => p(r)))
        .map((r) => ({ data: () => r })),
    }),
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    ruleResults: () => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: store.value[id] !== undefined,
          data: () => store.value[id],
        }),
        set: async (data: RuleResult) => {
          store.value[id] = data;
        },
        update: async (patch: Partial<RuleResult>) => {
          store.value[id] = { ...store.value[id], ...patch } as RuleResult;
        },
      }),
      where: (field: keyof RuleResult, op: string, value: unknown) =>
        makeQuery([]).where(field, op, value),
    }),
  },
}));

import { NotFoundError } from '@arbitra/shared';
import { RuleRepository } from './rule-repository.js';

function makeRuleResult(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    rule_result_id: 'rr_1',
    rule_id: 'rule_gate',
    case_id: 'case_1',
    run_id: 'run_1',
    result_status: 'blocked',
    message: 'Human confirmation required',
    evidence_refs: [],
    evaluated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('RuleRepository — RuleResult resolution', () => {
  beforeEach(() => reset());

  it('updateRuleResult patches only the given fields, leaving the rest intact', async () => {
    const repo = new RuleRepository();
    store.value['rr_1'] = makeRuleResult();

    const updated = await repo.updateRuleResult('rr_1', {
      result_status: 'pass',
      message: 'Confirmed by usr_reviewer: looks good',
    });

    expect(updated.result_status).toBe('pass');
    expect(updated.message).toBe('Confirmed by usr_reviewer: looks good');
    // Untouched fields are preserved.
    expect(updated.rule_id).toBe('rule_gate');
    expect(updated.case_id).toBe('case_1');

    // Persisted, not just returned.
    const reread = await repo.getRuleResultsByCaseId('case_1');
    expect(reread[0]?.result_status).toBe('pass');
  });

  it('updateRuleResult throws NotFoundError for a result id that does not exist', async () => {
    const repo = new RuleRepository();
    await expect(
      repo.updateRuleResult('missing_id', { result_status: 'pass' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('getRuleResultsByCaseAndRule scopes strictly by both case_id and rule_id', async () => {
    const repo = new RuleRepository();
    store.value['rr_a'] = makeRuleResult({ rule_result_id: 'rr_a', case_id: 'case_1', rule_id: 'rule_gate' });
    store.value['rr_b'] = makeRuleResult({ rule_result_id: 'rr_b', case_id: 'case_1', rule_id: 'rule_other' });
    store.value['rr_c'] = makeRuleResult({ rule_result_id: 'rr_c', case_id: 'case_2', rule_id: 'rule_gate' });

    const results = await repo.getRuleResultsByCaseAndRule('case_1', 'rule_gate');

    expect(results.map((r) => r.rule_result_id)).toEqual(['rr_a']);
  });
});
