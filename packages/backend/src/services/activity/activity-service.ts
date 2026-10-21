import type {
  ActivityEntry,
  ActivityKind,
  ActivityLeaderboardCounts,
  ActivityLeaderboardRow,
  ActivityLeaderboardSourceKind,
  ActivityLeaderboardWindow,
  ActivityProjectLeaderboardRow,
  Case,
  CaseEvent,
  Comment,
  Decision,
  Evidence,
  Finding,
  Project,
  WorkspaceEvent,
} from '@arbitra/shared';
import {
  envelopeForCaseEvent,
  envelopeForComment,
  envelopeForDecision,
  envelopeForEvidence,
  envelopeForFinding,
  envelopeForWorkspaceEvent,
} from '@arbitra/shared';
import { FieldPath } from 'firebase-admin/firestore';
import { collections } from '../../lib/firestore.js';
import { getAccessibleProjectIds, isEffectiveMember } from '../../lib/project-access.js';
import { parseEvidenceSummary } from '../intelligence/intelligence-service.js';

// ---------------------------------------------------------------------------
// Normalization — shape each source row into an ActivityEntry.
// ---------------------------------------------------------------------------

/**
 * Safe underscore-to-space humanizer. Activity rows are built from Firestore
 * documents whose shape predates the current enums (e.g. evidence rows missing
 * `type` after a partial migration). Any `.replace()` call on a possibly-
 * undefined field MUST go through this helper — otherwise the whole feed 500s
 * with "Cannot read properties of undefined (reading 'replace')" and the UI
 * shows a useless error banner.
 */
function humanize(value: string | undefined | null, fallback = 'unknown'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.replace(/_/g, ' ');
}

/**
 * Deep-link builder. The case page routes via `?tab=` (see
 * `packages/frontend/src/app/cases/[caseId]/page.tsx`), so hash-based links
 * don't actually land on the right tab. We encode the target tab (and, for
 * dossier sub-sections, the section + entity id) as query params.
 */
function caseHref(caseId: string, query?: Record<string, string | undefined>): string {
  const base = `/cases/${caseId}`;
  if (!query) return base;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value.length > 0) qs.set(key, value);
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

function titleFor(caseId: string, caseMap: Map<string, Case>): string | undefined {
  return caseMap.get(caseId)?.title;
}

function projectFor(caseId: string, caseMap: Map<string, Case>): string | undefined {
  return caseMap.get(caseId)?.project_id;
}

/**
 * Derive the "case was opened by a detector" signal from the parent
 * Case row. The Case shape doesn't carry a dedicated `detector_opened` flag
 * yet, so we infer it from the case owner — `system:arbitra-intelligence`
 * cases are detector-opened (the only system actor that creates cases via
 * the intelligence scheduler). Webhook-opened cases own to `'system'` and
 * intentionally don't qualify (the webhook is not the *signal*; it's just
 * the ingest path for a human-authored PR). Returns `false` for unknown
 * cases so the Signal rules don't accidentally Signal-promote rows for
 * cases we couldn't load.
 */
function caseWasDetectorOpened(caseId: string, caseMap: Map<string, Case>): boolean {
  const c = caseMap.get(caseId);
  if (!c) return false;
  return c.owner_user_id === 'system:arbitra-intelligence';
}

function projectNameFor(
  caseId: string,
  caseMap: Map<string, Case>,
  projectMap: Map<string, string>,
): string | undefined {
  const projectId = caseMap.get(caseId)?.project_id;
  if (!projectId) return undefined;
  return projectMap.get(projectId);
}

export function normalizeEvent(
  event: CaseEvent,
  caseMap: Map<string, Case>,
  projectMap: Map<string, string> = new Map(),
): ActivityEntry {
  const projectName = projectNameFor(event.case_id, caseMap, projectMap);
  const envelope = envelopeForCaseEvent(event, {
    caseStatus: caseMap.get(event.case_id)?.status,
    caseDetectorOpened: caseWasDetectorOpened(event.case_id, caseMap),
  });
  const preview = decisionEventPreview(event);
  return {
    id: `event:${event.event_id}`,
    kind: 'case_event',
    subkind: event.type as string,
    timestamp: event.created_at,
    case_id: event.case_id,
    case_title: titleFor(event.case_id, caseMap),
    project_id: projectFor(event.case_id, caseMap),
    ...(projectName ? { project_name: projectName } : {}),
    actor_user_id: event.actor_id,
    summary: summarizeEvent(event),
    href: caseHref(event.case_id, { tab: 'timeline' }),
    ...envelope,
    ...(preview ? { preview } : {}),
  };
}

export function normalizeComment(
  comment: Comment,
  caseMap: Map<string, Case>,
  findingToCase: Map<string, string>,
  projectMap: Map<string, string> = new Map(),
): ActivityEntry | null {
  const caseId =
    comment.parent_type === 'case'
      ? comment.parent_id
      : findingToCase.get(comment.parent_id);
  if (!caseId) return null;
  // Verb-phrase fragment. For case-scoped comments the
  // renderer appends the case title (so the row reads "Alex commented on
  // *{title}*"); finding-scoped comments still resolve up to a case but the
  // copy makes the finding scope explicit.
  const summary =
    comment.parent_type === 'case' ? 'commented on' : 'commented on a finding on';
  const projectName = projectNameFor(caseId, caseMap, projectMap);
  const href =
    comment.parent_type === 'case'
      ? caseHref(caseId, { tab: 'comments', comment: comment.comment_id })
      : caseHref(caseId, {
          tab: 'dossier',
          section: 'findings',
          finding: comment.parent_id,
          comment: comment.comment_id,
        });
  return {
    id: `comment:${comment.comment_id}`,
    kind: 'comment',
    subkind: comment.parent_type,
    timestamp: comment.created_at,
    case_id: caseId,
    case_title: titleFor(caseId, caseMap),
    project_id: projectFor(caseId, caseMap),
    ...(projectName ? { project_name: projectName } : {}),
    actor_user_id: comment.author_id,
    actor_metadata: comment.actor_metadata,
    comment_id: comment.comment_id,
    ...(comment.parent_type === 'finding' ? { finding_id: comment.parent_id } : {}),
    summary,
    href,
    ...envelopeForComment(comment, caseId),
  };
}

/**
 * Strip the JSON payload tail from an evidence `summary` when it was produced
 * by the intelligence scheduler (detection_report encoding — see
 * `formatEvidenceSummary` in intelligence-service.ts). Returns the raw summary
 * unchanged when no delimiter is present so legacy / non-intelligence evidence
 * keeps working untouched.
 */
