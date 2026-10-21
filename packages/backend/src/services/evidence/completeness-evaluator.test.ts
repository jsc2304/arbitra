import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompletenessEvaluator } from './completeness-evaluator.js';
import type { Case, Evidence, EvidencePolicy } from '@arbitra/shared';
import { buildPolicyRulesFromPreset, getDefaultPolicyRule } from '@arbitra/shared';

// Mock Firestore. The resolver uses a single deterministic chain:
//   where('project_id','==',...).get()
// It fetches ALL project policies (no orderBy → no field-presence exclusion,
// no composite index) and picks the canonical one in code. The chain
// terminates at `mockGet`, which returns the full doc set for the project.
vi.mock('../../lib/firestore.js', () => {
  const mockGet = vi.fn();
  const whereNode = { get: mockGet };
  return {
    collections: {
      evidencePolicies: () => ({
        where: () => whereNode,
      }),
    },
    __mockGet: mockGet,
  };
});

// Access the mock via dynamic import
async function getMockGet() {
  const mod = await import('../../lib/firestore.js') as unknown as { __mockGet: ReturnType<typeof vi.fn> };
  return mod.__mockGet;
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1', title: 'Test', description: '', source_type: 'manual',
    source_ref: '', project_id: 'p1', repository_id: 'r1', owner_user_id: 'usr_1',
    status: 'in_validation', validation_track: 'direct', risk_level: 'low',
    priority: 'normal', active_rule_set_refs: [], knowledge_context_refs: [],
    decision_ready: false, created_at: '', updated_at: '',
    ...overrides,
  };
}

function makeEvidence(type: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidence_id: `ev_${type}`, case_id: 'case_1', type,
    source_type: 'automated', machine_readable: true,
    validation_track: 'direct', created_at: '', created_by: 'system',
    ...overrides,
  };
}

