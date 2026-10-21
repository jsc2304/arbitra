/**
 * @file edit-policy-modal — reset-to-defaults + tooltip rendering tests.
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom).
 * The modal's stateful behavior (button click → confirm dialog → DELETE)
 * is exercised by directly invoking the api-client method and asserting
 * the network contract; structural assertions on the rendered HTML cover
 * the tooltip wiring and the reset button itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvidencePolicy } from '@arbitra/shared';

// Stub firebase so module init doesn't try to load the SDK.
vi.mock('../../../lib/firebase-client', () => ({
  getIdToken: async () => 'test-token',
}));

// The modal pulls project names through useProjectMap. Stub the hook so
// the renderer doesn't attempt to fetch from `/api/projects`.
vi.mock('../../../hooks/use-projects', () => ({
  useProjectMap: () => ({ proj_test: 'Test Project' }),
}));

import { EditPolicyModal, deepCopyRules } from '../edit-policy-modal';
import { api } from '../../../lib/api-client';
import type { EvidencePolicyRulesMap } from '@arbitra/shared';

const POLICY: EvidencePolicy = {
  policy_id: 'pol_1',
  project_id: 'proj_test',
  rules: {},
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('<EditPolicyModal /> — closed', () => {
  it('renders nothing when `open` is false', () => {
    const html = renderToStaticMarkup(
      <EditPolicyModal
        policy={POLICY}
        open={false}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(html).toBe('');
  });
});

describe('<EditPolicyModal /> — open: profile picker + tooltips + reset button', () => {
  function renderOpen(): string {
    return renderToStaticMarkup(
      <EditPolicyModal
        policy={POLICY}
        open={true}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
  }

  it('renders the starting-profile picker with all four options', () => {
    const html = renderOpen();
    expect(html).toContain('Starting profile');
    expect(html).toContain('Fast iteration');
    expect(html).toContain('Balanced');
    expect(html).toContain('Strict regulated');
    expect(html).toContain('Custom');
  });

  it('selects "Balanced" by default for an empty rules map (auto-detect)', () => {
    const html = renderOpen();
    // The select renders <option ... selected> for the matched profile.
    expect(html).toMatch(/<option[^>]*value="balanced"[^>]*selected/);
  });

  it('renders the reset-to-defaults button', () => {
    const html = renderOpen();
    expect(html).toContain('data-testid="reset-to-defaults-button"');
    expect(html).toContain('Reset to system defaults');
  });

  it('renders the four-eyes tooltip wording on each toggle row', () => {
    const html = renderOpen();
    expect(html).toContain('At least two distinct reviewers must approve.');
    // The aria-describedby ↔ sr-only span pair exists for screen readers.
    expect(html).toContain('aria-describedby="four-eyes-tip-low-direct"');
  });

  it('renders the self-approval tooltip wording on each toggle row', () => {
    const html = renderOpen();
    expect(html).toContain('The case owner can approve their own work.');
    expect(html).toContain('aria-describedby="self-approval-tip-low-direct"');
  });

  it('renders evidence-type buttons with required/optional tooltip pattern', () => {
    const html = renderOpen();
    // Pattern from `evidenceTooltip` — tooltip ends with the
    // required/optional explanation.
    expect(html).toContain(
      'Required = case can’t progress past review without it. Optional = welcome but not blocking.',
    );
  });

  it('renders the "requires no evidence" checkbox and tooltip on each toggle row', () => {
    const html = renderOpen();
    expect(html).toContain('This cell deliberately requires no evidence at all');
    expect(html).toContain('aria-describedby="requires-none-tip-low-direct"');
  });
});

describe('<EditPolicyModal /> — cell state badge (absent vs. explicit "requires nothing")', () => {
  it('shows "Inherits defaults" for every cell of a policy with an empty rules map', () => {
    const html = renderToStaticMarkup(
      <EditPolicyModal policy={POLICY} open={true} onClose={() => {}} onSaved={() => {}} />,
    );
    // 4 risk levels × 2 tracks = 8 cells, all absent.
    expect((html.match(/Inherits defaults/g) ?? []).length).toBe(8);
  });

  it('drops one "Inherits defaults" badge and shows one "requires no evidence" badge for an explicit empty+flag cell', () => {
    const policyWithExplicitEmptyCell = {
      ...POLICY,
      rules: {
        low: {
          direct: {
            required_evidence_types: [],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
            requires_no_evidence: true,
          },
        },
      },
    };
    const html = renderToStaticMarkup(
      <EditPolicyModal policy={policyWithExplicitEmptyCell} open={true} onClose={() => {}} onSaved={() => {}} />,
    );
    expect((html.match(/Inherits defaults/g) ?? []).length).toBe(7);
    // The checkbox label "Requires no evidence" renders once per cell (8)
    // regardless of state; the badge adds a 9th occurrence only for the
    // customized cell.
    expect((html.match(/Requires no evidence/g) ?? []).length).toBe(9);
  });
});

describe('deepCopyRules — no-op save preserves absent cells (defect 2 regression)', () => {
  it('leaves risk/track keys the source policy does not have absent in the copy', () => {
    // Exact shape of ep_clerk_8a7f43d3de8c06468226c0a8: only low.direct and
    // medium.direct populated, everything else absent (not empty).
    const stored: EvidencePolicyRulesMap = {
      low: {
        direct: {
          required_evidence_types: ['ci_result'],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: false,
        },
      },
      medium: {
        direct: {
          required_evidence_types: ['ci_result', 'unit_test_result'],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: false,
        },
      },
    };

    const copy = deepCopyRules(stored);

    // A no-op save sends `{ rules: copy }` — it must equal what's stored.
    expect(copy).toEqual(stored);
    expect(copy.high).toBeUndefined();
    expect(copy.critical).toBeUndefined();
    expect(copy.low?.manual).toBeUndefined();
    expect(copy.medium?.manual).toBeUndefined();
  });

  it('does not mutate the source rule objects (deep copy, not reference copy)', () => {
    const stored: EvidencePolicyRulesMap = {
      low: {
        direct: {
          required_evidence_types: ['ci_result'],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: false,
        },
      },
    };
    const copy = deepCopyRules(stored);
    copy.low!.direct!.required_evidence_types.push('unit_test_result');
    expect(stored.low!.direct!.required_evidence_types).toEqual(['ci_result']);
  });
});

describe('api.evidencePolicies.delete — reset wires through to DELETE', () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => ({}),
    } as unknown as Response);
    globalThis.fetch = fetchSpy as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('issues DELETE /api/evidence-policies/:id with the bearer token', async () => {
    await api.evidencePolicies.delete('pol_xyz');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/evidence-policies/pol_xyz');
    expect((init as RequestInit).method).toBe('DELETE');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
  });

  it('throws when the API returns a non-2xx response', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Policy not found' } }),
    } as unknown as Response);

    await expect(api.evidencePolicies.delete('pol_missing')).rejects.toThrow(
      'Policy not found',
    );
  });
});

describe('deepCopyRules — a legacy-empty cell is treated as inherited, not copied', () => {
  /**
   * A cell stored before `requires_no_evidence` existed is empty with no flag.
   * `classifyPolicyCell` buckets that as `inherits_defaults`, and the resolver
   * falls through to the built-in defaults for it — so the editor must treat it
   * the same way. Copying it through would round-trip a shape the write
   * boundary now rejects, and the user would lose the save over a cell they
   * never touched.
   *
   * Reverting `if (!isPolicyCellAuthored(src)) continue;` in `deepCopyRules`
   * back to `if (!src) continue;` breaks this.
   */
  it('drops a present-but-empty unflagged cell instead of round-tripping it', () => {
    const stored: EvidencePolicyRulesMap = {
      low: {
        direct: {
          required_evidence_types: [],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: false,
        },
      },
      critical: {
        direct: {
          required_evidence_types: ['ci_result'],
          optional_evidence_types: [],
          four_eyes_required: true,
          allow_self_approval: false,
        },
      },
    };

    const copy = deepCopyRules(stored);

    // The legacy-empty cell is gone entirely — and with it, its risk key.
    expect(copy.low).toBeUndefined();
    // The authored cell survives untouched.
    expect(copy.critical?.direct?.required_evidence_types).toEqual(['ci_result']);
  });

  /** An explicit "requires nothing" cell IS authored and must survive the copy. */
  it('keeps an explicitly-flagged empty cell', () => {
    const stored: EvidencePolicyRulesMap = {
      low: {
        direct: {
          required_evidence_types: [],
          optional_evidence_types: [],
          four_eyes_required: false,
          allow_self_approval: false,
          requires_no_evidence: true,
        },
      },
    };

    const copy = deepCopyRules(stored);
    expect(copy.low?.direct?.requires_no_evidence).toBe(true);
    expect(copy.low?.direct?.required_evidence_types).toEqual([]);
  });
});
