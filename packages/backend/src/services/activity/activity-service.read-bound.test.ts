/**
 * Read-path tests for `listActivity`'s Firestore-side since/before bounding
 * (see the docblock above `listActivity` in `activity-service.ts`). Each
 * test drives a counting in-memory fake of `collections` so assertions can
 * be made on *how many documents were actually read*, not just on the
 * entries returned — that's the whole point of the rewrite this file guards.
 *
 * Mock shape: a per-collection in-memory doc store behind a chainable query
 * fake (`where`/`orderBy`/`limit`/`get`) that records, per collection,
 * `getCalls` (number of `.get()` invocations), `docsRead` (documents
 * actually returned, summed across every `.get()`), and `whereCalls` (every
 * `.where(field, op, value)` applied — a `FieldPath` field is recorded as
 * `'__name__'`, matching how a real `documentId()` filter reads).
 * `activeCases()` pre-filters `deleted_at === null`; `cases()` is
 * unfiltered (unused by `listActivity`, kept for parity with the real
 * `collections` surface).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldPath } from 'firebase-admin/firestore';

type Row = Record<string, any>;

interface WhereCall {
  field: string;
  op: string;
  value: unknown;
}

interface CollectionStats {
  getCalls: number;
  docsRead: number;
  whereCalls: WhereCall[];
  /** Every `.limit(n)` value applied to a query on this collection, in call order. */
  limitCalls: number[];
}

function freshStats(): CollectionStats {
  return { getCalls: 0, docsRead: 0, whereCalls: [], limitCalls: [] };
}

interface FakeQuery {
  where(field: string | FieldPath, op: string, value: unknown): FakeQuery;
  orderBy(field: string, dir?: 'asc' | 'desc'): FakeQuery;
  limit(n: number): FakeQuery;
  get(): Promise<{ docs: { id: string; data: () => Row }[] }>;
}

/** Builds a chainable query fake over `rows`, recording reads into `stats`. */
function makeFakeCollection(
  rows: Row[],
  idKey: string,
  stats: CollectionStats,
  baseFilter?: (row: Row) => boolean,
): FakeQuery {
  function build(
    filters: { field: string | FieldPath; op: string; value: unknown }[],
    order: { field: string; dir: 'asc' | 'desc' } | undefined,
    limitN: number | undefined,
  ): FakeQuery {
    return {
      where(field, op, value) {
        stats.whereCalls.push({
          field: field instanceof FieldPath ? '__name__' : field,
          op,
          value,
        });
        return build([...filters, { field, op, value }], order, limitN);
      },
      orderBy(field, dir = 'asc') {
        return build(filters, { field, dir }, limitN);
      },
      limit(n) {
        stats.limitCalls.push(n);
        return build(filters, order, n);
      },
      async get() {
        stats.getCalls += 1;
        let result = baseFilter ? rows.filter(baseFilter) : rows.slice();
        for (const f of filters) {
          const isDocId = f.field instanceof FieldPath;
          result = result.filter((row) => {
            const actual = isDocId ? row[idKey] : row[f.field as string];
            switch (f.op) {
              case '>': return actual > (f.value as string);
              case '>=': return actual >= (f.value as string);
              case '<': return actual < (f.value as string);
              case '==': return actual === f.value;
              case 'in': return (f.value as unknown[]).includes(actual);
              default: throw new Error(`fake collection: unsupported where op '${f.op}'`);
            }
          });
        }
        if (order) {
          const dir = order.dir === 'desc' ? -1 : 1;
          const field = order.field;
          result = [...result].sort((a, b) => {
            if (a[field] === b[field]) return 0;
            return a[field] < b[field] ? -1 * dir : 1 * dir;
          });
        }
        if (limitN !== undefined) result = result.slice(0, limitN);
        stats.docsRead += result.length;
        return { docs: result.map((row) => ({ id: row[idKey], data: () => row })) };
      },
    };
  }
  return build([], undefined, undefined);
}

