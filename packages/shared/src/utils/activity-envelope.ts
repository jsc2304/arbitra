/**
 * Activity envelope helpers — the Signal filter and event-shape computations.
 * Pure functions, deterministic; no I/O.
 *
 * These helpers are the single source of truth for the envelope fields added
 * to `ActivityEntry`. The activity-service calls them at read time from each
 * `normalize*` path.
 *
 * Design notes:
 *
 * - Computation lives in `@arbitra/shared` (not `@arbitra/backend`) so the
 *   frontend can recompute / sanity-check the envelope locally if needed and
 *   so unit tests don't drag in Firestore.
 * - Each helper takes the minimal source-row shape it needs. We intentionally
 *   do not require the full `ActivityEntry` — the activity service builds the
 *   entry around the envelope, not vice-versa.
 * - The Signal rules are applied at the very end (`computeSignal`) on top of
 *   the already-computed envelope so the Signal ruleset is one self-contained
 *   readable function rather than scattered across normalizers.
 */

import type {
  ActivityActorAgent,
  ActivityActorKind,
  ActivityKind,
  ActivityOpenedBy,
  ActivitySeverity,
} from '../types/activity.js';
import type { ActorMetadata } from '../types/actor-metadata.js';
import type { CaseEvent, EventType } from '../types/event.js';
import type { Comment } from '../types/comment.js';
import type { Decision } from '../types/decision.js';
import type { Evidence } from '../types/evidence.js';
import type { Finding } from '../types/finding.js';
import type { WorkspaceEvent } from '../types/workspace-event.js';

// ---------------------------------------------------------------------------
// preview — first 140 chars of a body / summary string.
// ---------------------------------------------------------------------------

/** Max preview length. */
export const PREVIEW_MAX_CHARS = 140;

/**
 * Trim a body string to PREVIEW_MAX_CHARS, collapsing internal whitespace so
 * multi-line comments render as a clean single-line snippet. Returns
 * `undefined` for empty / nullish input so the field can be omitted from the
 * entry shape (Firestore tolerates undefined; the type marks `preview?`).
 */