describe('CompletenessEvaluator – default policy fallback', () => {
  let evaluator: CompletenessEvaluator;

  beforeEach(async () => {
    evaluator = new CompletenessEvaluator();
    const mockGet = await getMockGet();
    // Default: no project policy found → use defaults
    mockGet.mockResolvedValue({ empty: true, docs: [] });
  });

  it('should report satisfied when all required evidence is present (direct/low)', async () => {
    const c = makeCase({ validation_track: 'direct', risk_level: 'low' });
    const evidence = [makeEvidence('ci_result')];
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.four_eyes_required).toBe(false);
  });

  it('should report missing evidence (direct/low without ci_result)', async () => {
    const c = makeCase({ validation_track: 'direct', risk_level: 'low' });
    const result = await evaluator.evaluate(c, []);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('ci_result');
  });

  it('should require ci_result and unit_test_result for direct/medium', async () => {
    const c = makeCase({ validation_track: 'direct', risk_level: 'medium' });
    const evidence = [makeEvidence('ci_result')];
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('unit_test_result');
  });

  it('should require four_eyes for direct/high', async () => {
    const c = makeCase({ validation_track: 'direct', risk_level: 'high' });
    const evidence = [
      makeEvidence('ci_result'),
      makeEvidence('unit_test_result'),
      makeEvidence('runtime_log'),
    ];
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(true);
    expect(result.four_eyes_required).toBe(true);
  });

  it('should require four_eyes for direct/critical', async () => {
    const c = makeCase({ validation_track: 'direct', risk_level: 'critical' });
    const policy = getDefaultPolicyRule('direct', 'critical');
    const evidence = policy.required_evidence_types.map((t) => makeEvidence(t));
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(true);
    expect(result.four_eyes_required).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('should require manual_confirmation for manual/low', async () => {
    const c = makeCase({ validation_track: 'manual', risk_level: 'low' });
    const evidence = [makeEvidence('ci_result')];
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('manual_confirmation');
  });

  it('should report all required types for manual/high', async () => {
    const c = makeCase({ validation_track: 'manual', risk_level: 'high' });
    const result = await evaluator.evaluate(c, []);
    const expected = getDefaultPolicyRule('manual', 'high');
    expect(result.required).toEqual(expected.required_evidence_types);
    expect(result.missing).toEqual(expected.required_evidence_types);
    expect(result.four_eyes_required).toBe(true);
  });

  it('should track optional evidence that is present', async () => {
    const c = makeCase({ validation_track: 'direct', risk_level: 'low' });
    const evidence = [
      makeEvidence('ci_result'),
      makeEvidence('unit_test_result'), // optional for direct/low
      makeEvidence('diff_snapshot'),     // optional for direct/low
    ];
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(true);
    expect(result.optional_present).toContain('unit_test_result');
    expect(result.optional_present).toContain('diff_snapshot');
  });
});

describe('CompletenessEvaluator – project policy override', () => {
  let evaluator: CompletenessEvaluator;

  beforeEach(async () => {
    evaluator = new CompletenessEvaluator();
  });

  it('should use project-specific policy when available', async () => {
    const mockGet = await getMockGet();
    const customPolicy: EvidencePolicy = {
      policy_id: 'pol_1',
      project_id: 'p1',
      // Storage shape: rules[risk][track]
      rules: {
        low: {
          direct: {
            required_evidence_types: ['lint_result'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
        },
      },
      version: 1,
      created_at: '',
      updated_at: '',
    };
    mockGet.mockResolvedValue({
      empty: false,
      docs: [{ data: () => customPolicy }],
    });

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });
    const evidence = [makeEvidence('lint_result')];
    const result = await evaluator.evaluate(c, evidence);
    expect(result.satisfied).toBe(true);
    expect(result.required).toEqual(['lint_result']);
  });

  it('resolves a lone legacy doc missing updated_at via the single deterministic query', async () => {
    // The resolver fetches all project policies with one equality query (no
    // orderBy → no field-presence exclusion). A legacy doc lacking `updated_at`
    // is no longer dropped, so no unordered fallback is needed: it resolves on
    // the primary path.
    const mockGet = await getMockGet();
    const legacyPolicy = {
      policy_id: 'pol_legacy',
      project_id: 'p1',
      // Storage shape: rules[risk][track].
      rules: {
        low: {
          direct: {
            required_evidence_types: ['legacy_marker'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
        },
      },
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      // `updated_at` intentionally OMITTED to simulate legacy doc shape — the
      // coalesced recency key falls through to `created_at`.
    } as unknown as EvidencePolicy;
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => legacyPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });
    const rule = await evaluator.getEffectivePolicyRule(c);
    expect(rule.required_evidence_types).toEqual(['legacy_marker']);
  });

  it('deterministically picks the newest doc when duplicates exist, including docs missing updated_at', async () => {
    // Two policies for the same project (a known legacy data-shape issue). One
    // lacks `updated_at`; the other has a recent `updated_at`. Selection must be
    // deterministic regardless of Firestore return order: the doc with the
    // newest coalesced recency key wins, with policy_id as a stable tiebreaker.
    const mockGet = await getMockGet();
    const newer = {
      policy_id: 'ep_2000',
      project_id: 'p1',
      rules: { low: { direct: { required_evidence_types: ['newer_marker'], optional_evidence_types: [], four_eyes_required: false, allow_self_approval: false } } },
      version: 2,
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    } as unknown as EvidencePolicy;
    const legacyNoUpdatedAt = {
      policy_id: 'ep_1000',
      project_id: 'p1',
      rules: { low: { direct: { required_evidence_types: ['legacy_marker'], optional_evidence_types: [], four_eyes_required: false, allow_self_approval: false } } },
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      // no updated_at
    } as unknown as EvidencePolicy;

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });

    // Order A: legacy first.
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => legacyNoUpdatedAt }, { data: () => newer }] });
    const ruleA = await evaluator.getEffectivePolicyRule(c);
    expect(ruleA.required_evidence_types).toEqual(['newer_marker']);

    // Order B: reversed — same result proves order-independence.
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => newer }, { data: () => legacyNoUpdatedAt }] });
    const ruleB = await evaluator.getEffectivePolicyRule(c);
    expect(ruleB.required_evidence_types).toEqual(['newer_marker']);
  });

  it('breaks ties by policy_id when two docs both lack updated_at and created_at', async () => {
    // Fully degenerate legacy case: both docs lack every recency field. The
    // policy_id tiebreaker still yields a total order, so resolution is
    // deterministic (descending policy_id wins).
    const mockGet = await getMockGet();
    const docA = {
      policy_id: 'ep_aaa',
      project_id: 'p1',
      rules: { low: { direct: { required_evidence_types: ['marker_a'], optional_evidence_types: [], four_eyes_required: false, allow_self_approval: false } } },
      version: 1,
    } as unknown as EvidencePolicy;
    const docB = {
      policy_id: 'ep_bbb',
      project_id: 'p1',
      rules: { low: { direct: { required_evidence_types: ['marker_b'], optional_evidence_types: [], four_eyes_required: false, allow_self_approval: false } } },
      version: 1,
    } as unknown as EvidencePolicy;

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });

    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => docA }, { data: () => docB }] });
    const r1 = await evaluator.getEffectivePolicyRule(c);
    expect(r1.required_evidence_types).toEqual(['marker_b']); // ep_bbb > ep_aaa

    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => docB }, { data: () => docA }] });
    const r2 = await evaluator.getEffectivePolicyRule(c);
    expect(r2.required_evidence_types).toEqual(['marker_b']);
  });

  it('should fall back to default when project policy has no matching track', async () => {
    const mockGet = await getMockGet();
    const customPolicy: EvidencePolicy = {
      policy_id: 'pol_1',
      project_id: 'p1',
      // Storage shape: rules[risk][track]. Only manual configured at low.
      rules: {
        low: {
          manual: {
            required_evidence_types: ['screenshot'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
        },
      },
      version: 1,
      created_at: '',
      updated_at: '',
    };
    mockGet.mockResolvedValue({
      empty: false,
      docs: [{ data: () => customPolicy }],
    });

    // Case is on direct track, but policy only has manual rules → fallback
    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });
    const result = await evaluator.evaluate(c, []);
    expect(result.required).toContain('ci_result'); // default direct/low
  });
});

