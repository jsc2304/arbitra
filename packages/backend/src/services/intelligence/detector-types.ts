import type { ActorMetadata, Case, CaseEvent, Decision, Evidence, Project, Repository } from '@arbitra/shared';

/**
 * Read-only side of the Firestore surface the detectors need. Implementing this
 * as an explicit context object (rather than pulling `collections` directly)
 * keeps detector code testable — unit tests pass a stubbed context without
 * touching firebase-admin.
 */
export interface DetectorContext {
  now: Date;
  /**
   * Yield every non-terminal case the scheduler should consider. "Non-terminal"
   * means `status` ∉ `{'done', 'rejected'}`. Implementations may stream in
   * batches; detectors should not assume a full in-memory list.
   */
  listNonTerminalCases(): AsyncIterable<Case>;
  /** Yield every case, including terminal ones. Used by the high-risk detector. */
  listAllCases(): AsyncIterable<Case>;
  /** Latest event timestamp (ISO) for a case, or undefined when no events exist. */
  getLatestActivityAt(caseId: string): Promise<string | undefined>;
  /** Latest status-transition event's `created_at` for a case (any `*status*` event). */
  getLatestStatusTransitionAt(caseId: string, status: Case['status']): Promise<string | undefined>;
  /** Count of `decision_request_changes` (i.e. `request_changes`) events for a case. */
  countRequestChanges(caseId: string): Promise<number>;
  /** All events for a case (used sparingly — prefer the targeted helpers above). */
  getEventsForCase(caseId: string): Promise<CaseEvent[]>;
  /** Decisions registered on a case. */
  getDecisionsForCase(caseId: string): Promise<Decision[]>;
  /** List all repositories in the workspace. */
  listRepositories(): Promise<Repository[]>;
  /** List all projects (used to resolve owner for `suggested_owner`). */
  listProjects(): Promise<Project[]>;
  /** Existing non-terminal intelligence_signatures. Used for dedup. */
  getExistingSignatures(): Promise<Set<string>>;
  /**
   * Optional Git integration — returns remote branches with their last commit
   * timestamp. Resolves `undefined` when no integration is configured for the
   * repo (orphan-branch detector skips silently in that case).
   */
  listRemoteBranches?: (
    repo: Repository,
  ) => Promise<{ name: string; last_commit_at: string }[] | undefined>;
}

export interface DetectionResult {
  detector_id: string;
  /**
   * Stable dedup key. Hash input is `{detector_id}:{target_kind}:{target_id}`
   * — a signature collision means "same detector complaining about the same
   * target", which is exactly what we want to dedup on.
   */
  signature: string;
  target_kind: 'case' | 'branch' | 'project';
  target_id: string;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  severity: 'low' | 'medium';
  project_id: string;
  repository_id?: string;
  suggested_owner?: string;
}

export interface Detector {
  id: string;
  /**
   * Human-readable label surfaced in the admin observatory (PR 5). Optional
   * so legacy detectors without metadata don't fail the build; the admin
   * route falls back to `id` when absent.
   */
  name?: string;
  /** One-line description of what the detector watches for. */
  description?: string;
  run(ctx: DetectorContext): Promise<DetectionResult[]>;
}

export interface DetectorRunSummary {
  detector: string;
  /**
   * Count of "things written" by this detector in the run. Semantically
   * rename-in-place since Phase 1 of the intelligence refactor: detectors no
   * longer create autonomous cases — case-targeted detections write
   * `intelligence_flags` on the target case, branch/project-targeted
   * detections emit a `workspace_event` nudge. The field name is kept for
   * API/back-compat with the legacy `/api/intelligence/run` response shape.
   */
  cases_created: number;
  cases_skipped_existing: number;
  duration_ms: number;
  error?: string;
}

export function buildSignature(
  detectorId: string,
  targetKind: DetectionResult['target_kind'],
  targetId: string,
): string {
  return `${detectorId}:${targetKind}:${targetId}`;
}

/**
 * Actor metadata attached to every record (comment, event, evidence) the
 * intelligence scheduler writes. `client_version` reflects the backend
 * package version so audit trails can distinguish detector generations.
 */
export function intelligenceActorMetadata(clientVersion: string): ActorMetadata {
  return {
    client_name: 'arbitra-intelligence',
    client_version: clientVersion,
  };
}

/** Convenience alias — most helpers accept either a Decision or Evidence row. */
export type AuditRow = Evidence | Decision;
