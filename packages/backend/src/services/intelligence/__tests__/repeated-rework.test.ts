import { describe, it, expect } from 'vitest';
import { repeatedReworkDetector } from '../detectors/repeated-rework.js';
import { makeCase, makeStubContext } from './test-helpers.js';

describe('repeatedReworkDetector', () => {
  it('flags a case with ≥ 3 request_changes', async () => {
    const c = makeCase({ case_id: 'case_churn', status: 'in_review' });
    const ctx = makeStubContext({
      cases: [c],
      requestChangesCounts: { case_churn: 3 },
    });
    const results = await repeatedReworkDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].evidence.request_changes_count).toBe(3);
    expect(results[0].severity).toBe('medium');
  });

  it('does not flag cases below the threshold', async () => {
    const c = makeCase({ case_id: 'case_ok', status: 'in_review' });
    const ctx = makeStubContext({
      cases: [c],
      requestChangesCounts: { case_ok: 2 },
    });
    expect(await repeatedReworkDetector.run(ctx)).toHaveLength(0);
  });

  it('ignores terminal cases (not yielded by listNonTerminalCases)', async () => {
    const done = makeCase({ case_id: 'case_done', status: 'done' });
    const ctx = makeStubContext({
      cases: [done],
      requestChangesCounts: { case_done: 9 },
    });
    expect(await repeatedReworkDetector.run(ctx)).toHaveLength(0);
  });
});
