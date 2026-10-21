/**
 * Scheduled jobs (run sweeper, blueprint tick, daily intelligence run) an
 * operator can pause on an environment, for example to stop them from keeping
 * a development deployment scaled up.
 *
 * `ARBITRA_PAUSED_SCHEDULERS` is the single runtime source of truth for which
 * features are currently paused — `GET /api/version` exposes it as
 * `paused_schedulers` so the client can render a warning banner without
 * hardcoding the pause decision anywhere in the frontend. Removing the env var
 * and redeploying makes every banner disappear on its own; nothing else needs
 * to change.
 */
export const PAUSED_SCHEDULER_FEATURES = [
  'run_sweeper',
  'blueprint_tick',
  'intelligence',
] as const;

export type PausedSchedulerFeature = (typeof PAUSED_SCHEDULER_FEATURES)[number];

/**
 * Parses the comma-separated `ARBITRA_PAUSED_SCHEDULERS` env var into a list
 * of paused feature names. Unknown tokens are dropped rather than surfaced —
 * a typo in the env var should silently show no banner, not crash
 * `/api/version`. `undefined`/empty input returns `[]`.
 */
export function parsePausedSchedulers(raw: string | undefined | null): PausedSchedulerFeature[] {
  if (!raw) return [];
  const known = new Set<string>(PAUSED_SCHEDULER_FEATURES);
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token): token is PausedSchedulerFeature => known.has(token));
}
