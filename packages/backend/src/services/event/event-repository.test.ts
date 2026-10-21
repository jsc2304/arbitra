/**
 * Issue #1063 — `case_events` must be append-only: a second write with an
 * already-used `event_id` has to throw (ALREADY_EXISTS), not silently
 * overwrite the existing audit record.
 *
 * The fake Firestore below genuinely rejects a duplicate `.create()`/
 * `transaction.create()` the way the real `@google-cloud/firestore` SDK
 * does. This is deliberate: `event-service.test.ts`'s `makeFakeRepo()`
 * stubs `EventRepository.create`/`createInTransaction` unconditionally
 * (`create: vi.fn(async (event) => event)`), so a duplicate-id assertion
 * written against that mock would only prove the mock always succeeds —
 * the "stubbed seam" test shape, a known pitfall. Testing at the
 * repository level, against a fake that actually enforces
 * create-if-not-exists semantics, is the only way to exercise the real
 * behavior this issue is about.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CaseEvent } from '@arbitra/shared';

class AlreadyExistsError extends Error {
  code = 6; // gRPC ALREADY_EXISTS, matching @google-cloud/firestore's GoogleError.code

  constructor(id: string) {
    super(`ALREADY_EXISTS: document case_events/${id} already exists`);
  }
}

const store: { value: Map<string, CaseEvent> } = { value: new Map() };

function reset() {
  store.value = new Map();
}

function makeDocRef(id: string) {
  return {
    id,
    create: async (data: CaseEvent) => {
      if (store.value.has(id)) throw new AlreadyExistsError(id);
      store.value.set(id, data);
    },
    set: async (data: CaseEvent) => {
      store.value.set(id, data);
    },
    get: async () => ({
      exists: store.value.has(id),
      data: () => store.value.get(id),
    }),
  };
}

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    caseEvents: () => ({
      doc: (id: string) => makeDocRef(id),
      where: () => ({
        orderBy: () => ({
          get: async () => ({
            docs: Array.from(store.value.values())
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .map((data) => ({ data: () => data })),
          }),
        }),
      }),
    }),
  },
}));

const { EventRepository } = await import('./event-repository.js');

// Minimal fake `Transaction` — only `.create()` is exercised by
// `createInTransaction`, and it must reject a duplicate id the same way
// `doc.create()` does above.
//
// Caveat: real `Transaction.create()` (@google-cloud/firestore) just stages
// a create-precondition write and returns synchronously without checking
// anything — the actual ALREADY_EXISTS enforcement happens server-side,
// asynchronously, at transaction commit. The synchronous throw below is
// this fake's own contrived logic, not a model of that server-side check.
// The `createInTransaction` describe block below therefore proves
// `EventRepository.createInTransaction` calls `.create()` (not `.set()`)
// on the transaction — it does not exercise real commit-time semantics.
// The non-transactional `EventRepository.create` tests above don't have
// this gap: `DocumentReference.create()` is a real, awaited write that
// genuinely rejects ALREADY_EXISTS.
function makeFakeTransaction() {
  return {
    create: (ref: ReturnType<typeof makeDocRef>, data: CaseEvent) => {
      if (store.value.has(ref.id)) throw new AlreadyExistsError(ref.id);
      store.value.set(ref.id, data);
    },
  } as unknown as FirebaseFirestore.Transaction;
}

function makeEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    event_id: 'event_1',
    case_id: 'case_1',
    type: 'case_completed',
    actor_id: 'system:test',
    payload: {},
    created_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('EventRepository.create — append-only (#1063)', () => {
  beforeEach(() => reset());

  it('writes a new event', async () => {
    const repo = new EventRepository();
    const event = makeEvent();

    const result = await repo.create(event);

    expect(result).toEqual(event);
    expect(store.value.get('event_1')).toEqual(event);
  });

  it('throws ALREADY_EXISTS on a second write with the same event_id, and does not overwrite the first', async () => {
    const repo = new EventRepository();
    const first = makeEvent({ payload: { original: true } });
    const second = makeEvent({ payload: { original: false } });

    await repo.create(first);

    await expect(repo.create(second)).rejects.toThrow(/ALREADY_EXISTS/);
    // The stored record is still the first write — no silent overwrite.
    expect(store.value.get('event_1')).toEqual(first);
  });
});

describe('EventRepository.createInTransaction — append-only (#1063)', () => {
  beforeEach(() => reset());

  it('stages a new event on the transaction', () => {
    const repo = new EventRepository();
    const tx = makeFakeTransaction();
    const event = makeEvent();

    repo.createInTransaction(tx, event);

    expect(store.value.get('event_1')).toEqual(event);
  });

  it('throws ALREADY_EXISTS when staging a duplicate event_id, and does not overwrite the first', () => {
    const repo = new EventRepository();
    const tx = makeFakeTransaction();
    const first = makeEvent({ payload: { original: true } });
    const second = makeEvent({ payload: { original: false } });

    repo.createInTransaction(tx, first);

    expect(() => repo.createInTransaction(tx, second)).toThrow(/ALREADY_EXISTS/);
    expect(store.value.get('event_1')).toEqual(first);
  });
});

describe('EventRepository.getByCaseId — unaffected by the create-semantics change', () => {
  beforeEach(() => reset());

  it('returns events for a case in created_at order', async () => {
    const repo = new EventRepository();
    await repo.create(makeEvent({ event_id: 'event_2', created_at: '2026-09-08T00:00:01.000Z' }));
    await repo.create(makeEvent({ event_id: 'event_1', created_at: '2026-09-08T00:00:00.000Z' }));

    const events = await repo.getByCaseId('case_1');

    expect(events.map((e) => e.event_id)).toEqual(['event_1', 'event_2']);
  });
});
