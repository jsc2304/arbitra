/**
 * Deployment-environment detection for the env badge beside the sidebar logo.
 *
 * Rule (no deployment-specific hostnames are baked in):
 *   - localhost / 127.* / ::1                     → `local`
 *   - otherwise `NEXT_PUBLIC_ARBITRA_ENV` (`prod` | `dev`, inlined into the
 *     client bundle at build time)                → that value
 *   - anything else                               → null (render no badge
 *     rather than guess)
 *
 * Operators who want a PROD/DEV badge on a hosted instance set
 * `NEXT_PUBLIC_ARBITRA_ENV` as a build arg; without it only local runs show a
 * badge.
 *
 * Keyed off `window.location.hostname` by the consumer; pure function here so
 * all branches are unit-testable without a DOM. The configured value is a
 * parameter (defaulting to the build-time env) for the same reason.
 */

export type AppEnvironment = 'prod' | 'dev' | 'local';

/**
 * Resolve the deployment environment from a hostname plus the build-time
 * `NEXT_PUBLIC_ARBITRA_ENV` setting. Returns `null` when neither identifies
 * an environment — callers should render nothing rather than show a wrong
 * badge.
 */
export function detectEnvironment(
  hostname: string,
  configured: string | undefined = process.env.NEXT_PUBLIC_ARBITRA_ENV,
): AppEnvironment | null {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.')
  ) {
    return 'local';
  }
  const value = configured?.trim().toLowerCase();
  if (value === 'prod' || value === 'dev') return value;
  return null;
}

/**
 * Badge label + colour classes per environment, consumed by
 * `components/layout/environment-badge.tsx` via the shared `<Badge>`
 * primitive (`colorClassName` slot, soft tone = translucent fill + inset
 * ring — see badge.tsx / #658).
 *
 * Intent: DEV pops (amber/warning), LOCAL is distinct but calm (violet),
 * PROD stays quiet (neutral gray) — the badge exists so you notice when you
 * are NOT on prod. Orange (`accent`/`corp-orange`) is deliberately avoided:
 * the single interactive accent stays reserved for interactive affordances.
 * Light + dark pairs follow the `lib/badge-colors.ts` convention.
 */
export const ENVIRONMENT_BADGE: Record<
  AppEnvironment,
  { label: string; colorClassName: string }
> = {
  dev: {
    label: 'DEV',
    colorClassName:
      'bg-amber-100 text-amber-800 ring-amber-400/60 dark:bg-amber-950/60 dark:text-amber-400 dark:ring-amber-500/40',
  },
  local: {
    label: 'LOCAL',
    colorClassName:
      'bg-violet-100 text-violet-800 ring-violet-400/60 dark:bg-violet-950/60 dark:text-violet-400 dark:ring-violet-500/40',
  },
  prod: {
    label: 'PROD',
    colorClassName:
      'bg-gray-100 text-gray-600 ring-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700',
  },
};
