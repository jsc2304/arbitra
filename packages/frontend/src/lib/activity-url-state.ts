/**
 * URL ↔ MultiActivityFilter serialization for the consolidated activity
 * filter bar.
 *
 * Schema:
 *   ?mode=signal|raw                       (default signal, omitted)
 *   &kinds=findings,decisions,…            (CSV of plural kind tokens)
 *   &actors=agents,cursor,claude-code      (CSV — `agents` = any agent token)
 *   &projects=acme-atlas,acme              (CSV of project_id values)
 *   &since=1h|24h|7d|30d|all               (default 24h, omitted)
 *
 * Defaults are omitted from the URL so the canonical "no overrides" state has
 * a clean `/activity` URL with no query string. Slack-shareable links stay
 * short and the page can treat "no params" as "no overrides".
 *
 * Plural URL tokens (`findings`, `decisions`) read naturally in shared links;
 * they translate to/from the singular internal `ActivityKind` here so the rest
 * of the app stays on the singular form.
 *
 * Legacy single-value `?actor=` and `?project=` aliases are accepted on the
 * read path so previously-shared URLs from the old single-select bar still
 * resolve to the new multi-select filter shape.
 *
 * This module also owns `FilterDelta` and `applyFilterDelta` — the sparse
 * update protocol emitted by right-rail click targets. Rail
 * components stay stateless: each click emits a delta the page merges into
 * the URL via `applyFilterDelta` + `router.replace`.
 */

import {
  ACTOR_TOKEN_AGENTS,
  ACTOR_TOKEN_ALL,
  DEFAULT_MULTI_FILTER,
  isActivityKind,
  isActivitySinceWindow,
  type ActivityActorToken,
  type ActivityKind,
  type ActivityMode,
  type ActivitySinceWindow,
  type MultiActivityFilter,
} from './activity-feed-presentation';

const KIND_URL_PLURAL: Record<ActivityKind, string> = {
  lifecycle: 'lifecycle',
  finding: 'findings',
  decision: 'decisions',
  evidence: 'evidence',
  comment: 'comments',
  system: 'system',
};

const KIND_URL_FROM_PLURAL: Record<string, ActivityKind> = {
  lifecycle: 'lifecycle',
  findings: 'finding',
  decisions: 'decision',
  evidence: 'evidence',
  comments: 'comment',
  system: 'system',
  // Tolerate the singular form too in case people hand-edit URLs.
  finding: 'finding',
  decision: 'decision',
  comment: 'comment',
};

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function multiFilterFromParams(
  params: URLSearchParams | null | undefined,
): MultiActivityFilter {
  if (!params) return { ...DEFAULT_MULTI_FILTER };

  const modeRaw = params.get('mode');
  const mode = modeRaw === 'raw' ? 'raw' : 'signal';

  const kinds: ActivityKind[] = [];
  for (const token of parseCsv(params.get('kinds'))) {
    const k = KIND_URL_FROM_PLURAL[token];
    if (k && isActivityKind(k) && !kinds.includes(k)) kinds.push(k);
  }

  const actorsRaw = parseCsv(params.get('actors'));
  // Accept legacy single-value `?actor=…` for back-compat with the old single-select bar.
  const legacyActor = params.get('actor');
  if (legacyActor && actorsRaw.length === 0) actorsRaw.push(legacyActor);
  const actors: ActivityActorToken[] = [];
  for (const t of actorsRaw) {
    if (t === ACTOR_TOKEN_ALL) continue;
    if (!actors.includes(t)) actors.push(t);
  }

  const projectsRaw = parseCsv(params.get('projects'));
  const legacyProject = params.get('project');
  if (legacyProject && projectsRaw.length === 0) projectsRaw.push(legacyProject);
  const projects: string[] = [];
  for (const p of projectsRaw) if (!projects.includes(p)) projects.push(p);

  const sinceRaw = params.get('since');
  const since: ActivitySinceWindow = isActivitySinceWindow(sinceRaw)
    ? sinceRaw
    : DEFAULT_MULTI_FILTER.since;

  return { mode, kinds, actors, projects, since };
}

