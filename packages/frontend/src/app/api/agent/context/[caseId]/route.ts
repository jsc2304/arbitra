import { NextRequest, NextResponse } from 'next/server';
import {
  CaseService,
  EvidenceService,
  CompletenessEvaluator,
  EventService,
  FirestorePipelineAdapter,
  createPreconditionEvaluator,
} from '@arbitra/backend';
import { getTransitionsFrom } from '@arbitra/shared';
import type { CaseStatus, CaseType, CaseEvent, PreconditionId, LifecycleProfile } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { optionalEvidenceTypes } from '@/lib/optional-evidence-types';
import { resolveCaseShareUrl } from '@/lib/public-base-url';
import { getEvidenceLabel } from '@/lib/evidence-labels';

export const dynamic = 'force-dynamic';

/** Map raw evidence type IDs to objects with both the ID and a human-readable label. */
function labelEvidence(types: string[]): Array<{ type: string; label: string }> {
  return types.map((t) => ({ type: t, label: getEvidenceLabel(t) }));
}

/**
 * Framing surfaced to agents whenever review findings come back to them.
 * Findings are charges to answer, not orders to obey — the agent owns the
 * change, may fix or defend each finding, but must address every one.
 */
const REVIEW_FINDINGS_GUIDANCE =
  'Review findings are charges to answer, not orders to obey. You own this change and you have tested it. ' +
  'Engage with every finding on its merits: if it is a real problem, fix it; if it is off-base, out of scope for this ' +
  'case, or already handled, defend it — record a rationale (add_comment, or a create_decision rationale) so a human ' +
  'reviewer can waive it at the gate. Do not reflexively fix every finding, but you must address each one: an ' +
  'unanswered finding blocks the case.';

// ---------------------------------------------------------------------------
// Human-readable phase names
// ---------------------------------------------------------------------------

const PHASE_NAMES: Record<CaseStatus, string> = {
  open: 'Open',
  exploration: 'Exploration',
  ready_for_build: 'Ready for Build',
  in_build: 'In Build',
  in_validation: 'In Validation',
  in_review: 'AI Review',
  needs_human_decision: 'Needs Human Decision',
  verification_pending: 'Verification Pending',
  approved: 'Approved',
  pending_merge: 'Pending Merge',
  done: 'Done',
  rejected: 'Rejected',
};

// ---------------------------------------------------------------------------
// Next-steps per status
// ---------------------------------------------------------------------------

