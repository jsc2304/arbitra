'use client';

import { useEffect, useState } from 'react';
import type { User } from '@arbitra/shared';
import { api } from '../lib/api-client';
import { useOptionalToast } from '../providers/toast-provider';

type UserMap = Record<string, User>;

// Module-level cache shared across all hook instances
const cache: UserMap = {};

// Module-level cache for the current user. The `/api/users` batch endpoint
// can omit the requesting user's profile (e.g. when their Firestore doc is
// missing), which would cause `actorDisplayName` to fall back to the literal
// "User" label on history pills. Fetching `/api/users/me` once at module
// scope and merging into the cache provides a reliable fallback without
// touching the backend.
let meCache: User | null = null;
let meFetchPromise: Promise<User | null> | null = null;

// Fires the "couldn't load user names" toast at most once per browser session
// so a flaky `/api/users` doesn't spam the user across multiple page loads.
let userMapToastFired = false;

const RETRY_DELAYS_MS = [250, 1000, 4000] as const;

/**
 * Batch-fetches users with bounded exponential backoff. Replaces the prior
 * silent `.catch(() => {})` so a transient `/api/users` failure no longer
 * leaves the UI rendering raw ids forever.
 *
 * Resolves to the list of fetched users on success, or `null` on definitive
 * failure after all retries are exhausted (caller surfaces the user-facing
 * toast; we deliberately don't toast from inside this helper to keep it
 * pure / testable).
 */
async function fetchUsersWithRetry(missing: string[]): Promise<User[] | null> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const { users } = await api.users.batch(missing);
      return users;
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) {
        // Final attempt failed — surface to console for support / debug,
        // then let the caller decide on UI fallback.
        // eslint-disable-next-line no-console
        console.warn('[useUserMap] /api/users batch failed after retries', err);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]!));
    }
  }
  return null;
}

async function ensureMeFetched(): Promise<User | null> {
  if (meCache) return meCache;
  if (meFetchPromise) return meFetchPromise;
  meFetchPromise = api.users
    .me()
    .then((u) => {
      meCache = u;
      cache[u.user_id] = u;
      return u;
    })
    .catch(() => {
      // /me is best-effort — UserDisplay falls back to the SystemActor /
      // UnknownUser pill for ids it can't resolve, so a missing /me does
      // not leak raw ids.
      return null;
    })
    .finally(() => {
      meFetchPromise = null;
    }) as Promise<User | null>;
  return meFetchPromise;
}

export function useUserMap(userIds: string[]): UserMap {
  const toastCtx = useOptionalToast();
  const addToast = toastCtx?.addToast;

  const [users, setUsers] = useState<UserMap>(() => {
    const hit: UserMap = {};
    for (const id of userIds) {
      if (cache[id]) hit[id] = cache[id];
    }
    return hit;
  });

  const idsKey = [...new Set(userIds)].sort().join(',');

  // Keyed on `idsKey` only, so a new `userIds` array with the same ids does not
  // refetch. No "already ran" ref guard: under React Strict Mode the first run
  // is cancelled and the second must still deliver the result.
  useEffect(() => {
    const uniqueIds = idsKey ? idsKey.split(',') : [];
    const missing = uniqueIds.filter((id) => !cache[id]);

    let cancelled = false;

    const buildResult = (): UserMap => {
      const result: UserMap = {};
      for (const id of uniqueIds) {
        if (cache[id]) result[id] = cache[id];
      }
      return result;
    };

    if (missing.length === 0) {
      setUsers(buildResult());
      // Still ensure `me` is fetched once so subsequent renders that include
      // the current user's id can resolve them even if the batch endpoint
      // never returned them.
      ensureMeFetched().then((me) => {
        if (cancelled || !me) return;
        if (uniqueIds.includes(me.user_id)) setUsers(buildResult());
      });
      return () => { cancelled = true; };
    }

    Promise.all([
      fetchUsersWithRetry(missing).then((fetched) => {
        if (fetched === null) {
          if (!cancelled && !userMapToastFired && addToast) {
            userMapToastFired = true;
            addToast(
              'error',
              "Couldn't load user names",
              'Refresh the page to retry.',
            );
          }
          return;
        }
        for (const u of fetched) cache[u.user_id] = u;
      }),
      ensureMeFetched(),
    ]).then(() => {
      if (cancelled) return;
      setUsers(buildResult());
    });

    return () => { cancelled = true; };
  }, [idsKey, addToast]);

  return users;
}