interface World {
  cases: Row[];
  projects: Row[];
  caseEvents: Row[];
  comments: Row[];
  evidence: Row[];
  decisions: Row[];
  findings: Row[];
  workspaceEvents: Row[];
  dismissals: Row[];
  stats: {
    cases: CollectionStats;
    projects: CollectionStats;
    caseEvents: CollectionStats;
    comments: CollectionStats;
    evidence: CollectionStats;
    decisions: CollectionStats;
    findings: CollectionStats;
    workspaceEvents: CollectionStats;
    dismissals: CollectionStats;
  };
}

function createWorld(): World {
  return {
    cases: [],
    projects: [],
    caseEvents: [],
    comments: [],
    evidence: [],
    decisions: [],
    findings: [],
    workspaceEvents: [],
    dismissals: [],
    stats: {
      cases: freshStats(),
      projects: freshStats(),
      caseEvents: freshStats(),
      comments: freshStats(),
      evidence: freshStats(),
      decisions: freshStats(),
      findings: freshStats(),
      workspaceEvents: freshStats(),
      dismissals: freshStats(),
    },
  };
}

// `world` is read lazily inside the mocked `collections` methods below, so
// it's safe for those closures to be created before `beforeEach` assigns it
// — vi.hoisted keeps this binding stable across the vi.mock hoist.
const h = vi.hoisted(() => ({ world: undefined as unknown as World }));

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => makeFakeCollection(h.world.cases, 'case_id', h.world.stats.cases),
    activeCases: () =>
      makeFakeCollection(h.world.cases, 'case_id', h.world.stats.cases, (r) => r['deleted_at'] == null),
    projects: () => makeFakeCollection(h.world.projects, 'project_id', h.world.stats.projects),
    caseEvents: () => makeFakeCollection(h.world.caseEvents, 'event_id', h.world.stats.caseEvents),
    comments: () => makeFakeCollection(h.world.comments, 'comment_id', h.world.stats.comments),
    evidence: () => makeFakeCollection(h.world.evidence, 'evidence_id', h.world.stats.evidence),
    decisions: () => makeFakeCollection(h.world.decisions, 'decision_id', h.world.stats.decisions),
    findings: () => makeFakeCollection(h.world.findings, 'finding_id', h.world.stats.findings),
    workspaceEvents: () =>
      makeFakeCollection(h.world.workspaceEvents, 'event_id', h.world.stats.workspaceEvents),
    workspaceEventDismissals: () =>
      makeFakeCollection(h.world.dismissals, 'event_id', h.world.stats.dismissals),
  },
}));

vi.mock('../../lib/project-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/project-access.js')>();
  return {
    ...actual,
    getAccessibleProjectIds: vi.fn(async () => 'all'),
  };
});

import { listActivity, buildLeaderboard } from './activity-service.js';
import { getAccessibleProjectIds } from '../../lib/project-access.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINCE = '2026-05-01T00:00:00.000Z';
const OLD_TS = '2026-04-15T00:00:00.000Z'; // strictly before SINCE
const NEW_TS = '2026-05-02T00:00:00.000Z'; // strictly after SINCE

const FEED_COLLECTION_KEYS = [
  'caseEvents', 'comments', 'evidence', 'decisions', 'findings', 'workspaceEvents',
] as const;
type FeedKey = (typeof FEED_COLLECTION_KEYS)[number];
const FIELD_BY_COLLECTION: Record<FeedKey, string> = {
  caseEvents: 'created_at',
  comments: 'created_at',
  evidence: 'created_at',
  decisions: 'created_at',
  findings: 'created_at',
  workspaceEvents: 'timestamp',
};
const ALL_STAT_KEYS = [...FEED_COLLECTION_KEYS, 'cases', 'projects'] as const;

function projectIdForCaseIndex(n: number): string {
  return `p${((n - 1) % 5) + 1}`;
}

