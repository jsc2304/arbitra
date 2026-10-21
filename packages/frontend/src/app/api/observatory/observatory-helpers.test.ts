import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Case, Decision, KnowledgeAsset, Project, Repository } from '@arbitra/shared';
import { aggregateObservatory, getTopReferencedAssets } from './observatory-helpers';

// --- Test fixtures ---------------------------------------------------------

function makeAsset(overrides: Partial<KnowledgeAsset>): KnowledgeAsset {
  return {
    knowledge_id: 'ka_1',
    type: 'pattern',
    title: 'Sample',
    summary: '',
    body: '',
    scope_type: 'global',
    scope_ref: 'global',
    status: 'verified',
    version: 1,
    trust_level: 50,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: 'user_1',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> & { case_id: string; refs: string[] }): Decision {
  const { case_id, refs, ...rest } = overrides;
  return {
    decision_id: `dec_${Math.random().toString(36).slice(2, 10)}`,
    case_id,
    type: 'approve',
    actor_id: 'user_1',
    rationale: 'ok',
    snapshot: {
      active_rule_set_versions: {},
      evidence_policy_version: 1,
      knowledge_asset_refs: refs,
    },
    created_at: '2026-03-01T00:00:00.000Z',
    ...rest,
  };
}

function makeCase(overrides: Partial<Case>): Case {
  return {
    case_id: 'case_1',
    project_id: 'proj_1',
    title: 'Sample',
    description: '',
    owner_user_id: 'user_1',
    status: 'done',
    risk_level: 'low',
    validation_track: 'direct',
    case_type: 'feature',
    current_branch: 'main',
    evidence_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    active_rule_set_refs: [],
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    decision_ready: true,
    ...overrides,
  } as Case;
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    project_id: 'proj_1',
    name: 'Sample Project',
    description: '',
    reviewer_pool: [],
    tech_leads: [],
    default_rule_set_refs: [],
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRepository(overrides: Partial<Repository>): Repository {
  return {
    repository_id: 'repo_1',
    project_id: 'proj_1',
    name: 'Sample Repo',
    url: 'https://github.com/example/repo',
    provider: 'github',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- Tests -----------------------------------------------------------------

describe('getTopReferencedAssets', () => {
  it('returns empty array when there are no decisions', () => {
    const assets = [makeAsset({ knowledge_id: 'ka_1' })];
    expect(getTopReferencedAssets([], assets, null)).toEqual([]);
  });

  it('ignores decisions with empty knowledge_asset_refs', () => {
    const assets = [makeAsset({ knowledge_id: 'ka_1', title: 'A' })];
    const decisions = [
      makeDecision({ case_id: 'case_1', refs: [] }),
      makeDecision({ case_id: 'case_2', refs: [] }),
    ];
    expect(getTopReferencedAssets(decisions, assets, null)).toEqual([]);
  });

  it('counts one asset across multiple cases', () => {
    const assets = [
      makeAsset({ knowledge_id: 'ka_1', title: 'Alpha' }),
      makeAsset({ knowledge_id: 'ka_2', title: 'Beta' }),
      makeAsset({ knowledge_id: 'ka_3', title: 'Gamma' }),
    ];
    const decisions = [
      makeDecision({ case_id: 'case_1', refs: ['ka_1', 'ka_2'] }),
      makeDecision({ case_id: 'case_2', refs: ['ka_1'] }),
      makeDecision({ case_id: 'case_3', refs: ['ka_1', 'ka_3'] }),
    ];
    const result = getTopReferencedAssets(decisions, assets, null);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ knowledge_id: 'ka_1', reference_count: 3 });
    // ka_2 and ka_3 tie at 1; tiebreak by title asc → Beta, then Gamma
    expect(result[1]).toMatchObject({ knowledge_id: 'ka_2', reference_count: 1, title: 'Beta' });
    expect(result[2]).toMatchObject({ knowledge_id: 'ka_3', reference_count: 1, title: 'Gamma' });
  });

  it('per-case dedup: 5 decisions in one case contribute at most +1 per asset', () => {
    const assets = [makeAsset({ knowledge_id: 'ka_1', title: 'Alpha' })];
    const decisions = [
      makeDecision({ case_id: 'case_1', refs: ['ka_1'] }),
      makeDecision({ case_id: 'case_1', refs: ['ka_1'] }),
      makeDecision({ case_id: 'case_1', refs: ['ka_1'] }),
      makeDecision({ case_id: 'case_1', refs: ['ka_1'] }),
      makeDecision({ case_id: 'case_1', refs: ['ka_1'] }),
    ];
    const result = getTopReferencedAssets(decisions, assets, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.reference_count).toBe(1);
  });

  it('tiebreaker: equal counts sorted ascending by title', () => {
    const assets = [
      makeAsset({ knowledge_id: 'ka_c', title: 'Charlie' }),
      makeAsset({ knowledge_id: 'ka_a', title: 'Alpha' }),
      makeAsset({ knowledge_id: 'ka_b', title: 'Bravo' }),
    ];
    const decisions = [
      makeDecision({ case_id: 'case_1', refs: ['ka_a'] }),
      makeDecision({ case_id: 'case_2', refs: ['ka_b'] }),
      makeDecision({ case_id: 'case_3', refs: ['ka_c'] }),
    ];
    const result = getTopReferencedAssets(decisions, assets, null);
    expect(result.map((r) => r.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('silently excludes orphan refs (asset ID not in knowledgeAssets)', () => {
    const assets = [makeAsset({ knowledge_id: 'ka_1', title: 'Real' })];
    const decisions = [
      makeDecision({ case_id: 'case_1', refs: ['ka_1', 'ka_ghost'] }),
      makeDecision({ case_id: 'case_2', refs: ['ka_ghost_2'] }),
    ];
    const result = getTopReferencedAssets(decisions, assets, null);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ knowledge_id: 'ka_1', reference_count: 1 });
  });

  it('slices to top 5', () => {
    const assets = Array.from({ length: 8 }, (_, i) =>
      makeAsset({ knowledge_id: `ka_${i}`, title: `Asset${i}` }),
    );
    // Give each asset a distinct case count: ka_0 → 8, ka_1 → 7, ..., ka_7 → 1
    const decisions: Decision[] = [];
    for (let i = 0; i < 8; i++) {
      for (let c = 0; c < 8 - i; c++) {
        decisions.push(makeDecision({ case_id: `case_${i}_${c}`, refs: [`ka_${i}`] }));
      }
    }
    const result = getTopReferencedAssets(decisions, assets, null);
    expect(result).toHaveLength(5);
    expect(result.map((r) => r.knowledge_id)).toEqual(['ka_0', 'ka_1', 'ka_2', 'ka_3', 'ka_4']);
    expect(result.map((r) => r.reference_count)).toEqual([8, 7, 6, 5, 4]);
  });

  describe('time window', () => {
    const NOW = new Date('2026-04-10T12:00:00.000Z');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('excludes decisions older than validDays', () => {
      const assets = [
        makeAsset({ knowledge_id: 'ka_recent', title: 'Recent' }),
        makeAsset({ knowledge_id: 'ka_old', title: 'Old' }),
      ];
      const decisions = [
        makeDecision({
          case_id: 'case_recent',
          refs: ['ka_recent'],
          created_at: '2026-04-08T00:00:00.000Z', // 2 days ago
        }),
        makeDecision({
          case_id: 'case_old',
          refs: ['ka_old'],
          created_at: '2026-01-01T00:00:00.000Z', // ~99 days ago
        }),
      ];
      // 7-day window: only the recent decision counts
      const result = getTopReferencedAssets(decisions, assets, 7);
      expect(result).toHaveLength(1);
      expect(result[0]?.knowledge_id).toBe('ka_recent');
    });

    it('validDays=null includes all decisions', () => {
      const assets = [
        makeAsset({ knowledge_id: 'ka_recent', title: 'Recent' }),
        makeAsset({ knowledge_id: 'ka_old', title: 'Old' }),
      ];
      const decisions = [
        makeDecision({
          case_id: 'case_recent',
          refs: ['ka_recent'],
          created_at: '2026-04-08T00:00:00.000Z',
        }),
        makeDecision({
          case_id: 'case_old',
          refs: ['ka_old'],
          created_at: '2022-01-01T00:00:00.000Z',
        }),
      ];
      const result = getTopReferencedAssets(decisions, assets, null);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.knowledge_id).sort()).toEqual(['ka_old', 'ka_recent']);
    });
  });
});

describe('aggregateObservatory approval_rate', () => {
  it('treats done cases as approved outcomes and rejected cases as negative outcomes', () => {
    const cases = [
      ...Array.from({ length: 83 }, (_, i) => makeCase({
        case_id: `case_done_${i}`,
        status: 'done',
      })),
      ...Array.from({ length: 17 }, (_, i) => makeCase({
        case_id: `case_rejected_${i}`,
        status: 'rejected',
      })),
    ];

    const result = aggregateObservatory(cases, [], [], [], [], [], [], [], null);

    expect(result.summary.approval_rate).toBe(83);
  });

  it('counts currently approved cases as approved outcomes too', () => {
    const cases = [
      makeCase({ case_id: 'case_approved', status: 'approved' }),
      makeCase({ case_id: 'case_done', status: 'done' }),
      makeCase({ case_id: 'case_rejected', status: 'rejected' }),
    ];

    const result = aggregateObservatory(cases, [], [], [], [], [], [], [], null);

    expect(result.summary.approval_rate).toBe(67);
  });
});

// #676: repo/project pills must receive the terminal-case denominator
// (decided_count), not total_cases, so a row with cases but zero decisions
// reads neutral instead of alarm-red.
describe('aggregateObservatory decided_count (#676)', () => {
  it('top_repositories: repo with cases but zero decided → decided_count: 0', () => {
    const cases = [
      makeCase({ case_id: 'case_1', repository_id: 'repo_1', status: 'in_review' }),
      makeCase({ case_id: 'case_2', repository_id: 'repo_1', status: 'exploration' }),
      makeCase({ case_id: 'case_3', repository_id: 'repo_1', status: 'needs_human_decision' }),
    ];
    const repositories = [makeRepository({ repository_id: 'repo_1' })];
    const projects = [makeProject({ project_id: 'proj_1' })];

    const result = aggregateObservatory(cases, [], [], [], [], [], projects, repositories, null);

    expect(result.top_repositories).toHaveLength(1);
    expect(result.top_repositories[0]).toMatchObject({
      repository_id: 'repo_1',
      total_cases: 3,
      decided_count: 0,
      approval_rate: 0,
    });
  });

  it('top_repositories: mixed rows → correct decided_count per repo', () => {
    const cases = [
      // repo_1: 2 decided (done) + 1 undecided (in_review)
      makeCase({ case_id: 'case_1', repository_id: 'repo_1', status: 'done' }),
      makeCase({ case_id: 'case_2', repository_id: 'repo_1', status: 'done' }),
      makeCase({ case_id: 'case_3', repository_id: 'repo_1', status: 'in_review' }),
      // repo_2: 1 decided (rejected) + 2 undecided (exploration)
      makeCase({ case_id: 'case_4', repository_id: 'repo_2', status: 'rejected' }),
      makeCase({ case_id: 'case_5', repository_id: 'repo_2', status: 'exploration' }),
      makeCase({ case_id: 'case_6', repository_id: 'repo_2', status: 'exploration' }),
    ];
    const repositories = [
      makeRepository({ repository_id: 'repo_1' }),
      makeRepository({ repository_id: 'repo_2' }),
    ];
    const projects = [makeProject({ project_id: 'proj_1' })];

    const result = aggregateObservatory(cases, [], [], [], [], [], projects, repositories, null);

    const repo1 = result.top_repositories.find((r) => r.repository_id === 'repo_1');
    const repo2 = result.top_repositories.find((r) => r.repository_id === 'repo_2');
    expect(repo1).toMatchObject({ total_cases: 3, decided_count: 2 });
    expect(repo2).toMatchObject({ total_cases: 3, decided_count: 1 });
  });

  it('top_projects: project with cases but zero decided → decided_count: 0', () => {
    const cases = [
      makeCase({ case_id: 'case_1', project_id: 'proj_1', status: 'in_build' }),
      makeCase({ case_id: 'case_2', project_id: 'proj_1', status: 'verification_pending' }),
    ];
    const projects = [makeProject({ project_id: 'proj_1' })];

    const result = aggregateObservatory(cases, [], [], [], [], [], projects, [], null);

    expect(result.top_projects).toHaveLength(1);
    expect(result.top_projects[0]).toMatchObject({
      project_id: 'proj_1',
      total_cases: 2,
      decided_count: 0,
      approval_rate: 0,
    });
  });

  it('top_projects: mixed rows → correct decided_count per project', () => {
    const cases = [
      // proj_1: 1 decided (approved) + 1 undecided (open)
      makeCase({ case_id: 'case_1', project_id: 'proj_1', status: 'approved' }),
      makeCase({ case_id: 'case_2', project_id: 'proj_1', status: 'open' }),
      // proj_2: 3 decided (done) + 0 undecided
      makeCase({ case_id: 'case_3', project_id: 'proj_2', status: 'done' }),
      makeCase({ case_id: 'case_4', project_id: 'proj_2', status: 'done' }),
      makeCase({ case_id: 'case_5', project_id: 'proj_2', status: 'done' }),
    ];
    const projects = [
      makeProject({ project_id: 'proj_1' }),
      makeProject({ project_id: 'proj_2' }),
    ];

    const result = aggregateObservatory(cases, [], [], [], [], [], projects, [], null);

    const proj1 = result.top_projects.find((p) => p.project_id === 'proj_1');
    const proj2 = result.top_projects.find((p) => p.project_id === 'proj_2');
    expect(proj1).toMatchObject({ total_cases: 2, decided_count: 1 });
    expect(proj2).toMatchObject({ total_cases: 3, decided_count: 3 });
  });
});