function getNextSteps(
  status: CaseStatus,
  isReturn = false,
  caseType?: CaseType,
): string[] {
  if (caseType === 'assistant_task') {
    switch (status) {
      case 'open':
        return [
          '1. Wait for the assistant task run to be claimed and started',
          '2. Reject the case if the task should be cancelled before it starts',
        ];
      case 'in_build':
        return [
          '1. Continue the current assistant task run',
          '2. Register task_result evidence with an artifact_ref and the current run_id',
          '3. Complete the assistant_task_run',
          '4. Wait for the case to transition to done automatically',
        ];
      case 'needs_human_decision':
        return [
          '1. Provide the requested input or record an approve/request_changes decision',
          '2. Wait for the assistant task to resume in in_build',
          '3. Reject the case to cancel once no assistant run is active',
        ];
      case 'done':
        return ['Assistant task is complete.'];
      case 'rejected':
        return ['Assistant task has been rejected.'];
      default:
        return ['Assistant task is in an unsupported lifecycle status.'];
    }
  }

  switch (status) {
    case 'open':
      return ['1. Run /explore to start exploration'];
    case 'exploration':
      return ['1. Wait for auto-transition to ready_for_build'];
    case 'ready_for_build':
      return ['1. Run /build to start implementation'];
    case 'in_build': {
      const steps = isReturn
        ? [
            '0. Review the findings and reviewer rationale — they are charges to answer, not orders. You own this change and have tested it.',
            '1. For each open finding: fix it if real, or defend it with a rationale (add_comment / create_decision) so a human can waive it at the gate — address every finding, skip none.',
            '2. Commit changes to feature branch',
            '3. Push branch and update PR',
            '4. Call GET /api/agent/context/{caseId} to verify evidence status',
            '5. Present completion summary to user: branch, PR URL, changes, evidence',
            '6. After user confirms → call POST /api/agent/build-complete',
            '⚠ Your task is NOT complete until step 6 succeeds. Do NOT stop after committing.',
          ]
        : [
            '1. Implement changes and write tests',
            '2. Commit changes to feature branch',
            '3. Push branch and create PR',
            '4. Call GET /api/agent/context/{caseId} to verify evidence status',
            '5. Present completion summary to user: branch, PR URL, changes, evidence',
            '6. After user confirms → call POST /api/agent/build-complete',
            '⚠ Your task is NOT complete until step 6 succeeds. Do NOT stop after committing.',
          ];
      return steps;
    }
    case 'in_validation':
      return [
        '1. Wait for automatic validation',
        '2. If issues found, request_changes can loop back to in_build',
      ];
    case 'in_review':
      return [
        '1. Wait for auto-review to complete',
        '2. There is no manual review trigger. If the review run failed and exhausted retries (case stuck in in_review with no completed run), recovery is either a request_changes decision looping back to in_build followed by a fresh POST /api/agent/build-complete, or an authorized human recording a review_not_applicable decision',
      ];
    case 'needs_human_decision':
      return [
        '1. A human reviewer must approve, request changes, or reject',
        '2. Wait for the decision to be recorded',
      ];
    case 'verification_pending':
      return [
        '1. Manual verification is required',
        '2. Wait for manual_validation_confirmed event',
      ];
    case 'approved':
      return ['1. Wait for auto-transition to pending_merge'];
    case 'pending_merge':
      return [
        '1. Merge the PR',
        '2. Case transitions to done automatically after merge',
      ];
    case 'done':
      return ['Case is complete. To start new work, create a new case via /create-case.'];
    case 'rejected':
      return ['Case has been rejected. To start new work, create a new case via /create-case.'];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Warnings per status
// ---------------------------------------------------------------------------

function getWarnings(status: CaseStatus, caseType?: CaseType): string[] {
  if (caseType === 'assistant_task') {
    switch (status) {
      case 'open':
        return ['Do NOT run /explore or /build for an assistant task'];
      case 'in_build':
        return ['Do NOT open or merge a PR, or call build-complete, for an assistant task'];
      case 'needs_human_decision':
        return ['Do NOT resume the assistant task until input or approval is recorded after the latest hold'];
      default:
        return [];
    }
  }

  const warnings: string[] = [];
  switch (status) {
    case 'in_build':
      warnings.push('Do NOT merge PR before reaching pending_merge status');
      warnings.push('Do NOT skip the build-complete confirmation step');
      warnings.push('Do NOT stop after committing — push, create PR, and call build-complete to finish');
      break;
    case 'in_validation':
      warnings.push('Do NOT push new commits while validation is running');
      break;
    case 'in_review':
      warnings.push('Do NOT merge PR — review must complete first');
      break;
    case 'pending_merge':
      warnings.push('Only merge after all checks are green');
      break;
    case 'needs_human_decision':
      warnings.push('Do NOT attempt to auto-approve — a human must decide');
      break;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Allowed / blocked actions per status
// ---------------------------------------------------------------------------

function getAllowedActions(status: CaseStatus, caseType?: CaseType): string[] {
  if (caseType === 'assistant_task') {
    switch (status) {
      case 'open':
        return ['reject'];
      case 'in_build':
        return ['reject', 'add_evidence', 'add_comment'];
      case 'needs_human_decision':
        return ['approve', 'request_changes', 'reject', 'add_comment'];
      default:
        return [];
    }
  }

  switch (status) {
    case 'open':
      return ['explore', 'edit_case', 'delete_case'];
    case 'exploration':
      return ['reject'];
    case 'ready_for_build':
      return ['build', 'edit_case', 'reject'];
    case 'in_build':
      return ['build_complete', 'reject', 'add_evidence', 'add_comment'];
    case 'in_validation':
      return ['request_changes', 'reject', 'add_evidence'];
    case 'in_review':
      return ['reject', 'request_changes'];
    case 'needs_human_decision':
      return ['approve', 'request_changes', 'reject', 'escalate'];
    case 'verification_pending':
      return ['manual_validation_confirm', 'reject'];
    case 'approved':
      return [];
    case 'pending_merge':
      return ['merge', 'request_changes', 'reject'];
    case 'done':
      return [];
    case 'rejected':
      return [];
    default:
      return [];
  }
}

function getBlockedActions(status: CaseStatus, caseType?: CaseType): string[] {
  if (caseType === 'assistant_task') {
    const engineeringActions = ['explore', 'build', 'build_complete', 'merge'];
    switch (status) {
      case 'open':
      case 'in_build':
        return [...engineeringActions, 'approve', 'request_changes'];
      case 'needs_human_decision':
        return engineeringActions;
      case 'done':
      case 'rejected':
        return [...engineeringActions, 'approve', 'request_changes', 'reject'];
      default:
        return engineeringActions;
    }
  }

  switch (status) {
    case 'open':
      return ['build', 'merge', 'approve'];
    case 'exploration':
      return ['build', 'merge', 'approve'];
    case 'ready_for_build':
      return ['merge', 'approve', 'explore'];
    case 'in_build':
      return ['merge', 'approve', 'explore'];
    case 'in_validation':
      return ['merge', 'approve', 'build'];
    case 'in_review':
      return ['merge', 'approve', 'build'];
    case 'needs_human_decision':
      return ['merge', 'build', 'explore'];
    case 'verification_pending':
      return ['merge', 'build', 'explore', 'approve'];
    case 'approved':
      return ['build', 'explore', 'approve'];
    case 'pending_merge':
      return ['build', 'explore', 'approve'];
    case 'done':
      return ['build', 'explore', 'approve', 'merge', 'request_changes'];
    case 'rejected':
      return ['build', 'explore', 'approve', 'merge', 'request_changes'];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Preconditions from the transition matrix
// ---------------------------------------------------------------------------

interface PreconditionStatus {
  satisfied: boolean;
  reason?: string;
}

/**
 * Collect every precondition ID that appears on any outgoing transition from
 * the given status, deduped. Used to drive full evaluation via
 * PreconditionEvaluator.
 */
function collectPreconditionIds(status: CaseStatus, caseType?: CaseType): PreconditionId[] {
  const ids = new Set<PreconditionId>();
  for (const t of getTransitionsFrom(status, caseType)) {
    for (const p of t.preconditions) {
      ids.add(p);
    }
  }
  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    const { safeHeartbeat } = await import('@arbitra/backend');
    await safeHeartbeat({ caseId: params.caseId, userId: auth.userId, source: 'ide_agent' });

    const caseService = new CaseService();
    const caseData = await caseService.getCase(params.caseId);
    const status = caseData.status;

    // Fetch evidence requirements
    const evidenceService = new EvidenceService();
    const evidence = await evidenceService.getEvidenceForCase(params.caseId);
    const evaluator = new CompletenessEvaluator();
    const evalResult = await evaluator.evaluate(caseData, evidence);
    // Shared with `GET /api/cases/:id/evidence/requirements`: an agent reading a
    // Clerk case must be told the same optional list a person is.
    const optionalEvidence = await optionalEvidenceTypes(caseData, evaluator);

    // Fetch recent events
    const eventService = new EventService();
    const allEvents = await eventService.getHistory(params.caseId);
    const sortedEvents = allEvents
      .sort((a: CaseEvent, b: CaseEvent) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const recentEvents = sortedEvents.slice(0, 5);

    // Detect return to in_build after changes_requested
    const isReturn = status === 'in_build' && sortedEvents.some((e: CaseEvent) => e.type === 'changes_requested');

    // Build return_context for loopback cases
    let returnContext: Record<string, unknown> | undefined;
    if (isReturn) {
      try {
        const { DecisionService: DS, collections: cols } = await import('@arbitra/backend');
        const decisionSvc = new DS();
        const decisions = await decisionSvc.getDecisionsForCase(params.caseId);
        const lastRequestChanges = [...decisions]
          .reverse()
          .find((d) => d.type === 'request_changes');

        const findingsSnap = await cols.findings()
          .where('case_id', '==', params.caseId)
          .where('status', '==', 'open')
          .get();
        const openFindings = findingsSnap.docs.map((doc) => doc.data());

        returnContext = {
          returned: true,
          guidance: REVIEW_FINDINGS_GUIDANCE,
          reason: lastRequestChanges?.rationale ?? 'No rationale provided',
          decision_by: lastRequestChanges?.actor_id,
          open_findings: openFindings.map((f) => ({
            finding_id: f.finding_id,
            title: f.title,
            severity: f.severity,
            category: f.category,
          })),
        };
      } catch {
        // Return context lookup failed — continue without it
      }
    }

    // Fetch project (including lifecycle_profile so agents can predict
    // whether upcoming gate transitions auto-fire or wait for confirmation).
    let projectInfo: {
      name: string;
      custom_instructions?: string;
      reviewer_pool: string[];
      evidence_policy_id?: string;
      default_validation_track?: 'direct' | 'manual';
      default_language?: 'en' | 'de';
      lifecycle_profile?: LifecycleProfile;
    } | null = null;

    if (caseData.project_id) {
      try {
        const { collections } = await import('@arbitra/backend');
        const projDoc = await collections.projects().doc(caseData.project_id).get();
        if (projDoc.exists) {
          const proj = projDoc.data()!;
          projectInfo = {
            name: proj.name,
            reviewer_pool: proj.reviewer_pool ?? [],
            evidence_policy_id: proj.default_evidence_policy_id,
            default_validation_track: proj.default_validation_track ?? 'direct',
            default_language: proj.default_language ?? 'en',
            lifecycle_profile: proj.lifecycle_profile,
          };
        }
      } catch {
        // Project lookup failed — continue without project info
      }
    }

    // Evaluate preconditions for every outgoing transition from the current
    // status. Returns a detailed per-precondition status (satisfied + reason)
    // so the agent can see exactly what's blocking the next transition.
    const preconditionIds = collectPreconditionIds(status, caseData.case_type);
    let preconditions: Record<PreconditionId, PreconditionStatus> =
      {} as Record<PreconditionId, PreconditionStatus>;
    if (preconditionIds.length > 0) {
      try {
        const adapter = new FirestorePipelineAdapter();
        const ctx = await adapter.loadPreconditionContext(caseData);
        const preconditionEvaluator = createPreconditionEvaluator(ctx);
        const results = await Promise.all(
          preconditionIds.map(async (id) => [id, await preconditionEvaluator.evaluate(id)] as const),
        );
        for (const [id, result] of results) {
          preconditions[id] = result.reason
            ? { satisfied: result.satisfied, reason: result.reason }
            : { satisfied: result.satisfied };
        }
      } catch {
        // Precondition evaluation failed — fall back to listing IDs as
        // unsatisfied so the response shape stays consistent.
        preconditions = preconditionIds.reduce(
          (acc, id) => {
            acc[id] = { satisfied: false, reason: 'Evaluation failed' };
            return acc;
          },
          {} as Record<PreconditionId, PreconditionStatus>,
        );
      }
    }

    const share_url = resolveCaseShareUrl(request, caseData.case_id, caseData.status);

    return NextResponse.json({
      case: caseData,
      ...(share_url !== null && { share_url }),
      phase: {
        name: PHASE_NAMES[status] ?? status,
        allowed_actions: getAllowedActions(status, caseData.case_type),
        blocked_actions: getBlockedActions(status, caseData.case_type),
        warnings: getWarnings(status, caseData.case_type),
      },
      next_steps: getNextSteps(status, isReturn, caseData.case_type),
      evidence: {
        required: labelEvidence(evalResult.required),
        optional: labelEvidence(optionalEvidence),
        present: labelEvidence(evalResult.present),
        missing: labelEvidence(evalResult.missing),
        satisfied: evalResult.satisfied,
      },
      preconditions,
      project: projectInfo,
      recent_events: recentEvents,
      return_context: returnContext ?? null,
    });
  } catch (error) {
    return handleError(error);
  }
}
