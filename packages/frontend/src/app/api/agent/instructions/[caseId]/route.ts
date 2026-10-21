import { NextRequest, NextResponse } from 'next/server';
import { CaseService } from '@arbitra/backend';
import { getDefaultPolicyRule } from '@arbitra/shared';
import type { Case, CaseStatus } from '@arbitra/shared';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { getEvidenceLabel } from '@/lib/evidence-labels';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Phase-specific instruction generator
// ---------------------------------------------------------------------------

function generateInstructions(caseData: Case, projectName?: string, evidenceInfo?: {
  required: string[];
  missing: string[];
  satisfied: boolean;
}): string {
  const status = caseData.status;
  const lines: string[] = [];

  lines.push(`# ${getPhaseTitle(status)}`);
  lines.push('');
  lines.push(`Case: ${caseData.title} (${caseData.case_id})`);
  lines.push(`Risk: ${caseData.risk_level} | Track: ${caseData.validation_track}`);
  if (projectName) {
    lines.push(`Project: ${projectName}`);
  }
  lines.push('');

  // Phase-specific instructions
  lines.push('## What to do');
  lines.push('');
  for (const step of getPhaseSteps(status)) {
    lines.push(step);
  }
  lines.push('');

  // Evidence requirements (relevant for build/validation phases)
  if (evidenceInfo && ['in_build', 'in_validation', 'ready_for_build', 'needs_human_decision', 'verification_pending'].includes(status)) {
    lines.push('## Evidence requirements');
    lines.push('');
    if (evidenceInfo.satisfied) {
      lines.push('All required evidence is present.');
    } else {
      lines.push(`Missing: ${evidenceInfo.missing.map((t) => `${getEvidenceLabel(t)} (${t})`).join(', ')}`);
    }
    lines.push(`Required types: ${evidenceInfo.required.map((t) => `${getEvidenceLabel(t)} (${t})`).join(', ')}`);
    lines.push('');
  }

  // Do NOT list
  lines.push('## Do NOT');
  lines.push('');
  for (const rule of getDoNotList(status)) {
    lines.push(rule);
  }

  return lines.join('\n');
}

function getPhaseTitle(status: CaseStatus): string {
  const titles: Record<CaseStatus, string> = {
    open: 'Phase: Open — Set up the case',
    exploration: 'Phase: Exploration — Analyzing scope',
    ready_for_build: 'Phase: Ready for Build — Start implementation',
    in_build: 'Phase: In Build — Implement and deliver',
    in_validation: 'Phase: In Validation — Automated checks running',
    in_review: 'Phase: AI Review — Review in progress',
    needs_human_decision: 'Phase: Human Decision Required',
    verification_pending: 'Phase: Manual Verification Pending',
    approved: 'Phase: Approved — Preparing for merge',
    pending_merge: 'Phase: Pending Merge — Merge the PR',
    done: 'Phase: Done',
    rejected: 'Phase: Rejected',
  };
  return titles[status] ?? `Phase: ${status}`;
}

