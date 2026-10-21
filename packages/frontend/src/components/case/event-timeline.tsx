'use client';

import { useState, useMemo, type ReactNode } from 'react';
import useSWR from 'swr';
import type { CaseEvent, EventType, Run, User } from '@arbitra/shared';
import { useUserMap } from '../../hooks/use-users';
import { getEvidenceLabel } from '../../lib/evidence-labels';
import { actorDisplayName } from '../../lib/actor-display';
import { api } from '../../lib/api-client';
import {
  TIMELINE_EVENT_CATEGORIES,
  TIMELINE_CATEGORY_DOT_CLASS,
  type TimelineEventCategory,
} from '../../lib/activity-icons';
import { RelativeTime } from '../shared/relative-time';

// ---------------------------------------------------------------------------
// Event categories — sourced from the shared activity-icons module so the
// workspace-wide activity feed and the per-case timeline use the same
// taxonomy and dot colors.
// ---------------------------------------------------------------------------

type EventCategory = TimelineEventCategory;

const EVENT_CATEGORIES = TIMELINE_EVENT_CATEGORIES;
const CATEGORY_DOT_CLASS = TIMELINE_CATEGORY_DOT_CLASS;

const eventTypeLabels: Partial<Record<EventType, string>> = {
  case_created: 'Case Created',
  track_assigned: 'Validation Track Assigned',
  exploration_requested: 'Started Exploration',
  exploration_completed: 'Exploration Completed',
  case_ready_for_build: 'Marked Ready for Build',
  build_started: 'Build Started',
  validation_requested: 'Started Validation',
  validation_started: 'Validation Running',
  review_requested: 'Started AI Review',
  review_started: 'AI Review Running',
  human_decision_requested: 'Awaiting Human Decision',
  human_decision_recorded: 'Decision Recorded',
  manual_verification_requested: 'Manual Verification Needed',
  manual_validation_confirmed: 'Manual Verification Confirmed',
  auto_approve_decision: 'Auto-Approved',
  case_approved: 'Case Approved',
  pr_merged: 'PR Merged',
  case_anomaly_merge_on_gated_status: 'Anomaly: PR Merged on Gated Case',
  case_completed: 'Case Completed',
  case_rejected: 'Case Rejected',
  changes_requested: 'Changes Requested',
  run_created: 'Run Queued',
  run_started: 'Run Started',
  run_completed: 'Run Completed',
  review_completed: 'AI Review Completed',
  review_marked_not_applicable: 'AI Review Skipped (Not Applicable)',
  review_not_applicable_marked: 'AI Review Marked Not Applicable',
  review_not_applicable_cleared: 'AI Review Re-enabled',
  run_failed: 'Run Failed',
  run_retries_exhausted: 'Run Failed After Retries',
  evidence_registered: 'Evidence Added',
  evidence_missing_detected: 'Missing Evidence Detected',
  finding_created: 'Finding Reported',
  finding_updated: 'Finding Updated',
  rule_results_attached: 'Rule Check Results Added',
  // decision_created uses dynamic label via getDecisionEventLabel()
  risk_level_changed: 'Risk Level Changed',
  case_escalated: 'Case Escalated',
  comment_added: 'Comment Added',
  knowledge_asset_created: 'Knowledge Asset Created',
  knowledge_asset_status_changed: 'Knowledge Asset Updated',
  role_changed: 'Role Changed',
  status_changed: 'Status Changed',
};

