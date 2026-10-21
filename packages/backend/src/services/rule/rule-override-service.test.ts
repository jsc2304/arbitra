import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Finding, Rule, RuleOverride } from '@arbitra/shared';

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
const findingsStore = new Map<string, Finding>();
const overridesStore = new Map<string, RuleOverride>();

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    rules: () => makeCollection(rulesStore as unknown as Map<string, Record<string, unknown>>),
    findings: () => makeCollection(findingsStore as unknown as Map<string, Record<string, unknown>>),
    ruleOverrides: () => makeCollection(overridesStore as unknown as Map<string, Record<string, unknown>>),
  },
}));

vi.mock('../../lib/ids.js', () => {
  let counter = 0;
  return {
    generateId: (prefix: string) => `${prefix}_${++counter}`,
  };
});

const emitMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../event/event-service.js', () => ({
  EventService: vi.fn(() => ({ emit: emitMock })),
}));

import { RuleOverrideService } from './rule-override-service.js';

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'rule_global_1',
    name: 'no-console-log',
    category: 'code_quality_rule',
    scope: { layer: 'global', ref: 'global' },
    evaluation_mode: 'metadata_check',
    severity_if_failed: 'medium',
    config: {},
    description: '',
    rationale: '',
    status: 'active',
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeConflictFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'fnd_1',
    case_id: 'case_1',
    category: 'rule_override_conflict',
    severity: 'low',
    confidence: 1,
    status: 'open',
    title: 'Rule override conflict',
    description: 'desc',
    origin_type: 'rule_engine',
    source_refs: [],
    evidence_refs: [],
    rule_refs: ['rule_global_1', 'rule_project_1'],
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('RuleOverrideService.createOverride', () => {
  beforeEach(() => {
    rulesStore.clear();
    findingsStore.clear();
    overridesStore.clear();
    emitMock.mockClear();

    rulesStore.set('rule_global_1', makeRule({ rule_id: 'rule_global_1', version: 3 }));
    rulesStore.set('rule_project_1', makeRule({
      rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      version: 2,
    }));
  });

  it('rejects a blank/whitespace-only rationale', async () => {
    const service = new RuleOverrideService();
    await expect(
      service.createOverride({
        rule_id: 'rule_global_1',
        overriding_rule_id: 'rule_project_1',
        scope: { layer: 'project', ref: 'proj_1' },
        rationale: '   ',
      }, 'usr_lead'),
    ).rejects.toThrow(/rationale/i);

    expect(overridesStore.size).toBe(0);
  });

  it('creates the override, stamping created_by and both rule versions', async () => {
    const service = new RuleOverrideService();
    const override = await service.createOverride({
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'Project needs console logging for this integration debug tooling.',
    }, 'usr_lead');

    expect(override.created_by).toBe('usr_lead');
    expect(override.rule_version).toBe(3);
    expect(override.overriding_rule_version).toBe(2);
    expect(overridesStore.get(override.override_id)).toBeDefined();
  });

  it('resolves the explicitly-referenced finding and emits rule_override_created', async () => {
    findingsStore.set('fnd_1', makeConflictFinding());

    const service = new RuleOverrideService();
    const override = await service.createOverride({
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'Project needs console logging for this integration debug tooling.',
      finding_id: 'fnd_1',
    }, 'usr_lead');

    const finding = findingsStore.get('fnd_1')!;
    expect(finding.status).toBe('resolved');
    expect(finding.resolution).toContain(override.override_id);

    expect(emitMock).toHaveBeenCalledWith(
      'case_1',
      'rule_override_created',
      expect.objectContaining({
        override_id: override.override_id,
        rule_id: 'rule_global_1',
        overriding_rule_id: 'rule_project_1',
        finding_id: 'fnd_1',
      }),
      'usr_lead',
    );
  });

  it('does NOT resolve an explicit finding_id whose rule_refs do not match the override pair (cross-tenant guard)', async () => {
    // A different rule pair entirely — simulates a caller supplying an
    // arbitrary/foreign open conflict finding's id (e.g. from a different
    // project) alongside this override's (rule_global_1, rule_project_1) pair.
    findingsStore.set('fnd_1', makeConflictFinding({
      finding_id: 'fnd_1',
      rule_refs: ['rule_global_2', 'rule_project_2'],
    }));

    const service = new RuleOverrideService();
    await service.createOverride({
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'Project needs console logging for this integration debug tooling.',
      finding_id: 'fnd_1',
    }, 'usr_lead');

    expect(findingsStore.get('fnd_1')!.status).toBe('open');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('also resolves other open findings for the same rule pair on different cases (no explicit finding_id needed)', async () => {
    findingsStore.set('fnd_1', makeConflictFinding({ finding_id: 'fnd_1', case_id: 'case_1' }));
    findingsStore.set('fnd_2', makeConflictFinding({ finding_id: 'fnd_2', case_id: 'case_2' }));
    // Unrelated finding — different rule pair — must be left untouched.
    findingsStore.set('fnd_unrelated', makeConflictFinding({
      finding_id: 'fnd_unrelated',
      case_id: 'case_3',
      rule_refs: ['rule_global_1', 'rule_project_other'],
    }));

    const service = new RuleOverrideService();
    await service.createOverride({
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'Applies workspace-wide for this rule pair.',
    }, 'usr_lead');

    expect(findingsStore.get('fnd_1')!.status).toBe('resolved');
    expect(findingsStore.get('fnd_2')!.status).toBe('resolved');
    expect(findingsStore.get('fnd_unrelated')!.status).toBe('open');
  });

  it('does not resolve findings that are already resolved/fixed (no-op, no duplicate event)', async () => {
    findingsStore.set('fnd_1', makeConflictFinding({ status: 'resolved' }));

    const service = new RuleOverrideService();
    await service.createOverride({
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'Applies workspace-wide for this rule pair.',
    }, 'usr_lead');

    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('RuleOverrideService.listOverrides', () => {
  beforeEach(() => {
    overridesStore.clear();
  });

  it('filters by rule_id (matches either side of the pair)', async () => {
    overridesStore.set('ro_1', {
      override_id: 'ro_1',
      rule_id: 'rule_global_1',
      overriding_rule_id: 'rule_project_1',
      scope: { layer: 'project', ref: 'proj_1' },
      rationale: 'r',
      version: 1,
      rule_version: 1,
      overriding_rule_version: 1,
      created_by: 'usr_lead',
      created_at: '2026-01-01T00:00:00Z',
    });
    overridesStore.set('ro_2', {
      override_id: 'ro_2',
      rule_id: 'rule_global_2',
      overriding_rule_id: 'rule_project_2',
      scope: { layer: 'project', ref: 'proj_2' },
      rationale: 'r',
      version: 1,
      rule_version: 1,
      overriding_rule_version: 1,
      created_by: 'usr_lead',
      created_at: '2026-01-01T00:00:00Z',
    });

    const service = new RuleOverrideService();
    const result = await service.listOverrides({ rule_id: 'rule_global_1' });

    expect(result).toHaveLength(1);
    expect(result[0]!.override_id).toBe('ro_1');
  });
});