function getPhaseSteps(status: CaseStatus): string[] {
  switch (status) {
    case 'open':
      return [
        '- Ensure title, description, risk level, and validation track are set',
        '- Call signal_exploration_complete(case_id, summary) to finish exploration setup',
      ];
    case 'exploration':
      return [
        '- The system is analyzing the case scope automatically',
        '- Wait for exploration to complete — the case will auto-transition to ready_for_build',
        '- Call get_case_context(case_id) to check current status',
      ];
    case 'ready_for_build':
      return [
        '- Review the exploration results',
        '- Call transition_case(case_id, target_status: "in_build") to start the build phase',
      ];
    case 'in_build':
      return [
        '- Step 1: Implement the required changes in code',
        '- Step 2: Write tests and ensure they pass',
        '- Step 3: Commit changes to the feature branch',
        '- Step 4: Push the branch and create a PR',
        '- Step 5: Call get_case_context(case_id) to verify evidence and status',
        '- Step 6: Present completion summary to user (branch, PR URL, changes, evidence status)',
        '- Step 7: After user confirms, call signal_build_complete(case_id, summary, branch, pr_url, evidence)',
        '',
        '⚠ IMPORTANT: Your task is NOT complete until step 7 succeeds.',
        '⚠ Committing code is step 3 of 7 — do NOT stop there.',
      ];
    case 'in_validation':
      return [
        '- Automated validation (rules, evidence checks) is running',
        '- Monitor for any issues — if validation fails, request_changes loops back to in_build',
        '- Call get_case_context(case_id) to check progress',
        '- Once validation passes, the case auto-transitions to in_review',
      ];
    case 'in_review':
      return [
        '- AI review is running automatically',
        '- Call get_case_context(case_id) to check review status',
        '- Review results determine the next state (approved, needs_human_decision, or verification_pending)',
      ];
    case 'needs_human_decision':
      return [
        '- A human reviewer must evaluate the findings',
        '- Call add_comment(case_id, body) to provide context for the reviewer',
        '- Possible outcomes: approve, request changes, reject, or escalate',
      ];
    case 'verification_pending':
      return [
        '- Manual verification of the target system is required',
        '- A human must confirm the verification and record the result',
      ];
    case 'approved':
      return [
        '- The case is approved and will auto-transition to pending_merge',
      ];
    case 'pending_merge':
      return [
        '- Merge the PR in the target repository',
        '- The case transitions to done automatically after the merge is detected',
      ];
    case 'done':
      return ['- No further action needed. The case lifecycle is complete.'];
    case 'rejected':
      return ['- The case has been rejected. No further action is possible.'];
    default:
      return [];
  }
}

function getDoNotList(status: CaseStatus): string[] {
  switch (status) {
    case 'open':
      return [
        '- Do NOT skip setting risk_level and validation_track',
        '- Do NOT start building before exploration',
      ];
    case 'exploration':
      return [
        '- Do NOT start building — wait for exploration to complete',
        '- Do NOT modify case core fields during exploration',
      ];
    case 'ready_for_build':
      return [
        '- Do NOT merge any PR at this stage',
        '- Do NOT skip the /build command',
      ];
    case 'in_build':
      return [
        '- Do NOT merge the PR before reaching pending_merge status',
        '- Do NOT skip the build-complete confirmation with the user',
        '- Do NOT auto-approve or bypass validation',
        '- Do NOT consider your task complete after committing — you must also push, create PR, and call signal_build_complete',
      ];
    case 'in_validation':
      return [
        '- Do NOT push new commits while validation is running',
        '- Do NOT merge the PR',
      ];
    case 'in_review':
      return [
        '- Do NOT merge the PR — review must complete first',
        '- Do NOT attempt to override the review outcome',
      ];
    case 'needs_human_decision':
      return [
        '- Do NOT attempt to auto-approve — a human must decide',
        '- Do NOT self-approve (anti-gaming rule)',
      ];
    case 'verification_pending':
      return [
        '- Do NOT skip manual verification',
        '- Do NOT self-verify for high/critical risk (four-eyes principle)',
      ];
    case 'approved':
      return ['- Do NOT start new work on this case'];
    case 'pending_merge':
      return [
        '- Do NOT merge if CI checks are failing',
        '- Do NOT start new unrelated work in the same branch',
      ];
    case 'done':
    case 'rejected':
      return ['- Do NOT attempt to reopen or modify this case'];
    default:
      return [];
  }
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

    // Fetch project name
    let projectName: string | undefined;
    if (caseData.project_id) {
      try {
        const { collections } = await import('@arbitra/backend');
        const projDoc = await collections.projects().doc(caseData.project_id).get();
        if (projDoc.exists) {
          projectName = projDoc.data()!.name;
        }
      } catch {
        // Project lookup failed — continue without project name
      }
    }

    // Fetch evidence info
    const { EvidenceService, CompletenessEvaluator } = await import('@arbitra/backend');
    const evidenceService = new EvidenceService();
    const evidence = await evidenceService.getEvidenceForCase(params.caseId);
    const evaluator = new CompletenessEvaluator();
    const evalResult = await evaluator.evaluate(caseData, evidence);

    const instructions = generateInstructions(caseData, projectName, {
      required: evalResult.required,
      missing: evalResult.missing,
      satisfied: evalResult.satisfied,
    });

    return NextResponse.json({ instructions });
  } catch (error) {
    return handleError(error);
  }
}