export function computePreview(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
  // Hard char cut + ellipsis. We deliberately do not word-break — the preview
  // is a teaser, not a quotation, and word-break heuristics produce shorter
  // teasers on languages without explicit spaces (CJK).
  return `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// actor.kind / actor.agent classification.
// ---------------------------------------------------------------------------

/**
 * Canonical client_name → ActivityActorAgent map. Keys must match the
 * normalized lowercased values produced by `normalizeActorMetadata`. Unknown
 * client names yield `null` (kind=`agent`, agent=`null`) so the envelope still
 * differentiates IDE-agent traffic from humans even when the agent isn't one
 * of the four canonical IDs.
 */
const CLIENT_NAME_TO_AGENT: Record<string, ActivityActorAgent> = {
  cursor: 'cursor',
  'claude-code': 'claude-code',
  'arbitra-intelligence': 'code-intelligence',
};

/**
 * System actor IDs that should classify as `kind=system`. Includes the
 * scheduler / detector and the webhook bot. New system actors default to
 * `kind=system, agent=null` via the `system:` prefix fallback below.
 */
const SYSTEM_ACTOR_IDS = new Set<string>(['system']);

export interface ActorClassification {
  kind: ActivityActorKind;
  agent: ActivityActorAgent;
}

/**
 * Classify an actor into `(kind, agent)` from the actor IDs and ActorMetadata
 * already on a row. Resolution order:
 *
 *   1. `actor_metadata.client_name` is set → derive agent from the canonical
 *      map. `arbitra-intelligence` is the only known *system* client; all
 *      others (Cursor, Claude Code, Cline, Copilot, …) classify as `agent`.
 *   2. `actor_user_id` is `'system'` or `'system:*'` → `kind=system`. The
 *      detector ID `system:arbitra-intelligence` collapses to
 *      `agent='code-intelligence'`; everything else → `agent=null`.
 *   3. Otherwise → human, `agent=null`.
 *
 * `actor_user_id` is allowed to be undefined (some sources don't carry one,
 * e.g. findings) — those default to `human`.
 */
export function classifyActor(
  actorUserId: string | undefined,
  actorMetadata: ActorMetadata | undefined,
): ActorClassification {
  const clientName = actorMetadata?.client_name;
  if (clientName) {
    const agent = CLIENT_NAME_TO_AGENT[clientName] ?? null;
    // `arbitra-intelligence` is the one system-grade client. Everything else
    // with a client_name is an IDE agent.
    //
    // Note: this classifies *any* Cursor-mediated row (e.g. a comment carrying
    // `client_name='cursor'`) as `kind='agent'`, even when a human typed it
    // through Cursor. This is intentional and matches the dogfood model:
    // Cursor traffic is agent-mediated action, not direct human action, so it
    // shouldn't get the human Signal lift. A human who wants a row
    // treated as human action comments through the web app, which carries no
    // `client_name`.
    const kind: ActivityActorKind = clientName === 'arbitra-intelligence' ? 'system' : 'agent';
    return { kind, agent };
  }
  if (actorUserId && (actorUserId === 'system' || actorUserId.startsWith('system:'))) {
    if (actorUserId === 'system:arbitra-intelligence') {
      return { kind: 'system', agent: 'code-intelligence' };
    }
    if (SYSTEM_ACTOR_IDS.has(actorUserId)) {
      // Plain `'system'` — used by the webhook ingest. Agent is null because
      // there's no canonical "webhook" agent identity beyond the openedBy
      // field on the row.
      return { kind: 'system', agent: null };
    }
    // Future `system:*` actors — keep them as system but with no canonical
    // agent label. Frontend can fall back to a generic Arbitra avatar.
    return { kind: 'system', agent: null };
  }
  return { kind: 'human', agent: null };
}

// ---------------------------------------------------------------------------
// openedBy — case_created routing.
// ---------------------------------------------------------------------------

/**
 * Resolve how a `case_created` event came to exist:
 *
 * - `detector` — the detector / scheduler created it (`system:arbitra-intelligence`)
 * - `webhook`  — the git webhook auto-created it (`'system'`)
 * - `user`     — anything else (a real human or an IDE agent acting on behalf of one)
 *
 * Mirrors the source-side actor IDs used in `case-service.ts` /
 * `webhook-service.ts` / `intelligence-service.ts`. Stored on the activity
 * envelope so the frontend can stop using the `isDetectorActor` heuristic
 * (deprecated; removal deferred to a follow-up PR).
 */
export function resolveOpenedBy(actorUserId: string | undefined): ActivityOpenedBy {
  if (!actorUserId) return 'user';
  if (actorUserId === 'system:arbitra-intelligence') return 'detector';
  if (actorUserId === 'system') return 'webhook';
  // Other `system:*` actors are rare; treat as detector-class so they don't
  // get rendered as "{actor} opened *{title}*" in the headline.
  if (actorUserId.startsWith('system:')) return 'detector';
  return 'user';
}

// ---------------------------------------------------------------------------
// severity per kind/verb.
// ---------------------------------------------------------------------------

/**
 * Severity for a `case_event` row. Bias toward `info`/`low` — only events a
 * reviewer should plausibly notice get bumped to `medium`+. The Signal
 * rule promotes `severity >= medium` lifecycle events into Signal regardless
 * of actor.kind, so this is the lever we have to surface real issues without
 * drowning the feed in routine state transitions.
 */
export function severityForCaseEvent(type: EventType): ActivitySeverity {
  const t = String(type);
  switch (t) {
    // Hard fails — a build / run / webhook failure is always reviewer-level.
    case 'run_failed':
    case 'run_retries_exhausted':
    case 'webhook_rejected':
    case 'case_anomaly_merge_on_gated_status':
      return 'high';

    // Reviewer-level decisions and changes-requested are the meat of the feed.
    // `gate_rejected` mirrors `severityForDecision('gate_rejected')` so a gate
    // rejection carries the same medium weight whether it arrives as a decision
    // row or a case_event row.
    case 'changes_requested':
    case 'human_decision_requested':
    case 'case_rejected':
    case 'gate_rejected':
      return 'medium';

    // Low — visible in Raw, mostly cosmetic state moves.
    case 'status_changed':
    case 'profile_changed':
    case 'risk_level_changed':
    case 'role_changed':
      return 'low';

    // Everything else (case_created, build_started, exploration_*, run_*,
    // case_approved, …) is `info`. Promotion to Signal happens via the
    // actor.kind / openedBy Signal rules, not via severity.
    default:
      return 'info';
  }
}

/** Severity for a finding — direct passthrough of FindingSeverity. */
export function severityForFinding(severity: Finding['severity'] | undefined): ActivitySeverity {
  return severity ?? 'info';
}

/**
 * Severity for a decision — `reject` / `request_changes` are reviewer-grade,
 * `escalate` higher still. Approves and waivers are `low` (audit-trail rows
 * the reviewer only needs in Raw).
 */
export function severityForDecision(type: Decision['type'] | undefined): ActivitySeverity {
  switch (type) {
    case 'escalate':
      return 'high';
    case 'reject':
    case 'request_changes':
    case 'gate_rejected':
      return 'medium';
    default:
      return 'low';
  }
}

/** Comments and evidence default to `info` — they earn Signal via the Signal rules. */
export function severityForComment(): ActivitySeverity {
  return 'info';
}
export function severityForEvidence(): ActivitySeverity {
  return 'info';
}

/**
 * Severity for a workspace event (e.g. scheduled intelligence run). Defaults
 * to `info` so heartbeat-class rows stay out of Signal; the Signal rule for
 * "system event whose payload deviates from heartbeat baseline" lifts genuine
 * anomalies — that detection lives outside this helper (deferred
 * to a later step).
 */
export function severityForWorkspaceEvent(): ActivitySeverity {
  return 'info';
}

// ---------------------------------------------------------------------------
// groupKey — grouping bucket.
// ---------------------------------------------------------------------------

/** Bucket size for case-bound grouping ("3+ similar events in <10 min"). */
export const GROUP_BUCKET_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Deterministic 10-minute bucket label for an ISO timestamp. Format
 * `YYYYMMDDTHHMM` truncated to 10-minute boundaries (`HH:00`, `HH:10`, …).
 * Returns the literal `'unknown'` for unparseable timestamps so the groupKey
 * field stays a non-empty string and downstream `groupBy` logic doesn't choke.
 */
export function tenMinuteBucket(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const bucketMs = Math.floor(ms / GROUP_BUCKET_MS) * GROUP_BUCKET_MS;
  const d = new Date(bucketMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  // Floor to ten-minute mark: keep the tens digit, zero out the units.
  const minTens = Math.floor(d.getUTCMinutes() / 10).toString();
  return `${yyyy}${mm}${dd}T${hh}${minTens}0`;
}

/**
 * Group key for a case-bound event: `case:<caseId>:<10minBucket>`. For
 * non-case rows (workspace events) use `computeWorkspaceGroupKey` instead.
 */
export function computeCaseGroupKey(caseId: string, iso: string | undefined): string {
  return `case:${caseId}:${tenMinuteBucket(iso)}`;
}

/**
 * Group key for a system / workspace event. These collapse
 * by `kind:<verb>:<actorId>` so identical detector heartbeats from the same
 * actor pile into one bucket regardless of timestamp — which is exactly the
 * "compress heartbeats" intent.
 */
export function computeWorkspaceGroupKey(
  // `kind` is part of the public signature so callers can grow this to
  // discriminate by source-kind in the future (today only `workspace_event`
  // calls this, but system events from other kinds could use it later).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _kind: ActivityKind,
  verb: string | undefined,
  actorUserId: string | undefined,
): string {
  return `kind:${verb ?? 'unknown'}:${actorUserId ?? 'unknown'}`;
}

// ---------------------------------------------------------------------------
// signal — the Signal filter.
// ---------------------------------------------------------------------------

/** Rank for severity comparisons against the `>= medium` threshold. */
const SEVERITY_RANK: Record<ActivitySeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** True when severity is >= medium. */
export function isMediumOrAbove(s: ActivitySeverity | undefined): boolean {
  if (!s) return false;
  return SEVERITY_RANK[s] >= SEVERITY_RANK.medium;
}

/**
 * Statuses where a human is plausibly waiting on the case. Drives the
 * rule that suppresses internal state-machine transitions on cases where no
 * human has work to do. Defined here (not in `case.ts`) so the rule lives
 * next to the filter that consumes it.
 */
const HUMAN_WAITING_STATUSES = new Set<string>([
  'open',
  'in_review',
  'needs_human_decision',
  'verification_pending',
]);

export function caseHasHumanWaiting(status: string | undefined): boolean {
  if (!status) return true; // unknown → conservative (keep in Signal)
  return HUMAN_WAITING_STATUSES.has(status);
}

/**
 * Inputs for `computeSignal` — everything the Signal ruleset needs in one bag.
 * Caller (the activity service) is responsible for hydrating this from the
 * already-loaded case map; we deliberately keep this helper pure.
 */
export interface SignalInputs {
  kind: ActivityKind;
  verb?: string;
  severity: ActivitySeverity;
  actorKind: ActivityActorKind;
  openedBy?: ActivityOpenedBy;
  /**
   * Status of the parent case at read time. Used by the rule that suppresses
   * internal state transitions on cases without a human waiting. Optional —
   * absent for workspace events.
   */
  caseStatus?: string;
  /**
   * Whether the case was opened by an Arbitra detector. The Signal lifecycle
   * rule treats detector-opened cases as Signal even when the actor is system,
   * because the detection itself is the signal.
   */
  caseDetectorOpened?: boolean;
  /**
   * For workspace / system events: whether the payload deviates from the
   * heartbeat baseline. Hook for the baseline detector (deferred). When
   * `undefined`, system events default to `false` (Raw-only).
   */
  systemEventOffBaseline?: boolean;
  /**
   * For comments: whether the body mentions a human (e.g. `@alex`). Lifts
   * bot-on-bot comments into Signal when a human is pulled in.
   */
  commentMentionsHuman?: boolean;
}

/**
 * Apply the Signal ruleset. Returns `true` iff the row should appear in
 * Signal mode. Pseudocode:
 *
 *   findings/decisions/evidence → always Signal
 *   case_event/lifecycle        → human OR severity>=medium OR detector-opened
 *                                 (and NOT a state-machine transition on a
 *                                 case without a human waiting)
 *   workspace_event/system      → only when off-baseline
 *   comment                     → human author OR mentions human
 *
 * Rule rationale lives next to each branch.
 */
export function computeSignal(inputs: SignalInputs): boolean {
  switch (inputs.kind) {
    case 'finding':
    case 'decision':
    case 'evidence':
      // "All Findings, Decisions, Evidence events" → Signal.
      return true;

    case 'case_event': {
      // Suppress purely internal transitions when no human is waiting on the
      // case. This is the "marked ready for build on cases that have no human
      // waiting for it" carve-out — but only for transition-style verbs, so a
      // detector-opened case_created on an idle quorum failure still surfaces.
      const isInternalTransition =
        inputs.verb === 'status_changed' || inputs.verb === 'case_ready_for_build';
      if (
        isInternalTransition &&
        inputs.actorKind !== 'human' &&
        !caseHasHumanWaiting(inputs.caseStatus) &&
        !inputs.caseDetectorOpened
      ) {
        return false;
      }
      // Positive lifts: human actor, reviewer-grade severity, or a
      // detector-opened case (the detection itself is the signal).
      if (inputs.actorKind === 'human') return true;
      if (isMediumOrAbove(inputs.severity)) return true;
      if (inputs.caseDetectorOpened) return true;
      return false;
    }

    case 'workspace_event':
      // Heartbeat suppression: workspace events stay in Raw unless the
      // upstream baseline detector says they're off-pattern. Defaulting to
      // `false` (rather than `true`) is the safer choice — it matches the
      // user-facing intent ("Signal means filtered") while we ship the
      // baseline machinery in a later step.
      return inputs.systemEventOffBaseline === true;

    case 'comment':
      // Bot-on-bot chatter stays out of Signal unless a human is mentioned;
      // human-authored comments are always Signal.
      if (inputs.actorKind === 'human') return true;
      if (inputs.commentMentionsHuman === true) return true;
      return false;
  }
}

/** Cheap heuristic for "comment body mentions a human" — `@name`-style only. */
export function commentMentionsHuman(body: string | undefined): boolean {
  if (!body) return false;
  // Match `@<word>` not preceded by `://` (so URLs don't trigger).
  return /(^|[^\w/])@[A-Za-z][\w-]{1,}/.test(body);
}