function stripEvidenceSummaryTail(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    return parseEvidenceSummary(raw).summary;
  } catch {
    return raw;
  }
}

export function normalizeEvidence(
  ev: Evidence,
  caseMap: Map<string, Case>,
  projectMap: Map<string, string> = new Map(),
): ActivityEntry {
  const projectName = projectNameFor(ev.case_id, caseMap, projectMap);
  const humanSummary = stripEvidenceSummaryTail(ev.summary);
  return {
    id: `evidence:${ev.evidence_id}`,
    kind: 'evidence',
    ...(ev.type ? { subkind: ev.type } : {}),
    timestamp: ev.created_at,
    case_id: ev.case_id,
    case_title: titleFor(ev.case_id, caseMap),
    project_id: projectFor(ev.case_id, caseMap),
    ...(projectName ? { project_name: projectName } : {}),
    actor_user_id: ev.created_by,
    actor_metadata: ev.actor_metadata,
    evidence_id: ev.evidence_id,
    summary: humanSummary
      ? `registered evidence — ${humanSummary}`
      : `registered evidence (${humanize(ev.type, 'unspecified type')})`,
    href: caseHref(ev.case_id, {
      tab: 'dossier',
      section: 'evidence',
      evidence: ev.evidence_id,
    }),
    ...envelopeForEvidence(ev),
  };
}

export function normalizeFinding(
  f: Finding,
  caseMap: Map<string, Case>,
  projectMap: Map<string, string> = new Map(),
): ActivityEntry {
  const projectName = projectNameFor(f.case_id, caseMap, projectMap);
  return {
    id: `finding:${f.finding_id}`,
    kind: 'finding',
    ...(f.severity ? { subkind: f.severity } : {}),
    timestamp: f.created_at,
    case_id: f.case_id,
    case_title: titleFor(f.case_id, caseMap),
    project_id: projectFor(f.case_id, caseMap),
    ...(projectName ? { project_name: projectName } : {}),
    actor_user_id: undefined,
    finding_id: f.finding_id,
    summary: `finding (${f.severity ?? 'unknown severity'}) — ${f.title ?? 'untitled'}`,
    href: caseHref(f.case_id, {
      tab: 'dossier',
      section: 'findings',
      finding: f.finding_id,
    }),
    ...envelopeForFinding(f),
  };
}

export function normalizeDecision(
  d: Decision,
  caseMap: Map<string, Case>,
  projectMap: Map<string, string> = new Map(),
): ActivityEntry {
  const projectName = projectNameFor(d.case_id, caseMap, projectMap);
  return {
    id: `decision:${d.decision_id}`,
    kind: 'decision',
    ...(d.type ? { subkind: d.type } : {}),
    timestamp: d.created_at,
    case_id: d.case_id,
    case_title: titleFor(d.case_id, caseMap),
    project_id: projectFor(d.case_id, caseMap),
    ...(projectName ? { project_name: projectName } : {}),
    actor_user_id: d.actor_id,
    ...(d.actor_metadata ? { actor_metadata: d.actor_metadata } : {}),
    decision_id: d.decision_id,
    ...(d.finding_id ? { finding_id: d.finding_id } : {}),
    summary: humanDecisionLabel(d.type, !!d.finding_id),
    href: caseHref(d.case_id, {
      tab: 'dossier',
      section: 'decisions',
      decision: d.decision_id,
    }),
    ...envelopeForDecision(d),
  };
}

/**
 * Normalize a workspace-level event (e.g. a scheduled intelligence run) into
 * an ActivityEntry. These are NOT case-scoped: `case_id` is empty and `href`
 * is empty so the frontend renderer skips the usual case link. Consumers
 * that want to deep-link elsewhere (e.g. an Intelligence dashboard) can
 * branch on `subkind` later.
 */
export function normalizeWorkspaceEvent(event: WorkspaceEvent): ActivityEntry {
  return {
    id: `workspace_event:${event.event_id}`,
    kind: 'workspace_event',
    subkind: event.type,
    timestamp: event.timestamp,
    // No case — leave as empty string so renderers can detect and skip the
    // case link. Using empty over undefined keeps the type surface stable.
    case_id: '',
    actor_user_id: event.actor_user_id,
    ...(event.actor_metadata ? { actor_metadata: event.actor_metadata } : {}),
    summary: event.summary,
    // No href: workspace events don't have a canonical landing page yet.
    // Phase 2 could route to an Intelligence settings / run-history page.
    href: '',
    ...envelopeForWorkspaceEvent(event),
  };
}

/**
 * Verb-phrase fragments for decision rows. Actor is rendered first by the
 * frontend, the case title appears at the tail. `onFinding=true` swaps copy for the
 * finding-scoped variant so the row makes the finding context explicit
 * (e.g. "waived a finding on *{caseTitle}*", "requested changes on a
 * finding on *{caseTitle}*"). `false` keeps the case-scoped copy
 * ("approved the case", "rejected the case").
 */
function humanDecisionLabel(type: string | undefined, onFinding: boolean): string {
  if (!type) return onFinding ? 'recorded a decision on a finding on' : 'recorded a decision on';
  if (onFinding) {
    switch (type) {
      case 'approve':
        return 'approved a finding on';
      case 'auto_approve':
        return 'auto-approved a finding on';
      case 'reject':
        return 'rejected a finding on';
      case 'request_changes':
        return 'requested changes on a finding on';
      case 'waive':
        return 'waived a finding on';
      case 'escalate':
        return 'escalated a finding on';
      case 'manual_validation_confirmed':
        return 'confirmed manual validation of a finding on';
      case 'merge_not_applicable':
        return 'marked merge as not applicable for a finding on';
      case 'review_not_applicable':
        return 'marked review as not applicable for a finding on';
      case 'gate_confirmed':
        return 'confirmed a gate on a finding on';
      case 'gate_rejected':
        return 'rejected a gate on a finding on';
      case 'waived_on_completion':
        // System-authored, not a human waive: the case reached `done` while
        // this proposal was still unconfirmed, so the pipeline closed it
        // administratively (issue #751). Distinct phrasing from `waive` on
        // purpose — nobody actually confirmed this one.
        return 'closed an unconfirmed waiver proposal at completion for a finding on';
      default:
        return `${humanize(type, 'recorded')} a finding on`;
    }
  }
  switch (type) {
    case 'approve':
      return 'approved';
    case 'auto_approve':
      return 'auto-approved';
    case 'reject':
      return 'rejected';
    case 'request_changes':
      return 'requested changes on';
    case 'waive':
      return 'waived';
    case 'escalate':
      return 'escalated';
    case 'manual_validation_confirmed':
      return 'confirmed manual validation of';
    case 'merge_not_applicable':
      return 'marked merge as not applicable for';
    case 'review_not_applicable':
      return 'marked review as not applicable for';
    case 'gate_confirmed':
      return 'confirmed the gate on';
    case 'gate_rejected':
      return 'rejected the gate on';
    default:
      return `${humanize(type, 'recorded a decision on')}`;
  }
}