describe('CompletenessEvaluator – allow_self_approval surfacing', () => {
  let evaluator: CompletenessEvaluator;

  beforeEach(async () => {
    evaluator = new CompletenessEvaluator();
  });

  it('defaults to allow_self_approval=false for every default cell', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: true, docs: [] });

    for (const track of ['direct', 'manual'] as const) {
      for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
        const c = makeCase({ validation_track: track, risk_level: risk });
        const result = await evaluator.evaluate(c, []);
        expect(result.allow_self_approval).toBe(false);
      }
    }
  });

  it('reads the correct cell from a project-specific policy (direct/medium with allow=true)', async () => {
    // Regression guard for the resolver: when a project policy defines several
    // cells with different `allow_self_approval` values, the evaluator must
    // return the cell matching the case's track + risk — no cross-bleed.
    // Storage shape: rules[risk][track].
    const mockGet = await getMockGet();
    // NOTE: `required_evidence_types` must be non-empty here (unlike earlier
    // revisions of this fixture) — an empty required list with no
    // `requires_no_evidence` flag now classifies as `inherits_defaults`
    // (see classifyPolicyCell), which would make every cell below fall
    // through to the built-in defaults and defeat the very thing this test
    // checks (that the resolver returns the SPECIFIC cell's
    // `allow_self_approval`/`four_eyes_required`, not the default's). This
    // was exactly the near-miss the empty-cell security fix flagged: this
    // fixture used to construct empty-required cells and assert only on
    // `allow_self_approval`, never on `required`/`satisfied`.
    const customPolicy: EvidencePolicy = {
      policy_id: 'pol_multi',
      project_id: 'p1',
      rules: {
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
            required_evidence_types: ['ci_result'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: true,
          },
        },
        high: {
          direct: {
            required_evidence_types: ['ci_result'],
            optional_evidence_types: [],
            four_eyes_required: true,
            allow_self_approval: false,
          },
        },
      },
      version: 1,
      created_at: '',
      updated_at: '',
    };
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => customPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'medium', project_id: 'p1' });
    const result = await evaluator.evaluate(c, []);
    expect(result.allow_self_approval).toBe(true);

    const cHigh = makeCase({ validation_track: 'direct', risk_level: 'high', project_id: 'p1' });
    const resultHigh = await evaluator.evaluate(cHigh, []);
    expect(resultHigh.allow_self_approval).toBe(false);
  });

  it('exposes getEffectivePolicyRule for external callers (decision-service reuse path)', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: true, docs: [] });
    const c = makeCase({ validation_track: 'manual', risk_level: 'high' });
    const rule = await evaluator.getEffectivePolicyRule(c);
    expect(rule.four_eyes_required).toBe(true);
    expect(rule.allow_self_approval).toBe(false);
  });

  it('retains the resolved parent policy id and version', async () => {
    const mockGet = await getMockGet();
    const policy: EvidencePolicy = {
      policy_id: 'policy_governance',
      project_id: 'p1',
      rules: {
        medium: {
          direct: {
            required_evidence_types: ['ci_result'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
        },
      },
      version: 9,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    };
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => policy }] });

    const resolution = await evaluator.getEffectivePolicy(
      makeCase({ validation_track: 'direct', risk_level: 'medium' }),
    );

    expect(resolution.policy_id).toBe('policy_governance');
    expect(resolution.version).toBe(9);
    expect(resolution.rule).toBe(policy.rules.medium?.direct);
  });
});

