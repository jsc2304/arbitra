import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case } from '@arbitra/shared';
import { NotFoundError } from '@arbitra/shared';

// ── Firestore stub ───────────────────────────────────────────────────────────
//
// Minimal in-memory `cases` collection that supports:
//   collections.cases().doc(id).get() / .update(patch)
//   collections.cases().where(field, '==', value).[.where(...)].orderBy(...).limit(n).get()
//   collections.cases().where(...).count().get()
//
// Enough to exercise getById, list, softDelete, and countByStatus under the
// new soft-delete semantics (bug 1 of #419).

interface Filter {
  field: string;
  op: string;
  value: unknown;
}

const state: { cases: Map<string, Case> } = { cases: new Map() };

function reset(cases: Case[]): void {
  state.cases = new Map(cases.map((c) => [c.case_id, c]));
}

function matchesFilters(c: Case, filters: Filter[]): boolean {
  const anyC = c as unknown as Record<string, unknown>;
  return filters.every((f) => {
    const actual = anyC[f.field];
    if (f.op === '==') return actual === f.value;
    if (f.op === 'in') return Array.isArray(f.value) && (f.value as unknown[]).includes(actual);
    return false;
  });
}

function buildQuery(filters: Filter[]) {
  const self = {
    where: (field: string, op: string, value: unknown) =>
      buildQuery([...filters, { field, op, value }]),
    orderBy: (_field: string, _dir: string) => self,
    limit: (_n: number) => self,
    startAfter: (_doc: unknown) => self,
    get: async () => {
      const matching = [...state.cases.values()].filter((c) => matchesFilters(c, filters));
      return {
        docs: matching.map((c) => ({
          id: c.case_id,
          exists: true,
          data: () => c,
        })),
      };
    },
    count: () => ({
      get: async () => {
        const matching = [...state.cases.values()].filter((c) => matchesFilters(c, filters));
        return { data: () => ({ count: matching.length }) };
      },
    }),
  };
  return self;
}

function docHandle(id: string) {
  return {
    get: async () => {
      const c = state.cases.get(id);
      return {
        exists: c !== undefined,
        data: () => c,
      };
    },
    update: async (patch: Partial<Case>) => {
      const existing = state.cases.get(id);
      if (!existing) throw new Error(`no doc ${id}`);
      state.cases.set(id, { ...existing, ...patch });
    },
    set: async (c: Case) => {
      state.cases.set(id, c);
    },
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      ...buildQuery([]),
      doc: (id: string) => docHandle(id),
    }),
  },
  getDb: () => ({}),
}));

import { CaseRepository } from './case-repository.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  const base: Case = {
    case_id: 'case_active',
    title: 'Active case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'p1',
    repository_id: 'repo_X',
    owner_user_id: 'usr_owner',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
  };
  return { ...base, ...overrides };
}

describe('CaseRepository soft-delete semantics (bug 1 of #419)', () => {
  const repo = new CaseRepository();

  beforeEach(() => {
    reset([]);
  });

  it('getById throws NotFoundError when the doc is soft-deleted', async () => {
    reset([
      makeCase({ case_id: 'case_deleted', deleted_at: '2026-04-22T10:00:00.000Z', deleted_by: 'usr_admin' }),
    ]);
    await expect(repo.getById('case_deleted')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getById returns the doc when includeDeleted=true', async () => {
    reset([
      makeCase({ case_id: 'case_deleted', deleted_at: '2026-04-22T10:00:00.000Z', deleted_by: 'usr_admin' }),
    ]);
    const result = await repo.getById('case_deleted', { includeDeleted: true });
    expect(result.case_id).toBe('case_deleted');
    expect(result.deleted_at).not.toBeNull();
  });

  it('getById returns active cases normally', async () => {
    reset([makeCase({ case_id: 'case_active' })]);
    const result = await repo.getById('case_active');
    expect(result.case_id).toBe('case_active');
  });

  it('list filters out soft-deleted cases by default', async () => {
    reset([
      makeCase({ case_id: 'case_a' }),
      makeCase({
        case_id: 'case_b',
        deleted_at: '2026-04-22T10:00:00.000Z',
        deleted_by: 'usr_admin',
      }),
      makeCase({ case_id: 'case_c' }),
    ]);
    const { cases } = await repo.list({});
    const ids = cases.map((c) => c.case_id).sort();
    expect(ids).toEqual(['case_a', 'case_c']);
  });

  it('list includes soft-deleted cases when includeDeleted=true', async () => {
    reset([
      makeCase({ case_id: 'case_a' }),
      makeCase({
        case_id: 'case_b',
        deleted_at: '2026-04-22T10:00:00.000Z',
        deleted_by: 'usr_admin',
      }),
    ]);
    const { cases } = await repo.list({ includeDeleted: true });
    const ids = cases.map((c) => c.case_id).sort();
    expect(ids).toEqual(['case_a', 'case_b']);
  });

  it('softDelete marks the doc but keeps it in Firestore', async () => {
    reset([makeCase({ case_id: 'case_a', status: 'done' })]);
    await repo.softDelete('case_a', 'usr_admin');

    // Doc still exists in the underlying store.
    const raw = state.cases.get('case_a')!;
    expect(raw.deleted_at).toBeTypeOf('string');
    expect(raw.deleted_by).toBe('usr_admin');

    // But getById now returns NotFound.
    await expect(repo.getById('case_a')).rejects.toBeInstanceOf(NotFoundError);

    // And list() no longer returns it.
    const { cases } = await repo.list({ status: 'done' });
    expect(cases.map((c) => c.case_id)).not.toContain('case_a');
  });

  it('softDelete throws NotFoundError when the case does not exist', async () => {
    reset([]);
    await expect(repo.softDelete('case_missing', 'usr_admin')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('countByStatus ignores soft-deleted cases', async () => {
    reset([
      makeCase({ case_id: 'case_a', status: 'done' }),
      makeCase({ case_id: 'case_b', status: 'done' }),
      makeCase({
        case_id: 'case_c',
        status: 'done',
        deleted_at: '2026-04-22T10:00:00.000Z',
        deleted_by: 'usr_admin',
      }),
    ]);
    const count = await repo.countByStatus(['done']);
    expect(count).toBe(2);
  });
});