function summarizeEvent(event: CaseEvent): string {
  const p = event.payload;
  const type = String(event.type);
  // Verb-phrase fragments. The frontend renders the row as
  // `{Actor} {summary} {caseTitle}`,
  // so each phrase here is a past-simple verb that takes the case title as
  // its direct object — e.g. "opened", "started a build on", "completed
  // exploration of". Detector-opened `case_created` rows are routed in the
  // renderer to a dedicated "Arbitra flagged …" branch and never use this
  // summary directly.
  switch (type) {
    case 'case_created':
      return 'opened';
    case 'case_approved':
      return 'approved';
    case 'case_rejected':
      return 'rejected';
    case 'case_completed':
      return 'completed';
    case 'case_ready_for_build':
      // Embedded-title verb phrase: the case title is rendered between
      // "marked" and "ready for build" via the {title} placeholder. The
      // renderer in `activity-entry-row.tsx` splits on this token; phrases
      // without it fall through to the default `{summary} {title}` layout.
      return 'marked {title} ready for build';
    case 'build_started':
      return 'started a build on';
    case 'exploration_completed':
      return 'completed exploration of';
    case 'exploration_requested':
      return 'requested exploration of';
    case 'review_completed':
      return 'completed AI review of';
    case 'run_completed': {
      const runType = typeof p['run_type'] === 'string' ? p['run_type'] : 'run';
      const status = typeof p['status'] === 'string' ? p['status'] : 'completed';
      return `${status} ${String(runType).replace(/_/g, ' ')} on`;
    }
    case 'run_failed':
      return 'saw a run fail on';
    case 'changes_requested':
      return 'requested changes on';
    case 'human_decision_requested':
      return 'requested a human decision on';
    case 'decision_created':
      // Headline verb only; the decision type goes in the sub-line preview
      // (see `decisionEventPreview` / `normalizeEvent`).
      return 'recorded a decision on';
    case 'webhook_rejected':
      return 'rejected an incoming webhook for';
    case 'status_changed': {
      const to = typeof p['to_status'] === 'string' ? p['to_status'] : '';
      // Natural-language verb phrase ("{Actor} {verb} {title}").
      // The case title is rendered separately by the row, so this phrase reads
      // e.g. "Alice changed status to in review *Case X*". Avoid arrow syntax
      // (`status → X`) which broke the grammar.
      return to ? `changed status to ${to.replace(/_/g, ' ')}` : 'changed the status of';
    }
    case 'case_anomaly_merge_on_gated_status': {
      const prNumber = typeof p['pr_number'] === 'number' ? p['pr_number'] : undefined;
      const status = typeof p['source_status'] === 'string' ? p['source_status'] : undefined;
      const prLabel = prNumber ? `PR #${prNumber}` : 'PR';
      const statusLabel = status ? status.replace(/_/g, ' ') : 'a gated status';
      return `anomaly: ${prLabel} merged while case in ${statusLabel} — not auto-closed`;
    }
    default:
      return type.replace(/_/g, ' ');
  }
}

/**
 * Sub-line preview for a `decision_created` case_event row (decision rows
 * carry a concise sub-line under the headline). The event payload carries
 * `{ decision_id, type }` (see `decision-service.ts`); we surface a friendly
 * "Decision: <type>" teaser. Returns `undefined` for non-`decision_created`
 * events and for events with no usable `type`, so the field can be omitted from
 * the entry shape. Distinct from the standalone `decision` row's preview (which
 * comes from the decision's rationale via `envelopeForDecision`).
 */
function decisionEventPreview(event: CaseEvent): string | undefined {
  if (String(event.type) !== 'decision_created') return undefined;
  const type = event.payload['type'];
  if (typeof type !== 'string' || type.length === 0) return 'Decision recorded';
  return `Decision: ${humanize(type, 'recorded')}`;
}

// ---------------------------------------------------------------------------
// Query filters
// ---------------------------------------------------------------------------

/**
 * Post-fetch filter applied to merged entries. Extracted as a pure function
 * so it can be unit-tested without Firestore. Matches `listActivity`'s
 * filtering semantics exactly.
 */
export function applyActivityFilters(
  entries: ActivityEntry[],
  options: Pick<ListActivityOptions, 'since' | 'before' | 'agentsOnly' | 'clientName'>,
): ActivityEntry[] {
  let filtered = entries;
  if (options.since) {
    filtered = filtered.filter((e) => e.timestamp > options.since!);
  }
  if (options.before) {
    filtered = filtered.filter((e) => e.timestamp < options.before!);
  }
  if (options.agentsOnly) {
    filtered = filtered.filter((e) => !!e.actor_metadata?.client_name);
  }
  if (options.clientName) {
    const needle = options.clientName.trim().toLowerCase();
    filtered = filtered.filter(
      (e) => (e.actor_metadata?.client_name ?? '').toLowerCase() === needle,
    );
  }
  return filtered;
}

export interface ListActivityOptions {
  /** Max entries in the returned slice (truncated post-merge). */
  limit?: number;
  /** Only return entries newer than this ISO timestamp. */
  since?: string;
  /** Only return entries strictly older than this ISO timestamp (pagination). */
  before?: string;
  /** Filter by actor_metadata.client_name. */
  clientName?: string;
  /** Filter by project_id. */
  projectId?: string;
  /** Only return entries where `actor_metadata.client_name` is set. */
  agentsOnly?: boolean;
}

export interface ListActivityResult {
  entries: ActivityEntry[];
  cursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Load the viewer's workspace-event dismissal ids. Inlined here (rather
 * than importing `WorkspaceEventService`) to avoid a circular dep between
 * activity-service and workspace-event-service through the shared barrel.
 */
async function listDismissedWorkspaceEventIdsForUser(userId: string): Promise<Set<string>> {
  const snap = await collections.workspaceEventDismissals()
    .where('user_id', '==', userId)
    .get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data?.event_id) ids.add(data.event_id);
  }
  return ids;
}

