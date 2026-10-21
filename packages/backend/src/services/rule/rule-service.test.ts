import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case, Evidence, Finding, Rule, RuleOverride, RuleResult } from '@arbitra/shared';

// ── In-memory Firestore stand-ins ──────────────────────────────────────────
// Generic enough to back `rules`, `ruleResults`, `findings` and
// `ruleOverrides` — every collection RuleService touches, either directly or
// through the real `RuleRepository` (not mocked: exercising the real
// getActiveRulesForProject/saveRuleResult logic against these stores keeps
// the test honest about what RuleService actually reads/writes).
function makeCollection<T extends Record<string, unknown>>(store: Map<string, T>) {
  function query(predicate: (item: T) => boolean): {
    where: (field: string, op: string, value: unknown) => ReturnType<typeof query>;
    get: () => Promise<{ docs: { data: () => T }[] }>;
  } {
    return {
      where: (field: string, _op: string, value: unknown) =>
        query((item) => predicate(item) && item[field] === value),
      get: async () => ({
        docs: Array.from(store.values()).filter(predicate).map((data) => ({ data: () => data })),
      }),
    };
  }

  return {
    doc: (id: string) => ({
      get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
      set: async (data: T) => {
        store.set(id, data);
      },
      update: async (patch: Partial<T>) => {
        const current = store.get(id);
        if (current) store.set(id, { ...current, ...patch });
      },
    }),
    where: (field: string, _op: string, value: unknown) => query((item) => item[field] === value),
    get: async () => ({
      docs: Array.from(store.values()).map((data) => ({ data: () => data })),
    }),
  };
}

const rulesStore = new Map<string, Rule>();
const ruleResultsStore = new Map<string, RuleResult>();
const findingsStore = new Map<string, Finding>();
const overridesStore = new Map<string, RuleOverride>();

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    rules: () => makeCollection(rulesStore as unknown as Map<string, Record<string, unknown>>),
    ruleResults: () => makeCollection(ruleResultsStore as unknown as Map<string, Record<string, unknown>>),
    findings: () => makeCollection(findingsStore as unknown as Map<string, Record<string, unknown>>),
    ruleOverrides: () => makeCollection(overridesStore as unknown as Map<string, Record<string, unknown>>),
  },
  // Minimal transaction fake for `lib/finding-idempotency.ts`'s
  // create-or-reactivate write (issue #739). No real optimistic-concurrency
  // enforcement — the concurrency tests below rely on the deterministic
  // finding id itself collapsing racing writes onto the same map key, which
  // is the property under test.
  getDb: () => ({
    runTransaction: async (fn: (tx: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      create: (ref: { set: (data: unknown) => Promise<void> }, data: unknown) => void;
      update: (ref: { update: (data: unknown) => Promise<void> }, data: unknown) => void;
    }) => Promise<unknown>) =>
      fn({
        get: (ref) => ref.get(),
        create: (ref, data) => void ref.set(data),
        update: (ref, data) => void ref.update(data),
      }),
  }),
}));

vi.mock('../../lib/ids.js', () => {
  let counter = 0;
  return {
    generateId: (prefix: string) => `${prefix}_${++counter}`,
    deriveFindingId: (signature: string) => `fnd_${signature.slice(0, 32)}`,
  };
});

const emitMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../event/event-service.js', () => ({
  EventService: vi.fn(() => ({ emit: emitMock })),
}));

import { RuleService } from './rule-service.js';
import { computeRuleConflictSignature } from './conflict-detector.js';

/** Mirrors the `deriveFindingId` mock above — used to seed/read a finding at
 * the exact doc id `RuleService` will compute for a given conflict. */
