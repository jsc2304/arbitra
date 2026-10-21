'use client';

import useSWR from 'swr';
import type { Decision } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useUserMap } from '../../hooks/use-users';
import { actorDisplayName } from '../../lib/actor-display';
import { DECISION_TYPE_LABELS } from '../../lib/decision-type-labels';
import { RelativeTime } from '../shared/relative-time';

interface DecisionHistoryProps {
  caseId: string;
}

/**
 * Render entry for the decisions list. Either a single standalone decision
 * row, or a manual-track approve/manual_validation_confirmed pair rendered
 * as one merged row anchored on the user-driven approve.
 *
 * The pair is detected at render time only — both decisions remain present
 * in the underlying data and are revealed via a disclosure inside the
 * merged row, preserving the audit trail.
 */
type DecisionEntry =
  | { kind: 'single'; decision: Decision }
  | { kind: 'manual_track_pair'; approve: Decision; validation: Decision };

/**
 * Maximum drift between the auto-attached `manual_validation_confirmed`
 * timestamp and its sibling `approve`. Both rows are written by the same
 * `decision-service.ts` call, but Firestore commit latency can realistically
 * push the Δ to the low-second range. 5s is conservative — type-anchored on
 * `(approve, manual_validation_confirmed)` so it cannot false-positive on
 * rapid distinct approves. Anything larger than this is treated as two
 * distinct decisions and rendered separately.
 */
const PAIR_TIMESTAMP_TOLERANCE_MS = 5000;

/**
 * Detect manual-track approve pairs in the decision list and collapse them
 * into a single visual entry. The list is newest-first, so the `approve`
 * (later timestamp) appears immediately before the `manual_validation_confirmed`
 * (earlier timestamp). Pair predicate: adjacent rows, same actor_id, types
 * {approve, manual_validation_confirmed}, |Δtimestamp| < PAIR_TIMESTAMP_TOLERANCE_MS.
 * case_id is not checked because the list is already scoped to a single case.
 */
function groupDecisions(decisions: Decision[]): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  let i = 0;
  while (i < decisions.length) {
    const current = decisions[i];
    if (!current) break;
    const next = decisions[i + 1];
    if (next && isManualTrackApprovePair(current, next)) {
      entries.push({ kind: 'manual_track_pair', approve: current, validation: next });
      i += 2;
      continue;
    }
    entries.push({ kind: 'single', decision: current });
    i += 1;
  }
  return entries;
}

