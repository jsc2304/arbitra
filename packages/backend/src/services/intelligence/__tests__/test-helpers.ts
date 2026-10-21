import type { Case, CaseEvent, Decision, DecisionSnapshot, Project, Repository } from '@arbitra/shared';
import type { DetectorContext } from '../detector-types.js';

const snapshot: DecisionSnapshot = {
  active_rule_set_versions: {},
  evidence_policy_version: 1,
  knowledge_asset_refs: [],
};

export function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Example case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    decision_id: 'dec_' + Math.random().toString(36).slice(2, 8),
    case_id: 'case_1',
    type: 'approve',
    actor_id: 'usr_reviewer',
    rationale: '',
    snapshot,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    event_id: 'evt_' + Math.random().toString(36).slice(2, 8),
    case_id: 'case_1',
    type: 'case_created',
    actor_id: 'usr_owner',
    payload: {},
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    repository_id: 'repo_1',
    project_id: 'proj_1',
    name: 'example',
    url: 'https://example.com/org/example',
    provider: 'github',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'proj_1',
    name: 'Example',
    description: '',
    reviewer_pool: [],
    tech_leads: [],
    default_rule_set_refs: [],
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

export interface StubContextOptions {
  now?: Date;
  cases?: Case[];
  latestActivity?: Record<string, string>;
  latestStatusTransitions?: Record<string, Partial<Record<Case['status'], string>>>;
  requestChangesCounts?: Record<string, number>;
  decisionsByCase?: Record<string, Decision[]>;
  eventsByCase?: Record<string, CaseEvent[]>;
  repositories?: Repository[];
  projects?: Project[];
  existingSignatures?: Iterable<string>;
  remoteBranches?: (repo: Repository) => { name: string; last_commit_at: string }[] | undefined;
}

/**
 * Lightweight in-memory DetectorContext used by every detector unit test.
 * Keeps the tests pure and deterministic — no firebase-admin import path.
 */
export function makeStubContext(opts: StubContextOptions = {}): DetectorContext {
  const cases = opts.cases ?? [];
  const nonTerminal = cases.filter((c) => c.status !== 'done' && c.status !== 'rejected');

  async function* streamNonTerminal() {
    for (const c of nonTerminal) yield c;
  }
  async function* streamAll() {
    for (const c of cases) yield c;
  }

  return {
    now: opts.now ?? new Date('2026-04-19T00:00:00.000Z'),
    listNonTerminalCases: () => streamNonTerminal(),
    listAllCases: () => streamAll(),
    getLatestActivityAt: async (id) => opts.latestActivity?.[id],
    getLatestStatusTransitionAt: async (id, status) => opts.latestStatusTransitions?.[id]?.[status],
    countRequestChanges: async (id) => opts.requestChangesCounts?.[id] ?? 0,
    getEventsForCase: async (id) => opts.eventsByCase?.[id] ?? [],
    getDecisionsForCase: async (id) => opts.decisionsByCase?.[id] ?? [],
    listRepositories: async () => opts.repositories ?? [],
    listProjects: async () => opts.projects ?? [],
    getExistingSignatures: async () => new Set(opts.existingSignatures ?? []),
    ...(opts.remoteBranches ? { listRemoteBranches: async (repo: Repository) => opts.remoteBranches!(repo) } : {}),
  };
}