/** Chunk size for a Firestore `__name__ in [...]` (`FieldPath.documentId()`)
 *  lookup — the SDK caps an `in` clause at 30 values. */
const IN_CLAUSE_CHUNK = 30;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/** The since/before pair every feed sub-query bounds itself by. */
interface FeedCursor {
  since?: string;
  before?: string;
}

/**
 * One activity feed collection, bounded in Firestore instead of in memory.
 * Orders by `field` desc (the collection's normalized-timestamp field —
 * `created_at` for every feed except `workspace_events`, which uses
 * `timestamp`), applies `cursor.since`/`cursor.before` as a range filter on
 * that SAME field, then caps at `max` rows. A single-field index already
 * covers a range filter plus an orderBy on one field, so this needs no
 * `firestore.indexes.json` change.
 */
function feedQuery<T>(
  col: FirebaseFirestore.Query<T>,
  field: string,
  max: number,
  cursor: FeedCursor,
): Promise<FirebaseFirestore.QuerySnapshot<T>> {
  let q = col.orderBy(field, 'desc');
  if (cursor.since) q = q.where(field, '>', cursor.since);
  if (cursor.before) q = q.where(field, '<', cursor.before);
  return q.limit(max).get();
}

/**
 * Fan out the 6 activity feed collections, each bounded in Firestore by
 * `since`/`before` on its own normalized-timestamp field, then resolve the
 * cases/findings/projects those rows actually reference — never scan them.
 *
 * ## Read profile
 *
 * - **Idle since-tick** (the common case: an open SSE tab polling every 2s
 *   with nothing new) — 6 reads, one `get()` per feed collection, each
 *   returning 0 docs. Firestore charges one read for an empty query result,
 *   so this is 6 reads total, flat, regardless of workspace size. Neither
 *   `cases` nor `projects` nor `findings`-by-id is touched.
 * - **Active since-tick** — the 6 feed reads plus exactly the cases,
 *   findings, and projects those new rows reference, resolved by id in
 *   chunks of `IN_CLAUSE_CHUNK`. A comment on a finding older than the feed
 *   page is resolved on demand (see below) rather than dropped.
 * - **Initial load** (no `since`) — up to `2 × limit` docs per feed
 *   collection (case_events/comments/evidence/decisions), up to
 *   `max(4 × limit, 200)` findings, plus the referenced cases and projects
 *   by id — never the full `cases`/`projects` collections.
 *
 * `before` now bounds the same way `since` does: a query-level `<` filter,
 * not an in-memory one. That means deep backward pagination past the first
 * `2 × limit` docs of a collection now returns the next page of real rows
 * instead of going empty the moment the in-memory window ran out.
 *
 * ## Why a comment can need an on-demand finding lookup
 *
 * The `findings` feed query is bounded by the same `since`/`before` cursor
 * as every other feed, so it only carries findings created in-window. A
 * comment on an OLDER finding (the common case once `since` narrows the
 * window) would resolve to no case at all through that page alone — so any
 * comment whose `parent_id` isn't in the fetched findings gets its finding
 * doc resolved directly by id (chunked `documentId() in [...]`) before the
 * case join, exactly as `countCaseTransitionsForRequester`
 * (`tool-reads.ts`) resolves event case ids by chunked lookup rather than a
 * full scan.
 */