describe('CompletenessEvaluator – getEscalationThreshold (issue #987)', () => {
  let evaluator: CompletenessEvaluator;

  beforeEach(() => {
    evaluator = new CompletenessEvaluator();
  });

  it('defaults to "high" when the project has no evidence policy at all', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: true, docs: [] });

    const c = makeCase({ project_id: 'p1' });
    const threshold = await evaluator.getEscalationThreshold(c);
    expect(threshold).toBe('high');
  });

  it('defaults to "high" when the project has a policy but no authored escalation section', async () => {
    const mockGet = await getMockGet();
    const policy: EvidencePolicy = {
      policy_id: 'pol_no_escalation',
      project_id: 'p1',
      rules: {},
      version: 1,
      created_at: '',
      updated_at: '',
    };
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => policy }] });

    const c = makeCase({ project_id: 'p1' });
    const threshold = await evaluator.getEscalationThreshold(c);
    expect(threshold).toBe('high');
  });

  it('returns the project-authored escalation.risk_threshold when present', async () => {
    const mockGet = await getMockGet();
    const policy: EvidencePolicy = {
      policy_id: 'pol_strict',
      project_id: 'p1',
      rules: {},
      version: 1,
      created_at: '',
      updated_at: '',
      escalation: { risk_threshold: 'critical' },
    };
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => policy }] });

    const c = makeCase({ project_id: 'p1' });
    const threshold = await evaluator.getEscalationThreshold(c);
    expect(threshold).toBe('critical');
  });
});

