import { NextResponse } from 'next/server';
import {
  ARBITRA_BUILD,
  ARBITRA_STAGE,
  ARBITRA_SPEC_VERSION,
  ARBITRA_API_VERSION,
  parsePausedSchedulers,
} from '@arbitra/shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/version — public, unauthenticated build/stage metadata.
 *
 * Source of truth for `build`, `stage`, `spec`, `api` is
 * `packages/shared/src/version.ts`. `commit` and `deployed_at` are injected
 * at deploy time via `BUILD_COMMIT_SHA` and `BUILD_DEPLOYED_AT` env vars.
 *
 * `paused_schedulers` reflects `ARBITRA_PAUSED_SCHEDULERS` (set at
 * deploy time — see `packages/shared/src/utils/paused-schedulers.ts`
 * and `docs/deployment.md`). The frontend's "Paused on this instance"
 * banners (`components/shared/scheduler-paused-banner.tsx`) key off this
 * array via `hooks/use-paused-schedulers.ts` — an empty array (unset env
 * var) renders no banners.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    build: ARBITRA_BUILD,
    stage: ARBITRA_STAGE,
    spec: ARBITRA_SPEC_VERSION,
    api: ARBITRA_API_VERSION,
    commit: process.env.BUILD_COMMIT_SHA ?? 'unknown',
    deployed_at: process.env.BUILD_DEPLOYED_AT ?? null,
    paused_schedulers: parsePausedSchedulers(process.env.ARBITRA_PAUSED_SCHEDULERS),
  });
}
