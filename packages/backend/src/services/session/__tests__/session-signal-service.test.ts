import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Tests the Session Signal ingestion + registry seam (issue #983): the
 * public functions `ingestSessionSignalBatch` and `listActiveSessions`.
 *
 * The Firestore double is a narrow, hand-rolled shim — just enough to model
 * the two properties the implementation depends on:
 *   - `tx.create` throws (and commits nothing) when the target doc already
 *     exists, mirroring real Firestore transaction semantics. This is what
 *     makes the deterministic-doc-id claim in `ingestSessionSignalBatch`
 *     an atomic dedupe instead of a check-then-insert race.
 *   - a transaction commits every staged write or none of them.
 * It deliberately does not model concurrent transaction interleaving —
 * the service processes batch items sequentially, so that isn't exercised.
 */

type DocData = Record<string, unknown>;

// `vi.mock` factories are hoisted above this module's own top-level code, so
// everything the factory closes over must be built inside `vi.hoisted` to
// survive the TDZ. `store` is exposed for direct assertions in the tests
// below; `fakeDb`/`collections` are only consumed by the mock factory.
const { store, fakeDb, collections } = vi.hoisted(() => {
  type DocData = Record<string, unknown>;
  const store = new Map<string, Map<string, DocData>>();

  function collectionStore(name: string): Map<string, DocData> {
    let existing = store.get(name);
    if (!existing) {
      existing = new Map();
      store.set(name, existing);
    }
    return existing;
  }

  function snapshotOf(collectionName: string, id: string) {
    const data = collectionStore(collectionName).get(id);
    return { id, exists: data !== undefined, data: () => data };
  }

  class FakeDocRef {
    constructor(
      readonly collectionName: string,
      readonly id: string,
    ) {}

    get path(): string {
      return `${this.collectionName}/${this.id}`;
    }

    async get() {
      return snapshotOf(this.collectionName, this.id);
    }
  }

  interface Filter {
    field: string;
    op: '==' | '>=';
    value: unknown;
  }

  class FakeQuery {
    constructor(
      protected readonly collectionName: string,
      protected readonly filters: Filter[] = [],
    ) {}

    where(field: string, op: Filter['op'], value: unknown): FakeQuery {
      return new FakeQuery(this.collectionName, [...this.filters, { field, op, value }]);
    }

    async get() {
      const docs = [...collectionStore(this.collectionName).values()].filter((doc) =>
        this.filters.every(({ field, op, value }) => {
          const actual = doc[field];
          if (op === '==') return actual === value;
          // String comparison mirrors Firestore's lexicographic ordering on
          // ISO-8601 timestamps, which is what `last_seen_at` range filters
          // rely on in production.
          return String(actual ?? '') >= String(value);
        }),
      );
      return {
        forEach(fn: (doc: { data: () => DocData }) => void) {
          docs.forEach((data) => fn({ data: () => data }));
        },
      };
    }
  }

  class FakeCollection extends FakeQuery {
    doc(id: string): FakeDocRef {
      return new FakeDocRef(this.collectionName, id);
    }
  }

  type StagedWrite =
    | { ref: FakeDocRef; op: 'create'; data: DocData }
    | { ref: FakeDocRef; op: 'set'; data: DocData; merge: boolean };

  const fakeDb = {
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const writes: StagedWrite[] = [];
      const tx = {
        get: async (ref: FakeDocRef) => ref.get(),
        create: (ref: FakeDocRef, data: DocData) => writes.push({ ref, op: 'create', data }),
        set: (ref: FakeDocRef, data: DocData, options?: { merge?: boolean }) =>
          writes.push({ ref, op: 'set', data, merge: options?.merge ?? false }),
      };
      const result = await fn(tx);

      // Firestore commits atomically: check every create precondition before
      // applying any write.
      for (const write of writes) {
        if (write.op === 'create' && collectionStore(write.ref.collectionName).has(write.ref.id)) {
          throw new Error(`ALREADY_EXISTS: ${write.ref.path}`);
        }
      }
      for (const write of writes) {
        const coll = collectionStore(write.ref.collectionName);
        if (write.op === 'create') {
          coll.set(write.ref.id, write.data);
        } else {
          const prev = write.merge ? (coll.get(write.ref.id) ?? {}) : {};
          coll.set(write.ref.id, { ...prev, ...write.data });
        }
      }
      return result;
    },
  };

  const collections = {
    sessionSignalEvents: () => new FakeCollection('session_signal_events'),
    sessions: () => new FakeCollection('sessions'),
  };

  return { store, fakeDb, collections };
});