describe('CompletenessEvaluator – axis-order regression (risk-first storage shape)', () => {
  // Guards the resolver against reintroducing the pre-fix bug where the
  // resolver indexed track-first while the editor persists risk-first —
  // every customized cell silently fell through to defaults.
  let evaluator: CompletenessEvaluator;

  beforeEach(() => {
    evaluator = new CompletenessEvaluator();
  });

  const tracks = ['direct', 'manual'] as const;
  const risks = ['low', 'medium', 'high', 'critical'] as const;

  it('returns the customized cell (not the default) for every (risk × track) pair', async () => {
    // Build a fully-populated risk-first policy where every cell has a sentinel
    // `required_evidence_types` value — distinct from any default — so a
    // successful lookup is unambiguous.
    const rules: EvidencePolicy['rules'] = {};
    for (const risk of risks) {
      rules[risk] = {};
      for (const track of tracks) {
        rules[risk]![track] = {
          required_evidence_types: [`sentinel_${risk}_${track}`],
          optional_evidence_types: [],
          four_eyes_required: risk === 'high' || risk === 'critical',
          allow_self_approval: risk === 'medium' && track === 'direct',
        };
      }
    }
    const customPolicy: EvidencePolicy = {
      policy_id: 'pol_axis',
      project_id: 'p1',
      rules,
      version: 1,
      created_at: '',
      updated_at: '',
    };

    const mockGet = await getMockGet();

    for (const risk of risks) {
      for (const track of tracks) {
        mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => customPolicy }] });
        const c = makeCase({ validation_track: track, risk_level: risk, project_id: 'p1' });
        const result = await evaluator.evaluate(c, []);
        expect(result.required, `required for ${risk}/${track}`).toEqual([
          `sentinel_${risk}_${track}`,
        ]);
      }
    }

    // Spot-check a single customized flag survives resolution (medium/direct)
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => customPolicy }] });
    const cMedDirect = makeCase({
      validation_track: 'direct',
      risk_level: 'medium',
      project_id: 'p1',
    });
    const r = await evaluator.evaluate(cMedDirect, []);
    expect(r.allow_self_approval).toBe(true);
  });

  it('falls back to defaults when the specific (risk × track) cell is absent', async () => {
    // Risk bucket exists but only has the *other* track → should fall back.
    const customPolicy: EvidencePolicy = {
      policy_id: 'pol_partial',
      project_id: 'p1',
      rules: {
        medium: {
          manual: {
            required_evidence_types: ['screenshot'],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
          // direct intentionally missing
        },
      },
      version: 1,
      created_at: '',
      updated_at: '',
    };
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => customPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'medium', project_id: 'p1' });
    const result = await evaluator.evaluate(c, []);
    // default direct/medium requires ci_result + unit_test_result
    expect(result.required).toContain('ci_result');
    expect(result.required).toContain('unit_test_result');
    expect(result.required).not.toContain('screenshot');
  });
});

