/**
 * Agent presence heartbeat. Written by MCP-driven HTTP routes (Cursor, Claude
 * Code, Codex, etc.) so the frontend can surface live IDE-agent activity even
 * when the agent does not produce a long-running `runs` row.
 *
 * Doc id is deterministic: `${case_id}__${actor_user_id}` — guarantees
 * idempotent upserts and a single row per (case, actor) pair.
 */
export interface AgentPresence {
  presence_id: string;
  case_id: string;
  actor_user_id: string;
  /** Best-effort label: User.display_name → email → 'agent'. */
  actor_display: string;
  source: 'ide_agent' | 'system' | 'web';
  last_seen_at: string;
  first_seen_at: string;
}
