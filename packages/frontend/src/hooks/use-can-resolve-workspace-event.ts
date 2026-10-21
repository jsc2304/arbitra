'use client';

import useSWR from 'swr';
import { api } from '../lib/api-client';

/**
 * Can the current viewer globally resolve a workspace event?
 *
 * Returns `canResolve: true` only once `/users/me` has resolved and the user
 * carries either the `admin` or `tech_lead` role. `isLoading` stays `true`
 * until the SWR call settles; callers must gate on that to avoid a one-frame
 * flash of the resolve button for privileged users (or, worse, its absence).
 *
 * Patterned on `use-is-admin.ts` — shares the `users/me` SWR key so we don't
 * double-fetch the current user when both hooks mount on the same page.
 */
export function useCanResolveWorkspaceEvent(): { canResolve: boolean; isLoading: boolean } {
  const { data, isLoading } = useSWR('users/me', () => api.users.me(), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  const roles = data?.roles ?? [];
  return {
    canResolve: roles.includes('admin') || roles.includes('tech_lead'),
    isLoading,
  };
}
