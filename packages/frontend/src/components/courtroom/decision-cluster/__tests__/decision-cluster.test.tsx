/**
 * @file decision-cluster — static-render tests for the tiered courtroom
 * layout. Covers the (caseStatus × findingId × findings) matrix to lock
 * the cluster path to the audit-critical behavior.
 *
 * Node-only per the frontend convention; `renderToStaticMarkup` returns
 * the initial-state DOM. Click-driven behavior (selectedType → rationale
 * sheet open) is covered indirectly: we assert the Tier-1/Tier-2 buttons
 * render correctly so a click wires through, and the rationale sheet's
 * inner gating is covered by `rationale-form.test.tsx`.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Finding } from '@arbitra/shared';
import { DecisionCluster } from '../decision-cluster';
import { ToastProvider } from '../../../../providers/toast-provider';

vi.mock('../../../../lib/firebase-client', () => ({
  getIdToken: async () => 'test-token',
  getCurrentUser: () => null,
}));

vi.mock('../../../../lib/api-client', () => ({
  api: {
    cases: {
      submitDecision: vi.fn(),
    },
  },
}));

function renderCluster(
  props: Partial<React.ComponentProps<typeof DecisionCluster>> = {},
): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <DecisionCluster
        caseId="case-1"
        caseTitle="Test case"
        projectId="proj-1"
        onSubmit={() => {}}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('<DecisionCluster /> — tier routing by status', () => {
  it('needs_human_decision (case-level): T1 = Approve + Request Changes; T2 = Reject only (Waive lives in the in-panel FindingWaiveList, Escalate hidden)', () => {
    const html = renderCluster({ caseStatus: 'needs_human_decision' });
    // Tier-1 buttons.
    expect(html).toContain('data-testid="tier-one-approve"');
    expect(html).toContain('data-testid="tier-one-request_changes"');
    // Tier-2 buttons — only Reject.
    expect(html).toContain('data-testid="tier-two-reject"');
    expect(html).not.toContain('data-testid="tier-two-escalate"');
    expect(html).not.toContain('data-testid="tier-two-waive"');
    // Labels match canonical option list.
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Request Changes<');
    // Scope captions surface beneath each case-level button.
    expect(html).toContain('Closes the case as approved');
    expect(html).toContain('Returns the case for rework');
    expect(html).toContain('Closes the case as rejected');
  });

  it('needs_human_decision (finding-level): relabels approve → "Mark as resolved", request_changes → "Flag as blocking"; Waive is per-finding (waive list), not in T2', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findingId: 'f-7',
      onClearFinding: () => {},
    });
    expect(html).toContain('>Mark as resolved<');
    expect(html).toContain('>Flag as blocking<');
    expect(html).toContain('Deselect finding');
    expect(html).not.toContain('data-testid="tier-two-waive"');
    expect(html).toContain('data-testid="tier-two-reject"');
    expect(html).not.toContain('data-testid="tier-two-escalate"');
  });

  it('in_review: same shape as needs_human_decision case-level (T1 = Approve + Request Changes, T2 = Reject only)', () => {
    const html = renderCluster({ caseStatus: 'in_review' });
    expect(html).toContain('data-testid="tier-one-approve"');
    expect(html).toContain('data-testid="tier-one-request_changes"');
    expect(html).toContain('data-testid="tier-two-reject"');
    expect(html).not.toContain('data-testid="tier-two-escalate"');
  });

  it('verification_pending: T1 = Approve + Request Changes; T2 = Reject only (no Waive, no Escalate)', () => {
    const html = renderCluster({ caseStatus: 'verification_pending' });
    expect(html).toContain('data-testid="tier-one-approve"');
    expect(html).toContain('data-testid="tier-one-request_changes"');
    expect(html).toContain('data-testid="tier-two-reject"');
    expect(html).not.toContain('data-testid="tier-two-waive"');
    expect(html).not.toContain('data-testid="tier-two-escalate"');
  });

  it('pending_merge: no Tier-1, fallback "Awaiting merge" card rendered, but a case-level Request Changes affordance is available (issue #765)', () => {
    const html = renderCluster({ caseStatus: 'pending_merge' });
    expect(html).toContain('data-testid="decision-cluster-fallback"');
    expect(html).toContain('Awaiting merge');
    // No Approve — the case is already approved; blanket-adding pending_merge
    // to the Tier-1 statuses would wrongly resurface it.
    expect(html).not.toContain('data-testid="tier-one-approve"');
    expect(html).not.toContain('data-testid="tier-two-reject"');
    // The escape hatch: a secondary action on the DecisionProgress card,
    // not a Tier-1/Tier-2 button.
    expect(html).toContain('data-testid="pending-merge-request-changes"');
    // Not yet selected, so the rationale sheet hasn't opened.
    expect(html).not.toContain('data-testid="rationale-sheet"');
  });

  it('pending_merge: opens the same RationaleSheet used by Tier-1/Tier-2 when the pending-merge request-changes trigger has already been selected (via pendingDecisionType)', () => {
    // The cluster's own click handler can't be exercised under
    // renderToStaticMarkup (no DOM events); `pendingDecisionType` mirrors
    // the same `setSelectedType('request_changes')` call the pending-merge
    // button makes, letting us assert the sheet opens through the
    // identical code path Tier-1/Tier-2 use.
    const html = renderCluster({
      caseStatus: 'pending_merge',
      pendingDecisionType: { type: 'request_changes', nonce: 1 },
    });
    expect(html).toContain('data-testid="rationale-sheet"');
    expect(html).toContain('id="rationale"');
    // Still no Approve/Reject Tier-1/Tier-2 buttons alongside it.
    expect(html).not.toContain('data-testid="tier-one-approve"');
    expect(html).not.toContain('data-testid="tier-two-reject"');
  });

  it.each(['done', 'rejected'] as const)(
    '%s: no pending-merge request-changes affordance (case is terminal)',
    (status) => {
      const html = renderCluster({ caseStatus: status });
      expect(html).not.toContain('data-testid="pending-merge-request-changes"');
    },
  );

  it('in_validation: no Tier-1, fallback "Awaiting validation" card rendered', () => {
    const html = renderCluster({ caseStatus: 'in_validation' });
    expect(html).toContain('Awaiting validation');
    expect(html).toContain('data-testid="decision-cluster-fallback"');
  });
});

describe('<DecisionCluster /> — initial render shape', () => {
  it('renders the header', () => {
    const html = renderCluster({ caseStatus: 'needs_human_decision' });
    expect(html).toContain('>Decision<');
  });

  it('does NOT render the rationale sheet on initial render (no selectedType)', () => {
    const html = renderCluster({ caseStatus: 'needs_human_decision' });
    expect(html).not.toContain('data-testid="rationale-sheet"');
    // Textarea lives only inside the sheet.
    expect(html).not.toContain('id="rationale"');
  });
});

/**
 * In-panel per-finding waive list (moved here from the FindingCard —
 * user feedback: all decision affordances belong in the Decision panel).
 * Detailed grouping/affordance behavior is covered in
 * `finding-waive-list.test.tsx`; these tests lock the cluster wiring.
 */