function findingIdFor(caseId: string, globalRuleId: string, projectRuleId: string): string {
  const signature = computeRuleConflictSignature(caseId, {
    globalRule: makeRule({ rule_id: globalRuleId }),
    projectRule: makeRule({ rule_id: projectRuleId }),
    severity: 'medium',
  });
  return `fnd_${signature.slice(0, 32)}`;
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'rule_x',
    name: 'no-console-log',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'metadata_check',
    severity_if_failed: 'medium',
    config: { field: 'risk_level', operator: 'exists' },
    description: '',
    rationale: '',
    status: 'active',
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Test',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'in_review',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const evidence: Evidence[] = [];

function conflictFindings(): Finding[] {
  return Array.from(findingsStore.values()).filter((f) => f.category === 'rule_override_conflict');
}

describe('RuleService — rule_override_conflict findings', () => {
  beforeEach(() => {
    rulesStore.clear();
    ruleResultsStore.clear();
    findingsStore.clear();
    overridesStore.clear();
    emitMock.mockClear();
  });

  it('creates exactly one finding referencing both rule ids when a conflict is detected', async () => {
    const globalRule = makeRule({
      rule_id: 'rule_global_1',
      name: 'no-console-log',
      category: 'code_quality_rule',
      scope: { layer: 'global', ref: 'global' },
    });
    const projectRule = makeRule({
      rule_id: 'rule_project_1',
      name: 'no-console-log',
      category: 'code_quality_rule',
      scope: { layer: 'project', ref: 'proj_1' },
    });
    rulesStore.set(globalRule.rule_id, globalRule);
    rulesStore.set(projectRule.rule_id, projectRule);

    const service = new RuleService();
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_1', 'usr_actor');

    const findings = conflictFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe('open');
    expect(findings[0]!.rule_refs).toEqual(
      expect.arrayContaining(['rule_global_1', 'rule_project_1']),
    );
    expect(findings[0]!.rule_refs).toHaveLength(2);
    // Only low/medium — rule_override_conflict gates via its own dedicated
    // precondition, not the high/critical severity gate.
    expect(['low', 'medium']).toContain(findings[0]!.severity);
  });

  it('is idempotent: recomputing the same conflict across multiple runs does not spam duplicate findings', async () => {
    const globalRule = makeRule({
      rule_id: 'rule_global_1',
      scope: { layer: 'global', ref: 'global' },
    });
    const projectRule = makeRule({
      rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
    });
    rulesStore.set(globalRule.rule_id, globalRule);
    rulesStore.set(projectRule.rule_id, projectRule);

    const service = new RuleService();
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_1', 'usr_actor');
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_2', 'usr_actor');
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_3', 'usr_actor');

    expect(conflictFindings()).toHaveLength(1);
  });

  it('does not create a finding when the two rules do not conflict (different category/name)', async () => {
    rulesStore.set('rule_global_1', makeRule({
      rule_id: 'rule_global_1',
      name: 'no-console-log',
      scope: { layer: 'global', ref: 'global' },
    }));
    rulesStore.set('rule_project_1', makeRule({
      rule_id: 'rule_project_1',
      name: 'require-tests',
      scope: { layer: 'project', ref: 'proj_1' },
    }));

    const service = new RuleService();
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_1', 'usr_actor');

    expect(conflictFindings()).toHaveLength(0);
  });

  it('auto-resolves a previously open conflict finding once the conflict stops existing', async () => {
    const globalRule = makeRule({
      rule_id: 'rule_global_1',
      scope: { layer: 'global', ref: 'global' },
    });
    const projectRule = makeRule({
      rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
    });
    rulesStore.set(globalRule.rule_id, globalRule);
    rulesStore.set(projectRule.rule_id, projectRule);

    const service = new RuleService();
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_1', 'usr_actor');
    expect(conflictFindings()).toHaveLength(1);
    expect(conflictFindings()[0]!.status).toBe('open');

    // The conflict stops existing (e.g. the project rule was deactivated —
    // getActiveRulesForProject only returns `status: 'active'` rules).
    rulesStore.set(projectRule.rule_id, { ...projectRule, status: 'inactive' });

    await service.evaluateRulesForCase(makeCase(), evidence, 'run_2', 'usr_actor');

    const findings = conflictFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe('resolved');
  });

  it('skips finding creation for a rule pair that already has a confirmed RuleOverride', async () => {
    const globalRule = makeRule({
      rule_id: 'rule_global_1',
      scope: { layer: 'global', ref: 'global' },
    });
    const projectRule = makeRule({
      rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
    });
    rulesStore.set(globalRule.rule_id, globalRule);
    rulesStore.set(projectRule.rule_id, projectRule);
    overridesStore.set('ro_existing', {
      override_id: 'ro_existing',
      rule_id: globalRule.rule_id,
      overriding_rule_id: projectRule.rule_id,
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'Intentional — project needs console logging for this integration.',
      version: 1,
      rule_version: 1,
      overriding_rule_version: 1,
      created_by: 'usr_lead',
      created_at: '2026-01-01T00:00:00Z',
    });

    const service = new RuleService();
    await service.evaluateRulesForCase(makeCase(), evidence, 'run_1', 'usr_actor');

    expect(conflictFindings()).toHaveLength(0);
  });

  describe('idempotency under a racing double-run (issue #739)', () => {
    // Two `evaluateRulesForCase` calls racing on the same case each read
    // `existingFindings` before either has written (both see the store
    // empty), exactly the interleaving #739 describes. Fails if the
    // deterministic-id / create-only write in `persistConflictFindings` is
    // reverted to `generateId('finding')` + `.set()`: each racing call would
    // then mint its own random id and both writes would land, producing two
    // findings for the one conflict.
    function seedConflictingRules() {
      const globalRule = makeRule({
        rule_id: 'rule_global_1',
        scope: { layer: 'global', ref: 'global' },
      });
      const projectRule = makeRule({
        rule_id: 'rule_project_1',
        scope: { layer: 'project', ref: 'proj_1' },
      });
      rulesStore.set(globalRule.rule_id, globalRule);
      rulesStore.set(projectRule.rule_id, projectRule);
    }

    it('creates exactly one finding when two evaluations race on the same conflict', async () => {
      seedConflictingRules();
      const service = new RuleService();

      await Promise.all([
        service.evaluateRulesForCase(makeCase(), evidence, 'run_a', 'usr_actor'),
        service.evaluateRulesForCase(makeCase(), evidence, 'run_b', 'usr_actor'),
      ]);

      const findings = conflictFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.status).toBe('open');
      expect(findings[0]!.finding_id).toBe(
        findingIdFor('case_1', 'rule_global_1', 'rule_project_1'),
      );
    });

    it('reopens a previously resolved conflict finding under the same signature instead of duplicating it', async () => {
      seedConflictingRules();
      const findingId = findingIdFor('case_1', 'rule_global_1', 'rule_project_1');
      const signature = computeRuleConflictSignature('case_1', {
        globalRule: makeRule({ rule_id: 'rule_global_1' }),
        projectRule: makeRule({ rule_id: 'rule_project_1' }),
        severity: 'medium',
      });
      // A prior incarnation of the same conflict, already resolved (e.g. the
      // project rule was fixed, then edited back to reintroduce the clash).
      findingsStore.set(findingId, {
        finding_id: findingId,
        case_id: 'case_1',
        category: 'rule_override_conflict',
        severity: 'low',
        confidence: 1,
        status: 'resolved',
        title: 'Rule override conflict: no-console-log',
        description: 'stale',
        origin_type: 'rule_engine',
        source_refs: [],
        evidence_refs: [],
        rule_refs: ['rule_global_1', 'rule_project_1'],
        signature,
        resolution: 'Rule conflict no longer detected (a rule was edited, deactivated, or removed).',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });

      const service = new RuleService();
      await service.evaluateRulesForCase(makeCase(), evidence, 'run_1', 'usr_actor');

      // Reactivated in place — same doc id, not a second document.
      expect(findingsStore.size).toBe(1);
      const findings = conflictFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.finding_id).toBe(findingId);
      expect(findings[0]!.status).toBe('open');
    });
  });
});
