import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IntelligenceRun } from '@arbitra/shared';

/**
 * In-memory Firestore doubles. Each test file owns its own singleton — keeps
 * the tests hermetic so ordering between files doesn't matter.
 */
interface FakeDoc {
  id: string;
  data: IntelligenceRun;
}

const store = {
  runs: new Map<string, IntelligenceRun>(),
};

function reset() {
  store.runs.clear();
}

function makeQuery(field = 'started_at', dir: 'asc' | 'desc' = 'desc') {
  const filters: Array<{ field: string; op: '<'; value: string }> = [];
  let limit: number | undefined;
  const api: Record<string, unknown> = {
    orderBy: (_f: string, _d: 'asc' | 'desc') => {
      void _f;
      void _d;
      return api;
    },
    where: (f: string, op: '<', value: string) => {
      filters.push({ field: f, op, value });
      return api;
    },
    limit: (n: number) => {
      limit = n;
      return api;
    },
    get: async () => {
      let rows = Array.from(store.runs.values());
      for (const f of filters) {
        rows = rows.filter((r) => {
          const v = (r as Record<string, unknown>)[f.field] as string;
          return v < f.value;
        });
      }
      rows.sort((a, b) => {
        const av = (a as Record<string, unknown>)[field] as string;
        const bv = (b as Record<string, unknown>)[field] as string;
        return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
      });
      if (limit !== undefined) rows = rows.slice(0, limit);
      return {
        docs: rows.map<FakeDoc>((r) => ({ id: r.run_id, data: r })) .map((d) => ({
          ...d,
          data: () => d.data,
        })),
      };
    },
  };
  return api;
}

vi.mock('../../../lib/firestore.js', () => ({
  collections: {
    intelligenceRuns: () => ({
      doc: (id: string) => ({
        set: async (data: IntelligenceRun) => {
          store.runs.set(id, data);
        },
        get: async () => {
          const data = store.runs.get(id);
          return { exists: !!data, data: () => data };
        },
      }),
      orderBy: (f: string, d: 'asc' | 'desc') => makeQuery(f, d),
    }),
  },
}));

import { RunHistoryRepository } from '../run-history-repository.js';

function makeRun(overrides: Partial<IntelligenceRun> = {}): IntelligenceRun {
  return {
    run_id: 'irun_' + Math.random().toString(36).slice(2, 10),
    started_at: '2026-04-20T00:00:00.000Z',
    finished_at: '2026-04-20T00:00:01.000Z',
    duration_ms: 1000,
    trigger: 'scheduler',
    detector_count: 2,
    findings_total: 0,
    summaries: [],
    ...overrides,
  };
}

describe('RunHistoryRepository', () => {
  beforeEach(() => {
    reset();
  });

  it('create() then get() round-trips the run doc', async () => {
    const repo = new RunHistoryRepository();
    const run = makeRun({ run_id: 'irun_a', findings_total: 3 });
    await repo.create(run);
    const fetched = await repo.get('irun_a');
    expect(fetched).toBeDefined();
    expect(fetched!.run_id).toBe('irun_a');
    expect(fetched!.findings_total).toBe(3);
  });

  it('get() returns undefined for a missing run', async () => {
    const repo = new RunHistoryRepository();
    const fetched = await repo.get('irun_missing');
    expect(fetched).toBeUndefined();
  });

  it('list() orders by started_at DESC', async () => {
    const repo = new RunHistoryRepository();
    await repo.create(makeRun({ run_id: 'irun_old', started_at: '2026-04-01T00:00:00.000Z' }));
    await repo.create(makeRun({ run_id: 'irun_new', started_at: '2026-04-22T00:00:00.000Z' }));
    await repo.create(makeRun({ run_id: 'irun_mid', started_at: '2026-04-15T00:00:00.000Z' }));

    const { runs } = await repo.list({ limit: 10 });
    expect(runs.map((r) => r.run_id)).toEqual(['irun_new', 'irun_mid', 'irun_old']);
  });

  it('list() caps at limit and returns a next_cursor when the page is full', async () => {
    const repo = new RunHistoryRepository();
    for (let i = 0; i < 5; i++) {
      await repo.create(
        makeRun({
          run_id: `irun_${i}`,
          started_at: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
        }),
      );
    }
    const { runs, next_cursor } = await repo.list({ limit: 3 });
    expect(runs).toHaveLength(3);
    expect(runs[0]!.run_id).toBe('irun_4');
    expect(next_cursor).toBe(runs[runs.length - 1]!.started_at);
  });

  it('list() honors cursor to fetch the next page', async () => {
    const repo = new RunHistoryRepository();
    for (let i = 0; i < 5; i++) {
      await repo.create(
        makeRun({
          run_id: `irun_${i}`,
          started_at: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
        }),
      );
    }
    const page1 = await repo.list({ limit: 3 });
    const page2 = await repo.list({ limit: 3, cursor: page1.next_cursor });
    expect(page2.runs.map((r) => r.run_id)).toEqual(['irun_1', 'irun_0']);
    expect(page2.next_cursor).toBeUndefined();
  });
});