function collectionStore(name: string): Map<string, DocData> {
  let existing = store.get(name);
  if (!existing) {
    existing = new Map();
    store.set(name, existing);
  }
  return existing;
}

vi.mock('../../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections,
}));

import { ingestSessionSignalBatch, listActiveSessions, listSessionsSince } from '../session-signal-service.js';

beforeEach(() => {
  store.clear();
});

function event(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    event_id: 'evt_1',
    schema_version: 1,
    event_type: 'session_start',
    agent_name: 'claude-code',
    repository: 'repo_123',
    branch: 'feat/foo',
    session_id: 'sess_1',
    ...overrides,
  };
}

describe('ingestSessionSignalBatch', () => {
  it('yields exactly one session for a duplicate event_id, regardless of arrival order', async () => {
    // Reverting the `receiptSnap.exists` early-return in session-signal-service.ts
    // (the dedupe check) would apply the second, duplicate event again and this
    // assertion on `sessions` collection size would fail.
    const first = await ingestSessionSignalBatch([
      event({ event_id: 'evt_dup', event_type: 'session_start' }),
    ]);
    const second = await ingestSessionSignalBatch([
      event({ event_id: 'evt_dup', event_type: 'session_start' }),
    ]);

    expect(first.results[0]!.status).toBe('accepted');
    expect(second.results[0]!.status).toBe('duplicate');
    expect(collectionStore('sessions').size).toBe(1);
    expect(collectionStore('session_signal_events').size).toBe(1);
  });

  it('accepts the rest of a batch when one item is invalid', async () => {
    // Reverting the `safeParse` failure branch (removing the per-item
    // rejection and falling through to processing) would make the invalid
    // item's outcome 'accepted' instead of 'rejected', failing this assertion.
    const result = await ingestSessionSignalBatch([
      event({ event_id: 'evt_valid_1' }),
      { event_id: 'evt_invalid', event_type: 'not_a_real_type' }, // missing required fields too
      event({ event_id: 'evt_valid_2', session_id: 'sess_2' }),
    ]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.results[0]!.status).toBe('accepted');
    expect(result.results[1]!.status).toBe('rejected');
    expect(result.results[1]!.error?.code).toBe('VALIDATION_ERROR');
    expect(result.results[2]!.status).toBe('accepted');
  });

  it('creates a session on session_start and marks it ended on session_end', async () => {
    // Reverting the `ended` computation (`event.event_type === 'session_end'`)
    // to always `false` would leave `ended` false here, failing this assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_a', event_type: 'session_start' })]);
    await ingestSessionSignalBatch([event({ event_id: 'evt_b', event_type: 'session_end' })]);

    const stored = collectionStore('sessions').get('sess_1');
    expect(stored?.ended).toBe(true);
  });

  it('does not let a heartbeat after session_end resurrect the session', async () => {
    // Reverting the sticky-`ended` fix (i.e. going back to
    // `ended: event.event_type === 'session_end'` unconditionally in the
    // `sessionSnap.exists` branch) would flip `ended` back to `false` on the
    // heartbeat below, failing this assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_start', event_type: 'session_start' })]);
    await ingestSessionSignalBatch([event({ event_id: 'evt_end', event_type: 'session_end' })]);
    await ingestSessionSignalBatch([event({ event_id: 'evt_late_heartbeat', event_type: 'heartbeat' })]);

    const stored = collectionStore('sessions').get('sess_1');
    expect(stored?.ended).toBe(true);

    const active = await listActiveSessions();
    expect(active.find((s) => s.session_id === 'sess_1')).toBeUndefined();
  });
});

