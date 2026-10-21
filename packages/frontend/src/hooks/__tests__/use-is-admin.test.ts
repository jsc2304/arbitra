/**
 * @file use-is-admin — smoke tests for the admin-role hook.
 *
 * The hook wraps a SWR call to `/users/me`. We stub SWR to control
 * `isLoading` and `data`, then assert the hook's `{ isAdmin, isLoading }`
 * contract. The loading flag is the important one — callers use it to
 * avoid flashing an "access required" denial while `/users/me` is in
 * flight.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

type SwrState = {
  data?: { roles?: string[] } | undefined;
  isLoading: boolean;
};

const { swrState } = vi.hoisted(() => ({
  swrState: { isLoading: false, data: undefined } as SwrState,
}));

vi.mock('swr', () => ({
  default: () => swrState,
}));

vi.mock('../../lib/api-client', () => ({
  api: {
    users: {
      me: vi.fn(),
    },
  },
}));

import { useIsAdmin } from '../use-is-admin';

beforeEach(() => {
  swrState.data = undefined;
  swrState.isLoading = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useIsAdmin', () => {
  it('returns { isAdmin: false, isLoading: true } while SWR is fetching', () => {
    swrState.isLoading = true;
    swrState.data = undefined;
    expect(useIsAdmin()).toEqual({ isAdmin: false, isLoading: true });
  });

  it('returns { isAdmin: false, isLoading: false } once a non-admin loads', () => {
    swrState.isLoading = false;
    swrState.data = { roles: ['user'] };
    expect(useIsAdmin()).toEqual({ isAdmin: false, isLoading: false });
  });

  it('returns { isAdmin: true, isLoading: false } for an admin user', () => {
    swrState.isLoading = false;
    swrState.data = { roles: ['user', 'admin'] };
    expect(useIsAdmin()).toEqual({ isAdmin: true, isLoading: false });
  });

  it('treats a missing roles array as non-admin (defensive default)', () => {
    swrState.isLoading = false;
    swrState.data = {};
    expect(useIsAdmin()).toEqual({ isAdmin: false, isLoading: false });
  });
});