export async function listActivity(
  userId: string,
  admin: boolean,
  options: ListActivityOptions = {},
): Promise<ListActivityResult> {
  const limit = clampLimit(options.limit);
  const cursor: FeedCursor = { since: options.since, before: options.before };
  const feedMax = limit * 2;
  const findingsMax = Math.max(limit * 4, 200);

  const [eventsSnap, commentsSnap, evidenceSnap, decisionsSnap, findingsSnap, workspaceEventsSnap] =
    await Promise.all([
      feedQuery(collections.caseEvents(), 'created_at', feedMax, cursor),
      feedQuery(collections.comments(), 'created_at', feedMax, cursor),
      feedQuery(collections.evidence(), 'created_at', feedMax, cursor),
      feedQuery(collections.decisions(), 'created_at', feedMax, cursor),
      feedQuery(collections.findings(), 'created_at', findingsMax, cursor),
      feedQuery(collections.workspaceEvents(), 'timestamp', feedMax, cursor),
    ]);

  // Idle-tick fast path: nothing changed since the last poll. Zero further
  // reads — no case, project, or on-demand finding lookups.
  if (
    eventsSnap.docs.length === 0
    && commentsSnap.docs.length === 0
    && evidenceSnap.docs.length === 0
    && decisionsSnap.docs.length === 0
    && findingsSnap.docs.length === 0
    && workspaceEventsSnap.docs.length === 0
  ) {
    return { entries: [], cursor: null };
  }

  const events = eventsSnap.docs.map((d) => d.data());
  const comments = commentsSnap.docs.map((d) => d.data());
  const evidenceRows = evidenceSnap.docs.map((d) => d.data());
  const decisions = decisionsSnap.docs.map((d) => d.data());
  const findings = findingsSnap.docs.map((d) => d.data());

  // Finding -> case map so comments scoped to a finding resolve back to a
  // case. Seeded from the bounded findings page, then extended by an
  // on-demand id lookup for any comment whose finding fell outside it.
  const findingToCase = new Map<string, string>(findings.map((f) => [f.finding_id, f.case_id]));
  const missingFindingIds = [...new Set(
    comments
      .filter((c) => c.parent_type !== 'case' && !findingToCase.has(c.parent_id))
      .map((c) => c.parent_id),
  )];
  if (missingFindingIds.length > 0) {
    const resolvedFindingSnaps = await Promise.all(
      chunk(missingFindingIds, IN_CLAUSE_CHUNK).map((ids) =>
        collections.findings().where(FieldPath.documentId(), 'in', ids).get(),
      ),
    );
    for (const snap of resolvedFindingSnaps) {
      for (const doc of snap.docs) {
        const f = doc.data();
        findingToCase.set(f.finding_id, f.case_id);
      }
    }
  }

  // Distinct case ids referenced by every source that can name one.
  const caseIds = new Set<string>();
  for (const event of events) caseIds.add(event.case_id);
  for (const ev of evidenceRows) caseIds.add(ev.case_id);
  for (const d of decisions) caseIds.add(d.case_id);
  for (const f of findings) caseIds.add(f.case_id);
  for (const c of comments) {
    const caseId = c.parent_type === 'case' ? c.parent_id : findingToCase.get(c.parent_id);
    if (caseId) caseIds.add(caseId);
  }

  // Resolve exactly those cases by id — `activeCases()` keeps the same
  // `deleted_at == null` soft-delete semantics a full-collection scan had.
  // Workspace events are global (not case-scoped); fetch this viewer's
  // dismissals only when there's a workspace-event row to filter and only
  // when a project filter isn't already hiding them outright (see below).
  // Awaited together with the case lookup (not created as an early,
  // unawaited promise) so a rejection is handled here rather than left
  // dangling across the intervening await turns above — Node's default
  // `--unhandled-rejections=throw` would otherwise crash the process. Both
  // reads still run in parallel via `Promise.all`.
  const needsDismissals = !options.projectId && workspaceEventsSnap.docs.length > 0;
  const [caseSnaps, dismissedWorkspaceEventIds] = await Promise.all([
    caseIds.size > 0
      ? Promise.all(
          chunk([...caseIds], IN_CLAUSE_CHUNK).map((ids) =>
            collections.activeCases().where(FieldPath.documentId(), 'in', ids).get(),
          ),
        )
      : Promise.resolve([]),
    needsDismissals ? listDismissedWorkspaceEventIdsForUser(userId) : Promise.resolve(new Set<string>()),
  ]);
  let cases: Case[] = caseSnaps.flatMap((snap) => snap.docs.map((d) => d.data()));

  // Referenced project ids come from the resolved cases only — never a full
  // `projects` scan.
  const referencedProjectIds = new Set<string>();
  for (const c of cases) {
    if (c.project_id) referencedProjectIds.add(c.project_id);
  }
  let projects: Project[] = [];
  if (referencedProjectIds.size > 0) {
    const projectSnaps = await Promise.all(
      chunk([...referencedProjectIds], IN_CLAUSE_CHUNK).map((ids) =>
        collections.projects().where(FieldPath.documentId(), 'in', ids).get(),
      ),
    );
    projects = projectSnaps.flatMap((snap) => snap.docs.map((d) => d.data()));
  }
  const projectMap = new Map<string, string>(projects.map((p) => [p.project_id, p.name] as const));

  // Non-admin access is computed straight off the resolved project docs with
  // the exact predicate `getAccessibleProjectIds` applies to every project —
  // no full-workspace project scan needed to get the same answer.
  if (!admin) {
    const projectById = new Map(projects.map((p) => [p.project_id, p] as const));
    cases = cases.filter((c) => {
      const project = projectById.get(c.project_id);
      return project !== undefined && isEffectiveMember(project, userId);
    });
  }

  if (options.projectId) {
    cases = cases.filter((c) => c.project_id === options.projectId);
  }

  const accessibleCaseIds = new Set(cases.map((c) => c.case_id));
  const caseMap = new Map(cases.map((c) => [c.case_id, c] as const));

  const entries: ActivityEntry[] = [];

  for (const event of events) {
    if (!accessibleCaseIds.has(event.case_id)) continue;
    entries.push(normalizeEvent(event, caseMap, projectMap));
  }

  for (const comment of comments) {
    const row = normalizeComment(comment, caseMap, findingToCase, projectMap);
    if (!row) continue;
    if (!accessibleCaseIds.has(row.case_id)) continue;
    entries.push(row);
  }

  for (const ev of evidenceRows) {
    if (!accessibleCaseIds.has(ev.case_id)) continue;
    entries.push(normalizeEvidence(ev, caseMap, projectMap));
  }

  for (const f of findings) {
    if (!accessibleCaseIds.has(f.case_id)) continue;
    entries.push(normalizeFinding(f, caseMap, projectMap));
  }

  for (const d of decisions) {
    if (!accessibleCaseIds.has(d.case_id)) continue;
    entries.push(normalizeDecision(d, caseMap, projectMap));
  }

  // Workspace events are global by design — skip case-access filtering.
  // Project filter also bypasses them: a user explicitly filtering by project
  // probably wants per-project noise, so hide system rows in that case.
  // Additionally filter out (a) globally resolved events (hidden from
  // everyone) and (b) events this viewer has dismissed for themselves.
  if (!options.projectId) {
    for (const we of workspaceEventsSnap.docs.map((d) => d.data())) {
      if (we.resolved_at) continue;
      if (dismissedWorkspaceEventIds.has(we.event_id)) continue;
      entries.push(normalizeWorkspaceEvent(we));
    }
  }

  // Apply soft filters (since/before/agentsOnly/clientName) as an in-memory
  // safety net — the query-level bound above already does the heavy lifting,
  // this just keeps behavior identical for anything a query filter alone
  // can't express. Filter logic lives in `applyActivityFilters` so it's
  // unit-testable in isolation.
  const filtered = applyActivityFilters(entries, options).slice();

  filtered.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const sliced = filtered.slice(0, limit);
  const resultCursor = sliced.length > 0 ? sliced[sliced.length - 1]!.timestamp : null;

  return { entries: sliced, cursor: resultCursor };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<ActivityLeaderboardWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function cutoffFor(window: ActivityLeaderboardWindow): string {
  return new Date(Date.now() - WINDOW_MS[window]).toISOString();
}

interface LeaderboardRow {
  kind: ActivityKind;
  timestamp: string;
  case_id: string;
  actor_meta?: { client_name?: string; client_version?: string; model?: string };
  /** Only for kind = 'case_event' with subkind = 'case_created'. */
  is_case_created?: boolean;
  /**
   * For evidence rows: the `source_type` on the Firestore doc. Used to split
   * actor-less evidence into meaningful buckets (`automated` / `webhook` /
   * `manual`) instead of dumping everything into "Humans".
   */
  evidence_source_type?: 'automated' | 'manual' | 'webhook' | 'agent';
  /**
   * For case_event / finding / decision / comment rows: the raw `actor_user_id`
   * on the Firestore doc. When `actor_meta` is absent we use this to split
   * `system`-authored rows from truly human rows (e.g. decisions written by
   * the scheduler with `actor_id = "system:arbitra-intelligence"`).
   */
  actor_user_id?: string;
  /**
   * For decision rows: the `type` field on the Firestore doc (e.g. `approve`,
   * `manual_validation_confirmed`). Used by the leaderboard pair-collapse to
   * recognize the manual-track auto-attach pattern.
   */
  decision_type?: string;
}

/**
 * Resolve the synthetic `client_name` for rows that don't carry
 * `actor_metadata.client_name`. Returns one of:
 *
 * - `automated` — CI / pipeline-authored evidence (source_type === 'automated')
 * - `webhook`   — webhook-authored evidence (source_type === 'webhook')
 * - `system`    — system-authored events (actor_user_id === 'system' or
 *                 starts with 'system:')
 * - `human`     — everything else (manual evidence, human-authored events)
 *
 * Keep this in sync with `CLIENT_DISPLAY_MAP` in the frontend so the UI has a
 * label for each sentinel.
 */
function resolveSyntheticClientName(row: LeaderboardRow): string {
  if (row.kind === 'evidence') {
    if (row.evidence_source_type === 'automated') return 'automated';
    if (row.evidence_source_type === 'webhook') return 'webhook';
    // `manual` → true human attestation. `agent` rows should carry
    // actor_metadata upstream; if they somehow don't, fall through to human.
    return 'human';
  }
  const uid = row.actor_user_id;
  if (uid && (uid === 'system' || uid.startsWith('system:'))) return 'system';
  return 'human';
}

function rowKey(row: LeaderboardRow): string {
  const actor = row.actor_meta;
  const name = actor?.client_name ?? resolveSyntheticClientName(row);
  const version = actor?.client_version ?? '';
  const model = actor?.model ?? '';
  return `${name}||${version}||${model}`;
}

function resolveSourceKind(row: LeaderboardRow): ActivityLeaderboardSourceKind {
  if (row.actor_meta?.client_name) return 'client';
  return resolveSyntheticClientName(row) as Exclude<ActivityLeaderboardSourceKind, 'client'>;
}

function emptyLeaderboardCounts(): ActivityLeaderboardCounts {
  return {
    cases_created: 0,
    comments: 0,
    evidence: 0,
    findings: 0,
    decisions: 0,
    workspace_events: 0,
    total: 0,
  };
}

function incrementLeaderboardCounts(
  counts: ActivityLeaderboardCounts,
  row: Pick<LeaderboardRow, 'kind'>,
): void {
  switch (row.kind) {
    case 'case_event':
      counts.cases_created += 1;
      break;
    case 'comment':
      counts.comments += 1;
      break;
    case 'evidence':
      counts.evidence += 1;
      break;
    case 'finding':
      counts.findings += 1;
      break;
    case 'decision':
      counts.decisions += 1;
      break;
    case 'workspace_event':
      counts.workspace_events += 1;
      break;
  }
  counts.total += 1;
}

/**
 * Manual-track approve auto-attach pair tolerance, in milliseconds. The
 * `decision-service.ts` approve handler writes a `manual_validation_confirmed`
 * decision and then the user-driven `approve` decision in quick succession
 * with two separate `new Date().toISOString()` calls. The pair shares
 * case_id + actor_id + actor_metadata, but timestamps differ by the time
 * between the two writes. Five seconds is generous enough to absorb slow
 * Firestore writes / clock jitter while staying well below any realistic
 * interval between two genuinely separate human clicks. The dedup is also
 * type-anchored (approve + manual_validation_confirmed specifically), so this
 * tolerance can't false-positive on consecutive approves.
 */
const MANUAL_TRACK_PAIR_TOLERANCE_MS = 5_000;

function actorMetaSignature(meta: LeaderboardRow['actor_meta']): string {
  if (!meta) return '';
  return `${meta.client_name ?? ''}||${meta.client_version ?? ''}||${meta.model ?? ''}`;
}

/**
 * Drop the auto-attached `manual_validation_confirmed` half of the
 * manual-track approve pair. On a manual-track approve, `decision-service.ts`
 * writes two decisions (the auto-attached confirmation + the user-driven
 * approve) sharing case_id + actor_id + actor_metadata; both inherit the
 * caller's actor_metadata so they bucket under the same per-client name.
 * Without this collapse, one click counts twice in the per-client leaderboard.
 *
 * The audit trail is unaffected — both rows still exist in Firestore and on
 * the Decision-history listing. This dedup is purely for leaderboard /
 * activity-view aggregations.
 *
 * Predicate (must match all): both kind = 'decision'; types are the
 * (approve, manual_validation_confirmed) set; same case_id; same
 * actor_user_id; same actor_metadata signature; timestamps within
 * MANUAL_TRACK_PAIR_TOLERANCE_MS. We keep the `approve` row (the
 * user-driven click) and drop the `manual_validation_confirmed` row.
 */
function dropManualTrackAutoAttachPairs(rows: LeaderboardRow[]): LeaderboardRow[] {
  // Index approve rows by (case_id|actor_user_id|actor_meta_signature) so each
  // candidate manual_validation_confirmed can find its mate in O(1) and we
  // only consume each approve once (preventing collapse of three+ same-actor
  // rows clustered in time).
  const approvesByKey = new Map<string, LeaderboardRow[]>();
  for (const row of rows) {
    if (row.kind !== 'decision' || row.decision_type !== 'approve') continue;
    if (!row.actor_user_id) continue;
    const key = `${row.case_id}||${row.actor_user_id}||${actorMetaSignature(row.actor_meta)}`;
    const list = approvesByKey.get(key);
    if (list) list.push(row);
    else approvesByKey.set(key, [row]);
  }

  const consumedApproves = new Set<LeaderboardRow>();
  const droppedConfirmations = new Set<LeaderboardRow>();

  for (const row of rows) {
    if (row.kind !== 'decision') continue;
    if (row.decision_type !== 'manual_validation_confirmed') continue;
    if (!row.actor_user_id) continue;
    const key = `${row.case_id}||${row.actor_user_id}||${actorMetaSignature(row.actor_meta)}`;
    const candidates = approvesByKey.get(key);
    if (!candidates || candidates.length === 0) continue;
    const confirmTs = Date.parse(row.timestamp);
    if (Number.isNaN(confirmTs)) continue;
    // Pick the closest unconsumed approve within tolerance. Closest-first keeps
    // the pairing stable when multiple approves cluster (rare, but safe).
    let best: LeaderboardRow | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const approve of candidates) {
      if (consumedApproves.has(approve)) continue;
      const approveTs = Date.parse(approve.timestamp);
      if (Number.isNaN(approveTs)) continue;
      const delta = Math.abs(approveTs - confirmTs);
      if (delta <= MANUAL_TRACK_PAIR_TOLERANCE_MS && delta < bestDelta) {
        best = approve;
        bestDelta = delta;
      }
    }
    if (best) {
      consumedApproves.add(best);
      droppedConfirmations.add(row);
    }
  }

  if (droppedConfirmations.size === 0) return rows;
  return rows.filter((r) => !droppedConfirmations.has(r));
}

