/**
 * @file finding-waive-list — grouping + row-affordance tests for the
 * in-panel per-finding waive list.
 *
 * Node-only per the frontend convention (`renderToStaticMarkup`, no jsdom /
 * fireEvent): markup assertions cover the initial-state DOM (testids,
 * action labels, disclosure collapsed), and the pure helpers
 * (`partitionWaiveRows`, `waiveActionLabel`) cover the grouping / action
 * contracts directly. Click behavior is wired via plain `onClick` props
 * whose presence is asserted through the rendered roles/testids; the
 * page-level waive flow itself is covered by the DecisionCluster
 * `pendingDecisionType` tests.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Finding, FindingSeverity, FindingStatus } from '@arbitra/shared';
import {
  FindingWaiveList,
  partitionWaiveRows,
  waiveActionLabel,
} from '../finding-waive-list';

let seq = 0;
function makeFinding(
  overrides: Partial<Finding> & { severity: FindingSeverity; status: FindingStatus },
): Finding {
  seq += 1;
  return {
    finding_id: `f-${seq}`,
    case_id: 'case-1',
    title: `Finding ${seq}`,
    description: 'desc',
    category: 'bug',
    confidence: 0.9,
    origin_type: 'reviewer',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as Finding;
}

const noop = () => {};

function render(findings: readonly Finding[]): string {
  return renderToStaticMarkup(
    <FindingWaiveList findings={findings} onWaive={noop} onSelectFinding={noop} />,
  );
}

describe('waiveActionLabel', () => {
  it('offers "Waive…" for open findings', () => {
    expect(waiveActionLabel('open')).toBe('Waive…');
  });

  it('offers "Confirm waiver…" for agent-proposed waivers (waiver_proposed)', () => {
    expect(waiveActionLabel('waiver_proposed')).toBe('Confirm waiver…');
  });

  it('offers no action for accepted / contested / resolved statuses', () => {
    for (const status of ['accepted', 'contested', 'fixed', 'waived', 'resolved'] as const) {
      expect(waiveActionLabel(status)).toBeNull();
    }
  });

  it('offers no action for waived_on_completion (case is already done)', () => {
    // The proposal was closed administratively at completion (#751) — there is
    // nothing left for a human to confirm.
    expect(waiveActionLabel('waived_on_completion')).toBeNull();
  });
});

describe('partitionWaiveRows', () => {
  it('groups blocking (high/critical, non-resolved) findings into `blocking`', () => {
    const critical = makeFinding({ severity: 'critical', status: 'open' });
    const highProposed = makeFinding({ severity: 'high', status: 'waiver_proposed' });
    const highAccepted = makeFinding({ severity: 'high', status: 'accepted' });
    const { blocking, nonBlocking } = partitionWaiveRows([
      critical,
      highProposed,
      highAccepted,
    ]);
    expect(blocking.map((f) => f.finding_id)).toEqual([
      critical.finding_id,
      highProposed.finding_id,
      highAccepted.finding_id,
    ]);
    expect(nonBlocking).toEqual([]);
  });

  it('groups waivable non-blocking findings (open / waiver_proposed low+medium) into `nonBlocking`', () => {
    const lowOpen = makeFinding({ severity: 'low', status: 'open' });
    const mediumProposed = makeFinding({ severity: 'medium', status: 'waiver_proposed' });
    const { blocking, nonBlocking } = partitionWaiveRows([lowOpen, mediumProposed]);
    expect(blocking).toEqual([]);
    expect(nonBlocking.map((f) => f.finding_id)).toEqual([
      lowOpen.finding_id,
      mediumProposed.finding_id,
    ]);
  });

  it('omits resolved findings and actionless non-blocking statuses entirely', () => {
    const waived = makeFinding({ severity: 'critical', status: 'waived' });
    const fixed = makeFinding({ severity: 'high', status: 'fixed' });
    const lowAccepted = makeFinding({ severity: 'low', status: 'accepted' });
    const { blocking, nonBlocking } = partitionWaiveRows([waived, fixed, lowAccepted]);
    expect(blocking).toEqual([]);
    expect(nonBlocking).toEqual([]);
  });

  it('does not treat submodule-origin high findings as blocking (matches isBlocking)', () => {
    const submoduleHigh = makeFinding({
      severity: 'high',
      status: 'open',
      origin: 'submodule',
    } as Partial<Finding> & { severity: FindingSeverity; status: FindingStatus });
    const { blocking, nonBlocking } = partitionWaiveRows([submoduleHigh]);
    expect(blocking).toEqual([]);
    expect(nonBlocking.map((f) => f.finding_id)).toEqual([submoduleHigh.finding_id]);
  });
});

describe('<FindingWaiveList /> — blocking group', () => {
  it('renders header, waive-vs-approve explainer, and a row per blocking finding', () => {
    const open = makeFinding({ severity: 'critical', status: 'open' });
    const html = render([open]);
    expect(html).toContain('data-testid="finding-waive-list"');
    expect(html).toContain('Blocking findings');
    expect(html).toContain('Waive accepts the risk of a single finding');
    expect(html).toContain('Approve is the case-level decision');
    expect(html).toContain(`data-testid="waive-row-${open.finding_id}"`);
  });

  it('open blocking finding gets a "Waive…" action button', () => {
    const open = makeFinding({ severity: 'high', status: 'open' });
    const html = render([open]);
    expect(html).toContain(`data-testid="waive-action-${open.finding_id}"`);
    expect(html).toContain('Waive…');
  });

  it('waiver_proposed blocking finding gets "Confirm waiver…" and a status badge', () => {
    const proposed = makeFinding({ severity: 'critical', status: 'waiver_proposed' });
    const html = render([proposed]);
    expect(html).toContain(`data-testid="waive-action-${proposed.finding_id}"`);
    expect(html).toContain('Confirm waiver…');
    expect(html).toContain('Waiver proposed');
  });

  it('accepted / contested blocking findings render as rows WITHOUT an action button', () => {
    const accepted = makeFinding({ severity: 'high', status: 'accepted' });
    const contested = makeFinding({ severity: 'critical', status: 'contested' });
    const html = render([accepted, contested]);
    expect(html).toContain(`data-testid="waive-row-${accepted.finding_id}"`);
    expect(html).toContain(`data-testid="waive-row-${contested.finding_id}"`);
    expect(html).not.toContain(`data-testid="waive-action-${accepted.finding_id}"`);
    expect(html).not.toContain(`data-testid="waive-action-${contested.finding_id}"`);
    // Status badges explain why there is no action.
    expect(html).toContain('Accepted');
    expect(html).toContain('Contested');
  });

  it('rows are click/keyboard targets (role=button) for selecting the finding', () => {
    const open = makeFinding({ severity: 'high', status: 'open' });
    const html = render([open]);
    // The row div carries role="button" + tabindex for the select-on-click
    // affordance; the inner waive button stops propagation.
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });
});

describe('<FindingWaiveList /> — non-blocking disclosure', () => {
  it('collapses non-blocking open findings behind a disclosure with a count', () => {
    const blocking = makeFinding({ severity: 'critical', status: 'open' });
    const low = makeFinding({ severity: 'low', status: 'open' });
    const medium = makeFinding({ severity: 'medium', status: 'open' });
    const html = render([blocking, low, medium]);
    expect(html).toContain('data-testid="finding-waive-list-disclosure"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('2 open findings that don’t block approval');
    // Collapsed by default — non-blocking rows are not in the initial DOM.
    expect(html).not.toContain(`data-testid="waive-row-${low.finding_id}"`);
    expect(html).not.toContain(`data-testid="waive-row-${medium.finding_id}"`);
  });

  it('uses singular copy for exactly one non-blocking finding', () => {
    const low = makeFinding({ severity: 'low', status: 'open' });
    const html = render([low]);
    expect(html).toContain('1 open finding that doesn’t block approval');
  });

  it('renders the disclosure without the blocking header when only non-blocking findings remain', () => {
    const low = makeFinding({ severity: 'low', status: 'open' });
    const html = render([low]);
    expect(html).toContain('data-testid="finding-waive-list"');
    expect(html).toContain('data-testid="finding-waive-list-disclosure"');
    expect(html).not.toContain('Blocking findings');
  });
});

describe('<FindingWaiveList /> — empty render', () => {
  it('renders nothing when no waivable or blocking findings exist', () => {
    expect(render([])).toBe('');
    const resolvedOnly = [
      makeFinding({ severity: 'critical', status: 'waived' }),
      makeFinding({ severity: 'high', status: 'fixed' }),
      makeFinding({ severity: 'low', status: 'resolved' }),
    ];
    expect(render(resolvedOnly)).toBe('');
  });
});
