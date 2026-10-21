import {
  MISSION_CONTROL_ROW_CAP,
  type ActiveSessionsPanel,
  type ActiveSessionsWindowStats,
  type MissionControlSessionRow,
  type Project,
  type Repository,
  type SessionActivityRecord,
} from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { resolveCaseByBranch, type ResolveCaseByBranchResult } from '../case/branch-resolution.js';
import { WebhookService } from '../webhook/webhook-service.js';
import { listActiveSessions, listSessionsSince } from './session-signal-service.js';

const webhookService = new WebhookService();

/**
 * Resolve the raw `repository` string carried by Session Signals to stored
 * `Repository` rows. Signals carry whatever the emitting hook derived —
 * usually the git remote URL, sometimes a bare directory name, only ever a
 * `repo_...` doc id when a future client chooses to send one. A remote URL
 * contains `/`, which the Firestore SDK rejects as a doc id — passing it
 * into `collections.repositories().doc()` was a Mission Control 500.
 * Resolution order per distinct ref: direct doc get for
 * id-shaped refs (no `/`), then `WebhookService#resolveRepositoryForSignal`
 * — exact `repository_id` / `github_full_name` / `name` / normalized `url`
 * match ONLY, never the legacy `url.includes()` substring fallback (issue
 * #1013: a bare directory name like `"arbitra"`, the signal hook's fallback
 * for a non-git workspace, is a substring of the arbitra-app repo's URL and
 * must NOT resolve to it). This is the same matcher Observed Case creation
 * uses, so both views agree on what a signal's repository means.
 * Unresolvable refs are simply absent from the map (fail closed at the call
 * sites, see `buildMissionControlAggregate`'s doc comment below); resolution
 * errors are logged, not thrown.
 */
export async function resolveSessionRepositories(
  refs: readonly string[],
): Promise<Map<string, Repository>> {
  const repoByRef = new Map<string, Repository>();
  await Promise.all(
    [...new Set(refs)].map(async (ref) => {
      try {
        if (!ref.includes('/')) {
          const doc = await collections.repositories().doc(ref).get();
          if (doc.exists) {
            repoByRef.set(ref, doc.data() as Repository);
            return;
          }
        }
        const matched = await webhookService.resolveRepositoryForSignal(ref);
        if (matched) repoByRef.set(ref, matched);
      } catch (err) {
        console.warn(`[mission-control] repository resolution failed for '${ref}':`, err);
      }
    }),
  );
  return repoByRef;
}

export interface BuildMissionControlAggregateOptions {
  /**
   * Only ever set by tests. A caller passing an explicit `referenceTime`
   * bypasses `MISSION_CONTROL_CACHE_TTL_MS` (see below) and always computes
   * fresh — `route.ts` never passes it, so production traffic always goes
   * through the cache.
   */
  referenceTime?: Date;
  /**
   * Project ids the caller may see. `'all'` means unrestricted (admin) —
   * same convention as `getAccessibleProjectIds`'s non-`false` sentinel.
   */
  accessibleProjectIds: 'all' | ReadonlySet<string>;
}

/**
 * The expensive, caller-independent join: every active session resolved to
 * its repository/project and case, with NO `accessibleProjectIds` filter
 * applied yet. Split out of `buildMissionControlAggregate` so its result
 * can be cached and shared across every caller (admin or not) instead of
 * recomputed once per request — see `buildMissionControlAggregate`'s doc
 * comment for why.
 */
async function computeUnscopedRows(referenceTime: Date | undefined): Promise<MissionControlSessionRow[]> {
  const sessions = await listActiveSessions(referenceTime);
  if (sessions.length === 0) return [];

  const repoByRef = await resolveSessionRepositories(sessions.map((s) => s.repository));

  // Batched via `getAll` (issue #1003): Firestore still bills one read per
  // document either way — `getAll` cuts round trips, not the read count.
  // What actually cuts the read count is the cache below.
  const projectIds = [...new Set([...repoByRef.values()].map((r) => r.project_id))];
  const projectDocs =
    projectIds.length === 0
      ? []
      : await collections.projects().firestore.getAll(...projectIds.map((id) => collections.projects().doc(id)));
  const projectById = new Map<string, Project>();
  for (const doc of projectDocs) {
    if (doc.exists) projectById.set(doc.id, doc.data() as Project);
  }

  // Per-request dedupe: multiple sessions on the same (repository, branch) —
  // e.g. several agents in the same worktree — resolve to the same case, so
  // this caches by that pair and costs one `resolveCaseByBranch` call per
  // distinct branch instead of one per session.
  const caseByRepoBranch = new Map<string, ResolveCaseByBranchResult>();

  const rows: MissionControlSessionRow[] = [];
  for (const session of sessions) {
    const repo = repoByRef.get(session.repository);
    if (!repo) continue; // fail closed: unresolvable repository is unusable regardless of role

    const projectId = repo.project_id;
    const project = projectById.get(projectId);
    const cacheKey = `${repo.repository_id}:${session.branch}`;
    let resolved = caseByRepoBranch.get(cacheKey);
    if (!resolved) {
      resolved = await resolveCaseByBranch({
        repositoryId: repo.repository_id,
        branch: session.branch,
      });
      caseByRepoBranch.set(cacheKey, resolved);
    }
    const { case: matchedCase } = resolved;

    rows.push({
      session_id: session.session_id,
      agent_name: session.agent_name,
      repository_id: repo.repository_id,
      repository_name: repo.name,
      project_id: projectId,
      project_name: project?.name ?? projectId,
      branch: session.branch,
      case: matchedCase
        ? {
            case_id: matchedCase.case_id,
            title: matchedCase.title,
            status: matchedCase.status,
            case_type: matchedCase.case_type,
          }
        : null,
      last_seen_at: session.last_seen_at,
    });
  }

  return rows;
}

