'use client';

import useSWR from 'swr';
import { api } from '../lib/api-client';

/**
 * Hook returning the current user's admin status plus a loading flag.
 *
 * `isAdmin` is a definitive boolean: `true` only once the `/users/me` call
 * has resolved and the user carries the `admin` role. `isLoading` is `true`
 * until the first SWR response settles. Callers that gate UI on admin
 * access must check `isLoading` before rendering a denial, otherwise
 * admins will see a brief flash of the "access required" card on each
 * page load while SWR is still fetching.
 */
export function useIsAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const { data, isLoading } = useSWR('users/me', () => api.users.me(), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return {
    isAdmin: data?.roles?.includes('admin') ?? false,
    isLoading,
  };
}
