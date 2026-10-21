import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Finding } from '@arbitra/shared';
import {
  buildDecisionProgressModel,
  DecisionProgress,
} from '../decision-progress';

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    finding_id: 'f-1',
    case_id: 'case-1',
    category: 'bug',
    severity: 'medium',
    confidence: 0.9,
    status: 'open',
    title: 'Finding',
    description: 'Description',
    origin_type: 'reviewer',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildDecisionProgressModel', () => {
  it('marks approval as blocked when high or critical findings are still unresolved', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'needs_human_decision',
      hasFinding: false,
      findings: [
        makeFinding({ finding_id: 'f-critical', severity: 'critical', status: 'open' }),
        makeFinding({ finding_id: 'f-high', severity: 'high', status: 'contested' }),
        makeFinding({ finding_id: 'f-medium', severity: 'medium', status: 'open' }),
      ],
    });

    expect(model.eyebrow).toBe('Step 1 of 3');
    expect(model.title).toBe('Clear blockers before approval');
    expect(model.summary).toContain('2 blocking findings');
    expect(model.summary).toContain('Low and medium findings do not block');
    expect(model.steps[0]?.state).toBe('blocked');
    expect(model.steps[1]?.state).toBe('pending');
  });

  it('shows the case decision as the next step once blockers are cleared', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'needs_human_decision',
      hasFinding: false,
      findings: [
        makeFinding({ finding_id: 'f-critical', severity: 'critical', status: 'waived' }),
        makeFinding({ finding_id: 'f-high', severity: 'high', status: 'resolved' }),
      ],
    });

    expect(model.eyebrow).toBe('Step 2 of 3');
    expect(model.title).toBe('Ready for case decision');
    expect(model.steps[0]?.state).toBe('complete');
    expect(model.steps[1]?.state).toBe('current');
  });

  it('warns when the current controls are finding-scoped', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'needs_human_decision',
      hasFinding: true,
      findings: [],
    });

    expect(model.selectedFindingNote).toContain('A finding is selected');
    expect(model.steps[1]?.description).toContain('Deselect the finding');
  });

  it('uses manual verification copy for verification_pending cases', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'verification_pending',
      hasFinding: false,
      findings: [],
    });

    expect(model.title).toBe('Manual verification decision needed');
    expect(model.summary).toContain('Approve confirms manual validation');
  });

  it('uses review-running copy for in_review cases', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'in_review',
      hasFinding: false,
      findings: [],
    });

    expect(model.eyebrow).toBe('Step 1 of 3');
    expect(model.title).toBe('Review running');
    expect(model.summary).toContain('Courtroom decisions unlock after review');
    expect(model.steps[0]?.state).toBe('complete');
    expect(model.steps[1]?.state).toBe('current');
    expect(model.steps[1]?.label).toBe('Review in progress');
    expect(model.steps[2]?.state).toBe('pending');
    // Should NOT borrow the "Ready for case decision" Step 2 of 3 copy.
    expect(model.title).not.toBe('Ready for case decision');
  });

  it('uses pending-merge copy when the case is awaiting merge', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'pending_merge',
      hasFinding: false,
      findings: [],
    });

    expect(model.eyebrow).toBe('Step 3 of 3');
    expect(model.title).toBe('Approved, waiting for merge');
  });

  it('uses approved copy for approved cases', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'approved',
      hasFinding: false,
      findings: [],
    });

    expect(model.eyebrow).toBe('Step 3 of 3');
    expect(model.title).toBe('Case approved');
  });

  it('uses validation-running copy for in_validation cases', () => {
    const model = buildDecisionProgressModel({
      caseStatus: 'in_validation',
      hasFinding: false,
      findings: [],
    });

    expect(model.eyebrow).toBe('Before courtroom');
    expect(model.title).toBe('Validation still running');
  });
});

describe('<DecisionProgress />', () => {
  it('renders the progress surface with step labels', () => {
    const html = renderToStaticMarkup(
      <DecisionProgress
        caseStatus="needs_human_decision"
        hasFinding={false}
        findings={[makeFinding({ severity: 'critical', status: 'open' })]}
      />,
    );

    expect(html).toContain('data-testid="decision-progress"');
    expect(html).toContain('Courtroom decision progress');
    expect(html).toContain('Clear blockers before approval');
    expect(html).toContain('Resolve or waive blockers');
  });

  it('exposes a progressbar role with aria-value attributes on the bar', () => {
    const html = renderToStaticMarkup(
      <DecisionProgress
        caseStatus="needs_human_decision"
        hasFinding={false}
        findings={[]}
      />,
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="58"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toMatch(/aria-label="[^"]*progress[^"]*"/i);
  });

  it('renders an explicit deselect action when a finding is selected', () => {
    const html = renderToStaticMarkup(
      <DecisionProgress
        caseStatus="needs_human_decision"
        hasFinding
        findings={[]}
        onClearFinding={() => {}}
      />,
    );

    expect(html).toContain('A finding is selected');
    expect(html).toContain('Deselect finding');
  });
});

/**
 * Pending-merge "request changes" escape hatch (issue #765). A review can
 * complete against a pre-rebase diff and land the approval before the
 * branch gains more commits — there was previously no courtroom
 * affordance to send such a case back for a fresh review, only the
 * backend transition (`request_changes` → `in_build`). Render-only per
 * the frontend-test constraint: these lock the affordance's visibility,
 * not the click (covered by `decision-cluster.test.tsx` /
 * `decision-executor.test.tsx`).
 */
describe('<DecisionProgress /> — pending_merge request-changes affordance', () => {
  it('renders the "Request changes" button on pending_merge when the callback is supplied', () => {
    const html = renderToStaticMarkup(
      <DecisionProgress
        caseStatus="pending_merge"
        hasFinding={false}
        findings={[]}
        onRequestPendingMergeChanges={() => {}}
      />,
    );

    expect(html).toContain('data-testid="pending-merge-request-changes"');
    expect(html).toContain('Request changes');
  });

  it('does NOT render the button on pending_merge when no callback is supplied', () => {
    const html = renderToStaticMarkup(
      <DecisionProgress caseStatus="pending_merge" hasFinding={false} findings={[]} />,
    );

    expect(html).not.toContain('data-testid="pending-merge-request-changes"');
  });

  it.each(['done', 'rejected', 'approved', 'in_review'] as const)(
    'does NOT render the button on %s even if the callback is supplied',
    (status) => {
      const html = renderToStaticMarkup(
        <DecisionProgress
          caseStatus={status}
          hasFinding={false}
          findings={[]}
          onRequestPendingMergeChanges={() => {}}
        />,
      );

      expect(html).not.toContain('data-testid="pending-merge-request-changes"');
    },
  );
});
