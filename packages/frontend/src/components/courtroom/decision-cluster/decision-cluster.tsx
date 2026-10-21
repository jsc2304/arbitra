'use client';

/**
 * DecisionCluster — tiered courtroom decision surface.
 *
 * Layout:
 *   [ FindingWaiveList: per-finding Waive / Confirm waiver rows            ]
 *   [ T1 row: Approve | Request Changes  (50/50 on md+, stacked on narrow) ]
 *   [ T2 row: Reject (full-width, secondary)                                ]
 *   [ RationaleSheet (inline reveal once a type is picked)                   ]
 *
 * Waive is per-finding and lives in the in-panel `FindingWaiveList`
 * (moved here from the FindingCard so every decision affordance sits in
 * this panel). Escalate is temporarily hidden until its backend
 * semantics are defined.
 *
 * Status routing:
 *   - `needs_human_decision`, `in_review`: T1 + T2 (Reject).
 *   - `verification_pending`: same shape — T1 = Approve + Request
 *     Changes, T2 = Reject.
 *   - Anything else (e.g. `pending_merge`, `in_validation`): no Tier-1
 *     actions are appropriate, so we render the "awaiting <next step>"
 *     fallback card.
 *   - `pending_merge` is a deliberate partial exception (issue #765): the
 *     case is already approved, so re-showing Tier-1 (which includes
 *     Approve) would be wrong. Instead `DecisionProgress` renders a single
 *     secondary "Request changes" action on its "Approved, waiting for
 *     merge" card; clicking it sets `selectedType` to `request_changes`
 *     and opens the same `RationaleSheet` → `createDecisionExecutor` →
 *     `POST /cases/:id/decisions` path Tier-1/Tier-2 use elsewhere. Covers
 *     the case where a review approves a pre-rebase diff and the branch
 *     keeps moving — there was previously no way back to `in_review`.
 *
 * All audit-critical behavior is preserved by reusing the extracted
 * primitives (`getDecisionOptions`, `RationaleForm`, `createDecisionExecutor`):
 *   - `approveBlockedByFindings` chip + tooltip + disabled approve.
 *   - Reject + Request Changes ConfirmDialog flow.
 *   - KnowledgeCapturePrompt fires on success via `onSuccess`.
 *   - PR #475 transition_error toast copy.
 */

import { useEffect, useState } from 'react';
import type { CaseStatus, DecisionType, Finding } from '@arbitra/shared';
import { api } from '../../../lib/api-client';
import { useToast } from '../../../providers/toast-provider';
import { countBlockers } from '../../../lib/finding-selectors';
import { createDecisionExecutor } from '../decision-executor';
import { KnowledgeCapturePrompt } from '../knowledge-capture-prompt';
import { DecisionProgress } from '../decision-progress';
import { TierOneActions, getTierOneOptions } from './tier-one-actions';
import { TierTwoActions, getTierTwoOptions } from './tier-two-actions';
import { RationaleSheet } from './rationale-sheet';
import { FindingWaiveList } from './finding-waive-list';
import {
  PreconditionBlockers,
  type PreconditionBlocker,
} from './precondition-blockers';

export interface DecisionClusterProps {
  caseId: string;
  caseTitle: string;
  projectId: string;
  caseStatus?: CaseStatus;
  findingId?: string;
  findings?: readonly Finding[];
  /**
   * Optional external trigger for entering a decision flow (currently used
   * by the per-finding Waive action in the in-panel `FindingWaiveList`).
   * When this prop changes to a non-null value, the cluster syncs
   * `selectedType` so the RationaleSheet opens with that decision
   * pre-selected.
   *
   * Shape is `{ type, nonce }` rather than a bare `DecisionType`: the
   * cluster's mirror effect re-fires on identity change, so the parent
   * must change the object reference (bumping `nonce`) on every trigger.
   * That lets the same decision type fire twice in a row even if the
   * user dismissed the rationale sheet between attempts (e.g. clicked
   * Waive on finding A → cancelled → clicked Waive on finding B). A
   * plain `DecisionType` would dedupe on equality and stick.
   */
  pendingDecisionType?: { type: DecisionType; nonce: number } | null;
  /**
   * Unmet approve preconditions for the case (fetched by the courtroom page,
   * only populated in `needs_human_decision` / `verification_pending`).
   * Surfaced as a persistent "Approval blocked by" panel for case-level
   * decisions. Empty / omitted → panel renders nothing.
   */
  approvalBlockers?: readonly PreconditionBlocker[];
  /**
   * Per-finding waive trigger. When provided, the cluster renders the
   * `FindingWaiveList` above the Tier-1 actions (rows sourced from
   * `findings`). The page's handler is expected to select the finding AND
   * bump `pendingDecisionType` to `waive` so the rationale sheet opens
   * linked to that finding.
   */
  onWaiveFinding?: (findingId: string) => void;
  /**
   * Selects a finding (center-pane detail) when a `FindingWaiveList` row —
   * not its action button — is clicked.
   */
  onSelectFinding?: (findingId: string) => void;
  onClearFinding?: () => void;
  onSubmit: () => void;
}