function isManualTrackApprovePair(a: Decision, b: Decision): boolean {
  if (a.actor_id !== b.actor_id) return false;
  if (a.type !== 'approve' || b.type !== 'manual_validation_confirmed') return false;
  const deltaMs = Math.abs(
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  return deltaMs < PAIR_TIMESTAMP_TOLERANCE_MS;
}

function snapshotSummary(snapshot: Decision['snapshot']): string {
  if (snapshot.snapshot_fidelity !== 'exact') {
    return 'snapshot unavailable (legacy)';
  }
  return `${Object.keys(snapshot.active_rule_set_versions).length} rule set(s), evidence policy v${snapshot.evidence_policy_version}, ${snapshot.knowledge_asset_refs.length} knowledge ref(s)`;
}

export function DecisionHistory({ caseId }: DecisionHistoryProps) {
  const { data, error, isLoading } = useSWR(
    ['decisions', caseId],
    () => api.cases.decisions(caseId),
  );

  const decisions = data?.decisions ?? [];
  const actorIds = decisions.map((d) => d.actor_id).filter((id) => !id.startsWith('system:'));
  const userMap = useUserMap(actorIds);

  if (isLoading) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        Loading decisions...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-8 text-center text-sm text-red-600">
        Failed to load decisions: {error.message}
      </div>
    );
  }

  const entries = groupDecisions(decisions);

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Decisions ({decisions.length})
          </h3>
          <span
            className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-[10px] font-bold cursor-help"
            title="Decisions are the documented approval, rejection, or exception choices made on a case. They can be human (approve, reject, waive, escalate, request changes) or automatic (auto-approve when all criteria are met). Each decision includes a rationale and a snapshot of the rule and evidence state at the time."
          >
            ?
          </span>
        </div>
      </div>

      {decisions.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0 0 12 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 0 1-2.031.352 5.988 5.988 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971Zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0 2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 0 1-2.031.352 5.989 5.989 0 0 1-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971Z" />
          </svg>
          <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">No decisions yet</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            Decisions appear here when the case reaches review. If all auto-approve criteria are met
            (no high/critical findings, all rules pass, evidence complete), the system decides automatically.
            Otherwise, a human reviewer makes the call in the Courtroom.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {entries.map((entry) => {
            if (entry.kind === 'manual_track_pair') {
              return (
                <ManualTrackPairRow
                  key={entry.approve.decision_id}
                  approve={entry.approve}
                  validation={entry.validation}
                  resolvedActorName={
                    userMap[entry.approve.actor_id]?.display_name
                    || userMap[entry.approve.actor_id]?.email
                    || undefined
                  }
                />
              );
            }
            return (
              <DecisionRow
                key={entry.decision.decision_id}
                decision={entry.decision}
                resolvedActorName={
                  userMap[entry.decision.actor_id]?.display_name
                  || userMap[entry.decision.actor_id]?.email
                  || undefined
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface DecisionRowProps {
  decision: Decision;
  resolvedActorName: string | undefined;
}

function DecisionRow({ decision, resolvedActorName }: DecisionRowProps) {
  const typeConfig = DECISION_TYPE_LABELS[decision.type] ?? {
    label: decision.type,
    className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
  };

  return (
    <li data-entity-id={decision.decision_id} className="px-4 py-3 rounded transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${typeConfig.className}`}
          >
            {typeConfig.label}
          </span>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            by <span className="font-medium">{actorDisplayName(
              decision.actor_id,
              decision.actor_metadata,
              resolvedActorName,
            ).label}</span>
          </span>
        </div>
        <RelativeTime
          timestamp={decision.created_at}
          className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0"
        />
      </div>

      {decision.rationale && (
        <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400 pl-2 border-l-2 border-gray-200 dark:border-border-subtle ml-1">
          {decision.rationale}
        </p>
      )}

      {decision.finding_id && (
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          Finding: {decision.finding_id}
        </p>
      )}

      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        Snapshot: {snapshotSummary(decision.snapshot)}
      </div>
    </li>
  );
}

interface ManualTrackPairRowProps {
  approve: Decision;
  validation: Decision;
  resolvedActorName: string | undefined;
}

function ManualTrackPairRow({ approve, validation, resolvedActorName }: ManualTrackPairRowProps) {
  const approveTypeConfig = DECISION_TYPE_LABELS.approve;
  const validationTypeConfig = DECISION_TYPE_LABELS.manual_validation_confirmed;

  return (
    <li
      data-entity-id={approve.decision_id}
      data-paired-decision-id={validation.decision_id}
      className="px-4 py-3 rounded transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${approveTypeConfig.className}`}
          >
            Approved (manual track)
          </span>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            by <span className="font-medium">{actorDisplayName(
              approve.actor_id,
              approve.actor_metadata,
              resolvedActorName,
            ).label}</span>
          </span>
        </div>
        <RelativeTime
          timestamp={approve.created_at}
          className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0"
        />
      </div>

      {approve.rationale && (
        <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400 pl-2 border-l-2 border-gray-200 dark:border-border-subtle ml-1">
          {approve.rationale}
        </p>
      )}

      {approve.finding_id && (
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          Finding: {approve.finding_id}
        </p>
      )}

      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
        Snapshot: {snapshotSummary(approve.snapshot)}
      </div>

      <details
        data-paired-validation-id={validation.decision_id}
        className="mt-2"
      >
        <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400 hover:underline">
          Show validation step
        </summary>
        <div className="mt-2 ml-2 pl-3 border-l-2 border-gray-200 dark:border-border-subtle">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${validationTypeConfig.className}`}
              >
                {validationTypeConfig.label}
              </span>
              <span className="text-sm text-gray-700 dark:text-gray-300">
                by <span className="font-medium">{actorDisplayName(
                  validation.actor_id,
                  validation.actor_metadata,
                  resolvedActorName,
                ).label}</span>
              </span>
            </div>
            <RelativeTime
              timestamp={validation.created_at}
              className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0"
            />
          </div>

          {validation.rationale && (
            <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">
              {validation.rationale}
            </p>
          )}

          {validation.finding_id && (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Finding: {validation.finding_id}
            </p>
          )}

          <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Snapshot: {snapshotSummary(validation.snapshot)}
          </div>
        </div>
      </details>
    </li>
  );
}
