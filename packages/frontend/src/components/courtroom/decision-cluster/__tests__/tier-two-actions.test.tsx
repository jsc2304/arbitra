/**
 * @file tier-two-actions — secondary-grid tests.
 *
 * Only Reject is rendered at this tier (Waive
 * lives in the in-panel FindingWaiveList, Escalate hidden until backend semantics
 * defined). The destructive-confirm flow for
 * Reject lives in `RationaleForm` and is already covered by
 * `rationale-form.test.tsx`; here we just lock the option list and that
 * Reject is rendered + selectable.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TierTwoActions,
  getTierTwoOptions,
} from '../tier-two-actions';

function render(
  props: Partial<React.ComponentProps<typeof TierTwoActions>> = {},
): string {
  return renderToStaticMarkup(
    <TierTwoActions
      caseStatus="needs_human_decision"
      hasFinding={false}
      selectedType={null}
      onSelect={() => {}}
      {...props}
    />,
  );
}

describe('getTierTwoOptions', () => {
  it('case-level on needs_human_decision: returns reject only (waive lives in the FindingWaiveList, escalate hidden)', () => {
    const opts = getTierTwoOptions('needs_human_decision', false);
    expect(opts.map((o) => o.value)).toEqual(['reject']);
  });

  it('finding-level on needs_human_decision: still returns reject only (waive lives in the FindingWaiveList)', () => {
    const opts = getTierTwoOptions('needs_human_decision', true);
    expect(opts.map((o) => o.value)).toEqual(['reject']);
  });

  it('verification_pending: returns reject only', () => {
    const opts = getTierTwoOptions('verification_pending', false);
    expect(opts.map((o) => o.value)).toEqual(['reject']);
  });

  it('verification_pending stays reject-only even when a finding is selected', () => {
    const opts = getTierTwoOptions('verification_pending', true);
    expect(opts.map((o) => o.value)).toEqual(['reject']);
  });
});

describe('<TierTwoActions /> — Waive is no longer rendered here', () => {
  it('hides Waive at case-level', () => {
    const html = render({ hasFinding: false });
    expect(html).not.toContain('data-testid="tier-two-waive"');
  });

  it('hides Waive even when a finding is selected (it lives in the FindingWaiveList)', () => {
    const html = render({ hasFinding: true });
    expect(html).not.toContain('data-testid="tier-two-waive"');
  });
});

describe('<TierTwoActions /> — Escalate is hidden', () => {
  it('does not render an Escalate button at case-level', () => {
    const html = render();
    expect(html).not.toContain('data-testid="tier-two-escalate"');
    expect(html).not.toContain('>Escalate<');
  });

  it('does not render an Escalate button at finding-level', () => {
    const html = render({ hasFinding: true });
    expect(html).not.toContain('data-testid="tier-two-escalate"');
  });
});

describe('<TierTwoActions /> — Reject button renders', () => {
  it('renders Reject at case-level with the destructive (red) variant', () => {
    const html = render();
    expect(html).toContain('data-testid="tier-two-reject"');
    expect(html).toContain('>Reject<');
    expect(html).toContain('border-red-300');
  });

  it('renders the scope caption beneath the Reject button', () => {
    const html = render();
    expect(html).toContain('Closes the case as rejected');
  });
});