function makeCase(overrides: Partial<Row> = {}): Row {
  return {
    case_id: 'case_x',
    title: `Case ${overrides['case_id'] ?? 'x'}`,
    description: '',
    project_id: 'p1',
    owner_user_id: 'usr_owner',
    status: 'open',
    risk_level: 'low',
    validation_track: 'direct',
    case_type: 'bugfix',
    current_branch: 'feat/x',
    evidence_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    created_at: OLD_TS,
    updated_at: OLD_TS,
    deleted_at: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Row> = {}): Row {
  return {
    project_id: 'p1',
    name: 'Project',
    description: '',
    reviewer_pool: [],
    tech_leads: [],
    members: [],
    default_rule_set_refs: [],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Row> = {}): Row {
  return {
    event_id: 'evt_1',
    case_id: 'case_x',
    type: 'status_changed',
    actor_id: 'usr_1',
    payload: {},
    created_at: OLD_TS,
    ...overrides,
  };
}

function makeComment(overrides: Partial<Row> = {}): Row {
  return {
    comment_id: 'cmt_1',
    parent_type: 'case',
    parent_id: 'case_x',
    author_id: 'usr_1',
    body: 'hi',
    created_at: OLD_TS,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<Row> = {}): Row {
  return {
    evidence_id: 'ev_1',
    case_id: 'case_x',
    type: 'ci_result',
    source_type: 'agent',
    machine_readable: true,
    validation_track: 'direct',
    created_at: OLD_TS,
    created_by: 'usr_1',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Row> = {}): Row {
  return {
    decision_id: 'dec_1',
    case_id: 'case_x',
    type: 'approve',
    actor_id: 'usr_1',
    rationale: '',
    snapshot: { active_rule_set_versions: {}, evidence_policy_version: 1, knowledge_asset_refs: [] },
    created_at: OLD_TS,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Row> = {}): Row {
  return {
    finding_id: 'fnd_1',
    case_id: 'case_x',
    category: 'bug',
    severity: 'medium',
    confidence: 0.5,
    status: 'open',
    title: 'A finding',
    description: '',
    origin_type: 'reviewer',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    created_at: OLD_TS,
    updated_at: OLD_TS,
    ...overrides,
  };
}

function makeWorkspaceEvent(overrides: Partial<Row> = {}): Row {
  return {
    event_id: 'we_1',
    type: 'intelligence_run',
    actor_user_id: 'system:arbitra-intelligence',
    timestamp: OLD_TS,
    summary: 'a run',
    ...overrides,
  };
}

/** 300 active cases round-robin across p1..p5, plus 1 soft-deleted case. */
function seedCasesAndProjects(world: World) {
  for (let n = 1; n <= 5; n++) {
    world.projects.push(makeProject({
      project_id: `p${n}`,
      name: `Project ${n}`,
      // p1's only member is bob — see test C.
      members: n === 1 ? ['bob'] : [],
    }));
  }
  for (let n = 1; n <= 300; n++) {
    world.cases.push(makeCase({
      case_id: `c${n}`,
      title: `Case ${n}`,
      project_id: projectIdForCaseIndex(n),
    }));
  }
  world.cases.push(makeCase({
    case_id: 'c_deleted',
    title: 'Deleted case',
    project_id: 'p1',
    deleted_at: '2026-04-01T00:00:00.000Z',
  }));
}

/** 100 real, OLDER-than-SINCE docs per feed collection, referencing the case
 *  pool round-robin — present so the "0 reads" assertions below are proving
 *  something (there IS data an unbounded query would have read). */
function seedOldFeedBaseline(world: World, count: number) {
  for (let i = 0; i < count; i++) {
    const caseId = `c${(i % 300) + 1}`;
    world.caseEvents.push(makeEvent({ event_id: `evt_old_${i}`, case_id: caseId, created_at: OLD_TS }));
    world.comments.push(makeComment({ comment_id: `cmt_old_${i}`, parent_type: 'case', parent_id: caseId, created_at: OLD_TS }));
    world.evidence.push(makeEvidence({ evidence_id: `evd_old_${i}`, case_id: caseId, created_at: OLD_TS }));
    world.decisions.push(makeDecision({ decision_id: `dec_old_${i}`, case_id: caseId, created_at: OLD_TS }));
    world.findings.push(makeFinding({ finding_id: `fnd_old_${i}`, case_id: caseId, created_at: OLD_TS }));
    world.workspaceEvents.push(makeWorkspaceEvent({ event_id: `we_old_${i}`, timestamp: OLD_TS }));
  }
}

beforeEach(() => {
  h.world = createWorld();
  seedCasesAndProjects(h.world);
  (getAccessibleProjectIds as unknown as ReturnType<typeof vi.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// A. Idle since-tick
// ---------------------------------------------------------------------------

describe('listActivity — since-bounded reads', () => {
  it(
    'idle since-tick makes zero further reads once the six feed queries come back empty '
    + '(pre-fix: activity-service.ts:573 `if (cursor.since) q = q.where(field, \'>\', cursor.since)` — '
    + 'remove it and each feedQuery falls back to an unbounded page, so every docsRead===0 assertion below fails at 100)',
    async () => {
      seedOldFeedBaseline(h.world, 100);

      const result = await listActivity('admin_user', true, { limit: 50, since: SINCE });

      expect(result).toEqual({ entries: [], cursor: null });

      for (const key of FEED_COLLECTION_KEYS) {
        expect(h.world.stats[key].docsRead).toBe(0);
        const sinceWhere = h.world.stats[key].whereCalls.find((w) => w.op === '>' && w.value === SINCE);
        expect(sinceWhere).toBeDefined();
        expect(sinceWhere?.field).toBe(FIELD_BY_COLLECTION[key]);
      }

      // Reverting the on-demand case resolution back to an unconditional
      // `collections.activeCases().get()` would make this 1 / 300.
      expect(h.world.stats.cases.getCalls).toBe(0);
      expect(h.world.stats.cases.docsRead).toBe(0);
      expect(h.world.stats.projects.getCalls).toBe(0);
      expect(h.world.stats.projects.docsRead).toBe(0);
    },
  );

  // -------------------------------------------------------------------------
  // B. Active since-tick
  // -------------------------------------------------------------------------

  it(
    'active since-tick resolves only the cases/findings/projects the two new rows reference '
    + '(pre-fix: activity-service.ts:672 `if (missingFindingIds.length > 0)` — remove the on-demand '
    + 'finding lookup and the comment on f_old silently drops instead of resolving to case c9)',
    async () => {
      seedOldFeedBaseline(h.world, 100);
      // f_old is older than SINCE, so the bounded findings feed query won't
      // return it — the comment below can only resolve to case c9 via the
      // on-demand id lookup.
      h.world.findings.push(makeFinding({ finding_id: 'f_old', case_id: 'c9', created_at: OLD_TS }));

      h.world.caseEvents.push(makeEvent({ event_id: 'evt_new', case_id: 'c7', created_at: NEW_TS }));
      h.world.comments.push(makeComment({
        comment_id: 'cmt_new', parent_type: 'finding', parent_id: 'f_old', created_at: NEW_TS,
      }));

      const result = await listActivity('admin_user', true, { limit: 50, since: SINCE });

      expect(result.entries.map((e) => e.id).sort()).toEqual(['comment:cmt_new', 'event:evt_new']);
      for (const entry of result.entries) {
        expect(entry.case_title).toBeTruthy();
        expect(entry.project_name).toBeTruthy();
      }

      // c7 -> p2, c9 -> p4 (round-robin over 5 projects) — 2 distinct cases,
      // 2 distinct projects.
      expect(h.world.stats.cases.docsRead).toBe(2);
      expect(h.world.stats.findings.docsRead).toBe(1);
      expect(h.world.stats.projects.docsRead).toBe(2);

      const totalDocsRead = ALL_STAT_KEYS.reduce((sum, key) => sum + h.world.stats[key].docsRead, 0);
      expect(totalDocsRead).toBeLessThan(20);
    },
  );

  // -------------------------------------------------------------------------
  // C. Access semantics preserved for non-admin viewers
  // -------------------------------------------------------------------------

  it(
    'non-admin access is computed from resolved project docs, not a full-workspace scan '
    + '(pre-fix: activity-service.ts:733 `isEffectiveMember(project, userId)` — replace this branch with '
    + 'the old `getAccessibleProjectIds(userId, false)` call and this test\'s "not called" assertion fails)',
    async () => {
      h.world.caseEvents.push(makeEvent({ event_id: 'evt_p1', case_id: 'c1', created_at: NEW_TS }));
      h.world.caseEvents.push(makeEvent({ event_id: 'evt_p2', case_id: 'c2', created_at: NEW_TS }));
      h.world.caseEvents.push(makeEvent({ event_id: 'evt_deleted', case_id: 'c_deleted', created_at: NEW_TS }));

      // bob is a member of p1 (c1) only — not p2 (c2), and c_deleted is
      // soft-deleted so it's never even resolved by activeCases().
      const result = await listActivity('bob', false, { limit: 50, since: SINCE });

      expect(result.entries.map((e) => e.id)).toEqual(['event:evt_p1']);
      expect(result.entries[0]?.project_id).toBe('p1');
      expect(getAccessibleProjectIds).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // D. projectId filter (existing behavior, preserved)
  // -------------------------------------------------------------------------

  it(
    'projectId filter scopes cases to that project and excludes workspace events '
    + '(pre-fix: activity-service.ts:738 `cases = cases.filter((c) => c.project_id === options.projectId)` — '
    + 'remove it and evt_d_p1 leaks into the p2-filtered result)',
    async () => {
      h.world.caseEvents.push(makeEvent({ event_id: 'evt_d_p1', case_id: 'c1', created_at: NEW_TS }));
      h.world.caseEvents.push(makeEvent({ event_id: 'evt_d_p2', case_id: 'c2', created_at: NEW_TS }));
      h.world.workspaceEvents.push(makeWorkspaceEvent({ event_id: 'we_new', timestamp: NEW_TS }));

      const result = await listActivity('admin_user', true, { limit: 50, since: SINCE, projectId: 'p2' });

      expect(result.entries.map((e) => e.id)).toEqual(['event:evt_d_p2']);
      expect(result.entries.every((e) => e.kind !== 'workspace_event')).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // E. Initial load (no since) — bounded by the feed caps, not a full scan
  // -------------------------------------------------------------------------

  it(
    'initial load with no since caps each feed query at its limit and resolves cases by id '
    + '(pre-fix: activity-service.ts:552 `collections.activeCases().get()` — the old unconditional '
    + 'full scan would read 300 cases here instead of the 20 the top page actually references)',
    async () => {
      const base = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
      for (let i = 0; i < 700; i++) {
        const caseId = `c${(i % 20) + 1}`;
        h.world.caseEvents.push(makeEvent({
          event_id: `evt_init_${i}`,
          case_id: caseId,
          created_at: new Date(base + i * 1000).toISOString(),
        }));
      }

      const result = await listActivity('admin_user', true, { limit: 50 });

      expect(result.entries.length).toBe(50);
      // Bounded at limit*2 = 100, not the full 700 seeded.
      expect(h.world.stats.caseEvents.docsRead).toBe(100);
      // The top 100 (most recent) events cycle through case ids c1..c20 five
      // full times, so exactly 20 distinct cases are referenced — not 300.
      expect(h.world.stats.cases.docsRead).toBe(20);
      // c1..c20 round-robin over 5 projects touches every project once.
      expect(h.world.stats.projects.docsRead).toBe(5);
      expect(h.world.stats.comments.docsRead).toBe(0);
      expect(h.world.stats.evidence.docsRead).toBe(0);
      expect(h.world.stats.decisions.docsRead).toBe(0);
      expect(h.world.stats.findings.docsRead).toBe(0);
      expect(h.world.stats.workspaceEvents.docsRead).toBe(0);
    },
  );

  // -------------------------------------------------------------------------
  // F. before cursor bounds in Firestore too
  // -------------------------------------------------------------------------

  it(
    '`before` bounds every feed query in Firestore, not just in memory '
    + '(pre-fix: activity-service.ts:574 `if (cursor.before) q = q.where(field, \'<\', cursor.before)` — '
    + 'remove it and no feed collection records a \'<\' where call, failing every whereClause assertion below)',
    async () => {
      const BEFORE = '2026-04-15T00:00:00.000Z';
      const OLD = '2026-04-10T00:00:00.000Z';
      const NEW = '2026-04-20T00:00:00.000Z';

      h.world.caseEvents.push(makeEvent({ event_id: 'ev_old', case_id: 'c1', created_at: OLD }));
      h.world.caseEvents.push(makeEvent({ event_id: 'ev_new', case_id: 'c1', created_at: NEW }));
      h.world.comments.push(makeComment({ comment_id: 'cm_old', parent_type: 'case', parent_id: 'c1', created_at: OLD }));
      h.world.comments.push(makeComment({ comment_id: 'cm_new', parent_type: 'case', parent_id: 'c1', created_at: NEW }));
      h.world.evidence.push(makeEvidence({ evidence_id: 'ev2_old', case_id: 'c1', created_at: OLD }));
      h.world.evidence.push(makeEvidence({ evidence_id: 'ev2_new', case_id: 'c1', created_at: NEW }));
      h.world.decisions.push(makeDecision({ decision_id: 'de_old', case_id: 'c1', created_at: OLD }));
      h.world.decisions.push(makeDecision({ decision_id: 'de_new', case_id: 'c1', created_at: NEW }));
      h.world.findings.push(makeFinding({ finding_id: 'fi_old', case_id: 'c1', created_at: OLD }));
      h.world.findings.push(makeFinding({ finding_id: 'fi_new', case_id: 'c1', created_at: NEW }));
      h.world.workspaceEvents.push(makeWorkspaceEvent({ event_id: 'we_old', timestamp: OLD }));
      h.world.workspaceEvents.push(makeWorkspaceEvent({ event_id: 'we_new', timestamp: NEW }));

      const result = await listActivity('admin_user', true, { limit: 50, before: BEFORE });

      for (const key of FEED_COLLECTION_KEYS) {
        const whereClause = h.world.stats[key].whereCalls.find((w) => w.op === '<' && w.value === BEFORE);
        expect(whereClause).toBeDefined();
        expect(whereClause?.field).toBe(FIELD_BY_COLLECTION[key]);
      }

      expect(result.entries.length).toBeGreaterThan(0);
      for (const entry of result.entries) {
        expect(entry.timestamp < BEFORE).toBe(true);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// G. buildLeaderboard — same fix shape, own describe block
// ---------------------------------------------------------------------------

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// Comfortably inside the 24h window used below, with enough margin that the
// few ms between this computation and `cutoffFor('24h')`'s own `Date.now()`
// call can't matter. `seedOldFeedBaseline`'s fixed `OLD_TS` (2026-04-15,
// months before this test runs) already covers "comfortably outside".
const LB_INSIDE_WINDOW = isoHoursAgo(1); // 1 hour ago

describe('buildLeaderboard — bounded reads', () => {
  it(
    'idle window makes zero further reads once the six windowed scans come back empty, '
    + 'and each windowed scan is capped at LEADERBOARD_SCAN_LIMIT '
    + '(pre-fix: activity-service.ts `const caseSnaps = caseIds.size > 0 ? ... : [];` — '
    + 'replace with the old unconditional `await collections.activeCases().get()` and '
    + 'cases.getCalls/docsRead go from 0 to 1/300; pre-fix for the limit half: remove '
    + '`.limit(LEADERBOARD_SCAN_LIMIT)` from a windowed query and its `limitCalls` goes empty)',
    async () => {
      // 100 real, well-outside-the-window docs per feed collection — present
      // so the "0 reads" assertions below are proving something.
      seedOldFeedBaseline(h.world, 100);

      const result = await buildLeaderboard('admin_user', true, '24h');

      expect(result).toEqual({ rows: [], project_rows: [] });

      expect(h.world.stats.caseEvents.docsRead).toBe(0);
      expect(h.world.stats.comments.docsRead).toBe(0);
      expect(h.world.stats.evidence.docsRead).toBe(0);
      expect(h.world.stats.findings.docsRead).toBe(0);
      expect(h.world.stats.decisions.docsRead).toBe(0);
      expect(h.world.stats.workspaceEvents.docsRead).toBe(0);

      // Reverting the on-demand case/project resolution back to an
      // unconditional full scan would make these 300 / 5 instead of 0 / 0.
      expect(h.world.stats.cases.getCalls).toBe(0);
      expect(h.world.stats.cases.docsRead).toBe(0);
      expect(h.world.stats.projects.getCalls).toBe(0);
      expect(h.world.stats.projects.docsRead).toBe(0);

      // Every windowed scan is capped, not just filtered.
      expect(h.world.stats.caseEvents.limitCalls).toEqual([5000]);
      expect(h.world.stats.comments.limitCalls).toEqual([5000]);
      expect(h.world.stats.evidence.limitCalls).toEqual([5000]);
      expect(h.world.stats.findings.limitCalls).toEqual([5000]);
      expect(h.world.stats.decisions.limitCalls).toEqual([5000]);
      expect(h.world.stats.workspaceEvents.limitCalls).toEqual([5000]);
    },
  );

  it(
    'active window resolves only the cases/projects the windowed rows reference '
    + '(pre-fix: activity-service.ts `for (const f of findings) caseIds.add(f.case_id);` — '
    + 'delete this line and the finding on c15 stops resolving a case/project, dropping '
    + 'that finding\'s row from the leaderboard and undercounting p5)',
    async () => {
      h.world.caseEvents.push({
        event_id: 'evt_created', case_id: 'c7', type: 'case_created', actor_id: 'usr_1',
        payload: {}, created_at: LB_INSIDE_WINDOW,
      });
      h.world.evidence.push(makeEvidence({ evidence_id: 'evd_new', case_id: 'c9', created_at: LB_INSIDE_WINDOW }));
      h.world.decisions.push(makeDecision({ decision_id: 'dec_new', case_id: 'c12', created_at: LB_INSIDE_WINDOW }));
      h.world.findings.push(makeFinding({ finding_id: 'fnd_new', case_id: 'c15', created_at: LB_INSIDE_WINDOW }));
      h.world.comments.push(makeComment({
        comment_id: 'cmt_new', parent_type: 'case', parent_id: 'c20', created_at: LB_INSIDE_WINDOW,
      }));
      h.world.workspaceEvents.push(makeWorkspaceEvent({ event_id: 'we_new', timestamp: LB_INSIDE_WINDOW }));

      const result = await buildLeaderboard('admin_user', true, '24h');

      // c7 -> p2, c9 -> p4, c12 -> p2, c15 -> p5, c20 -> p5 (round-robin over
      // 5 projects): 5 distinct cases, 3 distinct projects.
      expect(h.world.stats.cases.docsRead).toBe(5);
      expect(h.world.stats.projects.docsRead).toBe(3);

      const totalCounted = result.rows.reduce((sum, r) => sum + r.counts.total, 0);
      expect(totalCounted).toBe(6); // case_created + evidence + decision + finding + comment + workspace_event

      const p5 = result.project_rows.find((p) => p.project_id === 'p5');
      expect(p5?.active_cases).toBe(2); // c15, c20
      expect(p5?.counts.total).toBe(2); // finding + comment
    },
  );

  it(
    'non-admin access is computed from resolved project docs, not a full-workspace scan, '
    + 'and preserves soft-delete semantics '
    + '(pre-fix: activity-service.ts `return project !== undefined && isEffectiveMember(project, userId);` — '
    + 'replace this branch with the old `getAccessibleProjectIds(userId, false)` call and the '
    + '"not called" assertion below fails)',
    async () => {
      h.world.caseEvents.push({
        event_id: 'evt_p1', case_id: 'c1', type: 'case_created', actor_id: 'usr_1',
        payload: {}, created_at: LB_INSIDE_WINDOW,
      });
      h.world.caseEvents.push({
        event_id: 'evt_p2', case_id: 'c2', type: 'case_created', actor_id: 'usr_1',
        payload: {}, created_at: LB_INSIDE_WINDOW,
      });
      h.world.caseEvents.push({
        event_id: 'evt_deleted', case_id: 'c_deleted', type: 'case_created', actor_id: 'usr_1',
        payload: {}, created_at: LB_INSIDE_WINDOW,
      });

      // bob is a member of p1 (c1) only — not p2 (c2), and c_deleted is
      // soft-deleted so it's never resolved by activeCases() even though its
      // id is in the candidate set.
      const result = await buildLeaderboard('bob', false, '24h');

      const totalCounted = result.rows.reduce((sum, r) => sum + r.counts.total, 0);
      expect(totalCounted).toBe(1);
      expect(result.project_rows.map((p) => p.project_id)).toEqual(['p1']);
      expect(getAccessibleProjectIds).not.toHaveBeenCalled();
    },
  );
});