const STATUS_PILL: Record<string, string> = {
  open: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  exploration: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  ready_for_build: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  in_build: 'bg-secondary-100 text-secondary-700 dark:bg-secondary-900/30 dark:text-secondary-400',
  in_validation: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  in_review: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  needs_human_decision: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  verification_pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  approved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  pending_merge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const PHASE_LABELS: Record<string, string> = {
  open: 'Open',
  exploration: 'Exploration',
  ready_for_build: 'Ready for Build',
  in_build: 'Build',
  in_validation: 'Validation',
  in_review: 'Review',
  needs_human_decision: 'Human Decision',
  verification_pending: 'Manual Verification',
  approved: 'Approved',
  pending_merge: 'Merge PR',
  done: 'Done',
  rejected: 'Rejected',
};

// ---------------------------------------------------------------------------
// Render item model
// ---------------------------------------------------------------------------

type EnrichedEvent = CaseEvent & { category: EventCategory };

type RenderItem =
  | { kind: 'phase_header'; phase: string }
  | { kind: 'event'; event: EnrichedEvent }
  | { kind: 'burst'; events: EnrichedEvent[]; timestamp: string };

function buildRenderItems(events: CaseEvent[]): RenderItem[] {
  const sorted = [...events].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const enriched: EnrichedEvent[] = sorted.map((e) => ({
    ...e,
    category: (EVENT_CATEGORIES[e.type] ?? 'pipeline') as EventCategory,
  }));

  const items: RenderItem[] = [];
  let lastPhase: string | null = null;
  let burstBuffer: EnrichedEvent[] = [];

  function flushBurst() {
    if (burstBuffer.length === 0) return;
    if (burstBuffer.length >= 2) {
      items.push({ kind: 'burst', events: [...burstBuffer], timestamp: burstBuffer[0]!.created_at });
    } else {
      for (const e of burstBuffer) {
        items.push({ kind: 'event', event: e });
      }
    }
    burstBuffer = [];
  }

  for (const event of enriched) {
    // Detect phase transitions: insert a header when to_status changes
    const toStatus = event.payload['to_status'] as string | undefined;
    if (toStatus && toStatus !== lastPhase) {
      flushBurst();
      items.push({ kind: 'phase_header', phase: toStatus });
      lastPhase = toStatus;
    }

    // Pipeline burst clustering: consecutive system:pipeline events within 3s
    const isBurstable =
      event.actor_id === 'system:pipeline' && event.category === 'pipeline';

    if (isBurstable) {
      if (burstBuffer.length > 0) {
        const lastTs = new Date(burstBuffer[burstBuffer.length - 1]!.created_at).getTime();
        const thisTs = new Date(event.created_at).getTime();
        if (Math.abs(lastTs - thisTs) <= 3000) {
          burstBuffer.push(event);
          continue;
        }
        flushBurst();
      }
      burstBuffer.push(event);
    } else {
      flushBurst();
      items.push({ kind: 'event', event });
    }
  }

  flushBurst();
  return items;
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string }) {
  const cls = STATUS_PILL[status] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Payload renderer — per-event-type structured display
// ---------------------------------------------------------------------------

// Human-readable labels for risk levels and validation tracks
const RISK_LABELS: Record<string, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

const TRACK_LABELS: Record<string, string> = {
  direct: 'direct validation',
  manual: 'manual validation',
};

const RUN_TYPE_LABELS: Record<string, string> = {
  exploration_run: 'Exploration',
  build_run: 'Build',
  review_run: 'AI Review',
  rule_run: 'Rule Check',
  test_run: 'Test',
  evidence_collection_run: 'Evidence Collection',
  manual_validation_run: 'Manual Validation',
};

const DECISION_LABELS: Record<string, string> = {
  approve: 'Approved',
  auto_approve: 'Auto-approved',
  reject: 'Rejected',
  request_changes: 'Changes requested',
  waive: 'Waived',
  escalate: 'Escalated',
  manual_validation_confirmed: 'Manual validation confirmed',
};

const DECISION_EVENT_TITLES: Record<string, string> = {
  approve: 'Case Approved',
  auto_approve: 'Case Auto-Approved',
  reject: 'Case Rejected',
  request_changes: 'Changes Requested',
  waive: 'Finding Waived',
  escalate: 'Case Escalated',
  manual_validation_confirmed: 'Verification Confirmed',
};

// Human-readable names for the fields `case_updated` can carry — shared by
// the dynamic label below and the payload renderer's field rows.
const CASE_UPDATED_FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  case_type: 'case type',
  priority: 'priority',
  validation_track: 'validation track',
};

