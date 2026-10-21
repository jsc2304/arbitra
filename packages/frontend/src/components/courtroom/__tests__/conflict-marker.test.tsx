/**
 * @file conflict-marker — unit tests for the "Confirm Override" wiring.
 *
 * Node-only per the frontend convention (see rationale-form.test.tsx).
 * `renderToStaticMarkup` only renders the initial state, so this exercises
 * the render-time branches (category guard, open vs. resolved copy, button
 * visibility) rather than the click → dialog → submit interaction, which
 * has no jsdom harness in this repo to drive.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Finding } from '@arbitra/shared';
import { ConflictMarker } from '../conflict-marker';

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: () => {} }),
}));

vi.mock('../../../lib/api-client', () => ({
  api: { rules: { overrides: { create: async () => ({}) } } },
}));

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'fnd_1',
    case_id: 'case_1',
    category: 'rule_override_conflict',
    severity: 'low',
    confidence: 1,
    status: 'open',
    title: 'Rule override conflict: no-console-log',
    description: 'desc',
    origin_type: 'rule_engine',
    source_refs: [],
    evidence_refs: [],
    rule_refs: ['rule_global_1', 'rule_project_1'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function render(finding: Finding): string {
  return renderToStaticMarkup(
    <ConflictMarker finding={finding} projectId="proj_1" />,
  );
}

describe('<ConflictMarker /> — category guard', () => {
  it('renders nothing for a non-conflict finding', () => {
    const html = render(makeFinding({ category: 'bug' }));
    expect(html).toBe('');
  });
});

describe('<ConflictMarker /> — open conflict', () => {
  it('renders both rule refs and an enabled "Confirm Override" button', () => {
    const html = render(makeFinding());
    expect(html).toContain('Rule Override Conflict');
    expect(html).toContain('rule_global_1');
    expect(html).toContain('rule_project_1');
    expect(html).toContain('Confirm Override');
    expect(html).toContain('A human decision is required');
  });

  it('omits the button when rule_refs does not have exactly a pair (defensive)', () => {
    const html = render(makeFinding({ rule_refs: ['rule_global_1'] }));
    expect(html).not.toContain('Confirm Override');
  });
});

describe('<ConflictMarker /> — resolved conflict', () => {
  it('does not render the "Confirm Override" button once resolved', () => {
    const html = render(makeFinding({ status: 'resolved' }));
    expect(html).not.toContain('Confirm Override');
    expect(html).toContain('has been resolved');
  });
});
