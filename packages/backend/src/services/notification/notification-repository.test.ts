/**
 * Issue #794 P0 — dedup, pagination, and stale-gate reconciliation.
 *
 * Firestore is faked in-memory (no emulator) with just enough of the query
 * surface `NotificationRepository` actually calls: equality `where`,
 * `orderBy` (including the `__name__` doc-id tiebreak), `startAfter`,
 * `limit`, `count`, `runTransaction`, and `batch`. This lets the dedup and
 * pagination tests exercise the REAL filtering/ordering/cursor logic rather
 * than a stub that always returns a canned answer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Notification } from '@arbitra/shared';

type Filter = { field: string; value: unknown };
type Order = { field: string; dir: 'asc' | 'desc' };

function fieldOf(doc: { id: string; data: Notification }, field: string): unknown {
  return field === '__name__' ? doc.id : (doc.data as Record<string, unknown>)[field];
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  return (a as string) < (b as string) ? -1 : 1;
}

class FakeQuery {
  constructor(
    private readonly store: Map<string, Notification>,
    private readonly filters: Filter[] = [],
    private readonly orders: Order[] = [],
    private readonly cursor: unknown[] | null = null,
    private readonly limitN: number | null = null,
  ) {}

  where(field: string, _op: '==', value: unknown): FakeQuery {
    return new FakeQuery(this.store, [...this.filters, { field, value }], this.orders, this.cursor, this.limitN);
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.store, this.filters, [...this.orders, { field, dir }], this.cursor, this.limitN);
  }

  startAfter(...values: unknown[]): FakeQuery {
    return new FakeQuery(this.store, this.filters, this.orders, values, this.limitN);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.filters, this.orders, this.cursor, n);
  }

  private rows(): { id: string; data: Notification }[] {
    let rows = Array.from(this.store.entries())
      .map(([id, data]) => ({ id, data }))
      .filter((row) => this.filters.every((f) => fieldOf(row, f.field) === f.value));

    rows.sort((a, b) => {
      for (const o of this.orders) {
        const cmp = compare(fieldOf(a, o.field), fieldOf(b, o.field));
        if (cmp !== 0) return o.dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });

    if (this.cursor) {
      const idx = rows.findIndex((row) =>
        this.orders.every((o, i) => fieldOf(row, o.field) === this.cursor![i]),
      );
      if (idx >= 0) rows = rows.slice(idx + 1);
    }

    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  async get() {
    const rows = this.rows();
    return {
      empty: rows.length === 0,
      docs: rows.map((row) => ({ ref: { id: row.id }, data: () => row.data })),
    };
  }

  count() {
    const rows = () => Array.from(this.store.entries())
      .map(([id, data]) => ({ id, data }))
      .filter((row) => this.filters.every((f) => fieldOf(row, f.field) === f.value));
    return { get: async () => ({ data: () => ({ count: rows().length }) }) };
  }
}

function makeStore() {
  const store = new Map<string, Notification>();

  const collection = {
    doc: (id: string) => ({
      id,
      get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
      set: async (data: Notification) => void store.set(id, { ...data }),
      update: async (patch: Record<string, unknown>) => {
        const cur = store.get(id);
        if (cur) store.set(id, { ...cur, ...patch } as Notification);
      },
      delete: async () => void store.delete(id),
    }),
    where: (field: string, op: '==', value: unknown) => new FakeQuery(store).where(field, op, value),
    orderBy: (field: string, dir?: 'asc' | 'desc') => new FakeQuery(store).orderBy(field, dir),
    count: () => new FakeQuery(store).count(),
  };

  const db = {
    runTransaction: async (fn: (tx: {
      get: (target: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (ref: { id: string }, data: Notification) => void;
      update: (ref: { id: string }, patch: Record<string, unknown>) => void;
    }) => Promise<unknown>) =>
      fn({
        get: (target) => target.get(),
        set: (ref, data) => void store.set(ref.id, { ...data }),
        update: (ref, patch) => {
          const cur = store.get(ref.id);
          if (cur) store.set(ref.id, { ...cur, ...patch } as Notification);
        },
      }),
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        update: (ref: { id: string }, patch: Record<string, unknown>) => {
          ops.push(() => {
            const cur = store.get(ref.id);
            if (cur) store.set(ref.id, { ...cur, ...patch } as Notification);
          });
        },
        commit: async () => { for (const op of ops) op(); },
      };
    },
  };

  return { store, collection, db };
}

let current: ReturnType<typeof makeStore>;

vi.mock('../../lib/firestore.js', () => ({
  collections: { notifications: () => current.collection },
  getDb: () => current.db,
}));

const { NotificationRepository } = await import('./notification-repository.js');

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: `notif_${Math.random().toString(36).slice(2, 10)}`,
    user_id: 'usr_1',
    type: 'gate_pending',
    title: 'T',
    body: 'B',
    case_id: 'case_1',
    read: false,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationRepository', () => {
  let repo: InstanceType<typeof NotificationRepository>;

  beforeEach(() => {
    current = makeStore();
    repo = new NotificationRepository();
  });

  describe('createOrRefresh — issue #794 P0 dedup', () => {
    it('a second identical (user_id, type, case_id) notification while the first is UNREAD refreshes it into one doc', async () => {
      const first = makeNotification({ notification_id: 'notif_a', title: 'Confirmation required', body: 'v1' });
      await repo.createOrRefresh(first);

      const second = makeNotification({ notification_id: 'notif_b', title: 'Confirmation required', body: 'v2' });
      const result = await repo.createOrRefresh(second);

      expect(result.outcome).toBe('refreshed');
      expect(current.store.size).toBe(1);
      // Refreshed in place at the ORIGINAL doc id, not the second candidate's.
      expect(current.store.has('notif_a')).toBe(true);
      expect(current.store.has('notif_b')).toBe(false);
      expect(current.store.get('notif_a')?.body).toBe('v2');
      expect(current.store.get('notif_a')?.read).toBe(false);
    });

    it('does not dedup across different users, types, or cases', async () => {
      await repo.createOrRefresh(makeNotification({ notification_id: 'n1', user_id: 'usr_1' }));
      await repo.createOrRefresh(makeNotification({ notification_id: 'n2', user_id: 'usr_2' }));
      await repo.createOrRefresh(makeNotification({ notification_id: 'n3', type: 'gate_rejected' }));
      await repo.createOrRefresh(makeNotification({ notification_id: 'n4', case_id: 'case_2' }));

      expect(current.store.size).toBe(4);
    });

    it('a matching notification after the prior one was READ creates a new doc rather than reviving it', async () => {
      const first = makeNotification({ notification_id: 'notif_a' });
      await repo.createOrRefresh(first);
      await repo.markAsRead('notif_a');

      const second = makeNotification({ notification_id: 'notif_b' });
      const result = await repo.createOrRefresh(second);

      expect(result.outcome).toBe('created');
      expect(current.store.size).toBe(2);
      expect(current.store.get('notif_a')?.read).toBe(true);
      expect(current.store.get('notif_b')?.read).toBe(false);
    });

    it('skips dedup and always creates when case_id is absent', async () => {
      await repo.createOrRefresh(makeNotification({ notification_id: 'n1', case_id: undefined }));
      const result = await repo.createOrRefresh(makeNotification({ notification_id: 'n2', case_id: undefined }));

      expect(result.outcome).toBe('created');
      expect(current.store.size).toBe(2);
    });
  });

  describe('listPage — cursor pagination (issue #794 P0)', () => {
    it('walks every row exactly once across pages, with no overlap or gap, even with tied created_at timestamps', async () => {
      // Two ties (T0 x3, T1 x2) — exactly the shape a fan-out notify() burst
      // produces. A cursor keyed on created_at alone would either skip the
      // rest of a tie (gap) or re-serve it (overlap) at a page boundary that
      // lands inside one.
      // Each row uses a distinct `case_id` so `create` (not `createOrRefresh`)
      // fixtures 5 independent docs here — dedup itself is covered by its
      // own describe block above; this one is purely about cursor walking.
      const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
      const createdAts = ['T0', 'T0', 'T0', 'T1', 'T1'];
      for (let i = 0; i < ids.length; i += 1) {
        await repo.create(makeNotification({ notification_id: ids[i], case_id: `case_${i}`, created_at: createdAts[i] }));
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const page = await repo.listPage('usr_1', { limit: 2, cursor: cursor ?? undefined });
        seen.push(...page.notifications.map((n) => n.notification_id));
        cursor = page.next_cursor;
        guard += 1;
      } while (cursor && guard < 10);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5); // no doc served twice (no overlap)
      expect(new Set(seen)).toEqual(new Set(ids)); // every doc served (no gap)
    });

    it('unread_count is the TOTAL unread count, independent of page size or which page is requested', async () => {
      for (let i = 0; i < 5; i += 1) {
        await repo.create(makeNotification({ notification_id: `n${i}`, case_id: `case_${i}`, created_at: `T${i}`, read: false }));
      }
      await repo.markAsRead('n0');

      const page = await repo.listPage('usr_1', { limit: 2 });

      expect(page.notifications).toHaveLength(2);
      expect(page.unread_count).toBe(4);
    });

    it('next_cursor is null once the last page is short', async () => {
      await repo.create(makeNotification({ notification_id: 'n1', case_id: 'case_a', created_at: 'T0' }));
      await repo.create(makeNotification({ notification_id: 'n2', case_id: 'case_b', created_at: 'T1' }));

      const page = await repo.listPage('usr_1', { limit: 10 });

      expect(page.notifications).toHaveLength(2);
      expect(page.next_cursor).toBeNull();
    });

    it('an old client calling with no cursor/limit still gets a valid first page', async () => {
      await repo.create(makeNotification({ notification_id: 'n1' }));

      const page = await repo.listPage('usr_1');

      expect(page.notifications).toHaveLength(1);
      expect(page.unread_count).toBe(1);
    });
  });

  describe('markStaleGatePending — issue #794 P0 staleness (gate_pending superseded by gate_confirmed/gate_rejected)', () => {
    it('marks every unread gate_pending for the case read, across every recipient, and leaves everything else alone', async () => {
      await repo.createOrRefresh(makeNotification({ notification_id: 'reviewer_a', user_id: 'usr_a', case_id: 'case_1', type: 'gate_pending' }));
      await repo.createOrRefresh(makeNotification({ notification_id: 'reviewer_b', user_id: 'usr_b', case_id: 'case_1', type: 'gate_pending' }));
      // Different case — must not be touched.
      await repo.createOrRefresh(makeNotification({ notification_id: 'other_case', user_id: 'usr_a', case_id: 'case_2', type: 'gate_pending' }));
      // Same case, different type — must not be touched.
      await repo.createOrRefresh(makeNotification({ notification_id: 'other_type', user_id: 'usr_a', case_id: 'case_1', type: 'case_needs_decision' }));

      const count = await repo.markStaleGatePending('case_1');

      expect(count).toBe(2);
      expect(current.store.get('reviewer_a')?.read).toBe(true);
      expect(current.store.get('reviewer_b')?.read).toBe(true);
      expect(current.store.get('other_case')?.read).toBe(false);
      expect(current.store.get('other_type')?.read).toBe(false);
    });

    it('is a no-op when there is no unread gate_pending for the case', async () => {
      const count = await repo.markStaleGatePending('case_missing');
      expect(count).toBe(0);
    });
  });

  describe('markStaleCaseNeedsDecision — issue #1073 (case_needs_decision superseded once the decision happens)', () => {
    it('marks every unread case_needs_decision for the case read, across every recipient, and leaves everything else alone', async () => {
      await repo.createOrRefresh(makeNotification({ notification_id: 'reviewer_a', user_id: 'usr_a', case_id: 'case_1', type: 'case_needs_decision' }));
      await repo.createOrRefresh(makeNotification({ notification_id: 'reviewer_b', user_id: 'usr_b', case_id: 'case_1', type: 'case_needs_decision' }));
      // Different case — must not be touched.
      await repo.createOrRefresh(makeNotification({ notification_id: 'other_case', user_id: 'usr_a', case_id: 'case_2', type: 'case_needs_decision' }));
      // Same case, different type — must not be touched.
      await repo.createOrRefresh(makeNotification({ notification_id: 'other_type', user_id: 'usr_a', case_id: 'case_1', type: 'gate_pending' }));

      const count = await repo.markStaleCaseNeedsDecision('case_1');

      expect(count).toBe(2);
      expect(current.store.get('reviewer_a')?.read).toBe(true);
      expect(current.store.get('reviewer_b')?.read).toBe(true);
      expect(current.store.get('other_case')?.read).toBe(false);
      expect(current.store.get('other_type')?.read).toBe(false);
    });

    it('is a no-op when there is no unread case_needs_decision for the case', async () => {
      const count = await repo.markStaleCaseNeedsDecision('case_missing');
      expect(count).toBe(0);
    });
  });

  describe('markAllAsRead', () => {
    it('marks every unread notification for the user read, scoped server-side (not to a loaded page)', async () => {
      for (let i = 0; i < 3; i += 1) {
        await repo.create(makeNotification({ notification_id: `unread_${i}`, case_id: `case_${i}`, created_at: `T${i}` }));
      }
      await repo.create(makeNotification({ notification_id: 'already_read', case_id: 'case_read', created_at: 'T9' }));
      await repo.markAsRead('already_read');

      const count = await repo.markAllAsRead('usr_1');

      expect(count).toBe(3);
      expect(current.store.get('unread_0')?.read).toBe(true);
      expect(current.store.get('unread_1')?.read).toBe(true);
      expect(current.store.get('unread_2')?.read).toBe(true);
      expect(current.store.get('already_read')?.read).toBe(true);
    });
  });
});