/**
 * Dynamic label for `case_updated` — issue #794: a single-field edit reads
 * as "Title changed"; multiple fields in one `updateCase` call read as
 * "Details updated — title, priority" so the timeline names exactly what
 * moved without a raw field-name dump.
 */
function getCaseUpdatedLabel(event: EnrichedEvent): string {
  const changed = (event.payload['changed'] as string[] | undefined) ?? [];
  if (changed.length === 0) return 'Case Updated';
  const labels = changed.map((f) => CASE_UPDATED_FIELD_LABELS[f] ?? f.replace(/_/g, ' '));
  if (labels.length === 1) {
    const [only] = labels as [string];
    return `${only.charAt(0).toUpperCase()}${only.slice(1)} changed`;
  }
  return `Details updated — ${labels.join(', ')}`;
}

/** Dynamic event label for decision_created and case_updated events */
function getEventLabel(event: EnrichedEvent): string {
  if (event.type === 'decision_created') {
    const decType = event.payload['type'] as string | undefined;
    if (decType && DECISION_EVENT_TITLES[decType]) {
      return DECISION_EVENT_TITLES[decType];
    }
  }
  if (event.type === 'case_updated') {
    return getCaseUpdatedLabel(event);
  }
  return eventTypeLabels[event.type as EventType] ?? String(event.type).replace(/_/g, ' ');
}