/**
 * Aggregate rows into leaderboard counts grouped by
 * `client_name + client_version + model`. Rows without `client_name` are
 * bucketed by a synthetic sentinel resolved from source_type (evidence) or
 * actor_user_id (other kinds): one of `automated`, `webhook`, `system`, or
 * `human`. This keeps actor-less CI writes out of the "Humans" bucket.
 */
export function aggregateLeaderboard(rows: LeaderboardRow[]): ActivityLeaderboardRow[] {
  rows = dropManualTrackAutoAttachPairs(rows);
  const buckets = new Map<string, ActivityLeaderboardRow>();

  for (const row of rows) {
    // Skip case_events that aren't `case_created` — only creation counts toward
    // the leaderboard. Do this BEFORE creating a bucket so non-counting events
    // never materialize an empty row.
    if (row.kind === 'case_event' && !row.is_case_created) continue;

    const key = rowKey(row);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        source_kind: resolveSourceKind(row),
        client_name: row.actor_meta?.client_name ?? resolveSyntheticClientName(row),
        ...(row.actor_meta?.client_version
          ? { client_version: row.actor_meta.client_version }
          : {}),
        ...(row.actor_meta?.model ? { model: row.actor_meta.model } : {}),
        counts: emptyLeaderboardCounts(),
      };
      buckets.set(key, bucket);
    }

    incrementLeaderboardCounts(bucket.counts, row);
  }

  return [...buckets.values()].sort((a, b) => b.counts.total - a.counts.total);
}