describe('ingestSessionSignalBatch user_id (issue #990)', () => {
  it('stamps the authenticated caller onto the session entry when userId is passed', async () => {
    // Reverting the `userId` param being threaded into the created
    // `SessionRegistryEntry` (i.e. dropping `user_id: userId` in the
    // `ingestOne` "create" branch) would leave `user_id` undefined here,
    // failing this assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_u1' })], { userId: 'usr_alice' });

    const stored = collectionStore('sessions').get('sess_1');
    expect(stored?.user_id).toBe('usr_alice');
  });

  it('leaves user_id unset when no userId is passed', async () => {
    // Reverting to always defaulting `user_id` to some sentinel (instead of
    // omitting the field) would make this assertion fail.
    await ingestSessionSignalBatch([event({ event_id: 'evt_u2', session_id: 'sess_2' })]);

    const stored = collectionStore('sessions').get('sess_2');
    expect(stored?.user_id).toBeUndefined();
  });

  it('updates user_id to the latest authenticated caller on an existing session', async () => {
    // Reverting the `user_id` patch in the `sessionSnap.exists` branch (only
    // ever setting it on creation) would leave `user_id` as 'usr_alice'
    // here instead of 'usr_bob', failing this assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_u3', session_id: 'sess_3' })], {
      userId: 'usr_alice',
    });
    await ingestSessionSignalBatch(
      [event({ event_id: 'evt_u4', session_id: 'sess_3', event_type: 'heartbeat' })],
      { userId: 'usr_bob' },
    );

    const stored = collectionStore('sessions').get('sess_3');
    expect(stored?.user_id).toBe('usr_bob');
  });
});

describe('liveness window', () => {
  it('reads a session as ended once its last heartbeat is past the liveness window', async () => {
    // Reverting the liveness-window comparison in `isSessionEntryActive` (e.g.
    // hardcoding it to always return true) would keep this session in the
    // active list past the window, failing the `toHaveLength(0)` assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_hb', event_type: 'heartbeat' })]);

    const withinWindow = await listActiveSessions(new Date(Date.now() + 60_000)); // +1min
    expect(withinWindow).toHaveLength(1);

    const pastWindow = await listActiveSessions(new Date(Date.now() + 6 * 60_000)); // +6min > 5min window
    expect(pastWindow).toHaveLength(0);
  });
});

describe('listSessionsSince (issue #990)', () => {
  it('includes an ended session, unlike listActiveSessions', async () => {
    // Reverting `listSessionsSince` to also filter `ended == false` (copying
    // `listActiveSessions`'s query) would drop this session from the
    // result, failing the `toHaveLength(1)` assertion.
    await ingestSessionSignalBatch([
      event({ event_id: 'evt_ended', session_id: 'sess_ended_1', event_type: 'session_end' }),
    ]);

    const records = await listSessionsSince(new Date(Date.now() - 60_000));
    expect(records).toHaveLength(1);
    expect(records[0]!.session_id).toBe('sess_ended_1');
  });

  it('excludes a session whose last_seen_at is before the cutoff', async () => {
    // Reverting the `last_seen_at >= cutoff` filter (e.g. dropping the
    // `.where` call and returning every session) would include this session
    // regardless of the cutoff, failing the `toHaveLength(0)` assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_old', session_id: 'sess_old' })]);

    const records = await listSessionsSince(new Date(Date.now() + 60_000));
    expect(records).toHaveLength(0);
  });

  it('carries user_id when the batch was ingested with an authenticated caller', async () => {
    // Reverting the `user_id` projection in `listSessionsSince` (omitting
    // it even when present on the stored entry) would leave this
    // `undefined`, failing the assertion.
    await ingestSessionSignalBatch([event({ event_id: 'evt_uid', session_id: 'sess_uid' })], {
      userId: 'usr_carol',
    });

    const records = await listSessionsSince(new Date(Date.now() - 60_000));
    expect(records.find((r) => r.session_id === 'sess_uid')?.user_id).toBe('usr_carol');
  });
});

describe('listActiveSessions', () => {
  it('lists active sessions with repository, branch, agent, session id, and last-seen', async () => {
    // Reverting the `!entry.ended` short-circuit in `isSessionEntryActive`
    // would let the explicitly-ended session below leak into this list,
    // failing the `toHaveLength(1)` assertion.
    await ingestSessionSignalBatch([
      event({ event_id: 'evt_x1', session_id: 'sess_active', agent_name: 'codex', repository: 'repo_a', branch: 'main' }),
    ]);
    await ingestSessionSignalBatch([
      event({ event_id: 'evt_x2', session_id: 'sess_ended', event_type: 'session_end' }),
    ]);

    const active = await listActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual({
      session_id: 'sess_active',
      agent_name: 'codex',
      repository: 'repo_a',
      branch: 'main',
      last_seen_at: expect.any(String),
    });
  });
});
