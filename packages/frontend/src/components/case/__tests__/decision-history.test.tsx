/**
 * @file decision-history — actor_metadata client-name rendering.
 *
 * Node-only (renderToStaticMarkup). SWR + useUserMap are mocked so each test
 * controls the decision payload and the resolved-name fallback. We assert
 * that the canonical client label ("Cursor", "Claude Code", ...) wins when
 * `actor_metadata.client_name` is present, and the human-name fallback wins
 * otherwise (back-compat for old decisions without the field).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Decision } from '@arbitra/shared';

type SWRState = {
  data?: { decisions: Decision[] };
  error?: unknown;
  isLoading: boolean;
};

const swrState: SWRState = { isLoading: false };

vi.mock('swr', () => ({
  default: () => swrState,
}));

vi.mock('../../../hooks/use-users', () => ({
  useUserMap: (ids: string[]) => {
    const map: Record<string, { user_id: string; display_name: string; email: string }> = {};
    for (const id of ids) {
      map[id] = { user_id: id, display_name: `Real Human ${id}`, email: `${id}@x` };
    }
    return map;
  },
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    cases: {
      decisions: vi.fn(),
    },
  },
}));

import { DecisionHistory } from '../decision-history';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decision_id: 'dec_1',
    case_id: 'case_1',
    type: 'approve',
    actor_id: 'usr_reviewer',
    rationale: 'Looks good',
    snapshot: {
      active_rule_set_versions: {},
      evidence_policy_version: 1,
      knowledge_asset_refs: [],
    },
    created_at: '2026-04-30T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  swrState.data = undefined;
  swrState.error = undefined;
  swrState.isLoading = false;
});

describe('DecisionHistory — actor_metadata rendering', () => {
  it('renders the canonical client label when actor_metadata.client_name is set', () => {
    swrState.data = {
      decisions: [
        makeDecision({
          actor_metadata: { client_name: 'cursor', client_version: '0.42.1' },
        }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).toContain('Cursor');
    // Human-name fallback must NOT win when the agent signature is present.
    expect(html).not.toContain('Real Human usr_reviewer');
  });

  it('renders Claude Code for client_name=claude-code', () => {
    swrState.data = {
      decisions: [
        makeDecision({ actor_metadata: { client_name: 'claude-code' } }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).toContain('Claude Code');
  });

  it('falls back to the resolved human name when actor_metadata is absent (back-compat)', () => {
    swrState.data = { decisions: [makeDecision()] };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).toContain('Real Human usr_reviewer');
  });
});

describe('DecisionHistory — snapshot fidelity', () => {
  it('labels a row without snapshot_fidelity as legacy instead of rendering fake versions', () => {
    swrState.data = { decisions: [makeDecision()] };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).toContain('Snapshot: snapshot unavailable (legacy)');
    expect(html).not.toContain('evidence policy v1');
  });

  it('renders governance versions for an exact snapshot', () => {
    swrState.data = {
      decisions: [
        makeDecision({
          snapshot: {
            active_rule_set_versions: { ruleset_a: 2, ruleset_b: 5 },
            evidence_policy_version: 8,
            knowledge_asset_refs: ['knowledge_1'],
            snapshot_fidelity: 'exact',
          },
        }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).toContain('Snapshot: 2 rule set(s), evidence policy v8, 1 knowledge ref(s)');
    expect(html).not.toContain('snapshot unavailable (legacy)');
  });
});

describe('DecisionHistory — manual-track approve pair grouping', () => {
  it('collapses adjacent approve + manual_validation_confirmed into one merged row with a disclosure, while keeping both underlying decisions in the data', () => {
    // Newest-first ordering: the user-driven approve has the later timestamp,
    // the auto-attached manual_validation_confirmed has the earlier timestamp,
    // and they appear adjacent in that order.
    swrState.data = {
      decisions: [
        makeDecision({
          decision_id: 'dec_approve',
          type: 'approve',
          rationale: 'Manual checks done',
          created_at: '2026-04-30T10:00:01.000Z',
        }),
        makeDecision({
          decision_id: 'dec_validation',
          type: 'manual_validation_confirmed',
          rationale: 'Auto-attached on approve (manual track)',
          created_at: '2026-04-30T10:00:00.500Z',
        }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    // The merged row uses the manual-track label and anchors on the approve.
    expect(html).toContain('Approved (manual track)');
    expect(html).toContain('data-entity-id="dec_approve"');
    // The list count still reflects both underlying decisions (audit trail).
    expect(html).toContain('Decisions (2)');
    // The validation decision is not rendered as a top-level row…
    expect(html).not.toContain('data-entity-id="dec_validation"');
    // …but it remains discoverable inside the disclosure.
    expect(html).toContain('Show validation step');
    expect(html).toContain('data-paired-validation-id="dec_validation"');
    // Both rationales remain present so the audit trail is complete.
    expect(html).toContain('Manual checks done');
    expect(html).toContain('Auto-attached on approve (manual track)');
  });

  it('does NOT pair when types are mismatched (approve + reject)', () => {
    swrState.data = {
      decisions: [
        makeDecision({ decision_id: 'dec_a', type: 'approve', created_at: '2026-04-30T10:00:00.500Z' }),
        makeDecision({ decision_id: 'dec_b', type: 'reject', created_at: '2026-04-30T10:00:00.500Z' }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).not.toContain('Approved (manual track)');
    expect(html).not.toContain('<details');
    expect(html).toContain('data-entity-id="dec_a"');
    expect(html).toContain('data-entity-id="dec_b"');
  });

  it('does NOT pair when actor_ids differ', () => {
    swrState.data = {
      decisions: [
        makeDecision({ decision_id: 'dec_a', type: 'approve', actor_id: 'usr_one', created_at: '2026-04-30T10:00:00.500Z' }),
        makeDecision({ decision_id: 'dec_b', type: 'manual_validation_confirmed', actor_id: 'usr_two', created_at: '2026-04-30T10:00:00.500Z' }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).not.toContain('Approved (manual track)');
    expect(html).toContain('data-entity-id="dec_a"');
    expect(html).toContain('data-entity-id="dec_b"');
  });

  it('does NOT pair when timestamp gap exceeds the 5s tolerance', () => {
    swrState.data = {
      decisions: [
        makeDecision({ decision_id: 'dec_a', type: 'approve', created_at: '2026-04-30T10:00:06.000Z' }),
        makeDecision({ decision_id: 'dec_b', type: 'manual_validation_confirmed', created_at: '2026-04-30T10:00:00.000Z' }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).not.toContain('Approved (manual track)');
    expect(html).toContain('data-entity-id="dec_a"');
    expect(html).toContain('data-entity-id="dec_b"');
  });

  it('does NOT pair when a non-matching row interleaves between approve and validation', () => {
    swrState.data = {
      decisions: [
        makeDecision({ decision_id: 'dec_a', type: 'approve', created_at: '2026-04-30T10:00:02.000Z' }),
        makeDecision({ decision_id: 'dec_b', type: 'reject', actor_id: 'usr_other', created_at: '2026-04-30T10:00:01.000Z' }),
        makeDecision({ decision_id: 'dec_c', type: 'manual_validation_confirmed', created_at: '2026-04-30T10:00:00.000Z' }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).not.toContain('Approved (manual track)');
    expect(html).toContain('data-entity-id="dec_a"');
    expect(html).toContain('data-entity-id="dec_b"');
    expect(html).toContain('data-entity-id="dec_c"');
  });

  it('does NOT pair when adjacency order is reversed (validation before approve)', () => {
    // The predicate is order-sensitive: a===approve && b===manual_validation_confirmed.
    swrState.data = {
      decisions: [
        makeDecision({ decision_id: 'dec_a', type: 'manual_validation_confirmed', created_at: '2026-04-30T10:00:01.000Z' }),
        makeDecision({ decision_id: 'dec_b', type: 'approve', created_at: '2026-04-30T10:00:00.500Z' }),
      ],
    };
    const html = renderToStaticMarkup(<DecisionHistory caseId="case_1" />);
    expect(html).not.toContain('Approved (manual track)');
    expect(html).toContain('data-entity-id="dec_a"');
    expect(html).toContain('data-entity-id="dec_b"');
  });
});