describe('<DecisionCluster /> — FindingWaiveList wiring', () => {
  const blockingFinding = {
    finding_id: 'f-blk',
    case_id: 'case-1',
    title: 'Blocking finding',
    severity: 'critical',
    status: 'open',
    created_at: new Date().toISOString(),
  } as unknown as Finding;

  it('renders the waive list between the progress stepper and Tier-1 when onWaiveFinding is provided', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findings: [blockingFinding],
      onWaiveFinding: () => {},
      onSelectFinding: () => {},
    });
    expect(html).toContain('data-testid="finding-waive-list"');
    expect(html).toContain('data-testid="waive-action-f-blk"');
    expect(html).toContain('Blocking findings');
    // Waive-vs-approve explainer copy.
    expect(html).toContain('Waive accepts the risk of a single finding');
    // The list renders before the Tier-1 grid in DOM order.
    expect(html.indexOf('data-testid="finding-waive-list"')).toBeLessThan(
      html.indexOf('data-testid="tier-one-approve"'),
    );
  });

  it('does NOT render the waive list when onWaiveFinding is omitted', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findings: [blockingFinding],
    });
    expect(html).not.toContain('data-testid="finding-waive-list"');
  });

  it('does NOT render the waive list in fallback statuses (no rationale sheet to route into)', () => {
    const html = renderCluster({
      caseStatus: 'pending_merge',
      findings: [blockingFinding],
      onWaiveFinding: () => {},
      onSelectFinding: () => {},
    });
    expect(html).not.toContain('data-testid="finding-waive-list"');
  });
});

