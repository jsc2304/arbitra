/**
 * @file tier-one-actions — option-grid tests for the primary 50/50 row.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TierOneActions,
  getTierOneOptions,
} from '../tier-one-actions';

function render(
  props: Partial<React.ComponentProps<typeof TierOneActions>> = {},
): string {
  return renderToStaticMarkup(
    <TierOneActions
      caseStatus="needs_human_decision"
      hasFinding={false}
      selectedType={null}
      approveBlockedByFindings={false}
      blockerCounts={{ high: 0, critical: 0, total: 0 }}
      onSelect={() => {}}
      {...props}
    />,
  );
}

describe('getTierOneOptions', () => {
  it('returns approve + request_changes for needs_human_decision case-level', () => {
    const opts = getTierOneOptions('needs_human_decision', false);
    expect(opts.map((o) => o.value)).toEqual(['approve', 'request_changes']);
    expect(opts[0]!.label).toBe('Approve');
    expect(opts[1]!.label).toBe('Request Changes');
  });

  it('relabels for finding-level: "Mark as resolved" + "Flag as blocking"', () => {
    const opts = getTierOneOptions('needs_human_decision', true);
    expect(opts[0]!.label).toBe('Mark as resolved');
    expect(opts[1]!.label).toBe('Flag as blocking');
  });

  it('returns the same 2 actions for verification_pending', () => {
    const opts = getTierOneOptions('verification_pending', false);
    expect(opts.map((o) => o.value)).toEqual(['approve', 'request_changes']);
  });
});

describe('<TierOneActions /> — approve-blocked rendering', () => {
  it('renders aria-disabled + "Cannot approve" tooltip when approve is blocked', () => {
    const html = render({
      approveBlockedByFindings: true,
      blockerCounts: { high: 1, critical: 1, total: 2 },
    });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Cannot approve:');
    expect(html).toContain('1 critical, 1 high');
    // Points at the in-panel blocking-findings list (waive moved there).
    expect(html).toContain('Fix or waive them in the blocking-findings list above.');
  });

  it('renders the disabled-reason chip when approve is blocked', () => {
    const html = render({
      approveBlockedByFindings: true,
      blockerCounts: { high: 1, critical: 0, total: 1 },
    });
    expect(html).toContain('Approve is disabled');
    expect(html).toContain('<strong>1</strong>');
    // Singular form for total === 1.
    expect(html).toContain('open blocking finding ');
    // Wording aligned with the in-panel blocking-findings list.
    expect(html).toContain('in the list above before approving');
  });

  it('does NOT render the chip when not blocked', () => {
    const html = render({ approveBlockedByFindings: false });
    expect(html).not.toContain('Approve is disabled');
    expect(html).not.toContain('aria-disabled="true"');
  });
});

describe('<TierOneActions /> — relabel logic via prop drive', () => {
  it('renders "Mark as resolved" + "Flag as blocking" labels when hasFinding is true', () => {
    const html = render({ hasFinding: true });
    expect(html).toContain('>Mark as resolved<');
    expect(html).toContain('>Flag as blocking<');
    expect(html).not.toContain('>Approve<');
    expect(html).not.toContain('>Request Changes<');
  });

  it('renders "Approve" + "Request Changes" labels when hasFinding is false', () => {
    const html = render({ hasFinding: false });
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Request Changes<');
  });
});

describe('<TierOneActions /> — corp-orange variant', () => {
  it('Approve uses bg-accent (corp-orange)', () => {
    const html = render();
    // Approve button is the first; we can't easily isolate it but we can
    // assert the bg-accent class appears in the markup.
    expect(html).toContain('bg-accent');
  });
});

describe('<TierOneActions /> — scope captions', () => {
  it('renders a scope caption beneath each case-level button', () => {
    const html = render();
    expect(html).toContain('data-testid="tier-one-approve-caption"');
    expect(html).toContain('Closes the case as approved');
    expect(html).toContain('data-testid="tier-one-request_changes-caption"');
    expect(html).toContain('Returns the case for rework');
  });
});
