/**
 * @file chat-identity-service — exact-match mapping + idempotent write.
 *
 * The Firestore double below models exactly what `mapChatIdentity` needs:
 * an `email`-filtered query capped at 2 results (so zero/one/many can be
 * told apart) and a transaction that re-reads the target doc before
 * deciding whether to write. Real transactional isolation across
 * concurrent callers is not modeled — these tests exercise the decision
 * logic inside one transaction at a time, which is what every assertion
 * below actually depends on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from '@arbitra/shared';

type DocData = Record<string, unknown>;

const usersStore = new Map<string, DocData>();

function reset(): void {
  usersStore.clear();
}

function persistable<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

function seedUser(id: string, overrides: Partial<User> = {}): void {
  const base: User = {
    user_id: id,
    email: 'someone@example.com',
    display_name: 'Someone',
    roles: ['developer'],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  usersStore.set(id, persistable({ ...base, ...overrides }) as DocData);
}

function storedUser(id: string): DocData | undefined {
  return usersStore.get(id);
}

interface Filter {
  field: string;
  value: unknown;
}

class FakeUserDocRef {
  constructor(readonly id: string) {}

  async get() {
    const data = usersStore.get(this.id);
    return { exists: data !== undefined, id: this.id, data: () => data };
  }
}

function applySet(id: string, data: DocData, merge: boolean): void {
  const existing = usersStore.get(id) ?? {};
  usersStore.set(id, merge ? { ...existing, ...persistable(data) } : persistable(data));
}

class FakeUsersCollection {
  constructor(
    private readonly filters: Filter[] = [],
    private readonly maxResults?: number,
  ) {}

  where(field: string, _op: '==', value: unknown): FakeUsersCollection {
    return new FakeUsersCollection([...this.filters, { field, value }], this.maxResults);
  }

  limit(maxResults: number): FakeUsersCollection {
    return new FakeUsersCollection(this.filters, maxResults);
  }

  doc(id: string): FakeUserDocRef {
    return new FakeUserDocRef(id);
  }

  async get() {
    const matched = [...usersStore.entries()].filter(([, doc]) =>
      this.filters.every((f) => doc[f.field] === f.value),
    );
    const limited = this.maxResults === undefined ? matched : matched.slice(0, this.maxResults);
    return {
      empty: limited.length === 0,
      docs: limited.map(([id, data]) => ({ id, data: () => data })),
    };
  }
}

const fakeDb = {
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const tx = {
      get: async (ref: FakeUserDocRef) => ref.get(),
      set: (ref: FakeUserDocRef, data: DocData, options?: { merge?: boolean }) => {
        applySet(ref.id, data, !!options?.merge);
      },
    };
    return fn(tx);
  },
};

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => fakeDb,
  collections: { users: () => new FakeUsersCollection() },
}));

const { mapChatIdentity } = await import('./chat-identity-service.js');

beforeEach(() => {
  reset();
});

describe('mapChatIdentity — the three unmapped outcomes', () => {
  /**
   * Reverting `if (!normalizedEmail) { return { outcome: 'no_email' }; }`
   * breaks this — without it, `.toLowerCase()` on `undefined` (via the
   * optional-chained `email?.trim()`) still yields `undefined`, so the code
   * would fall through into the Firestore query with an undefined filter
   * value instead of short-circuiting.
   */
  it('resolves no_email when the event carried no email', async () => {
    const result = await mapChatIdentity({ chatUserId: 'users/1', spaceName: 'spaces/A', email: undefined });
    expect(result).toEqual({ outcome: 'no_email' });
  });

  /**
   * Reverting `if (snapshot.empty) { return { outcome: 'no_match' }; }`
   * breaks this.
   */
  it('resolves no_match when no Arbitra user has that email', async () => {
    const result = await mapChatIdentity({
      chatUserId: 'users/1',
      spaceName: 'spaces/A',
      email: 'nobody@example.com',
    });
    expect(result).toEqual({ outcome: 'no_match' });
  });

  /**
   * Reverting `if (snapshot.docs.length > 1) { return { outcome:
   * 'ambiguous_match' }; }` breaks this — without it, the code would fall
   * through to `snapshot.docs[0]` and silently pick one of the two
   * candidates, which is exactly the mis-binding this check exists to
   * prevent.
   */
  it('resolves ambiguous_match when two Arbitra users share that email', async () => {
    seedUser('usr_a', { email: 'shared@example.com' });
    seedUser('usr_b', { email: 'shared@example.com' });
    const result = await mapChatIdentity({
      chatUserId: 'users/1',
      spaceName: 'spaces/A',
      email: 'shared@example.com',
    });
    expect(result).toEqual({ outcome: 'ambiguous_match' });
  });
});

