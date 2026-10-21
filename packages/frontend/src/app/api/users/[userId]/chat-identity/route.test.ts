/**
 * Issue #1069 fix 1 — admin remap of Chat identity, CLEAR ONLY
 * (issue #1069).
 * Modeled on `../roles/route.test.ts`'s Firestore double, extended with a
 * `WorkspaceEventService` spy and a `firebase-admin/firestore` `FieldValue`
 * delete-sentinel mock.
 *
 * The `collections.users()` double models real Firestore transaction
 * semantics (per-doc version + optimistic-concurrency conflict detection at
 * commit, with automatic retry of the transaction body) rather than a plain
 * stubbed get/update. That strictness is deliberate: a double that just
 * mirrors get-then-update would stay green whether or not the route
 * actually wraps its read-modify-write in a transaction, and would not
 * catch the exact regression this fix addresses (see the "concurrent
 * write" describe block below, and its own docstring).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

interface ChatIdentity {
  space_name: string;
  chat_user_id: string;
  mapped_at: string;
}

interface UserDoc {
  roles?: string[];
  chat_identity?: ChatIdentity;
}

interface UserRecord {
  data: UserDoc;
  /** Bumped on every applied write. Firestore's real conflict-detection
   * mechanism — a transaction that read a doc at version N aborts and
   * retries if the doc is no longer at version N when it tries to commit. */
  version: number;
}

const DELETE_SENTINEL = Symbol('FieldValue.delete');

const state: { users: Map<string, UserRecord> } = { users: new Map() };

function reset(): void {
  state.users = new Map();
}

function seedUser(id: string, data: UserDoc): void {
  state.users.set(id, { data, version: 1 });
}

function applyPatch(existing: UserDoc, patch: Record<string, unknown>): UserDoc {
  const next: UserDoc = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === DELETE_SENTINEL) {
      delete (next as Record<string, unknown>)[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

const { targetUpdate } = vi.hoisted(() => ({ targetUpdate: vi.fn() }));
const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
const { recordWorkspaceEvent } = vi.hoisted(() => ({ recordWorkspaceEvent: vi.fn() }));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => DELETE_SENTINEL },
}));

/**
 * Fires at most once, on the FIRST read of `usr_target` — regardless of
 * whether that read comes from the fixed code's `tx.get()` or (with the fix
 * reverted) the plain, non-transactional `ref.get()`. Lets a test simulate a
 * fully independent write (e.g. a concurrent `mapChatIdentity` commit)
 * landing between "we read the doc" and "we act on what we read", the exact
 * window this fix closes.
 */
let onFirstRead: (() => void) | undefined;
let firstReadFired = false;

function noteRead(id: string): void {
  if (firstReadFired || !onFirstRead) return;
  if (id !== 'usr_target') return;
  firstReadFired = true;
  onFirstRead();
}