// ---------------------------------------------------------------------------
// Per-source envelope builders.
//
// These are the single call sites the activity-service uses. Each takes the
// fully-typed source row plus minimal context (case status, project map) and
// returns the envelope fields ready to spread onto the ActivityEntry.
// ---------------------------------------------------------------------------

/** Just the envelope fields. Spreads cleanly into `ActivityEntry`. */
export interface ActivityEnvelope {
  severity: ActivitySeverity;
  signal: boolean;
  actor_kind: ActivityActorKind;
  actor_agent: ActivityActorAgent;
  opened_by?: ActivityOpenedBy;
  group_key: string;
  preview?: string;
}

export interface CaseEventContext {
  /** Status of the parent case at read time (drives transition suppression). */
  caseStatus?: string;
  /** Whether the parent case was opened by an Arbitra detector. */
  caseDetectorOpened?: boolean;
}

export function envelopeForCaseEvent(
  event: CaseEvent,
  ctx: CaseEventContext = {},
): ActivityEnvelope {
  const { kind, agent } = classifyActor(event.actor_id, undefined);
  const severity = severityForCaseEvent(event.type);
  const opened_by = event.type === 'case_created' ? resolveOpenedBy(event.actor_id) : undefined;
  const signal = computeSignal({
    kind: 'case_event',
    verb: String(event.type),
    severity,
    actorKind: kind,
    openedBy: opened_by,
    caseStatus: ctx.caseStatus,
    caseDetectorOpened: ctx.caseDetectorOpened ?? opened_by === 'detector',
  });
  const env: ActivityEnvelope = {
    severity,
    signal,
    actor_kind: kind,
    actor_agent: agent,
    group_key: computeCaseGroupKey(event.case_id, event.created_at),
  };
  if (opened_by) env.opened_by = opened_by;
  return env;
}

