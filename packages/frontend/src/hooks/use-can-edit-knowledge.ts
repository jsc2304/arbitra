'use client';

import useSWR from 'swr';
import { api } from '../lib/api-client';

/**
 * Returns true if the current user is tech_lead or admin — the two roles
 * permitted to create, edit, or delete knowledge assets.
 *
 * Backend enforces the same check at the API + service layer; this hook is
 * purely for hiding UI affordances.
 */
export function useCanEditKnowledge(): boolean {
  const { data } = useSWR('users/me', () => api.users.me(), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  const roles = data?.roles ?? [];
  return roles.includes('tech_lead') || roles.includes('admin');
}
