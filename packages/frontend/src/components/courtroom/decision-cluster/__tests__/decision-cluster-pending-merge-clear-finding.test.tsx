/**
 * @file decision-cluster — the pending_merge "Request changes" escape
 * hatch (issue #765) must always submit a case-level decision, never a
 * finding-level one (review finding on PR #919).
 *
 * Repro: a finding is selected (persisted panel selection, or a
 * `?finding=<id>` URL param) when the reviewer clicks the pending_merge
 * "Request changes" button. If the click handler doesn't clear it before
 * opening the rationale sheet, the sheet stays linked to that finding;
 * `RationaleForm.execute()` composes `finding_id: linkedFindingId ||
 * undefined`, decision-service treats the submission as finding-level
 * (`isCaseLevelDecision=false`), and the case silently never leaves
 * `pending_merge` — the escape hatch no-ops with no visible error.
 *
 * Node-only per the frontend convention (no jsdom — see
 * decision-cluster.test.tsx). `renderToStaticMarkup` has no commit phase,
 * so the click can't be simulated through the DOM. Instead this test
 * captures the exact `onRequestPendingMergeChanges` closure DecisionCluster
 * builds (via a proxy standing in for the real `DecisionProgress`) and
 * calls that real production closure directly — not a simulated DOM event,
 * a direct call of the function reference the component actually wired up.
 *
 * That closure also calls the `setLinkedFindingId` / `setSelectedType`
 * hook setters. Calling a `useState` setter after `renderToStaticMarkup`
 * has already returned is a documented no-op in React's SSR hooks
 * dispatcher (the update is attributed to "a component that has already
 * returned" and discarded) — verified empirically against this repo's
 * React 18.3.1 before relying on it here. So the one part of the fix this
 * test can observe directly is the `onClearFinding` call-through. In the
 * real browser all three calls land in the same synchronous event handler
 * and the same React commit (rationale-sheet.tsx / rationale-form.tsx),
 * so `onClearFinding` firing is equivalent evidence that the finding is
 * cleared before the payload is composed.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
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

// Proxy standing in for the real DecisionProgress: captures whatever
// `onRequestPendingMergeChanges` DecisionCluster wires up so the test can
// invoke the exact production closure directly.
let capturedHandler: (() => void) | undefined;
vi.mock('../../decision-progress', () => ({
  DecisionProgress: (props: { onRequestPendingMergeChanges?: () => void }) => {
    capturedHandler = props.onRequestPendingMergeChanges;
    return null;
  },
}));

function renderCluster(
  props: Partial<ComponentProps<typeof DecisionCluster>> = {},
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

describe('<DecisionCluster /> — pending_merge request-changes always clears the linked finding', () => {
  it('clears the linked finding via onClearFinding when a finding is selected at click time', () => {
    capturedHandler = undefined;
    const onClearFinding = vi.fn();
    renderCluster({
      caseStatus: 'pending_merge',
      findingId: 'f-stale',
      onClearFinding,
    });

    expect(capturedHandler).toBeTypeOf('function');
    // Direct call of the real click handler DecisionCluster built for
    // this render — not a simulated DOM event.
    expect(() => capturedHandler?.()).not.toThrow();
    expect(onClearFinding).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no finding is selected (onClearFinding omitted)', () => {
    capturedHandler = undefined;
    renderCluster({ caseStatus: 'pending_merge' });

    expect(capturedHandler).toBeTypeOf('function');
    expect(() => capturedHandler?.()).not.toThrow();
  });

  it('is not wired at all outside pending_merge (no escape hatch to clear anything for)', () => {
    capturedHandler = undefined;
    renderCluster({
      caseStatus: 'needs_human_decision',
      findingId: 'f-stale',
      onClearFinding: vi.fn(),
    });
    expect(capturedHandler).toBeUndefined();
  });
});