export function envelopeForComment(comment: Comment, caseId: string): ActivityEnvelope {
  const { kind, agent } = classifyActor(comment.author_id, comment.actor_metadata);
  const severity = severityForComment();
  const mentionsHuman = commentMentionsHuman(comment.body);
  const signal = computeSignal({
    kind: 'comment',
    severity,
    actorKind: kind,
    commentMentionsHuman: mentionsHuman,
  });
  const preview = computePreview(comment.body);
  const env: ActivityEnvelope = {
    severity,
    signal,
    actor_kind: kind,
    actor_agent: agent,
    group_key: computeCaseGroupKey(caseId, comment.created_at),
  };
  if (preview) env.preview = preview;
  return env;
}

export function envelopeForEvidence(ev: Evidence): ActivityEnvelope {
  const { kind, agent } = classifyActor(ev.created_by, ev.actor_metadata);
  const severity = severityForEvidence();
  const signal = computeSignal({
    kind: 'evidence',
    severity,
    actorKind: kind,
  });
  const preview = computePreview(ev.summary);
  const env: ActivityEnvelope = {
    severity,
    signal,
    actor_kind: kind,
    actor_agent: agent,
    group_key: computeCaseGroupKey(ev.case_id, ev.created_at),
  };
  if (preview) env.preview = preview;
  return env;
}

