import type { ActorMetadata } from '@arbitra/shared';

/**
 * Canonical display-name mapping for known IDE / agent clients. Keys are the
 * lowercase `client_name` values that the backend normalizes on ingest
 * (see `normalizeActorMetadata` in `@arbitra/shared`). Unknown clients fall
 * back to a title-cased rendering of their raw `client_name` so the UI never
 * hard-fails on a new agent.
 */
export const CLIENT_DISPLAY_MAP: Record<string, string> = {
  'arbitra-intelligence': 'Code Intelligence',
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  cline: 'Cline',
  'gemini-cli': 'Gemini CLI',
  copilot: 'Copilot',
  // Synthetic sentinels emitted by the leaderboard aggregator when a row has
  // no `actor_metadata.client_name`. Kept in this map so the leaderboard card
  // renders a friendly label instead of title-casing the sentinel literal.
  automated: 'CI / Automated',
  webhook: 'Webhook',
  system: 'Arbitra',
  human: 'Humans',
};

/**
 * Prefix-based display-name rules. Evaluated before the title-case fallback
 * so same-family clients (e.g. `cursor-vscode`, `cursor-nightly`,
 * `claude-code-beta`) render as the canonical product name instead of
 * title-cased variants like "Cursor Vscode".
 */
const CLIENT_PREFIX_RULES: Array<{ prefix: string; label: string }> = [
  { prefix: 'cursor-', label: 'Cursor' },
  { prefix: 'claude-code-', label: 'Claude Code' },
  { prefix: 'cline-', label: 'Cline' },
];

/** System actor ID conventions used across the codebase. */
export function isSystemActorId(id: string | undefined): boolean {
  if (!id) return false;
  return id === 'system' || id.startsWith('system:');
}

/**
 * Detector actor IDs only — the subset of system actors that emit detector
 * findings (currently `system:arbitra-intelligence`, see
 * `INTELLIGENCE_ACTOR_ID` in `packages/backend/src/services/intelligence/config.ts`).
 *
 * Used by the activity feed to route `case_created` rows into the
 * "Arbitra flagged …" branch. Plain `'system'` (e.g. webhook
 * case-creation) and other future system actors must NOT match — they should
 * fall through to the normal `{Actor} opened *{title}*` headline.
 */
export function isDetectorActor(id: string | undefined): boolean {
  if (!id) return false;
  return id === 'system:arbitra-intelligence';
}

function titleCase(input: string): string {
  return input
    .split(/[-_\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

export interface ActorDisplay {
  /** Primary human-readable label (e.g. "Claude Code", "Arbitra", "Alice"). */
  label: string;
  /**
   * Optional secondary label the caller may render as a tooltip or side note.
   * Currently populated with the raw "client_name client_version" string so
   * users can still inspect version info without it cluttering the row.
   */
  secondary?: string;
}

/**
 * Single source of truth for actor labels across the activity feed, case
 * timeline, comments, and evidence detail panel. Resolution order:
 *
 *   1. `actor_metadata.client_name` → mapped via `CLIENT_DISPLAY_MAP`, with a
 *      title-cased fallback. Version is returned as `secondary` for tooltips.
 *   2. `actor_user_id` is a system actor (`system` or `system:*`) → `Arbitra`.
 *   3. Otherwise → caller is responsible for resolving a real user via
 *      `useUserMap`; we surface `resolvedHumanName` when passed, else a safe
 *      truncation of the raw id.
 *
 * MUST remain a pure function — no hooks inside. The caller passes
 * `resolvedHumanName` already looked up from `useUserMap`.
 */
export function actorDisplayName(
  actorUserId: string | undefined,
  actorMetadata: ActorMetadata | undefined,
  resolvedHumanName?: string,
): ActorDisplay {
  // 1. Prefer client_name mapping when actor_metadata is present.
  const clientName = actorMetadata?.client_name;
  if (clientName) {
    const prefixMatch = CLIENT_PREFIX_RULES.find((r) => clientName.startsWith(r.prefix));
    const mapped =
      CLIENT_DISPLAY_MAP[clientName] ??
      prefixMatch?.label ??
      titleCase(clientName);
    const secondary = actorMetadata?.client_version
      ? `${clientName} ${actorMetadata.client_version}`
      : clientName;
    return { label: mapped, secondary };
  }
  // 2. System actors — both `system` and `system:*` forms.
  if (isSystemActorId(actorUserId)) {
    return { label: 'Arbitra' };
  }
  // 3. Human user — caller resolved via useUserMap.
  if (resolvedHumanName && resolvedHumanName.length > 0) {
    return { label: resolvedHumanName };
  }
  if (!actorUserId) return { label: '—' };
  // Firebase-UID-shaped raw ids get a generic label; other strings pass
  // through (truncated to keep a single-line row intact).
  if (/^[A-Za-z0-9]{20,}$/.test(actorUserId)) {
    return { label: 'User' };
  }
  return {
    label: actorUserId.length > 24 ? `${actorUserId.slice(0, 24)}…` : actorUserId,
  };
}
