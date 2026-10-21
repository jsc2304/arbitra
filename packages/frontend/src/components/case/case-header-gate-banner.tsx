'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { GATE_TRANSITION_MAP, type Case, type CaseStatus } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { CASE_STATUS_LABELS } from '../../lib/case-status-labels';
import { useToast } from '../../providers/toast-provider';
import { useAuth } from '../../providers/auth-provider';

interface GateBannerProps {
  caseData: Case;
  onTransition: () => void;
}

/** Case statuses where a gate can never be pending — skip the rule-gate fetch. */
const GATE_IRRELEVANT_STATUSES: CaseStatus[] = ['done', 'rejected'];

export function GateBanner({ caseData, onTransition }: GateBannerProps) {
  const { user } = useAuth();
  const isOwner = !!user && user.uid === caseData.owner_user_id;

  // A `pending_gate` marker is only ACTIVE when the case is still sitting in
  // the status the gate was emitted for. A legitimate transition out of that
  // status (most commonly a case-level Request Changes) can leave the marker
  // set on a case that has since moved on — the banner must never advertise
  // a gate the case has already passed, or offer Confirm/Decline for it
  // (issue #1049). `executeGateConfirmation` applies the identical
  // `GATE_TRANSITION_MAP[gate_id].from === status` guard server-side and
  // refuses a stale confirm, so this keeps the UI from ever inviting a click
  // the backend would reject anyway.
  const pendingGate = caseData.pending_gate;
  const activeGate =
    pendingGate && GATE_TRANSITION_MAP[pendingGate.gate_id]?.from === caseData.status
      ? pendingGate
      : undefined;

  // Resolve effective `allow_self_approval` for this case (track × risk) via the
  // evidence requirements endpoint. Only fetched when the current user is the
  // owner AND a gate is pending — avoids unnecessary calls for reviewers.
  const shouldFetchRequirements = isOwner && !!activeGate;
  const { data: requirements } = useSWR(
    shouldFetchRequirements ? ['case-evidence-requirements', caseData.case_id] : null,
    () => api.cases.evidenceRequirements(caseData.case_id),
  );
  const allowSelfApproval = requirements?.allow_self_approval === true;
  // Owner is blocked from the gate buttons only when the effective policy cell
  // prohibits self-approval (historical default). When the cell permits it, the
  // owner may proceed — a second distinct human is still required for four-eyes.
  const ownerBlockedFromGate = isOwner && !allowSelfApproval;
  const ownerGateTooltip = 'Case owners cannot confirm their own gate (anti-gaming). Another reviewer or tech lead must confirm.';
  const { addToast } = useToast();
  const [gateActing, setGateActing] = useState(false);

  // Blocked `human_confirmation` rule gates — a case-level action
  // distinct from the lifecycle pending_gate above (resolved via the same
  // gate_confirmed/gate_rejected decision types, scoped by `rule_id`). Their
  // presence isn't known from the Case object, so this always fetches for
  // any non-terminal case.
  const shouldFetchRuleGates = !GATE_IRRELEVANT_STATUSES.includes(caseData.status);
  const { data: ruleGatesData, error: ruleGatesError, mutate: mutateRuleGates } = useSWR(
    shouldFetchRuleGates ? ['case-human-confirmation-gates', caseData.case_id] : null,
    () => api.cases.humanConfirmationGates(caseData.case_id),
  );
  const ruleGates = ruleGatesData?.gates ?? [];
  const [ruleGateActingId, setRuleGateActingId] = useState<string | null>(null);

  async function handleRuleGateConfirm(ruleId: string) {
    setRuleGateActingId(ruleId);
    try {
      await api.cases.submitDecision(caseData.case_id, {
        case_id: caseData.case_id,
        type: 'gate_confirmed',
        rule_id: ruleId,
        rationale: `Confirmed human_confirmation gate for rule ${ruleId}`,
      });
      addToast('success', 'Gate confirmed — case is proceeding');
      await mutateRuleGates();
      onTransition();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to confirm gate');
    } finally {
      setRuleGateActingId(null);
    }
  }

  async function handleRuleGateReject(ruleId: string) {
    setRuleGateActingId(ruleId);
    try {
      await api.cases.submitDecision(caseData.case_id, {
        case_id: caseData.case_id,
        type: 'gate_rejected',
        rule_id: ruleId,
        rationale: `Declined human_confirmation gate for rule ${ruleId}`,
      });
      addToast('success', 'Gate declined — case stays in current state');
      await mutateRuleGates();
      onTransition();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to decline gate');
    } finally {
      setRuleGateActingId(null);
    }
  }

  async function handleGateConfirm() {
    setGateActing(true);
    try {
      await api.cases.submitDecision(caseData.case_id, {
        case_id: caseData.case_id,
        type: 'gate_confirmed',
        rationale: `Confirmed gate ${activeGate?.gate_id} to proceed to ${activeGate?.target_status}`,
      });
      addToast('success', 'Gate confirmed — case is proceeding');
      onTransition();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to confirm gate');
    } finally {
      setGateActing(false);
    }
  }

  async function handleGateDecline() {
    setGateActing(true);
    try {
      await api.cases.submitDecision(caseData.case_id, {
        case_id: caseData.case_id,
        type: 'gate_rejected',
        rationale: `Declined gate ${activeGate?.gate_id} — case stays in ${caseData.status}`,
      });
      addToast('success', 'Gate declined — case stays in current state');
      onTransition();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to decline gate');
    } finally {
      setGateActing(false);
    }
  }

  // A failed rule-gates fetch must stay visible — silently falling through to
  // `ruleGates.length === 0` renders as "no gates", hiding a real error from
  // whoever needs to confirm the gate (issue #738 point 3).
  if (!activeGate && ruleGates.length === 0 && !ruleGatesError) return null;

  return (
    <>
      {ruleGatesError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400"
        >
          Failed to load gate status: {ruleGatesError instanceof Error ? ruleGatesError.message : 'Unknown error'}
        </div>
      )}

      {activeGate && (
        <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Awaiting confirmation to proceed to{' '}
                  <span className="font-semibold">{CASE_STATUS_LABELS[activeGate.target_status as CaseStatus] ?? activeGate.target_status}</span>
                </p>
                <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                  All preconditions are satisfied. A reviewer or tech lead must confirm this transition.
                </p>
              </div>
            </div>
            <div className="flex flex-col sm:items-end gap-1 flex-shrink-0">
              <div className="flex items-center gap-2">
                {/* Wrapper span carries the tooltip for disabled buttons — browsers don't fire hover on disabled <button>. */}
                <span title={ownerBlockedFromGate ? ownerGateTooltip : undefined} tabIndex={ownerBlockedFromGate ? 0 : -1}>
                  <button
                    type="button"
                    onClick={handleGateConfirm}
                    disabled={gateActing || ownerBlockedFromGate}
                    aria-describedby={ownerBlockedFromGate ? 'gate-owner-hint' : undefined}
                    title={ownerBlockedFromGate ? ownerGateTooltip : undefined}
                    className="inline-flex items-center rounded-md bg-amber-600 px-3 py-1.5 text-xs sm:text-sm font-medium text-white hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {gateActing ? 'Processing...' : 'Confirm'}
                  </button>
                </span>
                <span title={ownerBlockedFromGate ? ownerGateTooltip : undefined} tabIndex={ownerBlockedFromGate ? 0 : -1}>
                  <button
                    type="button"
                    onClick={handleGateDecline}
                    disabled={gateActing || ownerBlockedFromGate}
                    aria-describedby={ownerBlockedFromGate ? 'gate-owner-hint' : undefined}
                    title={ownerBlockedFromGate ? ownerGateTooltip : undefined}
                    className="inline-flex items-center rounded-md bg-surface-raised px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 transition-colors ring-1 ring-gray-300 dark:ring-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Decline
                  </button>
                </span>
              </div>
              {ownerBlockedFromGate && (
                <p id="gate-owner-hint" className="text-xs text-amber-700 dark:text-amber-400 max-w-xs sm:text-right">
                  {ownerGateTooltip}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Blocked human_confirmation rule gates — same confirm/reject
          pattern as the lifecycle gate above, scoped to a specific rule via
          `rule_id` instead of the case's `pending_gate`. */}
      {ruleGates.map((gate) => (
        <div
          key={gate.rule_result_id}
          className="mt-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Human confirmation required: <span className="font-semibold">{gate.rule_name}</span>
                </p>
                <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">{gate.message}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => handleRuleGateConfirm(gate.rule_id)}
                disabled={ruleGateActingId === gate.rule_id}
                className="inline-flex items-center rounded-md bg-amber-600 px-3 py-1.5 text-xs sm:text-sm font-medium text-white hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {ruleGateActingId === gate.rule_id ? 'Processing...' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => handleRuleGateReject(gate.rule_id)}
                disabled={ruleGateActingId === gate.rule_id}
                className="inline-flex items-center rounded-md bg-surface-raised px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 transition-colors ring-1 ring-gray-300 dark:ring-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
