/**
 * @file chat-thread-link-service — doc-id derivation, and the
 * resolve/record round trip against a fake Firestore doc store (same
 * pattern as `chat-identity-service.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatContinuityKeyKind } from '@arbitra/shared';

type DocData = Record<string, unknown>;

const linksStore = new Map<string, DocData>();

function reset(): void {
  linksStore.clear();
}

class FakeLinkDocRef {
  constructor(readonly id: string) {}

  async get() {
    const data = linksStore.get(this.id);
    return { exists: data !== undefined, id: this.id, data: () => data };
  }

  async set(data: DocData, options?: { merge?: boolean }) {
    const existing = linksStore.get(this.id) ?? {};
    linksStore.set(this.id, options?.merge ? { ...existing, ...data } : data);
  }
}

class FakeChatThreadLinksCollection {
  doc(id: string): FakeLinkDocRef {
    return new FakeLinkDocRef(id);
  }
}

vi.mock('../../lib/firestore.js', () => ({
  collections: { chatThreadLinks: () => new FakeChatThreadLinksCollection() },
}));

const { chatThreadLinkId, resolveChatThreadCase, recordChatThreadTip } = await import(
  './chat-thread-link-service.js'
);

beforeEach(() => {
  reset();
});

describe('chatThreadLinkId — kind is folded into the hash, not just carried alongside it', () => {
  /**
   * The whole point of hashing `(keyKind, key)` together rather than `key`
   * alone: a `thread_name` and a `space_name` must never collide even if
   * the literal string values happened to be equal. Reverting
   * `chatThreadLinkId` back to hashing `key` alone (dropping `keyKind` from
   * the digest input) breaks this.
   */
  it('produces different ids for the same literal string under different key kinds', () => {
    const sameString = 'spaces/AAAA';
    const asThread = chatThreadLinkId('thread_name', sameString);
    const asSpace = chatThreadLinkId('space_name', sameString);
    expect(asThread).not.toBe(asSpace);
  });

  /**
   * Two distinct threads in the same space are two distinct conversations —
   * load-bearing at the id-derivation level, since `resolveChatThreadCase`/
   * `recordChatThreadTip` never do anything but compute this id and read/
   * write the doc at it. Reverting `chatThreadLinkId` to ignore its `key`
   * argument (e.g. hashing a constant) breaks this.
   */
  it('produces different ids for two different threads in the same space', () => {
    const threadA = chatThreadLinkId('thread_name', 'spaces/AAAA/threads/T1');
    const threadB = chatThreadLinkId('thread_name', 'spaces/AAAA/threads/T2');
    expect(threadA).not.toBe(threadB);
  });

  it('is deterministic for the same (kind, key) pair', () => {
    const first = chatThreadLinkId('space_name', 'spaces/AAAA');
    const second = chatThreadLinkId('space_name', 'spaces/AAAA');
    expect(first).toBe(second);
  });

  it('has the ctl_ prefix and a 32-hex-char digest', () => {
    const id = chatThreadLinkId('thread_name', 'spaces/AAAA/threads/T1');
    expect(id).toMatch(/^ctl_[0-9a-f]{32}$/);
  });
});