/**
 * Aggregate case-scoped rows into project activity. Workspace events are
 * excluded because they are not attributable to a project.
 */
export function aggregateProjectLeaderboard(
  rows: LeaderboardRow[],
  caseMap: Map<string, Case>,
  projectMap: Map<string, string> = new Map(),
): ActivityProjectLeaderboardRow[] {
  rows = dropManualTrackAutoAttachPairs(rows);
  const buckets = new Map<
    string,
    ActivityProjectLeaderboardRow & { active_case_ids: Set<string> }
  >();

  for (const row of rows) {
    if (row.kind === 'workspace_event') continue;
    if (row.kind === 'case_event' && !row.is_case_created) continue;

    const projectId = caseMap.get(row.case_id)?.project_id;
    if (!projectId) continue;

    let bucket = buckets.get(projectId);
    if (!bucket) {
      bucket = {
        project_id: projectId,
        ...(projectMap.get(projectId) ? { project_name: projectMap.get(projectId) } : {}),
        active_cases: 0,
        counts: emptyLeaderboardCounts(),
        active_case_ids: new Set<string>(),
      };
      buckets.set(projectId, bucket);
    }

    bucket.active_case_ids.add(row.case_id);
    incrementLeaderboardCounts(bucket.counts, row);
  }

  return [...buckets.values()]
    .map(({ active_case_ids, ...bucket }) => ({
      ...bucket,
      active_cases: active_case_ids.size,
    }))
    .sort((a, b) => b.counts.total - a.counts.total);
}

/**
 * Safety cap on each of the six windowed leaderboard scans below. A
 * workspace producing more than this many comments/evidence/decisions/
 * findings/case-creations/workspace-events inside a single 24h/7d/30d window
 * is already far outside normal usage; the cap bounds one call's worst-case
 * cost and latency, not expected load — this endpoint has no pagination, so
 * exceeding it would silently truncate the aggregate rather than error.
 */
const LEADERBOARD_SCAN_LIMIT = 5000;

/**
 * Aggregate the six activity-window collections into leaderboard rows,
 * scoped to the cases/projects the resulting rows actually reference —
 * never a full `activeCases()` or `projects()` scan.
 *
 * ## Read profile
 *
 * - **Idle window** (no activity since `cutoff` — a quiet workspace, or a
 *   24h window on a workspace that only sees weekly bursts) — 6 reads, one
 *   `get()` per windowed collection, each returning 0 docs (Firestore
 *   charges one read for an empty query result). Neither `activeCases()`
 *   nor `projects()` is touched.
 * - **Active window** — the 6 windowed reads plus exactly the cases and
 *   projects those rows reference, resolved by id in chunks of
 *   `IN_CLAUSE_CHUNK` (the same `tool-reads.ts` idiom `listActivity` uses),
 *   via `collections.activeCases()` so soft-delete semantics (`deleted_at
 *   == null`) are preserved exactly as a full-collection scan had them.
 * - **Busy window, worst case** — each windowed scan is capped at
 *   `LEADERBOARD_SCAN_LIMIT` (see its docblock).
 */