export function envelopeForFinding(f: Finding): ActivityEnvelope {
  // Findings carry no actor on the schema today; default to `human` so they
  // count toward the human-author Signal lift even though the rule for
  // findings (`always Signal`) would short-circuit anyway.
  const { kind, agent } = classifyActor(undefined, undefined);
  const severity = severityForFinding(f.severity);
  const signal = computeSignal({
    kind: 'finding',
    severity,
    actorKind: kind,
  });
  // Findings can carry both a title and a description; prefer the
  // description (the body) for the preview so the row teases the actual
  // content and not the already-rendered headline.
  const preview = computePreview(f.description) ?? computePreview(f.title);
  const env: ActivityEnvelope = {
    severity,
    signal,
    actor_kind: kind,
    actor_agent: agent,
    group_key: computeCaseGroupKey(f.case_id, f.created_at),
  };
  if (preview) env.preview = preview;
  return env;
}

export function envelopeForDecision(d: Decision): ActivityEnvelope {
  const { kind, agent } = classifyActor(d.actor_id, d.actor_metadata);
  const severity = severityForDecision(d.type);
  const signal = computeSignal({
    kind: 'decision',
    severity,
    actorKind: kind,
  });
  const preview = computePreview(d.rationale);
  const env: ActivityEnvelope = {
    severity,
    signal,
    actor_kind: kind,
    actor_agent: agent,
    group_key: computeCaseGroupKey(d.case_id, d.created_at),
  };
  if (preview) env.preview = preview;
  return env;
}

export function envelopeForWorkspaceEvent(event: WorkspaceEvent): ActivityEnvelope {
  const { kind, agent } = classifyActor(event.actor_user_id, event.actor_metadata);
  const severity = severityForWorkspaceEvent();
  const signal = computeSignal({
    kind: 'workspace_event',
    verb: event.type,
    severity,
    actorKind: kind,
    // Baseline detection is deferred — leave the off-baseline hint unset
    // so workspace events stay in Raw by default. A future PR will plug in a
    // baseline-aware computation here.
    systemEventOffBaseline: undefined,
  });
  return {
    severity,
    signal,
    actor_kind: kind,
    actor_agent: agent,
    group_key: computeWorkspaceGroupKey('workspace_event', event.type, event.actor_user_id),
  };
}