interface KnowledgePromptState {
  decisionId: string;
  decisionType: DecisionType;
  rationale: string;
}

/**
 * Statuses where the case is mid-decision and Tier-1 should be active.
 * Anything outside this set falls through to the no-Tier-1 fallback card.
 */
const TIER_ONE_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'needs_human_decision',
  'in_review',
  'verification_pending',
]);

function nextStepCopy(status: CaseStatus | undefined): string {
  switch (status) {
    case 'pending_merge':
      return 'merge';
    case 'in_validation':
      return 'validation';
    case 'in_build':
      return 'build completion';
    default:
      return 'next step';
  }
}

export function DecisionCluster({
  caseId,
  caseTitle,
  projectId,
  caseStatus,
  findingId,
  findings,
  pendingDecisionType,
  approvalBlockers,
  onWaiveFinding,
  onSelectFinding,
  onClearFinding,
  onSubmit,
}: DecisionClusterProps) {
  // Initialize from a non-null pending trigger so static-rendered (SSR /
  // initial-mount) consumers see the rationale sheet open immediately.
  // The mirror effect below picks up subsequent prop-driven triggers.
  const [selectedType, setSelectedType] = useState<DecisionType | null>(
    pendingDecisionType?.type ?? null,
  );
  const [linkedFindingId, setLinkedFindingId] = useState(findingId ?? '');
  const [knowledgePrompt, setKnowledgePrompt] =
    useState<KnowledgePromptState | null>(null);
  const { addToast } = useToast();

  // Sync linked-finding id from the parent-supplied selection.
  useEffect(() => {
    setLinkedFindingId(findingId ?? '');
  }, [findingId]);

  // Mirror parent-driven decision-type triggers (e.g. Waive from the
  // FindingWaiveList, routed through the page so the finding gets
  // selected too). The dep is the `pendingDecisionType` object identity:
  // the parent bumps `nonce` on every trigger so this fires even when
  // the user picks the same decision type twice in a row.
  useEffect(() => {
    if (pendingDecisionType) setSelectedType(pendingDecisionType.type);
  }, [pendingDecisionType]);

  const blockerCounts = countBlockers(findings ?? []);
  const hasFinding = Boolean(linkedFindingId);
  const approveBlockedByFindings =
    caseStatus === 'needs_human_decision' &&
    !linkedFindingId &&
    blockerCounts.total > 0;

  // Persistent approve-blocker panel: case-level decisions only (match the
  // `approveBlockedByFindings` gating that requires `!linkedFindingId`).
  //
  // De-dupe with the TierOneActions findings chip: when that amber chip is
  // already showing (`blockerCounts.total > 0`), drop the
  // `all_high_critical_resolved` blocker from this panel so the same fact
  // isn't stated twice in two different wordings. Other blockers (evidence,
  // four-eyes, manual validation) always show here.
  //
  // Note: the two sources are independent — `blockerCounts` is derived from
  // the client `findings` list, while the `all_high_critical_resolved` blocker
  // comes from the server-side precondition evaluator. They can briefly drift
  // (e.g. a waived high finding). Worst case the blocker is shown once in the
  // panel instead of the chip, which is acceptable; we never double-state it.
  const panelBlockers =
    !linkedFindingId && approvalBlockers
      ? approvalBlockers.filter(
          (b) =>
            !(b.id === 'all_high_critical_resolved' && blockerCounts.total > 0),
        )
      : [];

  const handleExecute = createDecisionExecutor({
    caseId,
    caseStatus,
    blockerCounts,
    submitDecision: api.cases.submitDecision,
    addToast,
    onSuccess: ({ decisionId, decisionType, rationale }) => {
      setSelectedType(null);
      setKnowledgePrompt({ decisionId, decisionType, rationale });
      onSubmit();
    },
  });

  const inTierOneStatus = caseStatus
    ? TIER_ONE_STATUSES.has(caseStatus)
    : false;

  const t1Options = getTierOneOptions(caseStatus, hasFinding);
  const t2Options = getTierTwoOptions(caseStatus, hasFinding);
  const hasAnyAction =
    inTierOneStatus && (t1Options.length > 0 || t2Options.length > 0);

  return (
    <div
      className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg"
      data-testid="decision-cluster"
    >
      <div className="border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Decision
        </h3>
      </div>

      <div className="p-4">
        <DecisionProgress
          caseStatus={caseStatus}
          findings={findings}
          hasFinding={hasFinding}
          onClearFinding={hasFinding ? onClearFinding : undefined}
          onRequestPendingMergeChanges={
            caseStatus === 'pending_merge'
              ? () => {
                  // The escape hatch (issue #765) is case-level by
                  // construction: pending_merge means the case is already
                  // approved, so this must always re-open it as a whole,
                  // never flag a single finding. If a finding was selected
                  // (persisted selection, or a `?finding=` URL param) when
                  // the user clicks this, clear it — both the cluster's own
                  // `linkedFindingId` (what actually goes into the submit
                  // payload, see rationale-form.tsx) and the parent's
                  // selection (`onClearFinding`, so the URL/center-pane
                  // selection and the sheet's "Linked Finding" display stay
                  // consistent with the case-level decision being made).
                  // Without this, the RationaleSheet opens still linked to
                  // the finding, submits `finding_id` set, decision-service
                  // treats it as a finding-level decision, and the case
                  // silently never leaves pending_merge.
                  setLinkedFindingId('');
                  onClearFinding?.();
                  setSelectedType('request_changes');
                }
              : undefined
          }
        />

        <PreconditionBlockers blockers={panelBlockers} />

        {hasAnyAction ? (
          <>
            {/* Per-finding waive rows. Inside the action branch on purpose:
                `FindingWaiveList` is not rendered in fallback statuses
                (pending_merge / in_validation), so a waive trigger from it
                can't fire there. (`pending_merge` does have its own,
                separate, non-finding-scoped `request_changes` trigger —
                see the hoisted `RationaleSheet` below.) */}
            {onWaiveFinding && (
              <FindingWaiveList
                findings={findings ?? []}
                onWaive={onWaiveFinding}
                onSelectFinding={onSelectFinding ?? (() => {})}
              />
            )}
            <TierOneActions
              caseStatus={caseStatus}
              hasFinding={hasFinding}
              selectedType={selectedType}
              approveBlockedByFindings={approveBlockedByFindings}
              blockerCounts={blockerCounts}
              onSelect={setSelectedType}
            />
            <TierTwoActions
              caseStatus={caseStatus}
              hasFinding={hasFinding}
              selectedType={selectedType}
              onSelect={setSelectedType}
            />
          </>
        ) : (
          <div
            className="rounded-md border border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/40 px-3 py-3 text-xs text-gray-600 dark:text-gray-400"
            data-testid="decision-cluster-fallback"
          >
            Awaiting {nextStepCopy(caseStatus)}.
          </div>
        )}

        {/*
          Hoisted outside the Tier-1/Tier-2 branch: the pending_merge
          escape hatch (issue #765, see DecisionProgress's
          `onRequestPendingMergeChanges` button) sets `selectedType` to
          `request_changes` from the fallback branch above, where
          `hasAnyAction` is false. The sheet self-gates on `open` /
          `selectedType`, so this is a no-op everywhere else.
        */}
        <RationaleSheet
          open={selectedType !== null}
          caseId={caseId}
          selectedType={selectedType}
          findingId={findingId}
          linkedFindingId={linkedFindingId}
          onLinkedFindingIdChange={setLinkedFindingId}
          approveBlockedByFindings={approveBlockedByFindings}
          onExecute={handleExecute}
        />

        {knowledgePrompt && (
          <KnowledgeCapturePrompt
            caseId={caseId}
            caseTitle={caseTitle}
            projectId={projectId}
            decisionId={knowledgePrompt.decisionId}
            decisionType={knowledgePrompt.decisionType}
            rationale={knowledgePrompt.rationale}
            onClose={() => setKnowledgePrompt(null)}
          />
        )}
      </div>
    </div>
  );
}