export async function buildLeaderboard(
  userId: string,
  admin: boolean,
  window: ActivityLeaderboardWindow,
): Promise<{ rows: ActivityLeaderboardRow[]; project_rows: ActivityProjectLeaderboardRow[] }> {
  const cutoff = cutoffFor(window);

  const [
    casesCreatedSnap,
    commentsSnap,
    evidenceSnap,
    findingsSnap,
    decisionsSnap,
    workspaceEventsSnap,
  ] = await Promise.all([
    collections.caseEvents()
      .where('type', '==', 'case_created')
      .where('created_at', '>=', cutoff)
      .limit(LEADERBOARD_SCAN_LIMIT)
      .get(),
    collections.comments().where('created_at', '>=', cutoff).limit(LEADERBOARD_SCAN_LIMIT).get(),
    collections.evidence().where('created_at', '>=', cutoff).limit(LEADERBOARD_SCAN_LIMIT).get(),
    collections.findings().where('created_at', '>=', cutoff).limit(LEADERBOARD_SCAN_LIMIT).get(),
    collections.decisions().where('created_at', '>=', cutoff).limit(LEADERBOARD_SCAN_LIMIT).get(),
    collections.workspaceEvents().where('timestamp', '>=', cutoff).limit(LEADERBOARD_SCAN_LIMIT).get(),
  ]);

  const casesCreated = casesCreatedSnap.docs.map((d) => d.data());
  const comments = commentsSnap.docs.map((d) => d.data());
  const evidenceRows = evidenceSnap.docs.map((d) => d.data());
  const findings = findingsSnap.docs.map((d) => d.data());
  const decisions = decisionsSnap.docs.map((d) => d.data());
  const workspaceEvents = workspaceEventsSnap.docs.map((d) => d.data());

  // Distinct case ids the windowed rows actually reference. Comments scoped
  // to a finding (parent_type !== 'case') are intentionally left out here,
  // matching the existing comment-loop behavior below: the leaderboard
  // doesn't resolve findings, so a finding-scoped comment's "case_id" is the
  // finding id, never checked against `accessibleCaseIds`.
  const caseIds = new Set<string>();
  for (const event of casesCreated) caseIds.add(event.case_id);
  for (const ev of evidenceRows) caseIds.add(ev.case_id);
  for (const f of findings) caseIds.add(f.case_id);
  for (const d of decisions) caseIds.add(d.case_id);
  for (const c of comments) {
    if (c.parent_type === 'case') caseIds.add(c.parent_id);
  }

  const caseSnaps = caseIds.size > 0
    ? await Promise.all(
        chunk([...caseIds], IN_CLAUSE_CHUNK).map((ids) =>
          collections.activeCases().where(FieldPath.documentId(), 'in', ids).get(),
        ),
      )
    : [];
  let cases: Case[] = caseSnaps.flatMap((snap) => snap.docs.map((d) => d.data()));

  // Referenced project ids come from the resolved cases only — never a full
  // `projects` scan.
  const referencedProjectIds = new Set<string>();
  for (const c of cases) {
    if (c.project_id) referencedProjectIds.add(c.project_id);
  }
  let projects: Project[] = [];
  if (referencedProjectIds.size > 0) {
    const projectSnaps = await Promise.all(
      chunk([...referencedProjectIds], IN_CLAUSE_CHUNK).map((ids) =>
        collections.projects().where(FieldPath.documentId(), 'in', ids).get(),
      ),
    );
    projects = projectSnaps.flatMap((snap) => snap.docs.map((d) => d.data()));
  }
  const projectMap = new Map<string, string>(projects.map((p) => [p.project_id, p.name] as const));

  // Non-admin access is computed straight off the resolved project docs with
  // the exact predicate `getAccessibleProjectIds` applies to every project —
  // no full-workspace project scan needed to get the same answer.
  if (!admin) {
    const projectById = new Map(projects.map((p) => [p.project_id, p] as const));
    cases = cases.filter((c) => {
      const project = projectById.get(c.project_id);
      return project !== undefined && isEffectiveMember(project, userId);
    });
  }

  const accessibleCaseIds = new Set(cases.map((c) => c.case_id));
  const caseMap = new Map(cases.map((c) => [c.case_id, c] as const));

  const rows: LeaderboardRow[] = [];

  for (const event of casesCreated) {
    if (!accessibleCaseIds.has(event.case_id)) continue;
    const payload = event.payload as Record<string, unknown>;
    const actorMetaRaw = payload['actor_metadata'] as
      | { client_name?: string; client_version?: string; model?: string }
      | undefined;
    const row: LeaderboardRow = {
      kind: 'case_event',
      timestamp: event.created_at,
      case_id: event.case_id,
      is_case_created: true,
      ...(event.actor_id ? { actor_user_id: event.actor_id } : {}),
    };
    if (actorMetaRaw) row.actor_meta = actorMetaRaw;
    rows.push(row);
  }

  for (const comment of comments) {
    // Comments point at a case or finding; we don't load findings here for the
    // leaderboard so we count all comments whose parent case is accessible OR
    // whose parent_type is 'case' and parent_id is accessible.
    if (comment.parent_type === 'case' && !accessibleCaseIds.has(comment.parent_id)) continue;
    const row: LeaderboardRow = {
      kind: 'comment',
      timestamp: comment.created_at,
      case_id: comment.parent_type === 'case' ? comment.parent_id : comment.parent_id,
      ...(comment.author_id ? { actor_user_id: comment.author_id } : {}),
    };
    if (comment.actor_metadata) row.actor_meta = comment.actor_metadata;
    rows.push(row);
  }

  for (const ev of evidenceRows) {
    if (!accessibleCaseIds.has(ev.case_id)) continue;
    const row: LeaderboardRow = {
      kind: 'evidence',
      timestamp: ev.created_at,
      case_id: ev.case_id,
      ...(ev.source_type ? { evidence_source_type: ev.source_type } : {}),
      ...(ev.created_by ? { actor_user_id: ev.created_by } : {}),
    };
    if (ev.actor_metadata) row.actor_meta = ev.actor_metadata;
    rows.push(row);
  }

  for (const f of findings) {
    if (!accessibleCaseIds.has(f.case_id)) continue;
    // Findings don't carry actor_metadata today. There's also no per-finding
    // `actor_id` on the current schema — they're produced by reviewers /
    // detectors and attributed at the case level. Leave actor_user_id unset
    // so they bucket under "human" (historical behavior) unless future schema
    // adds a stable actor reference.
    rows.push({ kind: 'finding', timestamp: f.created_at, case_id: f.case_id });
  }

  for (const d of decisions) {
    if (!accessibleCaseIds.has(d.case_id)) continue;
    // Decisions carry both actor_id (used to split system-authored decisions
    // like the scheduler's `system:arbitra-intelligence` from real human
    // reviewers) and, when filed via an MCP client, actor_metadata so the
    // leaderboard can attribute Cursor / Claude Code / Codex sessions to
    // their per-client buckets instead of the synthetic "human" bucket.
    const row: LeaderboardRow = {
      kind: 'decision',
      timestamp: d.created_at,
      case_id: d.case_id,
      ...(d.actor_id ? { actor_user_id: d.actor_id } : {}),
      ...(d.type ? { decision_type: d.type } : {}),
    };
    if (d.actor_metadata) row.actor_meta = d.actor_metadata;
    rows.push(row);
  }

  // Workspace events are global — not case-scoped — so we include them for
  // every leaderboard window regardless of project access. They attribute to
  // the actor's client_name bucket (e.g. `arbitra-intelligence`) via
  // `actor_metadata`, so the synthetic `"human"` bucket is not polluted.
  for (const we of workspaceEvents) {
    // Resolved events are globally hidden — they no longer contribute to
    // leaderboard counts so the two surfaces stay aligned.
    if (we.resolved_at) continue;
    const row: LeaderboardRow = {
      kind: 'workspace_event',
      timestamp: we.timestamp,
      case_id: '',
    };
    if (we.actor_metadata) row.actor_meta = we.actor_metadata;
    rows.push(row);
  }

  return {
    rows: aggregateLeaderboard(rows),
    project_rows: aggregateProjectLeaderboard(rows, caseMap, projectMap),
  };
}

// Re-export small test helpers for project-access filtering parity.
export { getAccessibleProjectIds, isEffectiveMember };