vi.mock('@arbitra/backend', () => ({
  requireRole,
  WorkspaceEventService: class {
    // Non-transactional path — unused by the fixed route, kept only so a
    // reverted route still compiles/links against the same mock shape.
    record(input: unknown) {
      return recordWorkspaceEvent(input);
    }
    // Transactional path: stages the audit write on the SAME transaction
    // the caller is mid-commit on. Only reaches `recordWorkspaceEvent` if
    // and when that transaction actually commits (see runTransaction below)
    // — never on an attempt that gets discarded and retried.
    recordInTransaction(tx: { __stageAudit: (input: unknown) => void }, input: unknown) {
      tx.__stageAudit(input);
    }
  },
  collections: {
    users: () => ({
      doc: (id: string) => ({
        id,
        get: async () => {
          // Capture the snapshot BEFORE firing the read-hook: a real read
          // returns a consistent view as of read time, and only THEN can an
          // independent concurrent write move the store on. Firing the hook
          // first would make this read observe its own concurrent write,
          // which models no race at all.
          const rec = state.users.get(id);
          noteRead(id);
          return { exists: rec !== undefined, data: () => rec?.data };
        },
        update: async (patch: Record<string, unknown>) => {
          targetUpdate(id, patch);
          const existing = state.users.get(id);
          const nextData = applyPatch(existing?.data ?? {}, patch);
          state.users.set(id, { data: nextData, version: (existing?.version ?? 0) + 1 });
        },
      }),
    }),
  },
  getDb: () => ({
    runTransaction: async <T>(
      fn: (tx: {
        get: (ref: { id: string }) => Promise<{ exists: boolean; data: () => UserDoc | undefined }>;
        update: (ref: { id: string }, patch: Record<string, unknown>) => void;
        __stageAudit: (input: unknown) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      const MAX_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const readVersions = new Map<string, number>();
        const stagedUserWrites: Array<{ id: string; patch: Record<string, unknown> }> = [];
        const stagedAudits: unknown[] = [];

        const tx = {
          get: async (ref: { id: string }) => {
            // Same ordering requirement as the plain `.get()` above: capture
            // the version and snapshot before the hook can move the store.
            const rec = state.users.get(ref.id);
            readVersions.set(ref.id, rec?.version ?? 0);
            noteRead(ref.id);
            return { exists: rec !== undefined, data: () => rec?.data };
          },
          update: (ref: { id: string }, patch: Record<string, unknown>) => {
            stagedUserWrites.push({ id: ref.id, patch });
          },
          __stageAudit: (input: unknown) => {
            stagedAudits.push(input);
          },
        };

        const result = await fn(tx);

        // Commit-time conflict check: has any doc this attempt read moved
        // since the read? If so, discard everything staged this attempt
        // and retry with a fresh read — this is what makes the real
        // `runTransaction` safe against exactly the race this fix targets.
        let conflict = false;
        for (const [id, readVersion] of readVersions) {
          const current = state.users.get(id);
          if ((current?.version ?? 0) !== readVersion) {
            conflict = true;
            break;
          }
        }
        if (conflict) continue;

        for (const write of stagedUserWrites) {
          targetUpdate(write.id, write.patch);
          const existing = state.users.get(write.id);
          const nextData = applyPatch(existing?.data ?? {}, write.patch);
          state.users.set(write.id, { data: nextData, version: (existing?.version ?? 0) + 1 });
        }
        for (const input of stagedAudits) {
          recordWorkspaceEvent(input);
        }
        return result;
      }
      throw new Error('fake transaction exceeded retry budget');
    },
  }),
  // Mirrors the real `validateBody` contract (see roles/route.test.ts /
  // tokens/route.test.ts): real Zod schema, thrown error carries
  // `statusCode` for `handleError`.
  validateBody: (
    schema: {
      safeParse: (
        data: unknown,
      ) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } };
    },
    body: unknown,
  ) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw Object.assign(new Error('Invalid request payload'), {
        statusCode: 400,
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  },
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { PATCH } from './route';

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/users/usr_target/chat-identity', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ userId: 'usr_target' }) };

const BOUND: ChatIdentity = {
  space_name: 'spaces/AAAA',
  chat_user_id: 'users/123456789',
  mapped_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  reset();
  onFirstRead = undefined;
  firstReadFired = false;
  requireRole.mockResolvedValue(['admin']);
});

describe('PATCH /api/users/:userId/chat-identity — admin gate', () => {
  it('rejects a non-admin caller with 403, no write, no audit event', async () => {
    authenticate.mockResolvedValue({ userId: 'usr_caller' });
    requireRole.mockRejectedValue(Object.assign(new Error('Required role: admin'), { statusCode: 403 }));
    seedUser('usr_target', { chat_identity: BOUND });

    const res = await PATCH(patchReq({ action: 'clear' }), params);

    expect(res.status).toBe(403);
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(recordWorkspaceEvent).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:userId/chat-identity — updateChatIdentitySchema wiring', () => {
  beforeEach(() => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
    seedUser('usr_target', { chat_identity: BOUND });
  });

  it('rejects an empty body with 400, no write', async () => {
    const res = await PATCH(patchReq({}), params);
    expect(res.status).toBe(400);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('rejects action "replace" with 400, no write', async () => {
    const res = await PATCH(patchReq({ action: 'replace' }), params);
    expect(res.status).toBe(400);
    expect(targetUpdate).not.toHaveBeenCalled();
  });

  it('rejects a body carrying chat_user_id with 400, no write', async () => {
    const res = await PATCH(patchReq({ action: 'set', chat_user_id: 'users/999' }), params);
    expect(res.status).toBe(400);
    expect(targetUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:userId/chat-identity — target user', () => {
  beforeEach(() => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
  });

  it('returns 404 when the target user does not exist', async () => {
    const res = await PATCH(patchReq({ action: 'clear' }), { params: Promise.resolve({ userId: 'usr_ghost' }) });
    expect(res.status).toBe(404);
  });

  it('is an idempotent no-op when the target has no chat_identity: 200, no Firestore update, no audit event', async () => {
    seedUser('usr_target', {});

    const res = await PATCH(patchReq({ action: 'clear' }), params);

    expect(res.status).toBe(200);
    expect(targetUpdate).not.toHaveBeenCalled();
    expect(recordWorkspaceEvent).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:userId/chat-identity — real clear', () => {
  beforeEach(() => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
    seedUser('usr_target', { chat_identity: BOUND });
  });

  it('deletes chat_identity via the FieldValue.delete() sentinel and returns a body without it', async () => {
    const res = await PATCH(patchReq({ action: 'clear' }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(targetUpdate).toHaveBeenCalledWith(
      'usr_target',
      expect.objectContaining({ chat_identity: DELETE_SENTINEL }),
    );
    expect(body.chat_identity).toBeUndefined();
    expect(state.users.get('usr_target')?.data.chat_identity).toBeUndefined();
  });

  it('records a chat_identity_cleared audit event naming the actor and the previous binding', async () => {
    await PATCH(patchReq({ action: 'clear' }), params);

    expect(recordWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(recordWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat_identity_cleared',
        actor_user_id: 'usr_admin',
        evidence: expect.objectContaining({
          target_user_id: 'usr_target',
          previous_chat_user_id: BOUND.chat_user_id,
          previous_space_name: BOUND.space_name,
        }),
      }),
    );
  });
});

describe('PATCH /api/users/:userId/chat-identity — concurrent write between read and write', () => {
  /**
   * The regression this fix targets: a fully independent write to the same
   * user doc (modeled here as a raw, direct `update()` — the shape a
   * concurrent `mapChatIdentity` transaction commit would take from this
   * route's point of view) lands in the window between "we read
   * chat_identity" and "we act on what we read".
   *
   * Without the fix (plain `targetRef.get()` + unconditional
   * `targetRef.update()`), the route reads A, the concurrent write then
   * commits B, and the route's unconditional delete silently wipes out B
   * while the audit event records stale evidence — `previous_chat_user_id:
   * A`, when what was actually destroyed was B. That is the bug: not that
   * the clear fails, but that it destroys a mapping it never looked at and
   * lies about which one in the audit trail.
   *
   * With the fix, the route's `runTransaction` detects that `usr_target`
   * changed between its read and its commit attempt, and retries: the
   * retry's read observes B, and the delete + audit both act on B. The
   * audit event's `previous_chat_user_id` therefore names B, never A, and
   * fires exactly once (not once per attempt).
   */
  const CONCURRENT: ChatIdentity = {
    space_name: 'spaces/BBBB',
    chat_user_id: 'users/999999999',
    mapped_at: '2026-02-01T00:00:00.000Z',
  };

  beforeEach(() => {
    authenticate.mockResolvedValue({ userId: 'usr_admin' });
    seedUser('usr_target', { chat_identity: BOUND });
    onFirstRead = () => {
      // A fully independent, direct write — NOT routed through this
      // route's own transaction — landing right after the route's first
      // read observed BOUND (A).
      const existing = state.users.get('usr_target')!;
      state.users.set('usr_target', {
        data: { ...existing.data, chat_identity: CONCURRENT },
        version: existing.version + 1,
      });
    };
  });

  it('deletes the mapping that was actually current, and records THAT mapping as `previous` in the audit event — not the stale value read before the concurrent write', async () => {
    const res = await PATCH(patchReq({ action: 'clear' }), params);

    expect(res.status).toBe(200);
    expect(state.users.get('usr_target')?.data.chat_identity).toBeUndefined();
    expect(recordWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(recordWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          previous_chat_user_id: CONCURRENT.chat_user_id,
          previous_space_name: CONCURRENT.space_name,
        }),
      }),
    );
  });
});