function PayloadRenderer({ event }: { event: EnrichedEvent }) {
  const p = event.payload;

  // Case created — show a human-readable summary instead of raw field dump
  if (event.type === 'case_created') {
    const risk = RISK_LABELS[p['risk_level'] as string] ?? (p['risk_level'] as string);
    const track = TRACK_LABELS[p['validation_track'] as string] ?? (p['validation_track'] as string);
    const parts: string[] = [];
    if (risk) parts.push(risk);
    if (track) parts.push(track);
    if (parts.length === 0) return null;
    return (
      <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
        Created as {parts.join(', ')}
      </p>
    );
  }

  // Case detail edit (issue #794) — title/case_type/priority/validation_track
  // carry old→new values; description only carries a changed-marker (no
  // body) since free-text diffs don't belong in an audit timeline.
  if (event.type === 'case_updated') {
    const changed = (p['changed'] as string[] | undefined) ?? [];
    if (changed.length === 0) return null;
    const titleChange = p['title'] as { from?: string; to?: string } | undefined;
    const caseTypeChange = p['case_type'] as { from?: string; to?: string } | undefined;
    const priorityChange = p['priority'] as { from?: string; to?: string } | undefined;
    const trackChange = p['validation_track'] as { from?: string; to?: string } | undefined;
    const rows: { key: string; node: ReactNode }[] = [];
    if (titleChange) {
      rows.push({
        key: 'title',
        node: (
          <>
            <span className="line-through opacity-60">{titleChange.from}</span>
            {' → '}
            {titleChange.to}
          </>
        ),
      });
    }
    if (caseTypeChange) {
      const from = caseTypeChange.from?.replace(/_/g, ' ') ?? '—';
      const to = caseTypeChange.to?.replace(/_/g, ' ') ?? '—';
      rows.push({ key: 'case_type', node: <>Case type: {from} → {to}</> });
    }
    if (priorityChange) {
      const from = priorityChange.from?.replace(/_/g, ' ') ?? '—';
      const to = priorityChange.to?.replace(/_/g, ' ') ?? '—';
      rows.push({ key: 'priority', node: <>Priority: {from} → {to}</> });
    }
    if (trackChange) {
      const from = TRACK_LABELS[trackChange.from ?? ''] ?? trackChange.from ?? '—';
      const to = TRACK_LABELS[trackChange.to ?? ''] ?? trackChange.to ?? '—';
      rows.push({ key: 'validation_track', node: <>Validation track: {from} → {to}</> });
    }
    if (changed.includes('description')) {
      rows.push({ key: 'description', node: <>Description updated</> });
    }
    if (rows.length === 0) return null;
    return (
      <div className="mt-0.5 space-y-0.5">
        {rows.map((row) => (
          <p key={row.key} className="text-xs text-gray-400 dark:text-gray-500 truncate">
            {row.node}
          </p>
        ))}
      </div>
    );
  }

  // State transition — support both from_status/to_status and from/to payload shapes.
  // Issue #1041: `risk_level_changed` also emits bare `from`/`to` (see the
  // dedicated block below) but is not a case-status transition, so it is
  // excluded here — otherwise its risk-level values get rendered as
  // StatusPills and the dedicated block is never reached. Add any other
  // event type that emits bare `from`/`to` for a non-status payload to this
  // exclusion rather than letting it fall through silently.
  const fromStatus = (p['from_status'] ?? p['from']) as string | undefined;
  const toStatus = (p['to_status'] ?? p['to']) as string | undefined;
  const triggeredBy = p['triggered_by'] as string | undefined;
  if ((fromStatus || toStatus) && event.type !== 'risk_level_changed') {
    return (
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        {fromStatus && <StatusPill status={fromStatus} />}
        {fromStatus && toStatus && (
          <svg className="w-3 h-3 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        )}
        {toStatus && <StatusPill status={toStatus} />}
        {triggeredBy && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-1">
            via {triggeredBy === 'autonomous_pipeline' ? 'Arbitra' : triggeredBy}
          </span>
        )}
      </div>
    );
  }

  // Run event — show run type label instead of raw ID
  const runId = p['run_id'] as string | undefined;
  const runType = p['run_type'] as string | undefined;
  const runStatus = p['status'] as string | undefined;
  if (runId) {
    const runLabel = runType ? (RUN_TYPE_LABELS[runType] ?? runType.replace(/_/g, ' ')) : null;
    return (
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        {runLabel && (
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
            {runLabel}
          </span>
        )}
        {runStatus && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{runStatus}</span>
        )}
        {typeof p['model'] === 'string' && (
          <>
            {String(p['model']).split(', ').map((modelName: string) => (
              <span key={modelName} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                </svg>
                {modelName.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}
              </span>
            ))}
            {p['consensus_models'] != null && Number(p['consensus_models']) >= 2 && (
              <span className="text-[10px] text-purple-500 dark:text-purple-400 font-medium">
                consensus
              </span>
            )}
          </>
        )}
        {p['total_tokens'] != null && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{Number(p['total_tokens']).toLocaleString()} tokens</span>
        )}
        {p['finding_count'] != null && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{String(p['finding_count'])} {Number(p['finding_count']) === 1 ? 'finding' : 'findings'}</span>
        )}
      </div>
    );
  }

  // Evidence event — show type label, hide raw ID
  const evidenceId = p['evidence_id'] as string | undefined;
  const evidenceType = p['type'] as string | undefined;
  if (evidenceId) {
    const evLabel = evidenceType ? getEvidenceLabel(evidenceType) : null;
    return (
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        {evLabel && (
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400">
            {evLabel}
          </span>
        )}
      </div>
    );
  }

  // Decision event — show decision type label and scope (case vs finding)
  const decisionId = p['decision_id'] as string | undefined;
  if (decisionId) {
    const decType = p['type'] as string | undefined;
    const findingRef = p['finding_id'] as string | undefined;
    const decLabel = decType ? (DECISION_LABELS[decType] ?? decType.replace(/_/g, ' ')) : null;
    const decColor =
      decType === 'approve' || decType === 'auto_approve'
        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
        : decType === 'reject'
          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          : decType === 'request_changes'
            ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
            : decType === 'waive'
              ? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
    const scopeLabel = findingRef ? 'on finding' : 'on case';
    return (
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        {decLabel && (
          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] ${decColor}`}>
            {decLabel}
          </span>
        )}
        <span className="text-[10px] text-gray-400 dark:text-gray-500">
          {scopeLabel}
        </span>
        {findingRef && (
          <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500 truncate max-w-[120px]" title={findingRef}>
            {findingRef}
          </span>
        )}
      </div>
    );
  }

  // Review-not-applicable lifecycle: emitted when the pipeline gives up on
  // auto-review (no PR/branch, retry-exhaustion, or auto-heal of pre-#454
  // cases) and when a later real review_run clears the flag.
  if (
    event.type === 'review_marked_not_applicable' ||
    event.type === 'review_not_applicable_cleared' ||
    event.type === 'review_not_applicable_marked'
  ) {
    const reasonMap: Record<string, string> = {
      no_pr_or_branch: 'No PR or branch attached',
      diff_resolve_failed: 'Diff fetch failed after retries',
      auto_healed_from_pipeline_failure_comment: 'Auto-healed from pipeline failure',
      review_run_completed: 'Replaced by completed review run',
      human_decision: 'Marked not applicable by a reviewer',
    };
    const reasonRaw = p['reason'] as string | undefined;
    const reasonLabel = reasonRaw ? (reasonMap[reasonRaw] ?? reasonRaw.replace(/_/g, ' ')) : null;
    const isCleared = event.type === 'review_not_applicable_cleared';
    const isHumanMarked = event.type === 'review_not_applicable_marked';
    const rationaleExcerpt = p['rationale_excerpt'] as string | undefined;
    const tone = isCleared
      ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/10 dark:border-green-900/40 dark:text-green-300'
      : 'bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-800/40 dark:border-gray-700 dark:text-gray-300';
    return (
      <div className={`mt-1 rounded-md border ${tone} p-2 text-xs`}>
        <p>
          {isCleared
            ? 'A real AI review completed — the case is no longer flagged as review-not-applicable.'
            : isHumanMarked
              ? 'A reviewer marked AI review as not applicable for this case. Approval preconditions that normally require a completed review run are bypassed.'
              : 'AI review was skipped for this case. Approval preconditions that normally require a completed review run are bypassed.'}
        </p>
        {reasonLabel && (
          <p className="mt-1 text-[11px] opacity-80">Reason: {reasonLabel}</p>
        )}
        {rationaleExcerpt && (
          <p className="mt-1 text-[11px] italic opacity-80">&ldquo;{rationaleExcerpt}&rdquo;</p>
        )}
      </div>
    );
  }

  // Observed Case escalation (issue #987 / ADR-0001) — shows both the
  // case_type flip and the risk_level transition that caused it. Issue
  // #1029: `from_risk_level` is additive on `case_escalated`, so older
  // events (written before this field existed) simply fall back to showing
  // just the destination risk level, same as before.
  if (event.type === 'case_escalated') {
    const fromCaseType = p['from_case_type'] as string | undefined;
    const toCaseType = p['to_case_type'] as string | undefined;
    const fromRisk = p['from_risk_level'] as string | undefined;
    const toRisk = p['risk_level'] as string | undefined;
    return (
      <div className="mt-0.5 space-y-0.5">
        {(fromCaseType || toCaseType) && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Case type: {(fromCaseType ?? '—').replace(/_/g, ' ')} → {(toCaseType ?? '—').replace(/_/g, ' ')}
          </p>
        )}
        {toRisk && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Risk: {fromRisk ? `${RISK_LABELS[fromRisk] ?? fromRisk} → ` : ''}{RISK_LABELS[toRisk] ?? toRisk}
          </p>
        )}
      </div>
    );
  }

  // Risk level change — backend emits bare `from`/`to`
  // (case-escalation-service.ts, case-service.ts); `from_risk_level`/
  // `to_risk_level` is kept as a fallback for historical events written
  // before the payload settled on the bare keys.
  if (event.type === 'risk_level_changed') {
    const from = (p['from'] ?? p['from_risk_level']) as string | undefined;
    const to = (p['to'] ?? p['to_risk_level']) as string | undefined;
    if (from || to) {
      return (
        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
          {from && to ? `${RISK_LABELS[from] ?? from} → ${RISK_LABELS[to] ?? to}` : (RISK_LABELS[to ?? ''] ?? to)}
        </p>
      );
    }
  }

  // Track assigned
  if (event.type === 'track_assigned') {
    const track = p['validation_track'] as string | undefined;
    if (track) {
      return (
        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
          {TRACK_LABELS[track] ?? track.replace(/_/g, ' ')}
        </p>
      );
    }
  }

  // Merge-on-gated-status anomaly — elevated warning block so operators see
  // that the PR was merged while the case was still in a gated/unexplored
  // state. Backend emits this event in place of `pr_merged` on the anomaly
  // path; no auto-close happens and manual intervention is required.
  if (event.type === 'case_anomaly_merge_on_gated_status') {
    const prUrl = p['pr_url'] as string | undefined;
    const prNumber = p['pr_number'] as number | undefined;
    const branch = p['branch'] as string | undefined;
    const sourceStatus = p['source_status'] as string | undefined;
    const prLabel = prNumber ? `PR #${prNumber}` : 'PR';
    return (
      <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 p-2 text-xs text-amber-900 dark:text-amber-200">
        <p>
          {prLabel} was merged while this case was in{' '}
          {sourceStatus ? <StatusPill status={sourceStatus} /> : 'a gated status'}
          . The case was <strong>not</strong> auto-closed — resolve manually.
        </p>
        <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px]">
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline break-all"
            >
              {prUrl}
            </a>
          )}
          {branch && (
            <span className="font-mono text-amber-800/80 dark:text-amber-300/80">
              {branch}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Fallback: show summary for remaining payloads, skip internal IDs
  const SKIP_KEYS = new Set(['case_id', 'event_id', 'actor_id', 'project_id', 'repository_id', 'owner_user_id', 'source']);
  const entries = Object.entries(p).filter(([k]) => !SKIP_KEYS.has(k));
  if (entries.length === 0) return null;
  const parts = entries
    .slice(0, 3)
    .map(([k, v]) => {
      const label = k.replace(/_/g, ' ');
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${label}: ${val}`;
    });
  if (entries.length > 3) parts.push(`+${entries.length - 3} more`);
  return (
    <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500 truncate">{parts.join(' / ')}</p>
  );
}

// ---------------------------------------------------------------------------
// Actor badge
// ---------------------------------------------------------------------------

function isSystemActor(id: string): boolean {
  return id === 'system' || id.startsWith('system:');
}

function isLikelyFirebaseUid(id: string): boolean {
  return /^[A-Za-z0-9]{20,}$/.test(id);
}

function ActorBadge({
  actorId,
  userMap,
  actorMetadata,
}: {
  actorId: string;
  userMap: Record<string, User>;
  actorMetadata?: { client_name?: string; client_version?: string; model?: string };
}) {
  // Funnel through the same `actorDisplayName` helper the activity feed and
  // courtroom use so vocabulary stays consistent (IDE clients → mapped label
  // via actor_metadata.client_name, system actors → "Arbitra", human users
  // resolved by `useUserMap`, Firebase UIDs → "User"). Events emitted before
  // PR #496 don't carry actor_metadata on the payload — optional chaining
  // keeps those rows rendering as plain human/system actors.
  const user = userMap[actorId];
  const resolved = user?.display_name || user?.email || undefined;
  const display = actorDisplayName(actorId, actorMetadata, resolved);

  if (isSystemActor(actorId)) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
        <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
        {display.label}
      </span>
    );
  }
  return (
    <span className="text-[10px] text-gray-400 dark:text-gray-500">{display.label}</span>
  );
}

// ---------------------------------------------------------------------------
// Burst group
// ---------------------------------------------------------------------------

function BurstGroup({ events, timestamp, userMap, reviewModel }: { events: EnrichedEvent[]; timestamp: string; userMap: Record<string, User>; reviewModel?: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="mb-3 ml-6">
      <span className="absolute -left-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700 ring-4 ring-white dark:ring-gray-900" />
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        aria-expanded={expanded}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <span className="font-medium">
          {events.length} pipeline event{events.length !== 1 ? 's' : ''}
        </span>
        <span className="text-gray-300 dark:text-gray-600">·</span>
        <RelativeTime timestamp={timestamp} precision="seconds" />
      </button>

      {expanded && (
        <ol className="mt-2 space-y-2 border-l border-gray-100 dark:border-border-subtle ml-1 pl-3">
          {events.map((event) => {
            const label = getEventLabel(event);
            const showBurstModel =
              reviewModel &&
              REVIEW_EVENT_TYPES.has(event.type) &&
              typeof event.payload['model'] !== 'string';
            return (
              <li key={event.event_id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                    {label}
                    {showBurstModel && (
                      <span className="ml-1 text-[10px] text-purple-600 dark:text-purple-400">({reviewModel})</span>
                    )}
                  </span>
                  <ActorBadge
                    actorId={event.actor_id}
                    userMap={userMap}
                    actorMetadata={
                      (event.payload as Record<string, unknown>)?.['actor_metadata'] as
                        | { client_name?: string; client_version?: string; model?: string }
                        | undefined
                    }
                  />
                </div>
                <PayloadRenderer event={event} />
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Phase header
// ---------------------------------------------------------------------------

function PhaseHeader({ phase }: { phase: string }) {
  const label = PHASE_LABELS[phase] ?? phase.replace(/_/g, ' ');
  return (
    <li className="mb-2 mt-3 ml-6">
      <span className="text-[9px] font-bold uppercase tracking-widest text-gray-300 dark:text-gray-600 select-none">
        {label}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface EventTimelineProps {
  events: CaseEvent[];
  /**
   * Optional case id. When provided, the timeline fetches runs itself so it can
   * resolve the review model for review-related events. This lets the parent
   * defer the runs fetch to when the Timeline tab is actually opened (SWR
   * dedupes against RunsPanel's identical key).
   */
  caseId?: string;
  /** Pre-fetched runs. Takes precedence over internal fetch when provided. */
  runs?: Run[];
}

// Review-related event types that should show the AI model name
const REVIEW_EVENT_TYPES = new Set<string>([
  'review_requested',
  'review_started',
  'review_completed',
]);

export function EventTimeline({ events, caseId, runs: runsProp }: EventTimelineProps) {
  const items = buildRenderItems(events);

  // Self-fetch runs when no pre-fetched runs are supplied. SWR dedupes against
  // RunsPanel using the same `['runs', caseId]` key, so opening the Timeline
  // after the Runs tab (or vice versa) reuses the cached data.
  const { data: runsData } = useSWR(
    !runsProp && caseId ? ['runs', caseId] : null,
    () => api.runs.listForCase(caseId!),
  );
  const runs = runsProp ?? runsData?.runs;

  // Resolve the model name from the most recent completed review run
  const reviewModel = useMemo(() => {
    if (!runs || runs.length === 0) return undefined;
    const completedReview = runs
      .filter((r) => r.run_type === 'review_run' && r.token_usage?.model)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
    return completedReview?.token_usage?.model;
  }, [runs]);

  // Collect actor IDs that look like Firebase UIDs for batch resolution
  const actorIds = useMemo(() => {
    return [...new Set(
      events
        .map((e) => e.actor_id)
        .filter((id) => !isSystemActor(id) && isLikelyFirebaseUid(id))
    )];
  }, [events]);
  const userMap = useUserMap(actorIds);

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Event Timeline ({events.length})
          </h3>
          <span
            className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-[10px] font-bold cursor-help"
            title="The event timeline is an append-only audit log of everything that happened on this case: status changes, run executions, evidence registration, decisions, and more. It provides full traceability and cannot be modified after the fact."
          >
            ?
          </span>
          {/* Legend */}
          <div className="flex items-center gap-3 ml-auto">
            {([
              ['lifecycle', 'Lifecycle'],
              ['human', 'Human'],
              ['artifact', 'Artifact'],
              ['pipeline', 'Pipeline'],
            ] as [EventCategory, string][]).map(([cat, label]) => (
              <span key={cat} className="hidden sm:flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${CATEGORY_DOT_CLASS[cat]}`} />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <svg
            className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            No events recorded
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            The timeline tracks every state change, run, and action on this case. Events appear
            automatically as the case progresses through its lifecycle.
          </p>
        </div>
      ) : (
        <div className="px-4 py-2">
          <ol className="relative border-l border-gray-200 dark:border-border-subtle ml-3">
            {items.map((item, idx) => {
              if (item.kind === 'phase_header') {
                return <PhaseHeader key={`phase-${item.phase}-${idx}`} phase={item.phase} />;
              }

              if (item.kind === 'burst') {
                return (
                  <BurstGroup
                    key={`burst-${idx}`}
                    events={item.events}
                    timestamp={item.timestamp}
                    userMap={userMap}
                    reviewModel={reviewModel}
                  />
                );
              }

              const { event } = item;
              const label = getEventLabel(event);
              const dotCls = CATEGORY_DOT_CLASS[event.category];
              const isLifecycle = event.category === 'lifecycle';
              const isPipeline = event.category === 'pipeline';

              // Show model badge on review lifecycle events (review_requested, review_started)
              // that don't already carry model info in their payload.
              // review_completed events already display model via PayloadRenderer.
              const showModelBadge =
                reviewModel &&
                REVIEW_EVENT_TYPES.has(event.type) &&
                typeof event.payload['model'] !== 'string';

              return (
                <li
                  key={event.event_id}
                  data-entity-id={event.event_id}
                  className={`ml-6 ${isPipeline ? 'mb-2' : 'mb-4'}`}
                >
                  <span
                    className={`absolute flex items-center justify-center rounded-full ring-4 ring-white dark:ring-gray-900 ${dotCls} ${
                      isPipeline ? '-left-1 h-2 w-2' : '-left-1.5 h-3 w-3'
                    }`}
                  />
                  {isPipeline ? (
                    /* Compact single-line layout for pipeline/technical events */
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {label}
                      </span>
                      <PayloadRenderer event={event} />
                      <RelativeTime
                        timestamp={event.created_at}
                        className="text-[10px] text-gray-400 dark:text-gray-500 ml-auto flex-shrink-0"
                      />
                    </div>
                  ) : (
                    /* Full layout for lifecycle and artifact events */
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`text-sm font-medium ${
                            isLifecycle
                              ? 'text-gray-900 dark:text-gray-100'
                              : 'text-gray-800 dark:text-gray-200'
                          }`}
                        >
                          {label}
                          {showModelBadge && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                              <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                              </svg>
                              {reviewModel}
                            </span>
                          )}
                        </span>
                        <RelativeTime
                          timestamp={event.created_at}
                          className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0"
                        />
                      </div>
                      <div className="mt-0.5">
                        <ActorBadge
                          actorId={event.actor_id}
                          userMap={userMap}
                          actorMetadata={
                            (event.payload as Record<string, unknown>)?.['actor_metadata'] as
                              | { client_name?: string; client_version?: string; model?: string }
                              | undefined
                          }
                        />
                      </div>
                      <PayloadRenderer event={event} />
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
