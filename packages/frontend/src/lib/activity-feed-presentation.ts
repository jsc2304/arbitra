import type { ActivityEntry, ActivitySeverity } from '@arbitra/shared';

export type ActivityMode = 'signal' | 'raw';

export type ActivityTypeFilter =
  | 'all'
  | 'lifecycle'
  | 'finding'
  | 'decision'
  | 'evidence'
  | 'comment'
  | 'system';

/** Concrete kind tokens used in multi-select `What` filter (excludes 'all'). */
export type ActivityKind = Exclude<ActivityTypeFilter, 'all'>;

/**
 * Time-window filter. `'all'` disables the filter.
 * Replaces the previously hardcoded 24h window in the UI.
 */
export type ActivitySinceWindow = '1h' | '24h' | '7d' | '30d' | 'all';

const SINCE_WINDOW_MS: Record<ActivitySinceWindow, number | null> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export function isActivitySinceWindow(value: string | null | undefined): value is ActivitySinceWindow {
  return value === '1h' || value === '24h' || value === '7d' || value === '30d' || value === 'all';
}

export function isActivityKind(value: string): value is ActivityKind {
  return (
    value === 'lifecycle' ||
    value === 'finding' ||
    value === 'decision' ||
    value === 'evidence' ||
    value === 'comment' ||
    value === 'system'
  );
}

/**
 * `Who` actor scope. Mirrors the previous ActorScopeSelect contract:
 *   - `all`     — everybody
 *   - `agents`  — any agent (no specific client)
 *   - `<client_name>` — a specific detected client (cursor, claude-code, …)
 * Multi-select: when an explicit client is in the set, agents-only is implied.
 */
export type ActivityActorToken = string;

/** Named tokens with stable meaning. Specific clients are free-form strings. */
export const ACTOR_TOKEN_ALL = 'all';
export const ACTOR_TOKEN_AGENTS = 'agents';

export interface ActivityFeedEntryItem {
  kind: 'entry';
  id: string;
  entry: ActivityEntry;
  /** First-of-day badge — first occurrence of this kind in the visible window. */
  isFirstOfDay?: boolean;
}

export interface ActivityFeedClusterItem {
  kind: 'cluster';
  id: string;
  case_id: string;
  case_title?: string;
  project_id?: string;
  project_name?: string;
  href: string;
  latest_timestamp: string;
  entries: ActivityEntry[];
  /** Pre-rendered natural-language summary line — see `buildClusterNarrative`. */
  label: string;
  /** Older preview field, retained for callers that want a single-line teaser. */
  preview: string;
  /**
   * Verb chip strip One label per distinct verb in the cluster,
   * preserved in chronological order so the strip reads left-to-right as the
   * burst unfolded.
   */
  verbChips: string[];
  /** "5 in 12m" style count-and-window label */
  countLabel: string;
}

/**
 * Streak cluster — 3+ similar events in <10 min on the same case
 * collapsed into an inline expander. Uses the envelope's `group_key` field
 * to detect the burst. Distinct from the case-burst cluster above so the
 * UI can render the dedicated "Cursor · 4 comments in 7 min on {title}"
 * shape rather than the multi-verb summary line.
 */
export interface ActivityFeedStreakItem {
  kind: 'streak';
  id: string;
  case_id: string;
  case_title?: string;
  project_id?: string;
  project_name?: string;
  href: string;
  latest_timestamp: string;
  entries: ActivityEntry[];
  /** Actor display label (rendered as the streak headline lead). */
  actor_label: string;
  /** Verb describing what happened — e.g. "comments", "evidence items". */
  verb_label: string;
  /** Count of events in the streak. */
  count: number;
  /** Window in minutes between the earliest and the latest event in the streak. */
  window_minutes: number;
}

/**
 * HeartbeatTile item — replaces the placeholder
 * `cluster:heartbeat:*` from PR #547. Pinned to the top of the System feed.
 */
export interface ActivityFeedHeartbeatItem {
  kind: 'heartbeat';
  id: string;
  /** Underlying intelligence_run workspace events (latest first). */
  entries: ActivityEntry[];
  latest_timestamp: string;
}

export type ActivityFeedItem =
  | ActivityFeedEntryItem
  | ActivityFeedClusterItem
  | ActivityFeedStreakItem
  | ActivityFeedHeartbeatItem;

