import { describe, it, expect, vi, beforeEach } from 'vitest';

interface StoredDoc {
  data: Record<string, unknown>;
}

const store = new Map<string, StoredDoc>();
const userDocs = new Map<string, Record<string, unknown>>();

function makeDocRef(collectionName: string, id: string) {
  const key = `${collectionName}/${id}`;
  return {
    async get() {
      if (collectionName === 'users') {
        if (!userDocs.has(id)) return { exists: false, data: () => undefined };
        return { exists: true, data: () => userDocs.get(id) };
      }
      const existing = store.get(key);
      if (!existing) return { exists: false, data: () => undefined };
      return { exists: true, data: () => existing.data };
    },
    async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
      const prev = store.get(key)?.data ?? {};
      const merged = options?.merge ? { ...prev, ...data } : data;
      store.set(key, { data: merged });
    },
  };
}

vi.mock('../../../lib/firestore.js', () => ({
  collections: {
    agentPresence: () => ({
      doc: (id: string) => makeDocRef('agent_presence', id),
    }),
    users: () => ({
      doc: (id: string) => makeDocRef('users', id),
    }),
  },
}));

import {
  upsertPresence,
  presenceDocId,
  __resetActorDisplayCache,
} from '../agent-presence-service.js';

beforeEach(() => {
  store.clear();
  userDocs.clear();
  __resetActorDisplayCache();
});

describe('upsertPresence', () => {
  it('creates a new presence row with first_seen_at and last_seen_at on first contact', async () => {
    userDocs.set('usr_1', { user_id: 'usr_1', display_name: 'Agent One', email: 'a1@x' });

    await upsertPresence({ caseId: 'case_1', userId: 'usr_1' });

    const stored = store.get(`agent_presence/${presenceDocId('case_1', 'usr_1')}`);
    expect(stored).toBeDefined();
    const data = stored!.data;
    expect(data.case_id).toBe('case_1');
    expect(data.actor_user_id).toBe('usr_1');
    expect(data.actor_display).toBe('Agent One');
    expect(data.source).toBe('ide_agent');
    expect(typeof data.first_seen_at).toBe('string');
    expect(data.first_seen_at).toBe(data.last_seen_at);
    expect(data.presence_id).toBe(presenceDocId('case_1', 'usr_1'));
  });

  it('preserves first_seen_at and advances last_seen_at on subsequent heartbeats', async () => {
    userDocs.set('usr_1', { user_id: 'usr_1', display_name: 'Agent One', email: 'a1@x' });

    await upsertPresence({ caseId: 'case_1', userId: 'usr_1' });
    const firstSeen = store.get(`agent_presence/${presenceDocId('case_1', 'usr_1')}`)!.data.first_seen_at;

    // Advance wall clock then heartbeat again.
    await new Promise((r) => setTimeout(r, 5));
    await upsertPresence({ caseId: 'case_1', userId: 'usr_1' });

    const stored = store.get(`agent_presence/${presenceDocId('case_1', 'usr_1')}`)!.data;
    expect(stored.first_seen_at).toBe(firstSeen);
    expect(new Date(stored.last_seen_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(firstSeen as string).getTime(),
    );
  });

  it('falls back to email then userId when display_name is missing', async () => {
    userDocs.set('usr_2', { user_id: 'usr_2', email: 'agent@example.com' });
    await upsertPresence({ caseId: 'case_1', userId: 'usr_2' });
    expect(store.get(`agent_presence/${presenceDocId('case_1', 'usr_2')}`)!.data.actor_display).toBe(
      'agent@example.com',
    );

    await upsertPresence({ caseId: 'case_2', userId: 'usr_unknown' });
    expect(store.get(`agent_presence/${presenceDocId('case_2', 'usr_unknown')}`)!.data.actor_display).toBe(
      'usr_unknown',
    );
  });

  it('honors the source override', async () => {
    userDocs.set('usr_3', { display_name: 'Web User' });
    await upsertPresence({ caseId: 'case_x', userId: 'usr_3', source: 'web' });
    expect(store.get(`agent_presence/${presenceDocId('case_x', 'usr_3')}`)!.data.source).toBe('web');
  });

  it('is a no-op when caseId or userId is empty', async () => {
    await upsertPresence({ caseId: '', userId: 'u' });
    await upsertPresence({ caseId: 'c', userId: '' });
    expect(store.size).toBe(0);
  });
});
