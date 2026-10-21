'use client';

import useSWR from 'swr';
import type { PausedSchedulerFeature } from '@arbitra/shared';

/**
 * SWR key for `/api/version`, shared with `AppFooter`'s eventual client
 * fetch and any other consumer of build metadata — keeping this string in
 * one place is what makes concurrent callers dedupe onto a single request
 * instead of each firing its own `fetch('/api/version')`.
 */
export const VERSION_SWR_KEY = '/api/version';

interface VersionResponse {
  paused_schedulers?: PausedSchedulerFeature[];
}

async function fetchVersion(url: string): Promise<VersionResponse> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Reads which Cloud Scheduler-backed features are currently paused
 * (`ARBITRA_PAUSED_SCHEDULERS`, see `packages/shared/src/utils/paused-schedulers.ts`
 * and `docs/deployment.md`) via the public, unauthenticated `/api/version`
 * route. When the env var is unset, the array is always
 * empty and `isPaused` returns `false` for every feature.
 *
 * `/api/version` is public and unauthenticated (see that route's own doc
 * comment), so this fetches it directly rather than through
 * `lib/api-client.ts`'s `fetchApi`, which attaches an auth header this route
 * neither needs nor checks.
 */
export function usePausedSchedulers(): { isPaused: (feature: PausedSchedulerFeature) => boolean } {
  const { data } = useSWR(VERSION_SWR_KEY, fetchVersion, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });

  const paused = data?.paused_schedulers ?? [];

  return {
    isPaused: (feature: PausedSchedulerFeature) => paused.includes(feature),
  };
}