const SIGNAL_CASE_EVENT_SUBKINDS = new Set([
  'case_created',
  'case_ready_for_build',
  'build_started',
  'exploration_completed',
  'review_completed',
  'review_marked_not_applicable',
  'review_not_applicable_cleared',
  'review_not_applicable_marked',
  'changes_requested',
  'human_decision_requested',
  'merge_ready',
  'pr_merged',
  'case_anomaly_merge_on_gated_status',
  'case_approved',
  'case_rejected',
  'case_completed',
]);

const SIGNAL_FINDING_SUBKINDS = new Set(['high', 'critical']);
const SIGNAL_EVIDENCE_SUBKINDS = new Set([
  'ci_result',
  'integration_test_result',
  'manual_confirmation',
  'benchmark_result',
]);

const BURST_WINDOW_MS = 90_000;
/** Streak threshold: collapse 3+ similar events in <10min. */
const STREAK_MIN_COUNT = 3;
const STREAK_WINDOW_MS = 10 * 60 * 1000;

export function classifyActivityType(entry: ActivityEntry): Exclude<ActivityTypeFilter, 'all'> {
  switch (entry.kind) {
    case 'case_event':
      return 'lifecycle';
    case 'finding':
      return 'finding';
    case 'decision':
      return 'decision';
    case 'evidence':
      return 'evidence';
    case 'comment':
      return 'comment';
    case 'workspace_event':
      return 'system';
  }
}

export function isSignalEntry(entry: ActivityEntry): boolean {
  // Server-computed `signal` flag is the canonical source; if
  // the field is present, prefer it over the legacy frontend heuristic.
  if (typeof entry.signal === 'boolean') return entry.signal;
  switch (entry.kind) {
    case 'workspace_event':
      return true;
    case 'decision':
      return true;
    case 'finding':
      return SIGNAL_FINDING_SUBKINDS.has(entry.subkind ?? '');
    case 'evidence':
      return SIGNAL_EVIDENCE_SUBKINDS.has(entry.subkind ?? '');
    case 'case_event':
      return SIGNAL_CASE_EVENT_SUBKINDS.has(entry.subkind ?? '');
    case 'comment':
      return false;
  }
}

/**
 * Optional client-side filters that don't fit on the existing axes. Kept
 * separate from the server-side `ActivityFilters` (project / actor / agents)
 * because these are per-row predicates that the server-side query path
 * doesn't support yet. Step 5 will fold these into a dedicated filter axis
 * on the feed query.
 */
export interface ActivityClientFilters {
  /** Restrict to detector-opened case rows (`entry.opened_by === 'detector'`). */
  caseDetectorOpened?: boolean;
}

