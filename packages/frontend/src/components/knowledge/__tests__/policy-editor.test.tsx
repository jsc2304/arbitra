/**
 * @file policy-editor — `PolicyRuleCell` three-state rendering.
 *
 * Node-only per the frontend convention (renderToStaticMarkup). Renders the
 * cell in isolation (it returns a bare `<td>`, so it's wrapped in a
 * `<table>` shell) and asserts on the distinguishing badge text/class for
 * each of the three states a cell can be in.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvidencePolicyRule } from '@arbitra/shared';
import { PolicyRuleCell } from '../policy-editor';

function renderCell(rule: EvidencePolicyRule | undefined): string {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <tr>
          <PolicyRuleCell rule={rule} />
        </tr>
      </tbody>
    </table>,
  );
}

describe('<PolicyRuleCell /> — three-state rendering', () => {
  it('renders "Inherits defaults" for an absent cell', () => {
    const html = renderCell(undefined);
    expect(html).toContain('Inherits defaults');
    expect(html).not.toContain('Requires no evidence');
  });

  it('renders "Inherits defaults" for a legacy empty cell (no requires_no_evidence flag) — pins the LEGACY READ DECISION', () => {
    const html = renderCell({
      required_evidence_types: [],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: false,
    });
    expect(html).toContain('Inherits defaults');
    expect(html).not.toContain('Requires no evidence');
  });

  it('renders "Requires no evidence" for an explicit empty-with-flag cell, distinct from "Inherits defaults"', () => {
    const html = renderCell({
      required_evidence_types: [],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: false,
      requires_no_evidence: true,
    });
    expect(html).toContain('Requires no evidence');
    expect(html).not.toContain('Inherits defaults');
  });

  it('renders the actual required evidence types for a custom cell, with neither state badge', () => {
    const html = renderCell({
      required_evidence_types: ['ci_result'],
      optional_evidence_types: [],
      four_eyes_required: false,
      allow_self_approval: false,
    });
    expect(html).not.toContain('Inherits defaults');
    expect(html).not.toContain('Requires no evidence');
    expect(html).toContain('Required');
  });

  it('still surfaces four-eyes/self-approval flags on a "requires nothing" cell (independent of the required-evidence intent)', () => {
    const html = renderCell({
      required_evidence_types: [],
      optional_evidence_types: [],
      four_eyes_required: true,
      allow_self_approval: true,
      requires_no_evidence: true,
    });
    expect(html).toContain('Requires no evidence');
    expect(html).toContain('Four-eyes required');
    expect(html).toContain('Self-approval allowed');
  });
});
