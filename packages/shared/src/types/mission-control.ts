/**
 * Mission Control — the landing-page read aggregate answering "what is
 * running right now" (issue #989 / ADR-0001). Computed on read by joining
 * the session registry (`ActiveSessionSummary`) with repository → project
 * and branch → case, in the style of the Observatory aggregate. No
 * separate storage layer.
 */

import type { CaseStatus, CaseType } from './case.js';

/** The case bound to a session's (repository, branch), when one exists. */
export interface MissionControlCaseSummary {
  case_id: string;
  title: string;
  status: CaseStatus;
  /**
   * Threaded through so the session-list row can render the same honest
   * status label an Observed Case gets on its own detail page (e.g.
   * "Observing" instead of "Building") rather than forking `StatusBadge`
   * per surface — issue #1018. Optional to mirror `Case.case_type` itself
   * (cases predating the field have none — treated as the engineering
   * default, same as everywhere else `case_type` is threaded).
   */
  case_type?: CaseType;
}

/** One active session, joined with its repository/project and case. */
export interface MissionControlSessionRow {
  session_id: string;
  agent_name: string;
  repository_id: string;
  repository_name: string;
  project_id: string;
  project_name: string;
  branch: string;
  /** `null` when the branch has no case bound yet ("no case yet"). */
  case: MissionControlCaseSummary | null;
  last_seen_at: string;
}

/**
 * Row cap for the live session list (issue #1003): a pathological session
 * count (a flapping agent, a stuck loop) must not turn one Mission Control
 * poll into an unbounded response. Deliberately generous — this is a safety
 * ceiling, not a pagination page size — since a real "and N more" is meant
 * to be a rare, notice-worthy event, not routine UX.
 */
export const MISSION_CONTROL_ROW_CAP = 100;

/**
 * `GET /api/mission-control`'s full response body. `truncated_session_count`
 * is 0 whenever `sessions` already holds every row the caller may see; when
 * greater than 0 it is the count of additional sessions dropped past
 * `MISSION_CONTROL_ROW_CAP`, for the UI's explicit "and N more" indicator
 * (never a silent truncation).
 */
export interface MissionControlResponse {
  sessions: MissionControlSessionRow[];
  active_sessions_panel: ActiveSessionsPanel;
  truncated_session_count: number;
}

/**
 * Session/user counts for one activity window of the active-sessions panel
 * (issue #990). `distinct_users` is derived only from sessions that carry a
 * `user_id` (see `SessionRegistryEntry.user_id`) — a session without it
 * still counts in `sessions` but contributes nothing to `distinct_users`, so
 * the latter is a lower bound, never an over-count.
 */
export interface ActiveSessionsWindowStats {
  sessions: number;
  distinct_users: number;
}

/**
 * The Mission Control active-sessions panel (issue #990 / #981 story 10):
 * activity over the last 24 hours, 7 days, and 30 days, derived from the
 * same session registry as the live list — no separate analytics pipeline.
 * Windows are cumulative activity, not the 5-minute liveness window the
 * live list uses: a session counts in a window as long as its
 * `last_seen_at` falls inside it, whether or not it has since ended.
 */
export interface ActiveSessionsPanel {
  window_24h: ActiveSessionsWindowStats;
  window_7d: ActiveSessionsWindowStats;
  window_30d: ActiveSessionsWindowStats;
}
