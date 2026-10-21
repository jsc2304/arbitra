import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeAssets: Array<{ title: string; body: string }> = [];

vi.mock('../../../lib/firestore.js', () => ({
  collections: {
    knowledgeAssets: () => ({
      get: vi.fn(async () => ({
        docs: fakeAssets.map((a) => ({ data: () => a })),
      })),
    }),
  },
}));

import { loadKnowledgeAssets, __resetKnowledgeCache } from '../knowledge-loader.js';

beforeEach(() => {
  fakeAssets.length = 0;
  __resetKnowledgeCache();
  vi.useRealTimers();
});

describe('loadKnowledgeAssets', () => {
  it('formats each asset as `## Knowledge: <title>` joined by blank line', async () => {
    fakeAssets.push({ title: 'A', body: 'body-a' });
    fakeAssets.push({ title: 'B', body: 'body-b' });

    const out = await loadKnowledgeAssets();
    expect(out).toBe('## Knowledge: A\n\nbody-a\n\n## Knowledge: B\n\nbody-b');
  });

  it('caches results within the 60s TTL window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    fakeAssets.push({ title: 'first', body: 'one' });
    const first = await loadKnowledgeAssets();
    expect(first).toContain('first');

    fakeAssets.length = 0;
    fakeAssets.push({ title: 'second', body: 'two' });

    // 30s later — still cached.
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    const cached = await loadKnowledgeAssets();
    expect(cached).toBe(first);
    expect(cached).toContain('first');

    // 61s later — cache expired, re-fetch.
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    const fresh = await loadKnowledgeAssets();
    expect(fresh).toContain('second');
    expect(fresh).not.toContain('first');
  });

  it('returns empty string when no assets exist', async () => {
    const out = await loadKnowledgeAssets();
    expect(out).toBe('');
  });
});
