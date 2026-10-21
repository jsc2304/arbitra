/**
 * Retry/backoff policy for failed pipeline runs (generalizes the
 * narrow diff-resolution retry loop in `pipeline.ts`'s `attemptReview` to
 * ANY failed review/rule/build run, whether the failure came from
 * `RunExecutor`'s in-process executor, `ReviewService.runReview`, or the
 * stale-run sweeper (`run-sweep-service.ts`).
 *
 * Consumed by `RunCompletionHandler.handleRunFailure` (pipeline.ts).
 */

/** Max number of RETRIES (not total attempts) allowed for a transient failure before giving up. */
export const MAX_RUN_RETRIES = parseInt(process.env['ARBITRA_MAX_RUN_RETRIES'] ?? '2', 10);

/**
 * Backoff delay per retry, indexed by "how many retries have already
 * happened" (0 = about to schedule the 1st retry → 10s; 1 = about to
 * schedule the 2nd retry → 30s). The array length effectively bounds
 * `MAX_RUN_RETRIES` in practice — both default to 2.
 */
export const RUN_RETRY_BACKOFF_MS: readonly number[] = [10_000, 30_000];

/** Delay before the (`retriesSoFar` + 1)-th retry, clamped to the last configured backoff step. */
export function retryBackoffMs(retriesSoFar: number): number {
  const idx = Math.min(Math.max(retriesSoFar, 0), RUN_RETRY_BACKOFF_MS.length - 1);
  return RUN_RETRY_BACKOFF_MS[idx]!;
}

export type RunFailureClassification = 'transient' | 'permanent';

/**
 * Conservative transient/permanent classification of a run's `error_message`.
 *
 * | Classification | Signal (matched in `error_message`)                                   | Rationale |
 * |----------------|------------------------------------------------------------------------|-----------|
 * | transient      | timeout / timed out                                                    | slow dependency, may succeed on retry |
 * | transient      | `ECONNRESET`/`ECONNREFUSED`/`ETIMEDOUT`/`EAI_AGAIN`/`ENOTFOUND`/`EPIPE` | network-level errors — Node's own codes |
 * | transient      | "network" / "fetch failed" / "socket hang up"                         | generic transport-layer failures |
 * | transient      | HTTP 5xx status codes (`\b5\d\d\b`) or 429                             | server-side / rate-limit — retry is the correct response |
 * | transient      | "rate limit" / "rate-limited"                                         | provider throttling |
 * | transient      | "lease expired" / "lease exceeded" / "orphaned" / "stale run" / "swept by" | sweeper verdict — worker likely just got killed mid-run, not a real bug |
 * | permanent      | everything else (fail-closed default)                                 | validation errors, permission/auth (401/403), malformed diff/input (400/422), "no executor for run type", unknown bugs — retrying would loop on a real defect instead of surfacing it |
 *
 * The default is PERMANENT (no retry) for anything that doesn't match a
 * known transient signature — an unrecognized error is far more likely to be
 * a real bug than a blip, and silently retrying a real bug just delays the
 * `run_retries_exhausted` notification instead of preventing it.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /timed out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/,
  /\bnetwork\b/i,
  /fetch failed/i,
  /socket hang up/i,
  /\b5\d{2}\b/,
  /\b429\b/,
  /rate[- ]?limit/i,
  /lease (expired|exceeded)|orphaned|stale[- ]run|swept by/i,
];

export function classifyRunFailure(errorMessage: string | undefined | null): RunFailureClassification {
  if (!errorMessage) return 'permanent';
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(errorMessage)) ? 'transient' : 'permanent';
}
