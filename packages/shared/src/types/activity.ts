import type { ActorMetadata } from './actor-metadata.js';

/**
 * The source kinds the activity feed unifies.
 *
 * `workspace_event` is a system-level event NOT scoped to any case (e.g. a
 * scheduled intelligence run). Rows of this kind carry an empty `case_id` and
 * renderers must NOT try to build a case link for them.
 */
export type ActivityKind =
  | 'case_event'
  | 'comment'
  | 'evidence'
  | 'finding'
  | 'decision'
  | 'workspace_event';

/**
 * Per-row severity used by the Signal filter and the row dot.
 * Mirrors `FindingSeverity` for findings; computed deterministically per
 * kind/verb for everything else (see `packages/shared/src/utils/activity-envelope.ts`).
 */
export type ActivitySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Coarse classification of the actor that produced an activity row.
 *
 * - `human`   — a real user (default when no system / agent signal is found)
 * - `agent`   — an IDE agent (Cursor, Claude Code, etc.) — `actor_metadata.client_name` set
 * - `system`  — Arbitra itself (scheduler, detectors, webhooks)
 */
export type ActivityActorKind = 'human' | 'agent' | 'system';

/**
 * Authoritative agent identifier when `actor.kind` is `agent` or `system`.
 * `null` means the row is human-authored or the system actor is not one of the
 * canonical Arbitra subsystems. Closed enum so the Signal filter rules can match
 * exact values; downstream UI can map to display labels.
 */
export type ActivityActorAgent =
  | 'cursor'
  | 'claude-code'
  | 'code-intelligence'
  | 'arbitra'
  | null;

/**
 * How the underlying object was opened. Used to route case_created
 * rows to "Arbitra flagged …" copy when `detector`. Replaces the frontend's
 * `isDetectorActor` heuristic in `lib/actor-display.ts` (deprecation deferred
 * to a follow-up step).
 */
export type ActivityOpenedBy = 'user' | 'detector' | 'webhook';

/**
 * Normalized entry rendered in the workspace-wide activity feed. Merges rows
 * from five Firestore collections (case_events, comments, evidence, findings,
 * decisions) into a single time-ordered stream with a stable shape.
 *
 * `id` is stable per source row (e.g. `"evidence:<evidence_id>"`) so SWR
 * delta-fetching can prepend new entries without duplicating existing ones.
 */
export interface ActivityEntry {
  /** Stable id, namespaced by kind, e.g. `"evidence:ev_123"` / `"event:evt_456"`. */
  id: string;
  kind: ActivityKind;
  /** Finer-grained classifier within a kind (e.g. `event.type`, `decision.type`). */
  subkind?: string;
  /** ISO timestamp — row is sorted desc by this. */
  timestamp: string;
  /**
   * Owning case ID. Empty string for `kind: 'workspace_event'` — workspace
   * events are not case-scoped. Renderers must check for empty before linking.
   */
  case_id: string;
  case_title?: string;
  project_id?: string;
  /** Denormalized project display name (so rows can render + link without a second round-trip). */
  project_name?: string;
  actor_user_id?: string;
  /** Authoritative IDE-agent / model signature when the action came via an MCP client. */
  actor_metadata?: ActorMetadata;
  /** Source-entity IDs — surfaced so rows can deep-link to the specific finding/evidence/etc. */
  finding_id?: string;
  evidence_id?: string;
  comment_id?: string;
  decision_id?: string;
  /** Short display line ("registered build result", "approved case"). */
  summary: string;
  /** Deep link to the case + relevant tab/section. */
  href: string;

  // ---------------------------------------------------------------------------
  // Envelope additions.
  // Computed server-side at read time in `activity-service.ts` from per-source
  // helpers in `packages/shared/src/utils/activity-envelope.ts`.
  // All fields are optional on the type so existing fixtures and clients that
  // haven't picked up the wider envelope yet continue to compile.
  // ---------------------------------------------------------------------------

  /** Per-row severity. Drives the row dot and the Signal `severity >= medium` rule. */
  severity?: ActivitySeverity;
  /** Server-computed Signal flag — `true` when the row appears in Signal mode. */
  signal?: boolean;
  /** Coarse actor kind. */
  actor_kind?: ActivityActorKind;
  /** Canonical agent identifier when known. `null` for plain humans. */
  actor_agent?: ActivityActorAgent;
  /** How the row's underlying object was opened (drives detector routing). */
  opened_by?: ActivityOpenedBy;
  /** Bucket key for grouping (`case:<id>:<10minBucket>` or `kind:<verb>:<actor>`). */
  group_key?: string;
  /** First 140 chars of comment body / finding summary; absent on rows without a body. */
  preview?: string;
}

/**
 * Shared activity counters reused by source-level and project-level rollups.
 */
export interface ActivityLeaderboardCounts {
  cases_created: number;
  comments: number;
  evidence: number;
  findings: number;
  decisions: number;
  /**
   * Workspace-level events attributed to this actor (e.g. scheduled
   * intelligence runs). Counts toward `total` so noisy system actors don't
   * silently understate their footprint.
   */
  workspace_events: number;
  total: number;
}

/**
 * High-level attribution class for a leaderboard source row.
 *
 * `client` means the action carried authoritative client metadata (e.g.
 * Cursor, Claude Code). The other values are fallback buckets used when no
 * client signature was present on the source row.
 */
export type ActivityLeaderboardSourceKind =
  | 'client'
  | 'human'
  | 'automated'
  | 'webhook'
  | 'system';

/**
 * Per-source leaderboard row. Unique key is `client_name + client_version + model`.
 * Fallback buckets (`human`, `automated`, `webhook`, `system`) reuse the
 * `client_name` field as a stable synthetic key for backwards compatibility.
 */
export interface ActivityLeaderboardRow {
  source_kind: ActivityLeaderboardSourceKind;
  client_name: string;
  client_version?: string;
  model?: string;
  counts: ActivityLeaderboardCounts;
}

/**
 * Project-level leaderboard row for the `/activity` overview. Only case-scoped
 * actions count here; workspace events are excluded because they do not belong
 * to a project. `active_cases` is the distinct case count touched in-window.
 */
export interface ActivityProjectLeaderboardRow {
  project_id: string;
  project_name?: string;
  active_cases: number;
  counts: ActivityLeaderboardCounts;
}

export type ActivityLeaderboardWindow = '24h' | '7d' | '30d';
