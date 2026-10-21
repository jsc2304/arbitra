/**
 * @file decision-context-panel — actor_metadata client-name rendering.
 *
 * Node-only (renderToStaticMarkup). The `useLastDecision` and `useUserMap`
 * hooks are mocked so each test controls the decision payload independently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Decision } from '@arbitra/shared';

const lastDecisionState: { decision: Decision | null; isLoading: boolean; error: unknown } = {
  decision: null,
  isLoading: false,
  error: null,
};

vi.mock('../../../hooks/use-last-decision', () => ({
  useLastDecision: () => lastDecisionState,
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

import { DecisionContextPanel } from '../decision-context-panel';

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
  lastDecisionState.decision = null;
  lastDecisionState.isLoading = false;
  lastDecisionState.error = null;
});

describe('DecisionContextPanel — actor_metadata rendering', () => {
  it('renders the canonical client label when actor_metadata.client_name is set', () => {
    lastDecisionState.decision = makeDecision({
      actor_metadata: { client_name: 'cursor' },
    });
    const html = renderToStaticMarkup(<DecisionContextPanel caseId="case_1" />);
    expect(html).toContain('Cursor');
    expect(html).not.toContain('Real Human usr_reviewer');
  });

  it('falls back to the resolved human name when actor_metadata is absent', () => {
    lastDecisionState.decision = makeDecision();
    const html = renderToStaticMarkup(<DecisionContextPanel caseId="case_1" />);
    expect(html).toContain('Real Human usr_reviewer');
  });
});