export function filterActivityEntries(
  entries: ActivityEntry[],
  mode: ActivityMode,
  typeFilter: ActivityTypeFilter,
  clientFilters: ActivityClientFilters = {},
): ActivityEntry[] {
  return entries.filter((entry) => {
    if (mode === 'signal' && !isSignalEntry(entry)) return false;
    if (typeFilter !== 'all' && classifyActivityType(entry) !== typeFilter) return false;
    if (clientFilters.caseDetectorOpened && entry.opened_by !== 'detector') {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Multi-dimensional filter — drives the consolidated filter bar.
// ---------------------------------------------------------------------------

export interface MultiActivityFilter {
  mode: ActivityMode;
  /** Empty array = "all kinds". Matches via classifyActivityType(). */
  kinds: ActivityKind[];
  /**
   * Empty array = "all actors". Tokens are either `agents` (any agent) or a
   * concrete `client_name` (e.g. `cursor`). Multi-select is OR — any matching
   * token includes the row.
   */
  actors: ActivityActorToken[];
  /** Empty array = "all projects". Matches `entry.project_id`. */
  projects: string[];
  /** Time-window relative to `now`. `all` disables the filter. */
  since: ActivitySinceWindow;
}

export const DEFAULT_MULTI_FILTER: MultiActivityFilter = {
  mode: 'signal',
  kinds: [],
  actors: [],
  projects: [],
  since: '24h',
};

/**
 * Returns true if the multi-filter is in its default (no refinement) state.
 * Used by the filter bar to decide whether to render the active-chip strip.
 */
export function isMultiFilterPristine(filter: MultiActivityFilter): boolean {
  return (
    filter.mode === DEFAULT_MULTI_FILTER.mode &&
    filter.kinds.length === 0 &&
    filter.actors.length === 0 &&
    filter.projects.length === 0 &&
    filter.since === DEFAULT_MULTI_FILTER.since
  );
}

function entryMatchesActorTokens(entry: ActivityEntry, tokens: ActivityActorToken[]): boolean {
  if (tokens.length === 0) return true;
  const clientName = entry.actor_metadata?.client_name;
  // "Is an agent" definition — PARITY CONTRACT with server `agentsOnly`:
  //   Client (here): !!clientName OR actor_user_id === 'system' OR startsWith('system:')
  //   Server (activity-service.ts ~L441): !!actor_metadata.client_name only
  //
  // Known drift: the server's agentsOnly does NOT include bare `system` /
  // `system:*` rows (they carry no client_name). This means a single-actor
  // `actors=['agents']` fetch may return fewer rows than the client union
  // expects for system-authored entries. The gap is intentional for now —
  // system-authored rows appear rarely in practice and are captured on
  // wide-fetches (multi-actor). If parity becomes critical, update the
  // server filter in activity-service.ts to match this definition.
  const isAgent =
    !!clientName ||
    entry.actor_user_id === 'system' ||
    (entry.actor_user_id?.startsWith('system:') ?? false);
  for (const t of tokens) {
    if (t === ACTOR_TOKEN_AGENTS && isAgent) return true;
    if (clientName && t === clientName) return true;
  }
  return false;
}

function entryMatchesSince(entry: ActivityEntry, since: ActivitySinceWindow, nowMs: number): boolean {
  const windowMs = SINCE_WINDOW_MS[since];
  if (windowMs === null) return true;
  const ts = Date.parse(entry.timestamp);
  if (Number.isNaN(ts)) return true;
  return nowMs - ts <= windowMs;
}

/**
 * Apply the consolidated multi-filter (mode + kinds + actors + projects +
 * since-window). Server-side `agentsOnly` / `clientName` / `projectId` filters
 * still narrow at fetch time for a single-value selection; this client filter
 * handles the union (multi-select) semantics on top of whatever the server
 * returned.
 */
export function applyMultiFilter(
  entries: ActivityEntry[],
  filter: MultiActivityFilter,
  nowMs: number = Date.now(),
): ActivityEntry[] {
  return entries.filter((entry) => {
    if (filter.mode === 'signal' && !isSignalEntry(entry)) return false;
    if (filter.kinds.length > 0 && !filter.kinds.includes(classifyActivityType(entry))) return false;
    if (filter.projects.length > 0) {
      if (!entry.project_id || !filter.projects.includes(entry.project_id)) return false;
    }
    if (!entryMatchesActorTokens(entry, filter.actors)) return false;
    if (!entryMatchesSince(entry, filter.since, nowMs)) return false;
    return true;
  });
}

/**
 * Derive the server-side fetch filter from the current multi-filter.
 *
 * Narrows at the server only when a single actor dimension is selected:
 *   actors === ['agents']         → agentsOnly=true
 *   actors === ['<one-client>']   → clientName='<one-client>'
 *   actors.length > 1             → wide fetch; applyMultiFilter handles OR
 *
 * A single project selection is always pushed to the server.
 *
 * Exported for unit testing. Called by ActivityFeed to build fetchFilters.
 */
export function deriveServerFetchFilters(filter: Pick<MultiActivityFilter, 'actors' | 'projects'>): {
  agentsOnly?: boolean;
  clientName?: string;
  projectId?: string;
} {
  const f: { agentsOnly?: boolean; clientName?: string; projectId?: string } = {};
  if (filter.projects.length === 1) f.projectId = filter.projects[0]!;
  if (filter.actors.length === 1) {
    if (filter.actors[0] === ACTOR_TOKEN_AGENTS) {
      f.agentsOnly = true;
    } else {
      f.clientName = filter.actors[0];
    }
  }
  return f;
}

/** Per-kind counts on the visible feed — drives the dropdown badges. */
export function countByKind(entries: ActivityEntry[]): Record<ActivityKind, number> {
  const out: Record<ActivityKind, number> = {
    lifecycle: 0,
    finding: 0,
    decision: 0,
    evidence: 0,
    comment: 0,
    system: 0,
  };
  for (const e of entries) out[classifyActivityType(e)] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Severity helpers — drives the row-start dot
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<ActivitySeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Resolve the row severity. Prefers the envelope's first-class
 * `entry.severity` (severity is a first-class prop derived from the envelope, not
 * from kind). Falls back to deriving from
 * finding subkind for older rows that haven't been backfilled yet.
 */
export function resolveRowSeverity(entry: ActivityEntry): ActivitySeverity {
  if (entry.severity) return entry.severity;
  if (entry.kind === 'finding') {
    const sk = entry.subkind ?? '';
    if (sk === 'critical' || sk === 'high' || sk === 'medium' || sk === 'low' || sk === 'info') {
      return sk as ActivitySeverity;
    }
  }
  return 'info';
}

export function isMediumOrAbove(severity: ActivitySeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK.medium;
}

/**
 * Verb label rendered on the cluster's chip strip. Keep these one or
 * two words; the chip is a scannability aid, not a sentence.
 */
const VERB_CHIP_LABELS: Record<string, string> = {
  case_created: 'opened',
  case_ready_for_build: 'ready',
  build_started: 'build',
  exploration_completed: 'explored',
  exploration_requested: 'requested',
  case_completed: 'completed',
  case_approved: 'approved',
  case_rejected: 'rejected',
  changes_requested: 'changes',
  human_decision_requested: 'decision',
  webhook_rejected: 'rejected webhook',
  comment_added: 'commented',
};

function verbChipLabel(entry: ActivityEntry): string {
  const subkind = entry.subkind ?? '';
  if (subkind && VERB_CHIP_LABELS[subkind]) return VERB_CHIP_LABELS[subkind];
  switch (entry.kind) {
    case 'comment':
      return 'commented';
    case 'finding':
      return 'finding';
    case 'evidence':
      return 'evidence';
    case 'decision':
      return 'decision';
    case 'workspace_event':
      return 'system';
    case 'case_event':
      return 'updated';
  }
}

function verbNarrativeLabel(entry: ActivityEntry): string {
  const subkind = entry.subkind ?? '';
  if (subkind === 'case_created') return 'opened the case';
  if (subkind === 'build_started') return 'started a build';
  if (subkind === 'case_ready_for_build') return 'marked it ready for build';
  if (subkind === 'exploration_completed') return 'completed exploration';
  if (subkind === 'exploration_requested') return 'requested exploration';
  if (subkind === 'case_completed') return 'completed the case';
  if (subkind === 'case_approved') return 'approved the case';
  if (subkind === 'case_rejected') return 'rejected the case';
  if (subkind === 'changes_requested') return 'requested changes';
  if (subkind === 'human_decision_requested') return 'requested a decision';
  if (subkind === 'comment_added') return 'commented';
  switch (entry.kind) {
    case 'comment':
      return 'commented';
    case 'finding':
      return 'surfaced a finding';
    case 'evidence':
      return 'added evidence';
    case 'decision':
      return 'recorded a decision';
    case 'workspace_event':
      return 'emitted a system event';
    case 'case_event':
      return entry.summary || 'updated the case';
  }
}

function actorNarrativeLabel(entry: ActivityEntry): string {
  // Cheap inline classification — we don't import `actorDisplayName` here to
  // keep this presentation lib free of frontend-only deps. Falls back to
  // generic role labels for unknown cases.
  if (entry.actor_metadata?.client_name) {
    const c = entry.actor_metadata.client_name;
    if (c === 'cursor') return 'Cursor';
    if (c === 'claude-code') return 'Claude Code';
    if (c === 'arbitra-intelligence') return 'Arbitra';
    return c;
  }
  if (entry.actor_user_id === 'system' || entry.actor_user_id?.startsWith('system:')) {
    return 'Arbitra';
  }
  return 'Someone';
}

function clusterHref(caseId: string): string {
  return `/cases/${caseId}?tab=timeline`;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * Build the natural-language summary line:
 * `Alex started a build, Arbitra completed exploration, Cursor commented`.
 * Falls back to a deduped count when the burst is dominated by one verb.
 */
function buildClusterNarrative(entries: ActivityEntry[]): string {
  if (entries.length === 0) return '';
  // Take up to 3 distinct (actor, verb) pairs in chronological order. The
  // upstream feed is desc-by-timestamp, so reverse to read oldest-first.
  const seen = new Set<string>();
  const segments: string[] = [];
  const chronological = [...entries].reverse();
  for (const e of chronological) {
    const actor = actorNarrativeLabel(e);
    const verb = verbNarrativeLabel(e);
    const key = `${actor}|${verb}`;
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(`${actor} ${verb}`);
    if (segments.length >= 3) break;
  }
  return segments.join(', ');
}

function buildClusterPreview(entries: ActivityEntry[]): string {
  const parts = entries
    .slice(0, 3)
    .map((entry) => entry.summary)
    .filter((summary) => summary.length > 0);
  if (parts.length === 0) return '';
  if (entries.length <= 3) return parts.join(' • ');
  return `${parts.join(' • ')} • +${entries.length - 3} more`;
}

function buildVerbChips(entries: ActivityEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Chronological order for left-to-right reading.
  const chronological = [...entries].reverse();
  for (const e of chronological) {
    const label = verbChipLabel(e);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function minutesBetween(latestIso: string, earliestIso: string): number {
  const latest = Date.parse(latestIso);
  const earliest = Date.parse(earliestIso);
  if (Number.isNaN(latest) || Number.isNaN(earliest)) return 0;
  return Math.max(1, Math.round((latest - earliest) / 60_000));
}

function buildCountLabel(entries: ActivityEntry[]): string {
  if (entries.length === 0) return '';
  // Entries arrive desc-by-timestamp; entries[0] is the latest.
  const latest = entries[0]!.timestamp;
  const earliest = entries[entries.length - 1]!.timestamp;
  const minutes = minutesBetween(latest, earliest);
  return `${entries.length} in ${minutes}m`;
}

function canGroupTogether(previous: ActivityEntry, next: ActivityEntry): boolean {
  if (!previous.case_id || !next.case_id) return false;
  if (previous.case_id !== next.case_id) return false;
  if (previous.kind === 'workspace_event' || next.kind === 'workspace_event') return false;

  const previousTs = new Date(previous.timestamp).getTime();
  const nextTs = new Date(next.timestamp).getTime();
  return Math.abs(previousTs - nextTs) <= BURST_WINDOW_MS;
}

function makeCluster(id: string, entries: ActivityEntry[]): ActivityFeedClusterItem {
  const first = entries[0]!;
  return {
    kind: 'cluster',
    id,
    case_id: first.case_id,
    ...(first.case_title ? { case_title: first.case_title } : {}),
    ...(first.project_id ? { project_id: first.project_id } : {}),
    ...(first.project_name ? { project_name: first.project_name } : {}),
    href: clusterHref(first.case_id),
    latest_timestamp: first.timestamp,
    entries,
    label: buildClusterNarrative(entries),
    preview: buildClusterPreview(entries),
    verbChips: buildVerbChips(entries),
    countLabel: buildCountLabel(entries),
  };
}

// ---------------------------------------------------------------------------
// Heartbeat collapse — replaces every adjacent `intelligence_run` row with
// a single HeartbeatTile item. The tile component reads the run summaries
// off the entries to derive the baseline counters.
// ---------------------------------------------------------------------------

function collapseIntelligenceHeartbeats(entries: ActivityEntry[]): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  let i = 0;
  while (i < entries.length) {
    const current = entries[i]!;
    if (current.kind === 'workspace_event' && current.subkind === 'intelligence_run') {
      let j = i + 1;
      while (
        j < entries.length &&
        entries[j]!.kind === 'workspace_event' &&
        entries[j]!.subkind === 'intelligence_run'
      ) {
        j += 1;
      }
      const burst = entries.slice(i, j);
      // Always promote to a HeartbeatTile (even for a single run) so the
      // visual replaces the placeholder cluster from PR #547 consistently.
      // A run that differs from baseline (errors > 0, etc.) will already
      // carry `signal=true` on the envelope; the tile renders a status dot
      // accordingly, and individual off-baseline runs can be promoted to
      // real rows in a later step.
      items.push({
        kind: 'heartbeat',
        id: `heartbeat:${burst[0]!.id}`,
        entries: burst,
        latest_timestamp: burst[0]!.timestamp,
      });
      i = j;
      continue;
    }
    items.push({ kind: 'entry', id: current.id, entry: current });
    i += 1;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Streak collapse — uses envelope `group_key`.
// 3+ entries sharing the same group_key inside the streak window collapse
// into a single ActivityFeedStreakItem. Runs AFTER the per-burst clusterer
// so it works on the post-clustering item stream.
// ---------------------------------------------------------------------------

interface StreakBucket {
  key: string;
  entries: ActivityEntry[];
  /** Index into the input items array of the entry that anchors the streak. */
  firstIndex: number;
}

/**
 * Group adjacent entry items by `group_key` into streak buckets. Only
 * considers `kind: 'entry'` items — clusters and tiles are passed through
 * untouched. A bucket reaches "streak" status when it has ≥3 entries and
 * spans ≤10 min, at which point it replaces those entries with a single
 * streak item at the position of the earliest entry.
 */
function collapseStreaks(items: ActivityFeedItem[]): ActivityFeedItem[] {
  // Pass 1: bucket adjacent entries by group_key. We don't require strict
  // adjacency in the input order — same group_key entries within a 10-min
  // window collapse even if the upstream feed interleaves other rows for
  // a brief window. We do need to respect the input order to keep the
  // reduction stable.
  const buckets = new Map<string, StreakBucket>();
  // Track replacement: index → streak id (or null to drop).
  const replacement: Array<ActivityFeedItem | null> = items.map((it) => it);
  const dropIndices = new Set<number>();

  items.forEach((item, idx) => {
    if (item.kind !== 'entry') return;
    const key = item.entry.group_key;
    if (!key) return;
    const existing = buckets.get(key);
    if (existing) {
      // Compute the bucket's full span if we add this candidate. Reject if
      // the resulting span exceeds STREAK_WINDOW_MS so we never collapse
      // events that are actually too far apart in time. Upstream entries are
      // not strictly time-sorted within a group_key bucket (the feed orders
      // globally by timestamp desc, but two same-key events can be split by
      // unrelated rows), so we re-derive min/max defensively.
      const allTs = [...existing.entries, item.entry].map((e) => Date.parse(e.timestamp));
      const span = Math.max(...allTs) - Math.min(...allTs);
      if (span > STREAK_WINDOW_MS) return;
      existing.entries.push(item.entry);
    } else {
      buckets.set(key, { key, entries: [item.entry], firstIndex: idx });
    }
  });

  // Pass 2: for each bucket of size >= STREAK_MIN_COUNT, materialize a
  // streak item at the firstIndex slot and drop the other entry slots.
  for (const bucket of buckets.values()) {
    if (bucket.entries.length < STREAK_MIN_COUNT) continue;
    const streak = makeStreakItem(bucket);
    replacement[bucket.firstIndex] = streak;
    // Mark every other slot in `items` whose entry id is in the bucket for
    // dropping. The bucket carries entries in input order, so all but the
    // first slot need to go.
    const memberIds = new Set(bucket.entries.map((e) => e.id));
    items.forEach((it, idx) => {
      if (idx === bucket.firstIndex) return;
      if (it.kind === 'entry' && memberIds.has(it.entry.id)) {
        dropIndices.add(idx);
      }
    });
  }

  return replacement.filter((it, idx) => it !== null && !dropIndices.has(idx)) as ActivityFeedItem[];
}

function makeStreakItem(bucket: StreakBucket): ActivityFeedStreakItem {
  // Sort desc-by-timestamp so [0] is latest.
  const sorted = [...bucket.entries].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
  const latest = sorted[0]!;
  const earliest = sorted[sorted.length - 1]!;
  const minutes = minutesBetween(latest.timestamp, earliest.timestamp);
  const verb = verbStreakLabel(latest);
  return {
    kind: 'streak',
    id: `streak:${bucket.key}`,
    case_id: latest.case_id,
    ...(latest.case_title ? { case_title: latest.case_title } : {}),
    ...(latest.project_id ? { project_id: latest.project_id } : {}),
    ...(latest.project_name ? { project_name: latest.project_name } : {}),
    href: latest.case_id ? clusterHref(latest.case_id) : '',
    latest_timestamp: latest.timestamp,
    entries: sorted,
    actor_label: actorNarrativeLabel(latest),
    verb_label: verb,
    count: sorted.length,
    window_minutes: minutes,
  };
}

function verbStreakLabel(entry: ActivityEntry): string {
  const t = classifyActivityType(entry);
  switch (t) {
    case 'comment':
      return 'comments';
    case 'finding':
      return 'findings';
    case 'evidence':
      return 'evidence items';
    case 'decision':
      return 'decisions';
    case 'system':
      return 'system events';
    case 'lifecycle':
      return 'updates';
  }
}

// ---------------------------------------------------------------------------
// First-of-day computation
// ---------------------------------------------------------------------------

/**
 * Tag the first-occurrence-per-kind entry items with `isFirstOfDay = true`.
 * "First" is defined as the chronologically earliest entry of that kind in
 * the visible window. Since the upstream feed is desc-by-timestamp, the
 * "first" item of each kind is the LAST one we encounter scanning top-to-
 * bottom.
 */
function tagFirstOfDay(items: ActivityFeedItem[]): ActivityFeedItem[] {
  // Walk bottom-up (chronological order) and mark the first time we see each
  // ActivityKind. Entry items wrapped in clusters / streaks / heartbeats do
  // not count — the badge is row-level.
  const seen = new Set<string>();
  const reversed = [...items];
  for (let i = reversed.length - 1; i >= 0; i -= 1) {
    const it = reversed[i]!;
    if (it.kind !== 'entry') continue;
    const k = it.entry.kind;
    if (seen.has(k)) continue;
    seen.add(k);
    reversed[i] = { ...it, isFirstOfDay: true };
  }
  return reversed;
}

export function buildActivityFeedItems(
  entries: ActivityEntry[],
  options:
    | {
        mode: ActivityMode;
        typeFilter: ActivityTypeFilter;
        clientFilters?: ActivityClientFilters;
      }
    | { multi: MultiActivityFilter; nowMs?: number },
): ActivityFeedItem[] {
  const filtered =
    'multi' in options
      ? applyMultiFilter(entries, options.multi, options.nowMs)
      : filterActivityEntries(entries, options.mode, options.typeFilter, options.clientFilters);
  const preCollapsed = collapseIntelligenceHeartbeats(filtered);
  const items: ActivityFeedItem[] = [];
  const clusterOrdinalByCase = new Map<string, number>();

  for (const incoming of preCollapsed) {
    if (incoming.kind === 'cluster' || incoming.kind === 'heartbeat') {
      items.push(incoming);
      continue;
    }
    if (incoming.kind === 'streak') {
      // Streak items are produced post-collapse; they shouldn't be in
      // preCollapsed. Defensive passthrough.
      items.push(incoming);
      continue;
    }
    const entry = incoming.entry;
    const last = items[items.length - 1];
    if (!last) {
      items.push({ kind: 'entry', id: entry.id, entry });
      continue;
    }

    if (last.kind === 'entry' && canGroupTogether(last.entry, entry)) {
      const clusterOrdinal = clusterOrdinalByCase.get(entry.case_id) ?? 0;
      clusterOrdinalByCase.set(entry.case_id, clusterOrdinal + 1);
      items[items.length - 1] = makeCluster(
        `cluster:${entry.case_id}:${clusterOrdinal}`,
        [last.entry, entry],
      );
      continue;
    }

    if (
      last.kind === 'cluster' &&
      last.case_id &&
      canGroupTogether(last.entries[last.entries.length - 1]!, entry)
    ) {
      last.entries.push(entry);
      last.label = buildClusterNarrative(last.entries);
      last.preview = buildClusterPreview(last.entries);
      last.verbChips = buildVerbChips(last.entries);
      last.countLabel = buildCountLabel(last.entries);
      continue;
    }

    items.push({ kind: 'entry', id: entry.id, entry });
  }

  // Streak collapse runs AFTER per-burst clustering so a 3+ same-key streak
  // that would otherwise bury inside a multi-verb cluster gets promoted to
  // its own dedicated expander.
  const withStreaks = collapseStreaks(items);
  return tagFirstOfDay(withStreaks);
}
