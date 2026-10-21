'use client';

import useSWR from 'swr';
import type { UserRole } from '@arbitra/shared';
import { api } from '../lib/api-client';

export function useUserRoles(): UserRole[] {
  const { data } = useSWR('users/me', () => api.users.me(), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return data?.roles ?? [];
}

export function hasRole(roles: UserRole[], role: UserRole): boolean {
  return roles.includes(role);
}
