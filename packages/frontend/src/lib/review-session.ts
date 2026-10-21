import type { Case, UserRole } from '@arbitra/shared';
import {
  getTriageViewPredicate,
  type TriageView,
} from './triage-views';

export interface ReviewSessionContext {
  userId: string;
  roles: readonly UserRole[];
  findingCounts?: Record<string, number>;
  skippedCaseIds?: ReadonlySet<string>;
}

export interface ReviewSessionGuidance {
  reason: string;
  nextStep: string;
  localAgentHint: string;
}

const TERMINAL_STATUSES = new Set<Case['status']>(['done', 'rejected']);

function updatedAtMs(case_: Case): number {
  const parsed = Date.parse(case_.updated_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function priorityRank(case_: Case, findingCount: number): number {
  if (case_.pending_gate) return 0;
  if (case_.status === 'needs_human_decision') return 1;
  if (case_.status === 'verification_pending') return 2;
  return findingCount > 0 ? 3 : 4;
}

export function buildReviewSessionQueue(
  cases: readonly Case[],
  view: TriageView,
  context: ReviewSessionContext,
): Case[] {
  const skipped = context.skippedCaseIds ?? new Set<string>();
  const predicate = getTriageViewPredicate(view, {
    userId: context.userId,
    roles: context.roles,
    findingCounts: context.findingCounts,
  });

  return cases
    .filter((case_) => !TERMINAL_STATUSES.has(case_.status))
    .filter((case_) => !skipped.has(case_.case_id))
    .filter(predicate)
    .sort((a, b) => {
      const aFindings = context.findingCounts?.[a.case_id] ?? 0;
      const bFindings = context.findingCounts?.[b.case_id] ?? 0;
      const priorityDelta = priorityRank(a, aFindings) - priorityRank(b, bFindings);
      if (priorityDelta !== 0) return priorityDelta;
      const findingDelta = bFindings - aFindings;
      if (findingDelta !== 0) return findingDelta;
      return updatedAtMs(b) - updatedAtMs(a);
    });
}

export function getReviewSessionGuidance(
  case_: Case,
  view: TriageView,
  context: ReviewSessionContext,
): ReviewSessionGuidance {
  const findingCount = context.findingCounts?.[case_.case_id] ?? 0;
  const assignedToMe = case_.assigned_reviewer_id === context.userId;
  const ownedByMe = case_.owner_user_id === context.userId;

  if (case_.pending_gate && !ownedByMe) {
    return {
      reason: `This case is paused at a lifecycle gate before it can move to ${case_.pending_gate.target_status.replace(/_/g, ' ')}.`,
      nextStep: 'Confirm the gate if the prior phase looks complete, or open the case to inspect the evidence and timeline first.',
      localAgentHint: 'Your local agent can collect missing context, register evidence, or explain what changed on the branch before you confirm the gate.',
    };
  }

  if (case_.status === 'verification_pending') {
    return {
      reason: 'This case needs manual verification before Arbitra can treat the work as validated.',
      nextStep: 'Open the Courtroom to confirm manual verification, request changes, or reject the case with rationale.',
      localAgentHint: 'Your local agent can run the app, execute checks, attach screenshots/logs, and register manual verification evidence from your machine.',
    };
  }

  if (case_.status === 'needs_human_decision') {
    return {
      reason: findingCount > 0
        ? `This case is ready for human decision, but ${findingCount} finding${findingCount === 1 ? '' : 's'} still need review.`
        : 'This case has reached the human decision step and is waiting for reviewer judgment.',
      nextStep: findingCount > 0
        ? 'Review blockers first, then waive, resolve, request changes, or approve once the case is unblocked.'
        : 'Open the Courtroom and submit the appropriate decision with a clear rationale.',
      localAgentHint: 'Your local agent can inspect the diff, verify whether findings are real, fix issues locally, and report build/test evidence back to Arbitra.',
    };
  }

  if (findingCount > 0) {
    return {
      reason: `This case appears in ${view.replace(/-/g, ' ')} because it has ${findingCount} open finding${findingCount === 1 ? '' : 's'}.`,
      nextStep: 'Open the case or Courtroom, inspect the findings, and decide whether the work needs changes or a finding can be waived.',
      localAgentHint: 'Your local agent is usually the right place to investigate code-level findings, make fixes, run tests, and register evidence.',
    };
  }

  if (assignedToMe) {
    return {
      reason: 'This case is assigned to you, so Arbitra is treating it as part of your review queue.',
      nextStep: 'Check the lifecycle state and either continue review in the Courtroom or open the full case for context.',
      localAgentHint: 'Your local agent can answer codebase-specific questions and gather local evidence while the web UI records decisions and audit trail.',
    };
  }

  if (ownedByMe) {
    return {
      reason: 'You own this case and it is still active, so this session keeps it visible while other actors or automation work on it.',
      nextStep: 'Use the full case view to see what Arbitra is waiting for, or ask your local agent to continue implementation/evidence work.',
      localAgentHint: 'Your local agent can progress build work, add comments, register evidence, and call Arbitra MCP tools without leaving your editor.',
    };
  }

  return {
    reason: `This case matches the ${view.replace(/-/g, ' ')} triage view.`,
    nextStep: 'Open the case to inspect its current state, or move to the next item if it is not yours to handle.',
    localAgentHint: 'When the next action requires local code, tests, files, or screenshots, delegate that part to your IDE agent and let Arbitra track the outcome.',
  };
}
