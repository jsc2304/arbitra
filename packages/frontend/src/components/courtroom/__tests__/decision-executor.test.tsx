/**
 * @file decision-executor — orchestration tests for `createDecisionExecutor`.
 *
 * Covers the toast-copy branches (success, transition_error blocking-approve
 * from PR #475, transition_error generic, error path) and the
 * KnowledgeCapturePrompt fire (`onSuccess` callback).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createDecisionExecutor,
  type DecisionResponse,
} from '../decision-executor';

vi.mock('../../../lib/firebase-client', () => ({
  getIdToken: async () => 'test-token',
  getCurrentUser: () => null,
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    cases: {
      submitDecision: vi.fn(),
    },
  },
}));

interface ExecutorHarness {
  submitMock: ReturnType<typeof vi.fn>;
  toastMock: ReturnType<typeof vi.fn>;
  successMock: ReturnType<typeof vi.fn>;
}

function makeExecutor(
  overrides: {
    caseStatus?: Parameters<typeof createDecisionExecutor>[0]['caseStatus'];
    blockerCounts?: Parameters<typeof createDecisionExecutor>[0]['blockerCounts'];
    response?: DecisionResponse;
    rejectWith?: Error;
  } = {},
): {
  execute: ReturnType<typeof createDecisionExecutor>;
  harness: ExecutorHarness;
} {
  const submitMock = vi.fn();
  if (overrides.rejectWith) {
    submitMock.mockRejectedValue(overrides.rejectWith);
  } else {
    submitMock.mockResolvedValue(
      overrides.response ?? { decision_id: 'd-1' },
    );
  }
  const toastMock = vi.fn();
  const successMock = vi.fn();
  const execute = createDecisionExecutor({
    caseId: 'case-1',
    caseStatus: overrides.caseStatus,
    blockerCounts: overrides.blockerCounts ?? { high: 0, critical: 0, total: 0 },
    submitDecision: submitMock as unknown as Parameters<
      typeof createDecisionExecutor
    >[0]['submitDecision'],
    addToast: toastMock as unknown as Parameters<
      typeof createDecisionExecutor
    >[0]['addToast'],
    onSuccess: successMock,
  });
  return { execute, harness: { submitMock, toastMock, successMock } };
}

describe('createDecisionExecutor — happy path', () => {
  it('calls submitDecision with the right body, fires success toast with the option label, and triggers onSuccess (KnowledgeCapturePrompt)', async () => {
    const { execute, harness } = makeExecutor({
      caseStatus: 'needs_human_decision',
      response: { decision_id: 'dec-42' },
    });
    const result = await execute({
      type: 'approve',
      rationale: 'all good after review',
      finding_id: undefined,
    });
    expect(result).toEqual({ ok: true });
    expect(harness.submitMock).toHaveBeenCalledWith('case-1', {
      case_id: 'case-1',
      type: 'approve',
      rationale: 'all good after review',
      finding_id: undefined,
    });
    expect(harness.toastMock).toHaveBeenCalledWith(
      'success',
      'Decision "Approve" submitted successfully',
    );
    expect(harness.successMock).toHaveBeenCalledWith({
      decisionId: 'dec-42',
      decisionType: 'approve',
      rationale: 'all good after review',
    });
  });

  it('labels the pending_merge escape hatch (issue #765) "Request Changes" — same case-level label as in_review/needs_human_decision, since pending_merge falls through to the base case-level option list', async () => {
    const { execute, harness } = makeExecutor({
      caseStatus: 'pending_merge',
    });
    const result = await execute({
      type: 'request_changes',
      rationale: 'Diff moved since approval; branch gained more commits.',
      finding_id: undefined,
    });
    expect(result).toEqual({ ok: true });
    expect(harness.submitMock).toHaveBeenCalledWith('case-1', {
      case_id: 'case-1',
      type: 'request_changes',
      rationale: 'Diff moved since approval; branch gained more commits.',
      finding_id: undefined,
    });
    expect(harness.toastMock).toHaveBeenCalledWith(
      'success',
      'Decision "Request Changes" submitted successfully',
    );
  });

  it('uses the finding-level relabel ("Mark as resolved") when the submit carries a finding_id', async () => {
    const { execute, harness } = makeExecutor({
      caseStatus: 'needs_human_decision',
    });
    await execute({
      type: 'approve',
      rationale: 'finding fixed by author',
      finding_id: 'f-1',
    });
    expect(harness.toastMock).toHaveBeenCalledWith(
      'success',
      'Decision "Mark as resolved" submitted successfully',
    );
  });
});

describe('createDecisionExecutor — transition_error branch (PR #475 toast copy)', () => {
  it('emits info toast with the blocking-findings copy when approve fails on needs_human_decision with open blockers', async () => {
    const { execute, harness } = makeExecutor({
      caseStatus: 'needs_human_decision',
      blockerCounts: { high: 1, critical: 2, total: 3 },
      response: {
        decision_id: 'dec-1',
        transition_error: { message: 'OPEN_FINDINGS_BLOCK_DECISION' },
      },
    });
    await execute({
      type: 'approve',
      rationale: 'tried to approve',
      finding_id: undefined,
    });
    const [type, message, description] = harness.toastMock.mock.calls[0]!;
    expect(type).toBe('info');
    expect(message).toBe(
      'Decision "Approve" recorded but case status did not change',
    );
    expect(description).toBe(
      'Resolve or waive 3 blocking findings (2 critical, 1 high) before approving.',
    );
    const single = makeExecutor({
      caseStatus: 'needs_human_decision',
      blockerCounts: { high: 1, critical: 0, total: 1 },
      response: {
        decision_id: 'dec-1',
        transition_error: { message: 'x' },
      },
    });
    await single.execute({ type: 'approve', rationale: 'r', finding_id: undefined });
    expect(single.harness.toastMock.mock.calls[0]![2]).toBe(
      'Resolve or waive 1 blocking finding (0 critical, 1 high) before approving.',
    );
  });

  it('falls back to the generic transition_error description for non-blocking-approve variants', async () => {
    const { execute, harness } = makeExecutor({
      caseStatus: 'in_review',
      response: {
        decision_id: 'dec-1',
        transition_error: { message: 'No active review run' },
      },
    });
    await execute({
      type: 'request_changes',
      rationale: 'send back',
      finding_id: undefined,
    });
    const [, , description] = harness.toastMock.mock.calls[0]!;
    expect(description).toBe(
      'No active review run The decision is in the audit trail; the case stays in its current status until the precondition is met.',
    );
  });

  it('still fires onSuccess (KnowledgeCapturePrompt) when transition_error is present — the decision is persisted', async () => {
    const { execute, harness } = makeExecutor({
      caseStatus: 'in_review',
      response: {
        decision_id: 'dec-9',
        transition_error: { message: 'foo' },
      },
    });
    await execute({
      type: 'approve',
      rationale: 'rationale text',
      finding_id: undefined,
    });
    expect(harness.successMock).toHaveBeenCalledWith({
      decisionId: 'dec-9',
      decisionType: 'approve',
      rationale: 'rationale text',
    });
  });
});

describe('createDecisionExecutor — error path', () => {
  it('returns ok:false and emits an error toast with the thrown message', async () => {
    const { execute, harness } = makeExecutor({
      rejectWith: new Error('Network unreachable'),
    });
    const result = await execute({
      type: 'approve',
      rationale: 'rationale',
      finding_id: undefined,
    });
    expect(result).toEqual({ ok: false, message: 'Network unreachable' });
    expect(harness.toastMock).toHaveBeenCalledWith('error', 'Network unreachable');
    expect(harness.successMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the thrown value is not an Error', async () => {
    const { execute, harness } = makeExecutor({
      rejectWith: 'plain string' as unknown as Error,
    });
    const result = await execute({
      type: 'approve',
      rationale: 'rationale',
      finding_id: undefined,
    });
    expect(result).toEqual({ ok: false, message: 'Failed to submit decision' });
    expect(harness.toastMock).toHaveBeenCalledWith(
      'error',
      'Failed to submit decision',
    );
  });
});