describe('CompletenessEvaluator – no-CI/no-unit-test preset (#608)', () => {
  // End-to-end proof that a project policy built from the `no_ci_no_unit`
  // preset removes ci_result/unit_test_result from the REQUIRED set, substitutes
  // a required manual_confirmation, and that completeness is satisfiable by
  // {manual_confirmation, lint_result} — the path for repositories without CI.
  let evaluator: CompletenessEvaluator;

  // A policy doc whose rules are derived from the preset, exactly as the
  // apply-evidence-policy-preset script / the POST route would persist it.
  const presetPolicy: EvidencePolicy = {
    policy_id: 'pol_no_ci',
    project_id: 'p1',
    rules: buildPolicyRulesFromPreset('no_ci_no_unit'),
    version: 1,
    created_at: '',
    updated_at: '2026-06-07T00:00:00.000Z',
  };

  beforeEach(() => {
    evaluator = new CompletenessEvaluator();
  });

  it('removes ci_result/unit_test_result and requires manual_confirmation (direct/medium)', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => presetPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'medium', project_id: 'p1' });
    const result = await evaluator.evaluate(c, []);

    expect(result.required).not.toContain('ci_result');
    expect(result.required).not.toContain('unit_test_result');
    expect(result.required).toContain('manual_confirmation');
  });

  it('is satisfiable with {manual_confirmation, lint_result} (direct/medium)', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => presetPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'medium', project_id: 'p1' });
    const evidence = [makeEvidence('manual_confirmation'), makeEvidence('lint_result')];
    const result = await evaluator.evaluate(c, evidence);

    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('is satisfiable with just {manual_confirmation} at direct/low (only ci_result was required)', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => presetPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });
    const result = await evaluator.evaluate(c, [makeEvidence('manual_confirmation')]);
    expect(result.satisfied).toBe(true);
  });

  it('still requires runtime_log alongside manual_confirmation at direct/high', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => presetPolicy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'high', project_id: 'p1' });
    // manual_confirmation alone is NOT enough — high still needs runtime_log.
    const partial = await evaluator.evaluate(c, [makeEvidence('manual_confirmation')]);
    expect(partial.satisfied).toBe(false);
    expect(partial.missing).toContain('runtime_log');

    const full = await evaluator.evaluate(c, [
      makeEvidence('manual_confirmation'),
      makeEvidence('runtime_log'),
    ]);
    expect(full.satisfied).toBe(true);
  });

  it('WITHOUT the preset, ci_result is still required (unchanged behavior)', async () => {
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: true, docs: [] }); // no policy → defaults

    const c = makeCase({ validation_track: 'direct', risk_level: 'medium', project_id: 'p1' });
    const result = await evaluator.evaluate(c, [
      makeEvidence('manual_confirmation'),
      makeEvidence('lint_result'),
    ]);
    expect(result.required).toContain('ci_result');
    expect(result.required).toContain('unit_test_result');
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('ci_result');
  });
});

describe('CompletenessEvaluator – empty-cell security regression', () => {
  // This is the core regression this change closes: `getEffectivePolicy`
  // used to return a stored cell as soon as it existed (`if (trackRule)`),
  // so an empty `required_evidence_types` — whatever the reason — silently
  // satisfied the gate (`missing.length === 0` is trivially true for an
  // empty `required`). The live victim was ep_clerk_8a7f43d3de8c06468226c0a8.
  let evaluator: CompletenessEvaluator;

  beforeEach(() => {
    evaluator = new CompletenessEvaluator();
  });

  it('a legacy empty cell (no requires_no_evidence field) does NOT satisfy the gate — falls through to defaults (pins the LEGACY READ DECISION)', async () => {
    // Exact shape of a document written before `requires_no_evidence` existed:
    // an empty required list and no flag at all, not even `false`.
    const policy: EvidencePolicy = {
      policy_id: 'pol_empty_legacy',
      project_id: 'p1',
      rules: {
        low: {
          direct: {
            required_evidence_types: [],
            optional_evidence_types: [],
            four_eyes_required: false,
            allow_self_approval: false,
          },
        },
      },
      version: 1,
      created_at: '',
      updated_at: '',
    };
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => policy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });
    const result = await evaluator.evaluate(c, []);

    const expected = getDefaultPolicyRule('direct', 'low');
    expect(result.required).toEqual(expected.required_evidence_types);
    expect(result.missing).toEqual(expected.required_evidence_types);
    expect(result.satisfied).toBe(false);
  });

  it('an explicit requires_no_evidence: true cell IS honored — satisfied with zero evidence', async () => {
    const policy: EvidencePolicy = {
      policy_id: 'pol_explicit_empty',
      project_id: 'p1',
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
      version: 1,
      created_at: '',
      updated_at: '',
    };
    const mockGet = await getMockGet();
    mockGet.mockResolvedValue({ empty: false, docs: [{ data: () => policy }] });

    const c = makeCase({ validation_track: 'direct', risk_level: 'low', project_id: 'p1' });
    const result = await evaluator.evaluate(c, []);

    expect(result.required).toEqual([]);
    expect(result.missing).toHaveLength(0);
    expect(result.satisfied).toBe(true);
  });
});
