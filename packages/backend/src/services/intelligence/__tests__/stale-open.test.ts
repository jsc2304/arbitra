import { describe, it, expect } from 'vitest';
import { staleOpenDetector } from '../detectors/stale-open.js';
import { makeCase, makeStubContext } from './test-helpers.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

describe('staleOpenDetector', () => {
  it('flags a non-terminal case idle beyond the threshold', async () => {
    const c = makeCase({ case_id: 'case_idle', status: 'in_build' });
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const ctx = makeStubContext({
      now: NOW,
      cases: [c],
      latestActivity: { case_idle: tenDaysAgo },
    });
    const results = await staleOpenDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].evidence.days_idle).toBe(10);
    expect(results[0].severity).toBe('low');
  });

  it('leaves pending_merge cases to Detector 1', async () => {
    const c = makeCase({ case_id: 'case_pm', status: 'pending_merge' });
    const ctx = makeStubContext({
      now: NOW,
      cases: [c],
      latestActivity: { case_pm: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() },
    });
    expect(await staleOpenDetector.run(ctx)).toHaveLength(0);
  });

  it('does not flag a fresh case', async () => {
    const c = makeCase({ case_id: 'case_fresh', status: 'in_validation' });
    const ctx = makeStubContext({
      now: NOW,
      cases: [c],
      latestActivity: { case_fresh: new Date(NOW.getTime() - 1 * 86_400_000).toISOString() },
    });
    expect(await staleOpenDetector.run(ctx)).toHaveLength(0);
  });

  it('falls back to updated_at when no events exist', async () => {
    const c = makeCase({
      case_id: 'case_no_events',
      status: 'open',
      updated_at: new Date(NOW.getTime() - 14 * 86_400_000).toISOString(),
    });
    const ctx = makeStubContext({ now: NOW, cases: [c] });
    const results = await staleOpenDetector.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].evidence.days_idle).toBe(14);
  });
});