describe('mapChatIdentity — successful mapping and case-insensitive match', () => {
  /**
   * Reverting the `tx.set(ref, { chat_identity: chatIdentity, updated_at:
   * now }, { merge: true });` write (e.g. removing it) breaks this — the
   * outcome would still report 'mapped' only if the return value survived,
   * but the stored doc would never actually gain a `chat_identity`.
   */
  it('maps an exact single match and persists chat_identity', async () => {
    seedUser('usr_alex', { email: 'alex.example@example.com' });
    const result = await mapChatIdentity({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: 'alex.example@example.com',
    });
    expect(result).toEqual({ outcome: 'mapped', userId: 'usr_alex' });
    expect(storedUser('usr_alex')?.['chat_identity']).toEqual({
      chat_user_id: 'users/123456789',
      space_name: 'spaces/AAAA',
      mapped_at: expect.any(String),
    });
  });

  /**
   * Reverting `email?.trim().toLowerCase()` to drop `.toLowerCase()` (only
   * trimming) breaks this — a case-differing but otherwise identical
   * address would then fail to match a lowercase-stored one.
   */
  it('matches case-insensitively', async () => {
    seedUser('usr_alex', { email: 'alex.example@example.com' });
    const result = await mapChatIdentity({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: 'Alex.Example@Example.com',
    });
    expect(result).toEqual({ outcome: 'mapped', userId: 'usr_alex' });
  });
});

describe('mapChatIdentity — idempotency (the install double-event race)', () => {
  /**
   * Reverting `if (existing.chat_user_id === chatUserId) { return {
   * outcome: 'mapped_idempotent', userId: candidateId }; }` (e.g. deleting
   * the branch so execution falls through to the unconditional write)
   * breaks this — a replay of the same event (or the install's second,
   * near-simultaneous event) would overwrite `chat_identity` a second time
   * and shift `mapped_at`, instead of leaving the first mapping untouched.
   */
  it('a second identical event produces one write, with mapped_at unchanged', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-08T10:00:00.000Z'));
      seedUser('usr_alex', { email: 'alex.example@example.com' });

      const first = await mapChatIdentity({
        chatUserId: 'users/123456789',
        spaceName: 'spaces/AAAA',
        email: 'alex.example@example.com',
      });
      expect(first).toEqual({ outcome: 'mapped', userId: 'usr_alex' });
      const mappedAtAfterFirst = (storedUser('usr_alex')?.['chat_identity'] as { mapped_at: string }).mapped_at;

      // The install's second event (or a Chat retry) lands 3 seconds later.
      vi.setSystemTime(new Date('2026-08-08T10:00:03.000Z'));
      const second = await mapChatIdentity({
        chatUserId: 'users/123456789',
        spaceName: 'spaces/AAAA',
        email: 'alex.example@example.com',
      });
      expect(second).toEqual({ outcome: 'mapped_idempotent', userId: 'usr_alex' });

      const mappedAtAfterSecond = (storedUser('usr_alex')?.['chat_identity'] as { mapped_at: string }).mapped_at;
      expect(mappedAtAfterSecond).toBe(mappedAtAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Design decision 1 in the module doc: a DIFFERENT chat_user_id must
   * never overwrite an existing mapping. Reverting the `return { outcome:
   * 'mapping_conflict', userId: candidateId };` branch (e.g. falling
   * through to the unconditional write instead) breaks this — the seeded
   * mapping's `chat_user_id` would silently change to the new sender's id.
   */
  it('refuses to rebind an already-mapped user to a different Chat account', async () => {
    seedUser('usr_alex', {
      email: 'alex.example@example.com',
      chat_identity: { chat_user_id: 'users/OLD', space_name: 'spaces/ORIGINAL', mapped_at: '2026-08-01T00:00:00.000Z' },
    });

    const result = await mapChatIdentity({
      chatUserId: 'users/NEW',
      spaceName: 'spaces/AAAA',
      email: 'alex.example@example.com',
    });

    expect(result).toEqual({ outcome: 'mapping_conflict', userId: 'usr_alex' });
    expect(storedUser('usr_alex')?.['chat_identity']).toEqual({
      chat_user_id: 'users/OLD',
      space_name: 'spaces/ORIGINAL',
      mapped_at: '2026-08-01T00:00:00.000Z',
    });
  });

  /**
   * Design decision 2 in the module doc: `space_name` is fixed at first
   * mapping. Reverting the idempotent-replay branch to update `space_name`
   * from the new call's arguments (instead of returning early without a
   * write) breaks this.
   */
  it('does not move space_name when the same mapped sender messages from a different space', async () => {
    seedUser('usr_alex', { email: 'alex.example@example.com' });
    await mapChatIdentity({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/ORIGINAL_DM',
      email: 'alex.example@example.com',
    });

    await mapChatIdentity({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/SOME_OTHER_GROUP_SPACE',
      email: 'alex.example@example.com',
    });

    expect((storedUser('usr_alex')?.['chat_identity'] as { space_name: string }).space_name).toBe(
      'spaces/ORIGINAL_DM',
    );
  });
});
