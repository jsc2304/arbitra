/**
 * Types for Arbitra Intelligence run history + per-detector enable flags.
 *
 * These live in `shared` because they cross the backend/frontend boundary:
 * the admin observatory (landing in PR 5) reads `IntelligenceRun` records and
 * `DetectorConfig` state through the typed API client.
 *
 * Note: this file introduces a NEW `DetectorRunSummary` shape
 * (`detector_id`, `enabled`, `finding_count`, `duration_ms`, `error?`) used
 * exclusively by persisted `IntelligenceRun` rows. The pre-existing internal
 * summary shape in `packages/backend/src/services/intelligence/detector-types.ts`
 * (`detector`, `cases_created`, `cases_skipped_existing`, ...) continues to
 * feed the `workspace_event` emit for back-compat.
 */

export type IntelligenceRunTrigger = 'scheduler' | 'manual';

export interface DetectorRunSummary {
  detector_id: string;
  enabled: boolean;
  finding_count: number;
  duration_ms: number;
  error?: string;
}

export interface IntelligenceRun {
  run_id: string;
  started_at: string; // ISO-8601
  finished_at: string; // ISO-8601
  duration_ms: number;
  trigger: IntelligenceRunTrigger;
  triggered_by?: string; // user_id when trigger === 'manual'
  detector_count: number;
  findings_total: number;
  summaries: DetectorRunSummary[];
  error?: string;
}

export interface DetectorConfig {
  enabled: boolean; // default true if absent
  updated_at?: string;
  updated_by?: string;
}

export type DetectorConfigMap = Record<string, DetectorConfig>;
