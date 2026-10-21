/**
 * @file GateBanner — the human_confirmation rule-gates fetch must render a
 * visible error state when it fails, not fall through to "no gates" (issue
 * #738 point 3).
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom),
 * with `swr` replaced by a fake that dispatches on the SWR key — mirrors
 * `assistant-answer-panel.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import type { Case } from '@arbitra/shared';
import { GateBanner } from '../case-header-gate-banner';

const mocks = vi.hoisted(() => ({
  humanConfirmationGates: vi.fn(),
  evidenceRequirements: vi.fn(),
  submitDecision: vi.fn(),
  addToast: vi.fn(),
  auth: { user: { uid: 'usr_reviewer' } } as { user: { uid: string } | null },
}));

vi.mock('swr', () => ({
  default: vi.fn(),
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    cases: {
      humanConfirmationGates: mocks.humanConfirmationGates,
      evidenceRequirements: mocks.evidenceRequirements,
      submitDecision: mocks.submitDecision,
    },
  },
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => mocks.auth,
}));

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

/** `undefined` means the request has not resolved yet. */
let ruleGatesData: { gates: unknown[] } | undefined;
let ruleGatesError: unknown;

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Test',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'p1',
    repository_id: 'r1',
    owner_user_id: 'usr_owner',
    status: 'in_review',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = { user: { uid: 'usr_reviewer' } };
  ruleGatesData = undefined;
  ruleGatesError = undefined;

  mockedUseSWR.mockImplementation((key: unknown) => {
    if (key === null) {
      return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
    }
    if (Array.isArray(key) && key[0] === 'case-human-confirmation-gates') {
      return { data: ruleGatesData, error: ruleGatesError, isLoading: false, mutate: vi.fn() };
    }
    // 'case-evidence-requirements' and anything else — unused by these tests.
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  });
});

describe('GateBanner — human_confirmation rule-gates fetch', () => {
  it('renders nothing when there is no pending gate, no rule gates, and no fetch error', () => {
    ruleGatesData = { gates: [] };

    const html = renderToStaticMarkup(
      <GateBanner caseData={makeCase()} onTransition={vi.fn()} />,
    );

    expect(html).toBe('');
  });

  it('renders a visible error state when the rule-gates fetch fails, instead of "no gates"', () => {
    // Pre-fix (git stash the component change): `error` isn't destructured
    // from this SWR call at all, `ruleGates` falls back to `[]`, and the
    // component returns null here — this assertion fails against that
    // version because `html` is empty instead of containing the error text.
    ruleGatesError = new Error('Network request failed');

    const html = renderToStaticMarkup(
      <GateBanner caseData={makeCase()} onTransition={vi.fn()} />,
    );

    expect(html).not.toBe('');
    expect(html).toContain('Failed to load gate status');
    expect(html).toContain('Network request failed');
  });

  it('still surfaces the fetch-error banner alongside a pending lifecycle gate', () => {
    ruleGatesError = new Error('Network request failed');

    const html = renderToStaticMarkup(
      <GateBanner
        caseData={makeCase({
          pending_gate: { gate_id: 'review_to_approved', target_status: 'approved', since: '2026-01-01T00:00:00Z' },
        })}
        onTransition={vi.fn()}
      />,
    );

    expect(html).toContain('Failed to load gate status');
    expect(html).toContain('Awaiting confirmation to proceed to');
  });

  it('does not advertise a stale pending_gate once the case has moved past it (issue #1049)', () => {
    // `review_to_approved` is only active while the case is still `in_review`
    // (GATE_TRANSITION_MAP['review_to_approved'].from). A case-level Request
    // Changes (or any other legitimate transition) can move the case to a
    // different status while the marker is still on record — the banner
    // must not render Confirm/Decline, or the "All preconditions are
    // satisfied" copy, for a gate the case has already left behind.
    ruleGatesData = { gates: [] };

    const html = renderToStaticMarkup(
      <GateBanner
        caseData={makeCase({
          status: 'in_build',
          pending_gate: { gate_id: 'review_to_approved', target_status: 'approved', since: '2026-01-01T00:00:00Z' },
        })}
        onTransition={vi.fn()}
      />,
    );

    expect(html).toBe('');
  });

  it('renders the rule-gate banner (not the error state) once the fetch succeeds', () => {
    ruleGatesData = {
      gates: [
        {
          rule_result_id: 'rr_1',
          rule_id: 'rule_1',
          rule_name: 'Deployment window confirmation',
          message: 'Human confirmation required',
        },
      ],
    };

    const html = renderToStaticMarkup(
      <GateBanner caseData={makeCase()} onTransition={vi.fn()} />,
    );

    expect(html).not.toContain('Failed to load gate status');
    expect(html).toContain('Deployment window confirmation');
  });
});
