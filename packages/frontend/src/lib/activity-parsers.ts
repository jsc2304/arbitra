/**
 * Shared parsers for intelligence_run activity-feed summaries.
 *
 * The activity envelope doesn't carry the structured run payload; the figures
 * are recovered from the row summary which the backend formats deterministically
 * as:
 *   "Ran N detectors — N new nudges, N deduped, N errors (duration Nms)"
 * (see `intelligence-service.ts → emitRunWorkspaceEvent`).
 *
 * Both <HeartbeatTile> (#562) and <AnomaliesCard> (#566) parse this string
 * client-side. The regex + `parseRunErrors` previously lived duplicated in both
 * components; this module is the single source of truth. When the step 7
 * envelope work lands a structured `errors` field on workspace-event payloads,
 * this is the one place to swap the parser.
 */

/** Counters recovered from a single intelligence_run row summary. */
export interface ParsedRun {
  detectors: number;
  newNudges: number;
  deduped: number;
  errors: number;
  durationMs: number;
}

export const RUN_SUMMARY_RE =
  /Ran\s+(\d+)\s+detectors?\s+—\s+(\d+)\s+new\s+nudges?,\s+(\d+)\s+deduped,\s+(\d+)\s+errors?\s+\(duration\s+(\d+)ms\)/i;

/**
 * Parse the full set of run counters from a summary string. Returns `null` when
 * the summary isn't an intelligence_run row (so callers can skip non-run rows).
 */
export function parseRunSummary(summary: string): ParsedRun | null {
  const m = RUN_SUMMARY_RE.exec(summary);
  if (!m) return null;
  return {
    detectors: Number(m[1]),
    newNudges: Number(m[2]),
    deduped: Number(m[3]),
    errors: Number(m[4]),
    durationMs: Number(m[5]),
  };
}

/**
 * Parse just the detector-error count from a run summary. Returns `null` when
 * the summary isn't an intelligence_run row.
 */
export function parseRunErrors(summary: string): number | null {
  const m = RUN_SUMMARY_RE.exec(summary);
  if (!m) return null;
  return Number(m[4]);
}
