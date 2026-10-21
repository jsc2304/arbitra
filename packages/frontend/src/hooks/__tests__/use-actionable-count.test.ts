import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Minimal smoke-test harness: replace `useSWR` with a capture stub so we can
// assert that the hook (a) wires the narrow `/cases/actionable-count` API
// call as its fetcher and (b) returns `data.count` unchanged for consumers.

type Fetcher = () => Promise<{ count: number }>;

const { swrCapture } = vi.hoisted(() => ({
  swrCapture: {
    key: null as unknown,
    fetcher: null as Fetcher | null,
    dataToReturn: undefined as { count: number } | undefined,
  },
}));

vi.mock('swr', () => ({
  default: (key: unknown, fetcher: Fetcher) => {
    swrCapture.key = key;
    swrCapture.fetcher = fetcher;
    return { data: swrCapture.dataToReturn };
  },
}));

const { actionableCountMock } = vi.hoisted(() => ({
  actionableCountMock: vi.fn(),
}));

vi.mock('../../lib/api-client', () => ({
  api: {
    cases: {
      actionableCount: actionableCountMock,
    },
  },
}));

import { useActionableCount } from '../use-actionable-count';

beforeEach(() => {
  vi.clearAllMocks();
  swrCapture.key = null;
  swrCapture.fetcher = null;
  swrCapture.dataToReturn = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useActionableCount', () => {
  it('returns 0 while data is loading / undefined', () => {
    swrCapture.dataToReturn = undefined;
    expect(useActionableCount()).toBe(0);
  });

  it('returns data.count unchanged once loaded', () => {
    swrCapture.dataToReturn = { count: 12 };
    expect(useActionableCount()).toBe(12);
  });

  it('returns 0 when server reports zero', () => {
    swrCapture.dataToReturn = { count: 0 };
    expect(useActionableCount()).toBe(0);
  });

  it("wires the narrow '/cases/actionable-count' API call as the SWR fetcher", async () => {
    actionableCountMock.mockResolvedValue({ count: 3 });
    useActionableCount();

    expect(swrCapture.fetcher).toBeTypeOf('function');
    const result = await swrCapture.fetcher!();
    expect(actionableCountMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ count: 3 });
  });

  it('uses a stable cache key so SWR dedupes across mounts', () => {
    useActionableCount();
    // Same tuple each call — SWR keys on structural equality.
    expect(swrCapture.key).toEqual(['cases', 'actionable-count']);
  });
});