// Mission Control is polled every 10s (POLL_INTERVAL_MS, page.tsx) by every
// open tab. `MISSION_CONTROL_CACHE_TTL_MS` is kept a few seconds under that
// so a single tab still recomputes on essentially every poll (no
// regression), while any second tab or caller within the window reuses the
// same computation instead of repeating it — the multiplier that matters
// (open tabs) collapses from linear to ~constant. Same in-process
// cache/in-flight-dedupe shape as `loadKnowledgeAssets`
// (helper-bot/knowledge-loader.ts).
const MISSION_CONTROL_CACHE_TTL_MS = 8_000;

let cachedUnscopedRows: MissionControlSessionRow[] | null = null;
let cachedAt = 0;
let inFlightUnscopedRows: Promise<MissionControlSessionRow[]> | null = null;

async function getUnscopedRowsCached(): Promise<MissionControlSessionRow[]> {
  const now = Date.now();
  if (cachedUnscopedRows !== null && now - cachedAt < MISSION_CONTROL_CACHE_TTL_MS) {
    return cachedUnscopedRows;
  }
  if (inFlightUnscopedRows) return inFlightUnscopedRows;

  inFlightUnscopedRows = (async () => {
    try {
      const rows = await computeUnscopedRows(undefined);
      cachedUnscopedRows = rows;
      cachedAt = Date.now();
      return rows;
    } finally {
      inFlightUnscopedRows = null;
    }
  })();

  return inFlightUnscopedRows;
}

/** Test-only: drop the cached unscoped rows so a fresh build can be observed. */
export function __resetMissionControlAggregateCache(): void {
  cachedUnscopedRows = null;
  cachedAt = 0;
  inFlightUnscopedRows = null;
}

/**
 * Mission Control read aggregate (issue #989 / ADR-0001): every session
 * currently reading as active, joined with its repository → project and
 * branch → case. Computed on read, in the style of the Observatory
 * aggregate — no separate storage layer.
 *
 * Scoping mirrors `GET /api/sessions/active`: `accessibleProjectIds ===
 * 'all'` (admin) skips the membership filter entirely, but a session whose
 * repository doc can't be resolved is still dropped for every caller,
 * admin included — fail closed, since a row that can't carry a project
 * name isn't a usable Mission Control row regardless of role.
 *
 * Unattributed-session rendering (issue #1013, decision point raised by
 * #1013's "pick one and document"): dropping these sessions fail-closed,
 * rather than surfacing them as a separate "unlinked activity" row, is the
 * deliberate choice for now. An unattributed session is, by construction,
 * one whose repository ref didn't resolve at all — either a non-governed
 * workspace's fallback name (see `resolveGitContext` in
 * `packages/mcp/src/hooks/session-signal-hook.ts`) or a repository Arbitra
 * genuinely doesn't track — and Mission Control's project/repository
 * grouping has no natural place to put a row that names neither. Building
 * an "unlinked activity" bucket is deferred until there's a concrete case
 * for it (e.g. an operator wanting to see mis-configured or as-yet-untracked
 * sessions); until then, silence here is preferable to a badly-labelled row.
 *
 * Bounded reads (issue #1003): the join above (`computeUnscopedRows`) is
 * the expensive, caller-independent part — it does not depend on
 * `accessibleProjectIds` — so it is computed for every project at once and
 * cached for `MISSION_CONTROL_CACHE_TTL_MS`, shared across every caller;
 * the per-caller project filter below is applied fresh every call, over
 * the cached (or freshly computed) unscoped rows, so scoping correctness
 * never depends on cache state. Use `applyMissionControlRowCap` on the
 * result before returning it to a client — this function itself is
 * uncapped, since capping is a response-shaping concern, not a query-cost
 * one.
 */