describe('resolveChatThreadCase / recordChatThreadTip — round trip', () => {
  /**
   * Reverting `resolveChatThreadCase` to read `latest_case_id` off the
   * wrong doc id (e.g. hashing `key` alone) breaks this — the write and the
   * read below use the SAME `(keyKind, key)`, so a miss here would mean the
   * two no longer agree on the id.
   */
  it('a miss resolves to undefined', async () => {
    const result = await resolveChatThreadCase('space_name', 'spaces/AAAA');
    expect(result).toBeUndefined();
  });

  it('reads back the case id and timestamp written by recordChatThreadTip', async () => {
    await recordChatThreadTip('space_name', 'spaces/AAAA', 'case_root', 'case_root');
    const result = await resolveChatThreadCase('space_name', 'spaces/AAAA');
    expect(result?.caseId).toBe('case_root');
    expect(typeof result?.updatedAt).toBe('string');
  });

  /**
   * A DM (`space_name`) and a SPACE (`thread_name`) keyed on the same
   * literal string never share a pointer — the DM write here must not be
   * visible to a `thread_name` read of the same string.
   */
  it('a space_name write is invisible to a thread_name read of the same literal string', async () => {
    await recordChatThreadTip('space_name', 'spaces/AAAA', 'case_dm_root', 'case_dm_root');
    const asThread = await resolveChatThreadCase('thread_name', 'spaces/AAAA');
    expect(asThread).toBeUndefined();
  });

  it('advances the tip on a second write to the same key', async () => {
    await recordChatThreadTip('thread_name', 'spaces/AAAA/threads/T1', 'case_root', 'case_root');
    await recordChatThreadTip('thread_name', 'spaces/AAAA/threads/T1', 'case_root', 'case_followup_1');
    const result = await resolveChatThreadCase('thread_name', 'spaces/AAAA/threads/T1');
    expect(result?.caseId).toBe('case_followup_1');
  });

  it('keeps two different threads in the same space as two independent pointers', async () => {
    await recordChatThreadTip('thread_name', 'spaces/AAAA/threads/T1', 'case_t1', 'case_t1');
    await recordChatThreadTip('thread_name', 'spaces/AAAA/threads/T2', 'case_t2', 'case_t2');

    const t1 = await resolveChatThreadCase('thread_name', 'spaces/AAAA/threads/T1');
    const t2 = await resolveChatThreadCase('thread_name', 'spaces/AAAA/threads/T2');

    expect(t1?.caseId).toBe('case_t1');
    expect(t2?.caseId).toBe('case_t2');
  });

  it('stores continuity_key_kind and continuity_key on the written doc', async () => {
    const keyKind: ChatContinuityKeyKind = 'space_name';
    await recordChatThreadTip(keyKind, 'spaces/AAAA', 'case_root', 'case_root');
    const id = chatThreadLinkId(keyKind, 'spaces/AAAA');
    const raw = linksStore.get(id);
    expect(raw?.continuity_key_kind).toBe('space_name');
    expect(raw?.continuity_key).toBe('spaces/AAAA');
  });

  /**
   * Dual-key tip recording (chat DM explicit-thread-reply fix,
   * case-soft-cliff-lOZ_, Change 2): a DM's route-level `runChatIntake` now
   * records the SAME `(rootCaseId, caseId)` under BOTH a `space_name` key
   * and a `thread_name` key on every turn. At this service layer that is
   * just two independent writes — proven independent above by
   * `chatThreadLinkId` hashing `keyKind` into the digest — but this test
   * proves the pair stays independently readable and consistent (same case
   * ids on both) after both writes land, which is what actually makes a
   * later explicit reply's `thread_name` lookup and the DM's ongoing
   * `space_name` window-continuity lookup agree on the same case. Reverting
   * `chatThreadLinkId` to hash `key` alone (dropping `keyKind` from the
   * digest input, as this file's earlier tests already guard) would make
   * this collide instead of coexist.
   */
  it('keeps a dual-recorded space-keyed and thread-keyed tip for the same case independently readable and consistent', async () => {
    const spaceName = 'spaces/AAAA';
    const threadName = 'spaces/AAAA/threads/T1';
    await recordChatThreadTip('space_name', spaceName, 'case_root', 'case_root');
    await recordChatThreadTip('thread_name', threadName, 'case_root', 'case_root');

    const bySpace = await resolveChatThreadCase('space_name', spaceName);
    const byThread = await resolveChatThreadCase('thread_name', threadName);

    expect(bySpace?.caseId).toBe('case_root');
    expect(byThread?.caseId).toBe('case_root');

    // A later follow-up turn advances both to the SAME new tip.
    await recordChatThreadTip('space_name', spaceName, 'case_root', 'case_followup');
    await recordChatThreadTip('thread_name', threadName, 'case_root', 'case_followup');

    expect((await resolveChatThreadCase('space_name', spaceName))?.caseId).toBe('case_followup');
    expect((await resolveChatThreadCase('thread_name', threadName))?.caseId).toBe('case_followup');
  });
});
