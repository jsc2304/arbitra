import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DetectorConfigMap } from '@arbitra/shared';

const store = {
  doc: undefined as DetectorConfigMap | undefined,
};

function reset() {
  store.doc = undefined;
}

vi.mock('../../../lib/firestore.js', () => ({
  collections: {
    intelligenceConfig: () => ({
      doc: (_id: string) => ({
        get: async () => ({
          exists: store.doc !== undefined,
          data: () => store.doc,
        }),
        set: async (
          partial: DetectorConfigMap,
          options?: { merge?: boolean },
        ) => {
          if (options?.merge && store.doc) {
            store.doc = { ...store.doc, ...partial };
          } else {
            store.doc = { ...partial };
          }
        },
      }),
    }),
  },
}));

import { DetectorConfigRepository } from '../detector-config-repository.js';

describe('DetectorConfigRepository', () => {
  beforeEach(() => {
    reset();
  });

  it('getAll() returns an empty map when the doc does not exist', async () => {
    const repo = new DetectorConfigRepository();
    const map = await repo.getAll();
    expect(map).toEqual({});
  });

  it('setEnabled() creates the doc on first write and stamps updated_at/updated_by', async () => {
    const repo = new DetectorConfigRepository();
    const before = new Date().toISOString();
    const entry = await repo.setEnabled('aging-pending-merge', false, 'usr_admin');
    const after = new Date().toISOString();

    expect(entry.enabled).toBe(false);
    expect(entry.updated_by).toBe('usr_admin');
    expect(entry.updated_at).toBeDefined();
    expect(entry.updated_at! >= before).toBe(true);
    expect(entry.updated_at! <= after).toBe(true);

    const map = await repo.getAll();
    expect(map['aging-pending-merge']!.enabled).toBe(false);
  });

  it('setEnabled() merges — toggling one detector does not clobber another', async () => {
    const repo = new DetectorConfigRepository();
    await repo.setEnabled('det-a', false, 'usr_1');
    await repo.setEnabled('det-b', true, 'usr_2');

    const map = await repo.getAll();
    expect(map['det-a']!.enabled).toBe(false);
    expect(map['det-a']!.updated_by).toBe('usr_1');
    expect(map['det-b']!.enabled).toBe(true);
    expect(map['det-b']!.updated_by).toBe('usr_2');
  });

  it('setEnabled() can flip an existing entry without dropping the other entries', async () => {
    const repo = new DetectorConfigRepository();
    await repo.setEnabled('det-a', false, 'usr_1');
    await repo.setEnabled('det-b', false, 'usr_1');
    await repo.setEnabled('det-a', true, 'usr_admin');

    const map = await repo.getAll();
    expect(map['det-a']!.enabled).toBe(true);
    expect(map['det-a']!.updated_by).toBe('usr_admin');
    // det-b is untouched by the flip on det-a.
    expect(map['det-b']!.enabled).toBe(false);
  });

  it('getAll() returns a partial map — detectors without entries are absent, callers default to enabled', async () => {
    const repo = new DetectorConfigRepository();
    await repo.setEnabled('det-a', false, 'usr_1');
    const map = await repo.getAll();
    expect(Object.keys(map)).toEqual(['det-a']);
    // 'det-unknown' is NOT in the map — callers interpret that as enabled=true.
    expect(map['det-unknown']).toBeUndefined();
  });
});