/**
 * Mirror-effect coverage for the parent-driven `pendingDecisionType`
 * trigger. The cluster's mirror is a useEffect, but we also seed
 * `selectedType` from the prop in the lazy useState initializer so a
 * non-null pending value opens the sheet on the very first render. That
 * lets us verify the wire-up via static markup (the frontend tests are
 * deliberately node-only — no jsdom/effects).
 *
 * The accompanying regression — clicking the same decision type twice in
 * a row — is locked in by the `nonce` field on the prop shape: the
 * parent must mint a new object identity per click, so the useEffect
 * dep array re-fires even when `type` is unchanged. That parent-side
 * contract is asserted in the page-level test below; the cluster only
 * has to mirror identity changes, which is the default useEffect
 * semantics. The regression test for that is in
 * `pending-decision-trigger.test.ts` next to this file.
 */
describe('<DecisionCluster /> — pendingDecisionType mirror', () => {
  it('renders the rationale sheet on initial render when pendingDecisionType is supplied (Waive from the waive list)', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findingId: 'f-1',
      pendingDecisionType: { type: 'waive', nonce: 1 },
    });
    expect(html).toContain('data-testid="rationale-sheet"');
    // Rationale textarea only renders inside the sheet.
    expect(html).toContain('id="rationale"');
  });

  it('does NOT open the sheet when pendingDecisionType is null', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findingId: 'f-1',
      pendingDecisionType: null,
    });
    expect(html).not.toContain('data-testid="rationale-sheet"');
  });
});

describe('<DecisionCluster /> — approve-blocked-by-findings gate', () => {
  const blockingFindings: Finding[] = [
    {
      finding_id: 'f-1',
      case_id: 'case-1',
      run_id: 'r-1',
      reviewer_id: 'rv-1',
      title: 'Blocker',
      severity: 'critical',
      status: 'open',
      created_at: new Date().toISOString(),
    } as unknown as Finding,
    {
      finding_id: 'f-2',
      case_id: 'case-1',
      run_id: 'r-1',
      reviewer_id: 'rv-1',
      title: 'High',
      severity: 'high',
      status: 'open',
      created_at: new Date().toISOString(),
    } as unknown as Finding,
  ];

  it('renders the approve-disabled banner with the right counts when on needs_human_decision case-level', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findings: blockingFindings,
    });
    expect(html).toContain('Approve is disabled');
    expect(html).toContain('<strong>2</strong>');
    expect(html).toContain('1 critical, 1 high');
  });

  it('marks the Tier-1 approve button aria-disabled when blocked', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findings: blockingFindings,
    });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Cannot approve:');
  });

  it('does NOT render the gate banner when a finding is selected (finding-level approve stays enabled)', () => {
    const html = renderCluster({
      caseStatus: 'needs_human_decision',
      findingId: 'f-1',
      findings: blockingFindings,
    });
    expect(html).not.toContain('Approve is disabled');
  });

  it('does NOT render the gate banner outside needs_human_decision', () => {
    const html = renderCluster({
      caseStatus: 'in_review',
      findings: blockingFindings,
    });
    expect(html).not.toContain('Approve is disabled');
  });
});
