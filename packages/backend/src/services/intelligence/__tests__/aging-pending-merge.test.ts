import { describe, it, expect } from 'vitest';
import { agingPendingMergeDetector } from '../detectors/aging-pending-merge.js';
import { makeCase, makeStubContext } from './test-helpers.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('agingPendingMergeDetector', () => {
  it('flags a case parked in pending_merge beyond the threshold', async () => {
    const c = makeCase({
      case_id: 'case_aging',
      status: 'pending_merge',
      title: 'Merge me',
    });
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const ctx = makeStubContext({
      now: NOW,
      cases: [c],
      latestStatusTransitions: { case_aging: { pending_merge: tenDaysAgo } },
    });

    const results = await agingPendingMergeDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].detector_id).toBe('aging-pending-merge');
    expect(results[0].signature).toBe('aging-pending-merge:case:case_aging');
    expect(results[0].target_kind).toBe('case');
    expect(results[0].evidence.days_in_status).toBe(10);
  });

  it('does not flag a case parked below the threshold', async () => {
    const c = makeCase({ case_id: 'case_fresh', status: 'pending_merge' });
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const ctx = makeStubContext({
      now: NOW,
      cases: [c],
      latestStatusTransitions: { case_fresh: { pending_merge: threeDaysAgo } },
    });
    expect(await agingPendingMergeDetector.run(ctx)).toHaveLength(0);
  });

  it('ignores non-pending_merge cases entirely', async () => {
    const c = makeCase({ case_id: 'case_other', status: 'in_review' });
    const ctx = makeStubContext({ now: NOW, cases: [c] });
    expect(await agingPendingMergeDetector.run(ctx)).toHaveLength(0);
  });

  it('falls back to updated_at when no status transition event exists', async () => {
    const c = makeCase({
      case_id: 'case_fallback',
      status: 'pending_merge',
      updated_at: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
    });
    const ctx = makeStubContext({ now: NOW, cases: [c] });
    const results = await agingPendingMergeDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].evidence.days_in_status).toBe(30);
  });
});