export function multiFilterToParams(filter: MultiActivityFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.mode !== DEFAULT_MULTI_FILTER.mode) params.set('mode', filter.mode);
  if (filter.kinds.length > 0) {
    params.set('kinds', filter.kinds.map((k) => KIND_URL_PLURAL[k]).join(','));
  }
  if (filter.actors.length > 0) params.set('actors', filter.actors.join(','));
  if (filter.projects.length > 0) params.set('projects', filter.projects.join(','));
  if (filter.since !== DEFAULT_MULTI_FILTER.since) params.set('since', filter.since);
  return params;
}

/**
 * Convenience: round-trip a filter through string serialization. Stable —
 * useful in tests asserting roundtrip equivalence.
 */
export function roundtripMultiFilter(filter: MultiActivityFilter): MultiActivityFilter {
  const qs = multiFilterToParams(filter).toString();
  return multiFilterFromParams(new URLSearchParams(qs));
}

export const ACTIVITY_URL_KEYS = ['mode', 'kinds', 'actors', 'projects', 'since'] as const;

export { ACTOR_TOKEN_AGENTS, ACTOR_TOKEN_ALL };

// ---------------------------------------------------------------------------
// FilterDelta — sparse update emitted by right-rail click targets
// and applied to the active MultiActivityFilter via applyFilterDelta.
//
// Why a delta type rather than a full MultiActivityFilter?  The right rail
// doesn't know the current filter state, only its local intent ("pin this
// project", "add this actor"). A sparse update lets each rail component stay
// stateless and additive — clicking three different chips composes naturally.
//
// Toggle semantics: if the same project / actor / kind token is already
// pinned, the delta REMOVES it (click again = clear). A plain "click filters the feed"
// reading would be one-way, but UX expectation for chips is two-way; we
// defer to the existing filter-bar pattern.
// ---------------------------------------------------------------------------

export interface FilterDelta {
  /** Toggle a project_id in the `projects` set. */
  toggleProject?: string;
  /** Toggle an actor token (`agents` or a client_name) in the `actors` set. */
  toggleActor?: string;
  /** Toggle a kind in the `kinds` set. */
  toggleKind?: ActivityKind;
  /**
   * Special-case rail click for "attribution: missing". The feed has no
   * server-side attribution dimension yet; we surface this as a Raw-mode pin
   * so the user lands on the audit log where un-attributed rows are visible.
   */
  attributionMissing?: boolean;
  /** Force feed mode (rail clicks may want to land users on Raw). */
  setMode?: ActivityMode;
}

function toggleInSet<T>(arr: T[], value: T): T[] {
  const idx = arr.indexOf(value);
  if (idx >= 0) return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
  return [...arr, value];
}

/**
 * Applies a sparse FilterDelta to the current MultiActivityFilter
 * and returns the next filter (immutable update).
 */
export function applyFilterDelta(
  current: MultiActivityFilter,
  delta: FilterDelta,
): MultiActivityFilter {
  let next: MultiActivityFilter = { ...current };
  if (delta.toggleProject) {
    next = { ...next, projects: toggleInSet(next.projects, delta.toggleProject) };
  }
  if (delta.toggleActor) {
    next = { ...next, actors: toggleInSet(next.actors, delta.toggleActor) };
  }
  if (delta.toggleKind) {
    next = { ...next, kinds: toggleInSet(next.kinds, delta.toggleKind) };
  }
  if (delta.attributionMissing) {
    // Land users on Raw — that's where the un-attributed rows are visible.
    next = { ...next, mode: 'raw' };
  }
  if (delta.setMode) {
    // setMode wins when both attributionMissing and setMode are present in the
    // same delta; attributionMissing is auxiliary (its only effect is setting
    // mode: 'raw', which setMode overrides if it specifies a different value).
    next = { ...next, mode: delta.setMode };
  }
  return next;
}