export async function buildMissionControlAggregate(
  options: BuildMissionControlAggregateOptions,
): Promise<MissionControlSessionRow[]> {
  const { referenceTime, accessibleProjectIds } = options;
  const rows = referenceTime === undefined ? await getUnscopedRowsCached() : await computeUnscopedRows(referenceTime);

  if (accessibleProjectIds === 'all') return rows;
  return rows.filter((row) => accessibleProjectIds.has(row.project_id));
}

/**
 * Row cap for the live session list (issue #1003 AC2): truncates to
 * `MISSION_CONTROL_ROW_CAP` and reports how many were dropped, so the UI
 * can render an explicit "and N more" instead of silently hiding rows.
 * Applied after per-caller scoping (`buildMissionControlAggregate`), so the
 * cap is on what THIS caller may see, not on the shared unscoped total.
 */
export function applyMissionControlRowCap(rows: readonly MissionControlSessionRow[]): {
  sessions: MissionControlSessionRow[];
  truncated_session_count: number;
} {
  if (rows.length <= MISSION_CONTROL_ROW_CAP) {
    return { sessions: [...rows], truncated_session_count: 0 };
  }
  return {
    sessions: rows.slice(0, MISSION_CONTROL_ROW_CAP),
    truncated_session_count: rows.length - MISSION_CONTROL_ROW_CAP,
  };
}

const WINDOW_DEFS = [
  { key: 'window_24h', hours: 24 },
  { key: 'window_7d', hours: 7 * 24 },
  { key: 'window_30d', hours: 30 * 24 },
] as const satisfies readonly { key: keyof ActiveSessionsPanel; hours: number }[];

const WIDEST_WINDOW_HOURS = Math.max(...WINDOW_DEFS.map((w) => w.hours));

export interface BuildActiveSessionsPanelOptions {
  referenceTime?: Date;
  /** Same convention as `BuildMissionControlAggregateOptions.accessibleProjectIds`. */
  accessibleProjectIds: 'all' | ReadonlySet<string>;
}

/**
 * Active-sessions panel (issue #990 / #981 story 10): session and distinct-
 * user counts over the last 24h/7d/30d, derived from the same session
 * registry as the live Mission Control list — no separate analytics
 * pipeline. One bounded `listSessionsSince` read (range filter on
 * `last_seen_at`, capped at the widest window) supplies every bucket; the
 * three windows are then computed in memory instead of issuing one query
 * per window.
 *
 * Scoping mirrors `buildMissionControlAggregate`: a session whose
 * repository can't be resolved to a project is dropped for every caller
 * (fail closed), and a non-admin only sees sessions in their accessible
 * projects.
 */
export async function buildActiveSessionsPanel(
  options: BuildActiveSessionsPanelOptions,
): Promise<ActiveSessionsPanel> {
  const referenceTime = options.referenceTime ?? new Date();
  const cutoff = new Date(referenceTime.getTime() - WIDEST_WINDOW_HOURS * 60 * 60 * 1000);
  const records = await listSessionsSince(cutoff);

  const scoped = await scopeToAccessibleProjects(records, options.accessibleProjectIds);

  const panel = {} as ActiveSessionsPanel;
  for (const { key, hours } of WINDOW_DEFS) {
    const windowCutoffIso = new Date(referenceTime.getTime() - hours * 60 * 60 * 1000).toISOString();
    const inWindow = scoped.filter((r) => r.last_seen_at >= windowCutoffIso);
    const distinctUsers = new Set(
      inWindow.map((r) => r.user_id).filter((id): id is string => id !== undefined),
    );
    const stats: ActiveSessionsWindowStats = {
      sessions: inWindow.length,
      distinct_users: distinctUsers.size,
    };
    panel[key] = stats;
  }
  return panel;
}

/**
 * Shared repository → project resolution + scoping for the panel path.
 * Mirrors the fail-closed / accessible-set logic in
 * `buildMissionControlAggregate` (a session whose repository doc can't be
 * resolved is dropped for every caller; a non-admin is additionally scoped
 * to `accessibleProjectIds`), factored out since the panel projects a
 * different row shape (`SessionActivityRecord`, not `MissionControlSessionRow`).
 */
async function scopeToAccessibleProjects(
  records: readonly SessionActivityRecord[],
  accessibleProjectIds: 'all' | ReadonlySet<string>,
): Promise<SessionActivityRecord[]> {
  if (records.length === 0) return [];

  const repoByRef = await resolveSessionRepositories(records.map((r) => r.repository));

  return records.filter((record) => {
    const projectId = repoByRef.get(record.repository)?.project_id;
    if (!projectId) return false; // fail closed: unresolvable repository is unusable regardless of role
    if (accessibleProjectIds === 'all') return true;
    return accessibleProjectIds.has(projectId);
  });
}
