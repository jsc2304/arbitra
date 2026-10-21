import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Clerk's tools read Arbitra's own data, so the property that matters is not
 * "does it return rows" but "does it return ONLY rows the person who asked may
 * see". The double below therefore models exactly two things:
 *
 *  - the access-relevant collections (projects, users, cases, knowledge,
 *    repositories) with the query operators the reads actually use;
 *  - a write surface that THROWS. A read tool that ever mutated anything would
 *    fail the suite here rather than in production, which is what makes
 *    "read-only" a checked property instead of a comment.
 */

type DocData = Record<string, unknown>;

const store = new Map<string, Map<string, DocData>>();

function collectionStore(name: string): Map<string, DocData> {
  let existing = store.get(name);
  if (!existing) {
    existing = new Map();
    store.set(name, existing);
  }
  return existing;
}

interface Filter {
  field: string;
  op: '==' | 'in' | '>=' | '<=';
  value: unknown;
}

/**
 * Firestore orders and compares strings by byte order. `localeCompare` disagrees
 * (it sorts 'a' before 'B'), and a double that used it would order a page
 * differently from the way the real cursor resumes — hiding exactly the class of
 * paging bug these tests exist to catch.
 */
function compareValues(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function matches(doc: DocData, filters: Filter[]): boolean {
  return filters.every(({ field, op, value }) => {
    const actual = doc[field] ?? null;
    if (op === '==') return actual === (value ?? null);
    if (op === 'in') return (value as unknown[]).includes(actual);
    const cmp = compareValues(String(actual ?? ''), String(value));
    return op === '>=' ? cmp >= 0 : cmp <= 0;
  });
}

/** The document-id sort key, spelled as `FieldPath.documentId()` serialises. */
const DOC_ID_FIELD = '__name__';

interface Order {
  field: string;
  dir: 'asc' | 'desc';
}

interface StoredDoc {
  id: string;
  data: DocData;
}

interface QueryState {
  filters: Filter[];
  orders: Order[];
  max?: number;
  /** Exclusive cursor position on the ordered result, as `startAfter` does. */
  startAfter?: unknown[];
}

/** How many `.get()` calls each collection has served, so a test can pin cost. */
const queryReads: string[] = [];
const documentReads: string[] = [];
/** How many `firestore.getAll(...)` round trips each collection has served. */
const batchReads: string[] = [];

function sortKeyOf(doc: StoredDoc, field: string): string {
  return field === DOC_ID_FIELD ? doc.id : String(doc.data[field] ?? '');
}

function compareByOrders(a: StoredDoc, b: StoredDoc, orders: readonly Order[]): number {
  for (const { field, dir } of orders) {
    const cmp = compareValues(sortKeyOf(a, field), sortKeyOf(b, field));
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

/** Positive when the document lies after the cursor position in the query's order. */
function compareToCursor(
  doc: StoredDoc,
  values: readonly unknown[],
  orders: readonly Order[],
): number {
  for (let i = 0; i < values.length; i += 1) {
    const { field, dir } = orders[i]!;
    const cmp = compareValues(sortKeyOf(doc, field), String(values[i]));
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

class FakeQuery {
  constructor(
    readonly collectionName: string,
    private readonly state: QueryState = { filters: [], orders: [] },
  ) {}

  private with(patch: Partial<QueryState>): FakeQuery {
    return new FakeQuery(this.collectionName, { ...this.state, ...patch });
  }

  where(field: string, op: Filter['op'], value: unknown): FakeQuery {
    return this.with({ filters: [...this.state.filters, { field, op, value }] });
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    if (this.state.startAfter !== undefined) {
      throw new Error('orderBy after startAfter is invalid in Firestore');
    }
    return this.with({ orders: [...this.state.orders, { field, dir }] });
  }

  limit(max: number): FakeQuery {
    return this.with({ max });
  }

  startAfter(...values: unknown[]): FakeQuery {
    if (this.state.orders.length === 0) {
      throw new Error('startAfter without orderBy is invalid in Firestore');
    }
    if (values.length > this.state.orders.length) {
      throw new Error('Too many cursor values for the orderBy constraints of the query');
    }
    return this.with({ startAfter: values });
  }

  async get() {
    const { filters, orders, max, startAfter } = this.state;
    queryReads.push(this.collectionName);
    // `__name__` is the document id, not a stored data field — a `where`
    // filter on it (e.g. `FieldPath.documentId() in [...]`, as the join step
    // of `countCaseTransitionsForRequester` uses) has to be matched against
    // the map key, so it is folded into the data object under that key before
    // `matches` ever sees it.
    let docs: StoredDoc[] = [...collectionStore(this.collectionName).entries()]
      .map(([id, data]) => ({ id, data }))
      .filter(({ id, data }) => matches({ ...data, [DOC_ID_FIELD]: id }, filters));
    if (orders.length > 0) {
      // Firestore appends the document id to every ordering, in the direction of
      // the last explicit sort key — so the order is always total.
      const effective = orders.some((order) => order.field === DOC_ID_FIELD)
        ? orders
        : [...orders, { field: DOC_ID_FIELD, dir: orders[orders.length - 1]!.dir }];
      docs = [...docs].sort((a, b) => compareByOrders(a, b, effective));
      if (startAfter !== undefined) {
        docs = docs.filter((doc) => compareToCursor(doc, startAfter, effective) > 0);
      }
    }
    if (max !== undefined) docs = docs.slice(0, max);
    return {
      empty: docs.length === 0,
      docs: docs.map((doc) => ({ id: doc.id, data: () => doc.data })),
    };
  }

  count() {
    return {
      get: async () => {
        queryReads.push(this.collectionName);
        const docs = [...collectionStore(this.collectionName).entries()]
          .filter(([id, data]) => matches({ ...data, [DOC_ID_FIELD]: id }, this.state.filters));
        return { data: () => ({ count: docs.length }) };
      },
    };
  }
}

/** Reads resolve; every write throws. */
class FakeDocRef {
  constructor(
    readonly collectionName: string,
    readonly id: string,
  ) {}

  async get() {
    documentReads.push(`${this.collectionName}/${this.id}`);
    const data = collectionStore(this.collectionName).get(this.id);
    return { id: this.id, exists: data !== undefined, data: () => data };
  }

  async set(): Promise<never> {
    throw new Error(`A read tool attempted a WRITE: set ${this.collectionName}/${this.id}`);
  }

  async update(): Promise<never> {
    throw new Error(`A read tool attempted a WRITE: update ${this.collectionName}/${this.id}`);
  }

  async create(): Promise<never> {
    throw new Error(`A read tool attempted a WRITE: create ${this.collectionName}/${this.id}`);
  }

  async delete(): Promise<never> {
    throw new Error(`A read tool attempted a WRITE: delete ${this.collectionName}/${this.id}`);
  }
}

/**
 * Stands in for the `Firestore` client a `CollectionReference.firestore`
 * getter exposes — just enough to fake the one method `resolveDisplayNames`
 * uses, `getAll(...refs)`, as a single round trip regardless of how many refs
 * are passed.
 */
class FakeFirestoreHandle {
  constructor(private readonly collectionName: string) {}

  async getAll(...refs: FakeDocRef[]) {
    batchReads.push(this.collectionName);
    return Promise.all(refs.map((ref) => ref.get()));
  }
}

class FakeCollection extends FakeQuery {
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.collectionName, id);
  }

  get firestore(): FakeFirestoreHandle {
    return new FakeFirestoreHandle(this.collectionName);
  }
}

vi.mock('../../lib/firestore.js', () => ({
  getDb: () => {
    throw new Error('A read tool attempted to open a transaction');
  },
  collections: {
    cases: () => new FakeCollection('cases'),
    activeCases: () => new FakeQuery('cases').where('deleted_at', '==', null),
    caseEvents: () => new FakeCollection('case_events'),
    evidence: () => new FakeCollection('evidence'),
    knowledgeAssets: () => new FakeCollection('knowledge_assets'),
    repositories: () => new FakeCollection('repositories'),
    projects: () => new FakeCollection('projects'),
    users: () => new FakeCollection('users'),
  },
}));

const {
  countCaseTransitionsForRequester,
  countCasesForRequester,
  getKnowledgeForRequester,
  readCaseForRequester,
  searchCasesForRequester,
  searchKnowledgeForRequester,
} = await import('./tool-reads.js');
const { resolveAssistantBounds } = await import('./assistant-bounds.js');
const { READ_OUTCOME_KEY } = await import('./tool-outcomes.js');
type ToolReadContext = import('./tool-registry.js').ToolReadContext;

const MEMBER = 'usr_member';
const STRANGER = 'usr_stranger';
const ADMIN = 'usr_admin';

const MINE = 'proj_mine';
const THEIRS = 'proj_theirs';

function ctx(requesterUserId: string): ToolReadContext {
  return { requesterUserId, caseId: 'case-clerk', signal: undefined };
}

/**
 * Follow `next_cursor` the way the tool description tells the model to, and
 * report what actually came back. `maxPages` is a circuit breaker, not an
 * expectation: a cursor that fails to advance would otherwise hang the suite
 * instead of failing it, so a run that hits it is the bug.
 */
async function pageToCompletion(
  call: Record<string, unknown>,
  requester = MEMBER,
  maxPages = 40,
): Promise<{ served: string[]; pages: number; terminated: boolean }> {
  const served: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    const result = (await searchCasesForRequester(
      cursor === null ? call : { ...call, cursor },
      ctx(requester),
    )) as { cases: { case_id: string }[]; has_more: boolean; next_cursor: string | null };
    served.push(...result.cases.map((c) => c.case_id));
    cursor = result.next_cursor;
    if (cursor === null) {
      return { served, pages: pages + 1, terminated: !result.has_more };
    }
  }
  return { served, pages, terminated: false };
}

function seedProject(projectId: string, members: string[], name = projectId): void {
  collectionStore('projects').set(projectId, {
    project_id: projectId,
    name,
    owner_user_id: members[0] ?? 'usr_owner',
    members,
    reviewer_pool: [],
    tech_leads: [],
  });
}

function seedCase(overrides: DocData & { case_id: string }): void {
  collectionStore('cases').set(overrides.case_id as string, {
    title: 'A case',
    description: 'about something',
    status: 'open',
    project_id: MINE,
    repository_id: 'repo_1',
    owner_user_id: MEMBER,
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    decision_ready: false,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  });
}

/** The event a completing case records — the only completion time Arbitra keeps. */
function seedCompletion(caseId: string, createdAt: string): void {
  collectionStore('case_events').set(`evt_done_${caseId}`, {
    event_id: `evt_done_${caseId}`,
    case_id: caseId,
    type: 'case_completed',
    actor_id: MEMBER,
    payload: {},
    created_at: createdAt,
  });
}

/** A `case_completed`/`case_rejected` transition event, for the count-transitions suite. */
function seedTransitionEvent(
  eventId: string,
  caseId: string,
  type: 'case_completed' | 'case_rejected',
  createdAt: string,
): void {
  collectionStore('case_events').set(eventId, {
    event_id: eventId,
    case_id: caseId,
    type,
    actor_id: MEMBER,
    payload: {},
    created_at: createdAt,
  });
}

function seedKnowledge(overrides: DocData & { knowledge_id: string }): void {
  collectionStore('knowledge_assets').set(overrides.knowledge_id as string, {
    type: 'pattern',
    title: 'An asset',
    summary: 'summary',
    body: 'body',
    scope_type: 'project',
    scope_ref: MINE,
    status: 'verified',
    version: 1,
    trust_level: 3,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: MEMBER,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });
}

beforeEach(() => {
  store.clear();
  queryReads.length = 0;
  documentReads.length = 0;
  batchReads.length = 0;
  seedProject(MINE, [MEMBER]);
  seedProject(THEIRS, [STRANGER]);
  collectionStore('users').set(ADMIN, { user_id: ADMIN, roles: ['admin'] });
  collectionStore('users').set(MEMBER, { user_id: MEMBER, roles: [] });
  collectionStore('users').set(STRANGER, { user_id: STRANGER, roles: [] });
});

describe('arbitra_count_cases — exact requester-scoped aggregation', () => {
  it('counts only active cases in projects the requester may see', async () => {
    seedCase({ case_id: 'case-open', status: 'open' });
    seedCase({ case_id: 'case-done', status: 'done' });
    seedCase({ case_id: 'case-deleted', deleted_at: '2026-08-04T00:00:00.000Z' });
    seedCase({ case_id: 'case-theirs', project_id: THEIRS });

    const result = (await countCasesForRequester({}, ctx(MEMBER))) as {
      answered: boolean;
      exact: boolean;
      count: number;
    };

    expect(result).toMatchObject({ answered: true, exact: true, count: 2 });
  });

  it('combines project, status, case type and creation bounds without returning rows', async () => {
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedCase({
      case_id: 'case-match',
      status: 'open',
      case_type: 'bugfix',
      created_at: '2026-08-04T12:00:00.000Z',
    });
    seedCase({
      case_id: 'case-wrong-type',
      status: 'open',
      case_type: 'refactoring',
      created_at: '2026-08-04T12:00:00.000Z',
    });
    seedCase({
      case_id: 'case-wrong-day',
      status: 'open',
      case_type: 'bugfix',
      created_at: '2026-08-03T23:59:59.999Z',
    });

    const result = (await countCasesForRequester({
      project: 'Arbitra Core',
      status: 'open',
      case_type: 'bugfix',
      created_after: '2026-08-04',
      created_before: '2026-08-04',
    }, ctx(MEMBER))) as Record<string, unknown>;

    expect(result).toMatchObject({
      answered: true,
      exact: true,
      count: 1,
      status_filter: 'open',
      case_type_filter: 'bugfix',
      created_after: '2026-08-04T00:00:00.000Z',
      created_before: '2026-08-04T23:59:59.999Z',
      project_filter: { resolved: MINE, name: 'Arbitra Core' },
    });
    expect(JSON.stringify(result)).not.toContain('case-match');
    expect(documentReads).not.toContain(expect.stringMatching(/^cases\//));
  });

  it('returns a complete status map, including zeros, and an exact total', async () => {
    seedCase({ case_id: 'case-open-a', status: 'open' });
    seedCase({ case_id: 'case-open-b', status: 'open' });
    seedCase({ case_id: 'case-done', status: 'done' });

    const result = (await countCasesForRequester(
      { group_by_status: true },
      ctx(MEMBER),
    )) as { count: number; status_counts: Record<string, number> };

    expect(result.count).toBe(3);
    expect(result.status_counts).toMatchObject({ open: 2, done: 1, in_build: 0, rejected: 0 });
    expect(Object.keys(result.status_counts)).toHaveLength(12);
  });

  it('answers zero for no accessible projects and refuses an inaccessible project filter', async () => {
    seedCase({ case_id: 'case-mine' });
    const noScope = (await countCasesForRequester({}, ctx('usr_nobody'))) as {
      answered: boolean;
      count: number;
    };
    const inaccessible = (await countCasesForRequester(
      { project: THEIRS },
      ctx(MEMBER),
    )) as Record<string, unknown>;

    expect(noScope).toMatchObject({ answered: true, count: 0 });
    expect(inaccessible).toMatchObject({
      answered: false,
      exact: false,
      count: null,
      project_filter: { resolved: null, reason: 'no_matching_project' },
    });
  });

  it('refuses a calendar-invalid bound instead of turning it into a zero', async () => {
    const result = (await countCasesForRequester(
      { created_after: '2026-02-31' },
      ctx(MEMBER),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      answered: false,
      exact: false,
      count: null,
      invalid_input: 'created_after',
    });
  });
});

describe('arbitra_count_case_transitions — exact requester-scoped aggregation of terminal events (#807)', () => {
  it('counts completed and rejected transitions together by default, scoped to the requester\'s visible projects', async () => {
    seedCase({ case_id: 'case-done-mine', status: 'done' });
    seedCase({ case_id: 'case-rejected-mine', status: 'rejected' });
    seedCase({ case_id: 'case-done-theirs', status: 'done', project_id: THEIRS });
    seedTransitionEvent('evt-1', 'case-done-mine', 'case_completed', '2026-08-10T09:00:00.000Z');
    seedTransitionEvent('evt-2', 'case-rejected-mine', 'case_rejected', '2026-08-10T10:00:00.000Z');
    seedTransitionEvent('evt-3', 'case-done-theirs', 'case_completed', '2026-08-10T11:00:00.000Z');

    const result = (await countCaseTransitionsForRequester({}, ctx(MEMBER))) as Record<string, unknown>;

    expect(result).toMatchObject({
      answered: true,
      exact: true,
      count: 2,
      outcome: 'any',
      scope: 'requester_projects',
    });
    // Bounded and batched, never a per-case fan-out: the join reads `cases` via
    // one batched `__name__ in [...]` query, never a single-document get.
    expect(documentReads).not.toContain(expect.stringMatching(/^cases\//));
  });

  it("an admin's unscoped count stays a pure aggregation — no case documents are read at all", async () => {
    seedCase({ case_id: 'case-done-mine', status: 'done' });
    seedCase({ case_id: 'case-done-theirs', status: 'done', project_id: THEIRS });
    seedTransitionEvent('evt-1', 'case-done-mine', 'case_completed', '2026-08-10T09:00:00.000Z');
    seedTransitionEvent('evt-2', 'case-done-theirs', 'case_completed', '2026-08-10T10:00:00.000Z');

    const result = (await countCaseTransitionsForRequester({}, ctx(ADMIN))) as Record<string, unknown>;

    expect(result).toMatchObject({ answered: true, count: 2, scope: 'all_projects' });
    expect(queryReads).not.toContain('cases');
    expect(documentReads).not.toContain(expect.stringMatching(/^cases\//));
  });

  it('separates completed from rejected when outcome narrows the query', async () => {
    seedCase({ case_id: 'case-done' });
    seedCase({ case_id: 'case-rejected' });
    seedTransitionEvent('evt-1', 'case-done', 'case_completed', '2026-08-10T09:00:00.000Z');
    seedTransitionEvent('evt-2', 'case-rejected', 'case_rejected', '2026-08-10T10:00:00.000Z');

    const completed = (await countCaseTransitionsForRequester(
      { outcome: 'completed' },
      ctx(MEMBER),
    )) as Record<string, unknown>;
    const rejected = (await countCaseTransitionsForRequester(
      { outcome: 'rejected' },
      ctx(MEMBER),
    )) as Record<string, unknown>;

    expect(completed).toMatchObject({ count: 1, outcome: 'completed' });
    expect(rejected).toMatchObject({ count: 1, outcome: 'rejected' });
  });

  it('a UTC day bound covers the whole day and excludes what falls outside it', async () => {
    seedCase({ case_id: 'case-in-window' });
    seedCase({ case_id: 'case-before-window' });
    seedCase({ case_id: 'case-after-window' });
    seedTransitionEvent('evt-in', 'case-in-window', 'case_completed', '2026-08-10T23:59:59.999Z');
    seedTransitionEvent('evt-before', 'case-before-window', 'case_completed', '2026-08-09T23:59:59.999Z');
    seedTransitionEvent('evt-after', 'case-after-window', 'case_completed', '2026-08-11T00:00:00.000Z');

    const result = (await countCaseTransitionsForRequester(
      { occurred_after: '2026-08-10', occurred_before: '2026-08-10' },
      ctx(MEMBER),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      count: 1,
      occurred_after: '2026-08-10T00:00:00.000Z',
      occurred_before: '2026-08-10T23:59:59.999Z',
    });
  });

  it('group_by_outcome returns a complete, zero-filled breakdown', async () => {
    seedCase({ case_id: 'case-done' });
    seedTransitionEvent('evt-1', 'case-done', 'case_completed', '2026-08-10T09:00:00.000Z');

    const result = (await countCaseTransitionsForRequester(
      { group_by_outcome: true },
      ctx(MEMBER),
    )) as { groups: { outcome: string; count: number }[] };

    expect(result.groups).toHaveLength(2);
    expect(result.groups).toEqual(expect.arrayContaining([
      { outcome: 'completed', count: 1 },
      { outcome: 'rejected', count: 0 },
    ]));
  });

  it('group_by_project breaks totals down by project, and zero matches is an empty list — not one row per visible project', async () => {
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedCase({ case_id: 'case-done' });
    seedTransitionEvent('evt-1', 'case-done', 'case_completed', '2026-08-10T09:00:00.000Z');

    const withMatch = (await countCaseTransitionsForRequester(
      { group_by_project: true },
      ctx(MEMBER),
    )) as { groups: { project_id: string; project_name: string; count: number }[] };
    const withoutMatch = (await countCaseTransitionsForRequester(
      { group_by_project: true, occurred_after: '2099-01-01' },
      ctx(MEMBER),
    )) as { groups: unknown[] };

    expect(withMatch.groups).toEqual([{ project_id: MINE, project_name: 'Arbitra Core', count: 1 }]);
    expect(withoutMatch.groups).toEqual([]);
  });

  it('excludes a transition whose case can no longer be resolved, and says so honestly', async () => {
    seedCase({ case_id: 'case-still-here' });
    seedTransitionEvent('evt-1', 'case-still-here', 'case_completed', '2026-08-10T09:00:00.000Z');
    // No Case document at all for this one — e.g. a hard-deleted or pre-migration row.
    seedTransitionEvent('evt-2', 'case-long-gone', 'case_completed', '2026-08-10T10:00:00.000Z');

    const result = (await countCaseTransitionsForRequester({}, ctx(MEMBER))) as Record<string, unknown>;

    expect(result).toMatchObject({ count: 1, excluded_unresolved_cases: 1 });
    expect(result['excluded_unresolved_note']).toMatch(/could not verify/i);
  });

  it('a routine visibility exclusion (an event in a project the requester cannot see) is silent, not an honesty caveat', async () => {
    seedCase({ case_id: 'case-mine' });
    seedCase({ case_id: 'case-theirs', project_id: THEIRS });
    seedTransitionEvent('evt-1', 'case-mine', 'case_completed', '2026-08-10T09:00:00.000Z');
    seedTransitionEvent('evt-2', 'case-theirs', 'case_completed', '2026-08-10T10:00:00.000Z');

    const result = (await countCaseTransitionsForRequester({}, ctx(MEMBER))) as Record<string, unknown>;

    expect(result).toMatchObject({ count: 1 });
    expect(result['excluded_unresolved_cases']).toBeUndefined();
  });

  it('a project filter never lets a member count another project\'s transitions', async () => {
    seedCase({ case_id: 'case-mine' });
    seedTransitionEvent('evt-1', 'case-mine', 'case_completed', '2026-08-10T09:00:00.000Z');

    const result = (await countCaseTransitionsForRequester(
      { project: THEIRS },
      ctx(MEMBER),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      answered: false,
      exact: false,
      count: null,
      project_filter: { resolved: null, reason: 'no_matching_project' },
    });
    expect(result[READ_OUTCOME_KEY]).toBe('invalid_call');
  });

  it('answers zero for a requester with no accessible projects at all', async () => {
    const result = (await countCaseTransitionsForRequester({}, ctx('usr_nobody'))) as Record<string, unknown>;
    expect(result).toMatchObject({ answered: true, count: 0 });
  });

  it('refuses a calendar-invalid occurred_after instead of turning it into a zero', async () => {
    const result = (await countCaseTransitionsForRequester(
      { occurred_after: '2026-02-31' },
      ctx(MEMBER),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      answered: false,
      exact: false,
      count: null,
      invalid_input: 'occurred_after',
    });
  });

  it('refuses rather than joining a truncated set when the window holds more events than the scan cap', async () => {
    for (let i = 0; i < 501; i += 1) {
      const caseId = `case-${i}`;
      seedCase({ case_id: caseId });
      seedTransitionEvent(`evt-${i}`, caseId, 'case_completed', '2026-08-10T09:00:00.000Z');
    }

    const result = (await countCaseTransitionsForRequester({}, ctx(MEMBER))) as Record<string, unknown>;

    expect(result.answered).toBe(false);
    expect(result[READ_OUTCOME_KEY]).toBe('failed');
    expect(result['message']).toMatch(/narrow/i);
  });
});

describe('arbitra_search_cases — scoped to the requester', () => {
  it('returns cases from the requester’s projects and nothing from anyone else’s', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE, title: 'Mine' });
    seedCase({ case_id: 'case-theirs', project_id: THEIRS, title: 'Theirs' });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { case_id: string }[];
    };

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-mine']);
  });

  it('returns nothing at all for a requester with no accessible project', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE });
    const result = (await searchCasesForRequester({}, ctx('usr_nobody'))) as {
      cases: unknown[];
      scope?: string;
    };

    expect(result.cases).toEqual([]);
    expect(result.scope).toBe('no_accessible_projects');
  });

  it('hides soft-deleted cases', async () => {
    seedCase({ case_id: 'case-live', project_id: MINE });
    seedCase({ case_id: 'case-gone', project_id: MINE, deleted_at: '2026-08-02T00:00:00.000Z' });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { case_id: string }[];
    };

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-live']);
  });

  it('filters by status and by free text, and clamps the limit', async () => {
    seedCase({ case_id: 'case-a', title: 'Invoice export bug', status: 'open' });
    seedCase({ case_id: 'case-b', title: 'Unrelated', status: 'open' });
    seedCase({ case_id: 'case-c', title: 'Invoice export done', status: 'done' });

    const byStatus = (await searchCasesForRequester({ status: 'done' }, ctx(MEMBER))) as {
      cases: { case_id: string }[];
    };
    expect(byStatus.cases.map((c) => c.case_id)).toEqual(['case-c']);

    const byText = (await searchCasesForRequester({ query: 'invoice' }, ctx(MEMBER))) as {
      cases: { case_id: string }[];
    };
    expect(byText.cases.map((c) => c.case_id).sort()).toEqual(['case-a', 'case-c']);

    const clamped = (await searchCasesForRequester({ limit: 9999 }, ctx(MEMBER))) as {
      limit: number;
    };
    expect(clamped.limit).toBe(25);
  });

  it('lets an admin see every project, matching their existing API authority', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE });
    seedCase({ case_id: 'case-theirs', project_id: THEIRS });

    const result = (await searchCasesForRequester({}, ctx(ADMIN))) as {
      cases: { case_id: string }[];
    };

    expect(result.cases.map((c) => c.case_id).sort()).toEqual(['case-mine', 'case-theirs']);
  });
});

/**
 * #950: Clerk correctly concluded that no case shape carried an owner, after
 * fetching every visible case individually to answer "how many of those are
 * mine?" — five calls to arrive at "I can't tell". These pin the fix: the
 * owner (and, where present, the assigned reviewer) is now in the case shapes
 * both read tools return, resolved to a display name with an id fallback, and
 * an `owner` filter answers "how many/which of mine" in one bounded call —
 * without ever widening what project membership already permits to see.
 */
describe('arbitra_search_cases and arbitra_get_case — the case owner is now visible (#950)', () => {
  it('carries owner_name on every search row, resolved to a display name when one is on record', async () => {
    collectionStore('users').set(MEMBER, { user_id: MEMBER, roles: [], display_name: 'Alex Example' });
    seedCase({ case_id: 'case-mine', owner_user_id: MEMBER });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { owner_name: string; assigned_reviewer_name?: string }[];
    };

    expect(result.cases[0]!.owner_name).toBe('Alex Example');
    // No reviewer assigned in this fixture: the key is absent, not `null`.
    expect('assigned_reviewer_name' in result.cases[0]!).toBe(false);
  });

  it('falls back to the raw user id when the owner has no display name on record', async () => {
    // MEMBER is seeded in the top-level beforeEach with no display_name.
    seedCase({ case_id: 'case-mine', owner_user_id: MEMBER });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { owner_name: string }[];
    };

    expect(result.cases[0]!.owner_name).toBe(MEMBER);
  });

  it('resolves owner names for a whole page of distinct owners in one batched read, not one per owner (#956)', async () => {
    const ownerIds = Array.from({ length: 12 }, (_, i) => `usr_owner_${String(i).padStart(2, '0')}`);
    for (const id of ownerIds) {
      collectionStore('users').set(id, { user_id: id, roles: [], display_name: `Owner ${id}` });
    }
    ownerIds.forEach((id, i) => seedCase({ case_id: `case-owner-${i}`, owner_user_id: id }));

    const result = (await searchCasesForRequester({ limit: 25 }, ctx(MEMBER))) as {
      cases: { owner_name: string }[];
    };

    expect(result.cases.map((c) => c.owner_name).sort()).toEqual(
      ownerIds.map((id) => `Owner ${id}`).sort(),
    );
    // One `getAll` round trip resolves every distinct owner on the page — it
    // must not grow with the number of owners, the way `Promise.all` of
    // individual `.doc(id).get()` calls would.
    expect(batchReads.filter((name) => name === 'users').length).toBe(1);
    expect(ownerIds.every((id) => documentReads.includes(`users/${id}`))).toBe(true);
  });

  it('carries assigned_reviewer_name only when a reviewer is assigned, resolved the same way', async () => {
    collectionStore('users').set(STRANGER, { user_id: STRANGER, roles: [], display_name: 'A Reviewer' });
    seedCase({ case_id: 'case-with-reviewer', owner_user_id: MEMBER, assigned_reviewer_id: STRANGER });
    seedCase({ case_id: 'case-without-reviewer', owner_user_id: MEMBER });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { case_id: string; assigned_reviewer_name?: string }[];
    };

    const withReviewer = result.cases.find((c) => c.case_id === 'case-with-reviewer')!;
    const withoutReviewer = result.cases.find((c) => c.case_id === 'case-without-reviewer')!;
    expect(withReviewer.assigned_reviewer_name).toBe('A Reviewer');
    expect('assigned_reviewer_name' in withoutReviewer).toBe(false);
  });

  it('carries owner_name and assigned_reviewer_name on arbitra_get_case, falling back to the id', async () => {
    collectionStore('users').set(MEMBER, { user_id: MEMBER, roles: [], display_name: 'Alex Example' });
    // STRANGER keeps its beforeEach shape (no display_name), pinning the
    // fallback for the reviewer half of the same read.
    seedCase({ case_id: 'case-mine', owner_user_id: MEMBER, assigned_reviewer_id: STRANGER });

    const result = (await readCaseForRequester({ case_id: 'case-mine' }, ctx(MEMBER))) as {
      case: { owner_name: string; assigned_reviewer_name?: string };
    };

    expect(result.case.owner_name).toBe('Alex Example');
    expect(result.case.assigned_reviewer_name).toBe(STRANGER);
  });

  it('answers "how many of mine are open" in one bounded call with owner: \'current\'', async () => {
    seedCase({ case_id: 'case-mine-open', owner_user_id: MEMBER, status: 'open' });
    seedCase({ case_id: 'case-mine-done', owner_user_id: MEMBER, status: 'done' });
    // Same project, same status, visible to MEMBER — but owned by someone
    // else, so it must not count.
    seedCase({ case_id: 'case-colleagues-open', owner_user_id: 'usr_colleague', status: 'open' });

    const result = (await countCasesForRequester(
      { status: 'open', owner: 'current' },
      ctx(MEMBER),
    )) as { answered: boolean; exact: boolean; count: number; owner_filter: string | null };

    expect(result).toMatchObject({ answered: true, exact: true, count: 1, owner_filter: 'current' });
  });

  it('the owner filter returns only the requester\'s own cases in search, and count agrees exactly', async () => {
    seedCase({ case_id: 'case-mine-open', owner_user_id: MEMBER, status: 'open' });
    seedCase({ case_id: 'case-mine-done', owner_user_id: MEMBER, status: 'done' });
    seedCase({ case_id: 'case-colleagues-open', owner_user_id: 'usr_colleague', status: 'open' });

    const searched = (await searchCasesForRequester({ owner: 'current' }, ctx(MEMBER))) as {
      cases: { case_id: string; owner_name: string }[];
    };
    const counted = (await countCasesForRequester({ owner: 'current' }, ctx(MEMBER))) as {
      count: number;
    };

    expect(searched.cases.map((c) => c.case_id).sort()).toEqual(['case-mine-done', 'case-mine-open']);
    expect(searched.cases.every((c) => c.owner_name === MEMBER)).toBe(true);
    expect(counted.count).toBe(searched.cases.length);
  });

  /**
   * Visibility is not ownership: a case this requester happens to OWN but that
   * sits in a project they are not a member of (e.g. filed before being
   * removed from that project) must stay invisible. The owner filter may only
   * narrow within what project membership already permits — it must never
   * reach past it, even for the requester's own cases.
   */
  it('cannot widen visibility beyond the requester\'s scope, even for a case the requester owns', async () => {
    // MINE has MEMBER as a member; THEIRS does not (top-level beforeEach).
    seedCase({ case_id: 'case-owned-elsewhere', project_id: THEIRS, owner_user_id: MEMBER });
    seedCase({ case_id: 'case-mine', project_id: MINE, owner_user_id: MEMBER });

    const searched = (await searchCasesForRequester({ owner: 'current' }, ctx(MEMBER))) as {
      cases: { case_id: string }[];
    };
    const counted = (await countCasesForRequester({ owner: 'current' }, ctx(MEMBER))) as {
      count: number;
    };

    expect(searched.cases.map((c) => c.case_id)).toEqual(['case-mine']);
    expect(counted.count).toBe(1);
  });
});

/**
 * The filters below exist for one measured reason: a typical assistant task
 * — "which cases were created today in project Arbitra Core, and what status is
 * each in; for the most recently completed one, summarise what was implemented"
 * — could not be answered inside the attempt's tool-call budget. There was no
 * project filter, no date filter and no `created_at` in the projection, so the
 * only plan available was an unfiltered sweep plus one `get_case` per candidate.
 */
describe('arbitra_search_cases — project filter resolved server-side', () => {
  type SearchResult = {
    cases: { case_id: string; project_id: string; project_name: string | null }[];
    project_filter: { resolved: string | null; reason?: string; candidates?: unknown[] } | null;
    message?: string;
  };

  beforeEach(() => {
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedProject(THEIRS, [STRANGER], 'Someone Else');
  });

  it('accepts a project NAME and returns only that project’s cases', async () => {
    seedCase({ case_id: 'case-core', project_id: MINE });
    seedProject('proj_second', [MEMBER], 'Billing Platform');
    seedCase({ case_id: 'case-billing', project_id: 'proj_second' });

    const result = (await searchCasesForRequester(
      { project: 'Arbitra Core' },
      ctx(MEMBER),
    )) as SearchResult;

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-core']);
    expect(result.project_filter).toMatchObject({ resolved: MINE, name: 'Arbitra Core' });
  });

  it('accepts the project id just as well', async () => {
    seedCase({ case_id: 'case-core', project_id: MINE });
    seedProject('proj_second', [MEMBER], 'Billing Platform');
    seedCase({ case_id: 'case-billing', project_id: 'proj_second' });

    const result = (await searchCasesForRequester({ project: MINE }, ctx(MEMBER))) as SearchResult;

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-core']);
  });

  it('names the project on every row, so "which project" needs no second call', async () => {
    seedCase({ case_id: 'case-core', project_id: MINE });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as SearchResult;

    expect(result.cases[0]!.project_name).toBe('Arbitra Core');
  });

  it('resolves an exact name even when it is a prefix of another visible project', async () => {
    seedProject('proj_docs', [MEMBER], 'Arbitra Core Docs');
    seedCase({ case_id: 'case-core', project_id: MINE });
    seedCase({ case_id: 'case-docs', project_id: 'proj_docs' });

    const result = (await searchCasesForRequester(
      { project: 'Arbitra Core' },
      ctx(MEMBER),
    )) as SearchResult;

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-core']);
  });

  it('reports an ambiguous name with candidate ids instead of picking one', async () => {
    seedProject('proj_docs', [MEMBER], 'Arbitra Core Docs');
    seedCase({ case_id: 'case-core', project_id: MINE });
    seedCase({ case_id: 'case-docs', project_id: 'proj_docs' });

    const result = (await searchCasesForRequester({ project: 'arbitra' }, ctx(MEMBER))) as
      SearchResult;

    expect(result.cases).toEqual([]);
    expect(result.project_filter).toMatchObject({ resolved: null, reason: 'ambiguous_project' });
    expect(
      (result.project_filter!.candidates as { project_id: string }[]).map((c) => c.project_id).sort(),
    ).toEqual([MINE, 'proj_docs'].sort());
  });

  it('cannot be used to reach a project the requester may not see', async () => {
    seedCase({ case_id: 'case-theirs', project_id: THEIRS });

    const byName = (await searchCasesForRequester(
      { project: 'Someone Else' },
      ctx(MEMBER),
    )) as SearchResult;
    const byId = (await searchCasesForRequester({ project: THEIRS }, ctx(MEMBER))) as SearchResult;

    for (const result of [byName, byId]) {
      expect(result.cases).toEqual([]);
      expect(result.project_filter).toMatchObject({
        resolved: null,
        reason: 'no_matching_project',
      });
    }
  });
});

describe('arbitra_search_cases — creation dates are visible and filterable', () => {
  type DateResult = {
    cases: { case_id: string; created_at: string; updated_at: string }[];
    ordered_by: string;
    created_after: string | null;
    created_before: string | null;
    order_by_note?: string;
  };

  beforeEach(() => {
    seedCase({
      case_id: 'case-today-early',
      created_at: '2026-08-04T07:15:00.000Z',
      updated_at: '2026-08-04T07:15:00.000Z',
    });
    seedCase({
      case_id: 'case-today-late',
      created_at: '2026-08-04T22:59:59.999Z',
      updated_at: '2026-08-04T23:00:00.000Z',
    });
    seedCase({
      case_id: 'case-yesterday',
      created_at: '2026-08-03T23:59:59.999Z',
      updated_at: '2026-08-05T09:00:00.000Z',
    });
    seedCase({
      case_id: 'case-tomorrow',
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
    });
  });

  it('returns created_at on every row', async () => {
    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as DateResult;

    expect(result.cases.every((c) => typeof c.created_at === 'string' && c.created_at !== '')).toBe(
      true,
    );
  });

  it('treats a bare UTC day as that whole day on both bounds', async () => {
    const result = (await searchCasesForRequester(
      { created_after: '2026-08-04', created_before: '2026-08-04' },
      ctx(MEMBER),
    )) as DateResult;

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-today-late', 'case-today-early']);
    expect(result.created_after).toBe('2026-08-04T00:00:00.000Z');
    expect(result.created_before).toBe('2026-08-04T23:59:59.999Z');
  });

  it('accepts a zoned instant and normalises it to the stored millisecond form', async () => {
    // Lexicographically '…:00Z' sorts AFTER '…:00.000Z', so an unnormalised
    // bound would drop the case created in exactly that second.
    const result = (await searchCasesForRequester(
      { created_after: '2026-08-04T07:15:00Z' },
      ctx(MEMBER),
    )) as DateResult;

    expect(result.cases.map((c) => c.case_id)).toContain('case-today-early');
    expect(result.created_after).toBe('2026-08-04T07:15:00.000Z');
  });

  it('orders by created_at when a date bound is present, and says which axis it used', async () => {
    const result = (await searchCasesForRequester(
      { created_after: '2026-08-01', order_by: 'updated_at' },
      ctx(MEMBER),
    )) as DateResult;

    expect(result.ordered_by).toBe('created_at');
    expect(result.cases.map((c) => c.case_id)).toEqual([
      'case-tomorrow',
      'case-today-late',
      'case-today-early',
      'case-yesterday',
    ]);
    expect(result.order_by_note).toContain('created_at');
  });

  it('orders by updated_at by default, and reports that too', async () => {
    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as DateResult;

    expect(result.ordered_by).toBe('updated_at');
    expect(result.cases[0]!.case_id).toBe('case-yesterday');
  });

  it('rejects a calendar-invalid day by name instead of shifting the window', async () => {
    const result = (await searchCasesForRequester(
      { created_after: '2026-02-31' },
      ctx(MEMBER),
    )) as DateResult & { invalid_input?: string };

    expect(result.invalid_input).toBe('created_after');
    expect(result.cases).toEqual([]);
  });

  /**
   * `new Date('2026-04-31T23:59:59Z')` is 1 May, not an error. Validating only
   * the bare-day form refused `2026-04-31` by name while answering a silently
   * different question for the same mistake written as a full instant.
   */
  it('rejects a calendar-invalid day written as a full instant, not just as a bare day', async () => {
    for (const bound of ['2026-04-31T23:59:59Z', '2026-02-30T00:00:00.000Z', '2026-04-31']) {
      const result = (await searchCasesForRequester(
        { created_before: bound },
        ctx(MEMBER),
      )) as DateResult & { invalid_input?: string };

      expect(result.invalid_input).toBe('created_before');
      expect(result.created_before).toBeUndefined();
    }
  });

  it('keeps a valid instant whose UTC day differs from its local one', async () => {
    const result = (await searchCasesForRequester(
      { created_after: '2026-08-04T23:00:00-05:00' },
      ctx(MEMBER),
    )) as DateResult & { invalid_input?: string };

    expect(result.invalid_input).toBeUndefined();
    expect(result.created_after).toBe('2026-08-05T04:00:00.000Z');
  });
});

describe('arbitra_search_cases — a clipped result says so and can be continued', () => {
  type PageResult = {
    cases: { case_id: string }[];
    has_more: boolean;
    next_cursor: string | null;
    invalid_cursor?: boolean;
    cursor_error?: string;
  };

  function seedNumbered(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const stamp = `2026-08-04T${String(i).padStart(2, '0')}:00:00.000Z`;
      seedCase({ case_id: `case-${String(i).padStart(2, '0')}`, created_at: stamp, updated_at: stamp });
    }
  }


  it('flags a truncated page and hands back a cursor that continues it exactly', async () => {
    seedNumbered(7);

    const first = (await searchCasesForRequester({ limit: 3 }, ctx(MEMBER))) as PageResult;
    expect(first.cases.map((c) => c.case_id)).toEqual(['case-06', 'case-05', 'case-04']);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();

    const second = (await searchCasesForRequester(
      { limit: 3, cursor: first.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;
    expect(second.cases.map((c) => c.case_id)).toEqual(['case-03', 'case-02', 'case-01']);

    const third = (await searchCasesForRequester(
      { limit: 3, cursor: second.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;
    expect(third.cases.map((c) => c.case_id)).toEqual(['case-00']);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();
  });

  it('neither skips nor repeats cases that share the boundary timestamp', async () => {
    const tied = '2026-08-04T12:00:00.000Z';
    const ids = ['case-a', 'case-b', 'case-c', 'case-d', 'case-e', 'case-f'];
    for (const id of ids) {
      seedCase({ case_id: id, created_at: tied, updated_at: tied });
    }

    const { served } = await pageToCompletion({ limit: 2 });

    expect(new Set(served).size).toBe(ids.length);
    expect([...served].sort()).toEqual([...ids].sort());
  });

  /**
   * A batch write leaves every case it touched on one millisecond —
   * `scripts/cleanup-zombie-intelligence-cases.ts` computes `now` once and stamps
   * it onto every candidate. A boundary that can only say "the timestamp, plus
   * how many rows at it I already served" cannot page past a tie deeper than one
   * fetch window: the count stops advancing, pages repeat, and the rows below the
   * window can never be reached. Twenty-five tied cases at `limit: 5` is a window
   * of twenty, i.e. the shape that used to loop.
   */
  it('pages through a tie far deeper than the fetch window, once each and to the end', async () => {
    const tied = '2026-08-04T12:00:00.000Z';
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const id = `case-${String(i).padStart(2, '0')}`;
      ids.push(id);
      seedCase({ case_id: id, created_at: tied, updated_at: tied });
    }

    const { served, terminated } = await pageToCompletion({ limit: 5 });

    expect(terminated).toBe(true);
    expect(served.length).toBe(ids.length);
    expect([...served].sort()).toEqual([...ids].sort());
  });

  it('pages a tie of five at limit 1, where the fetch window is only four', async () => {
    const tied = '2026-08-04T12:00:00.000Z';
    const ids = ['case-0', 'case-1', 'case-2', 'case-3', 'case-4'];
    for (const id of ids) {
      seedCase({ case_id: id, status: 'done', created_at: tied, updated_at: tied });
    }

    const { served, terminated } = await pageToCompletion({ status: 'done', limit: 1 });

    expect(terminated).toBe(true);
    expect([...served].sort()).toEqual([...ids].sort());
  });

  /**
   * Forty distinct timestamps at `limit: 5` overruns the fetch ceiling on every
   * page, which is what makes the scan frontier load-bearing. Nothing exercised
   * it before: the deepest fixture was seven cases in a window of twelve, so
   * deleting the frontier entirely left the suite green.
   */
  it('pages a result set several fetch windows deep without losing a row', async () => {
    seedNumbered(40);

    const { served, terminated } = await pageToCompletion({ limit: 5 });

    expect(terminated).toBe(true);
    expect(new Set(served).size).toBe(40);
    expect(served.length).toBe(40);
  });

  /**
   * More accessible projects than fit in one Firestore `in` clause, so the search
   * runs several queries and each can stop at its own ceiling. The frontier is
   * what keeps the union of those pages ordered.
   */
  it('pages a result set spread over more project chunks than one query allows', async () => {
    store.get('projects')!.clear();
    const ids: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      const projectId = `proj_${String(i).padStart(2, '0')}`;
      seedProject(projectId, [MEMBER], `Project ${i}`);
      const id = `case-${String(i).padStart(2, '0')}`;
      ids.push(id);
      const stamp = `2026-08-04T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      seedCase({ case_id: id, project_id: projectId, created_at: stamp, updated_at: stamp });
    }

    const { served, terminated } = await pageToCompletion({ limit: 4 });

    expect(terminated).toBe(true);
    expect([...served].sort()).toEqual([...ids].sort());
  });

  /**
   * The text filter runs in this process, so a page can fetch its whole window
   * and match nothing in it. Without the scan frontier the tool would then report
   * `has_more: false` — a claim of completeness over a window it never looked
   * past — and the two matching cases below it would never be returned.
   */
  it('keeps paging when a whole fetch window is rejected by the text filter', async () => {
    for (let i = 0; i < 40; i += 1) {
      const stamp = `2026-08-04T${String(i).padStart(2, '0')}:${String(i).padStart(2, '0')}:00.000Z`;
      seedCase({
        case_id: `case-${String(i).padStart(2, '0')}`,
        // Only two cases match, and both sit well below the first window.
        title: i === 5 || i === 9 ? 'Invoice export needle' : 'chatter',
        created_at: stamp,
        updated_at: stamp,
      });
    }

    const { served, terminated } = await pageToCompletion({ query: 'needle', limit: 5 });

    expect(terminated).toBe(true);
    expect([...served].sort()).toEqual(['case-05', 'case-09']);
  });

  /**
   * Several project chunks, one of them stopping at its fetch ceiling while
   * another returns rows from far below that ceiling. Serving the deep rows now
   * would move the boundary past everything the truncated chunk has not scanned
   * yet — so those rows would be skipped for good.
   */
  it('defers rows below the frontier instead of paging past what a chunk has not scanned', async () => {
    store.get('projects')!.clear();
    const expected: string[] = [];
    // Chunk 1: thirty projects. Twenty-five carry recent noise, five carry
    // matches at timestamps below where the chunk query will stop.
    for (let i = 0; i < 30; i += 1) {
      const projectId = `proj_a${String(i).padStart(2, '0')}`;
      seedProject(projectId, [MEMBER], `Alpha ${i}`);
      const matching = i >= 25;
      const id = `case-a${String(i).padStart(2, '0')}`;
      if (matching) expected.push(id);
      seedCase({
        case_id: id,
        project_id: projectId,
        title: matching ? 'Invoice export needle' : 'chatter',
        updated_at: matching
          ? `2026-08-02T${String(i).padStart(2, '0')}:00:00.000Z`
          : `2026-08-04T${String(i).padStart(2, '0')}:00:00.000Z`,
      });
    }
    // Chunk 2: five more projects, matching, older than everything above.
    for (let i = 0; i < 5; i += 1) {
      const projectId = `proj_b${i}`;
      seedProject(projectId, [MEMBER], `Beta ${i}`);
      const id = `case-b${i}`;
      expected.push(id);
      seedCase({
        case_id: id,
        project_id: projectId,
        title: 'Invoice export needle',
        updated_at: `2026-08-01T0${i}:00:00.000Z`,
      });
    }

    const { served, terminated } = await pageToCompletion({ query: 'needle', limit: 2 });

    expect(terminated).toBe(true);
    expect([...served].sort()).toEqual([...expected].sort());
  });

  /**
   * The frontier row is the deepest row some chunk query actually returned, so it
   * WAS scanned and belongs on the page. The comparison that decides this is a
   * boundary of one character (`<= 0`, not `< 0`), and excluding the frontier
   * itself does not merely delay it: the cursor is issued AT the frontier, so the
   * next page starts strictly after it and the row is never served by any page.
   * A single matching row sitting exactly on the boundary is therefore the shape
   * that tells the two comparators apart — every other fixture here has rows
   * above the frontier that keep the page non-empty either way.
   */
  it('serves the row that sits exactly on the scan frontier', async () => {
    // limit 1 means a fetch window of four, so the fourth row back is the
    // frontier. Only that row matches; the three above it are noise.
    for (let i = 1; i <= 4; i += 1) {
      seedCase({
        case_id: `case-boundary-0${i}`,
        title: i === 4 ? 'Invoice export needle' : 'chatter',
        updated_at: `2026-08-04T10:0${5 - i}:00.000Z`,
      });
    }

    const first = (await searchCasesForRequester({ query: 'needle', limit: 1 }, ctx(MEMBER))) as {
      cases: { case_id: string }[];
    };
    expect(first.cases.map((c) => c.case_id)).toEqual(['case-boundary-04']);

    const { served, terminated } = await pageToCompletion({ query: 'needle', limit: 1 });
    expect(terminated).toBe(true);
    expect(served).toEqual(['case-boundary-04']);
  });

  /**
   * Firestore orders document ids by byte value; `localeCompare` orders 'a'
   * before 'B'. Ordering the page one way and resuming it the other drops rows
   * on any tie whose ids differ in case — which case ids do, they end in a
   * mixed-case suffix.
   */
  it('orders tied rows by document id the way Firestore does, not by locale', async () => {
    const tied = '2026-08-04T12:00:00.000Z';
    const ids = ['case-B1', 'case-a2', 'case-B3', 'case-a4'];
    for (const id of ids) {
      seedCase({ case_id: id, created_at: tied, updated_at: tied });
    }

    const { served, terminated } = await pageToCompletion({ limit: 1 });

    expect(terminated).toBe(true);
    expect([...served].sort()).toEqual([...ids].sort());
  });

  it('says a page is complete when it is', async () => {
    seedNumbered(2);

    const result = (await searchCasesForRequester({ limit: 10 }, ctx(MEMBER))) as PageResult;

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it('refuses a cursor issued for a different ordering rather than answering off the wrong axis', async () => {
    seedNumbered(7);

    const first = (await searchCasesForRequester(
      { limit: 3, order_by: 'created_at' },
      ctx(MEMBER),
    )) as PageResult;
    const replayed = (await searchCasesForRequester(
      { limit: 3, order_by: 'updated_at', cursor: first.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;

    expect(replayed.invalid_cursor).toBe(true);
    expect(replayed.cases).toEqual([]);
  });

  it('refuses a cursor it did not issue', async () => {
    seedNumbered(3);

    const result = (await searchCasesForRequester(
      { cursor: 'not-a-cursor' },
      ctx(MEMBER),
    )) as PageResult;

    expect(result.invalid_cursor).toBe(true);
  });

  it('refuses a cursor whose fields are not the ones it issues', async () => {
    seedNumbered(3);
    const issued = (await searchCasesForRequester({ limit: 1 }, ctx(MEMBER))) as PageResult;
    const decoded = JSON.parse(
      Buffer.from(issued.next_cursor!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const forge = (patch: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...decoded, ...patch }), 'utf8').toString('base64url');

    // The unmodified cursor is accepted, so every refusal below is about the field.
    const accepted = (await searchCasesForRequester(
      { limit: 1, cursor: forge({}) },
      ctx(MEMBER),
    )) as PageResult;
    expect(accepted.invalid_cursor).toBeUndefined();

    for (const patch of [{ d: undefined }, { d: '' }, { d: 42 }, { v: undefined }, { f: undefined }]) {
      const result = (await searchCasesForRequester(
        { limit: 1, cursor: forge(patch) },
        ctx(MEMBER),
      )) as PageResult;
      expect(result.invalid_cursor).toBe(true);
      expect(result.cases).toEqual([]);
    }
  });

  /**
   * A cursor is a position in one ordering of one result set, and it says so
   * nowhere. Replayed against different filters it used to decode fine, clip the
   * new set at a boundary that means nothing in it, and report `has_more: false` —
   * a wrong answer carrying an explicit claim of completeness.
   */
  it('refuses a cursor replayed against a different filter set instead of answering off it', async () => {
    seedProject('proj_beta', [MEMBER], 'Beta Ops');
    seedProject('proj_gamma', [MEMBER], 'Gamma Ops');
    const tied = '2026-08-04T12:00:00.000Z';
    for (const project of ['proj_beta', 'proj_gamma']) {
      for (let i = 0; i < 3; i += 1) {
        seedCase({
          case_id: `${project}-c${i}`,
          project_id: project,
          created_at: tied,
          updated_at: tied,
        });
      }
    }

    const beta = (await searchCasesForRequester(
      { project: 'Beta Ops', limit: 2 },
      ctx(MEMBER),
    )) as PageResult;
    expect(beta.next_cursor).not.toBeNull();

    const replayed = (await searchCasesForRequester(
      { project: 'Gamma Ops', limit: 10, cursor: beta.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;

    expect(replayed.invalid_cursor).toBe(true);
    expect(replayed.cursor_error).toBe('filters_changed');
    expect(replayed.cases).toEqual([]);
    // Gamma alone answers in full, so the refusal is about the cursor.
    const gamma = (await searchCasesForRequester(
      { project: 'Gamma Ops', limit: 10 },
      ctx(MEMBER),
    )) as PageResult;
    expect(gamma.cases.length).toBe(3);
  });

  it('refuses a cursor whose date window was dropped, even with order_by kept', async () => {
    seedCase({ case_id: 'case-today-a', created_at: '2026-08-04T09:00:00.000Z' });
    seedCase({ case_id: 'case-today-b', created_at: '2026-08-04T08:00:00.000Z' });
    seedCase({ case_id: 'case-earlier', created_at: '2026-08-03T08:00:00.000Z' });

    const first = (await searchCasesForRequester(
      { created_after: '2026-08-04', limit: 1 },
      ctx(MEMBER),
    )) as PageResult;

    const replayed = (await searchCasesForRequester(
      { order_by: 'created_at', limit: 5, cursor: first.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;

    expect(replayed.cursor_error).toBe('filters_changed');
    expect(replayed.cases).toEqual([]);
  });

  it('names a changed ordering separately from a changed filter set', async () => {
    seedNumbered(7);

    const first = (await searchCasesForRequester(
      { limit: 3, order_by: 'created_at' },
      ctx(MEMBER),
    )) as PageResult;
    const replayed = (await searchCasesForRequester(
      { limit: 3, order_by: 'updated_at', cursor: first.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;

    expect(replayed.cursor_error).toBe('order_mismatch');
  });

  /** The fingerprint uses the RESOLVED project, so a name and its id are one filter. */
  it('continues a page requested by project name when the next one passes the project id', async () => {
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedNumbered(4);

    const byName = (await searchCasesForRequester(
      { project: 'Arbitra Core', limit: 2 },
      ctx(MEMBER),
    )) as PageResult;
    const byId = (await searchCasesForRequester(
      { project: MINE, limit: 2, cursor: byName.next_cursor! },
      ctx(MEMBER),
    )) as PageResult;

    expect(byId.invalid_cursor).toBeUndefined();
    expect(byId.cases.map((c) => c.case_id)).toEqual(['case-01', 'case-00']);
  });
});

describe('arbitra_search_cases — the question that motivated all of this', () => {
  beforeEach(() => {
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedProject('proj_other', [MEMBER], 'Billing Platform');
    seedCase({
      case_id: 'case-today-open',
      project_id: MINE,
      status: 'in_build',
      created_at: '2026-08-04T08:00:00.000Z',
      updated_at: '2026-08-04T08:30:00.000Z',
    });
    seedCase({
      case_id: 'case-today-done',
      project_id: MINE,
      status: 'done',
      title: 'Shipped the export fix',
      created_at: '2026-08-04T09:00:00.000Z',
      updated_at: '2026-08-04T18:00:00.000Z',
    });
    seedCompletion('case-today-done', '2026-08-04T17:45:00.000Z');
    // Created six days ago, completed then, and touched AFTER today's case — a
    // re-opened case, a late comment, a status sweep all look like this.
    seedCase({
      case_id: 'case-older-done',
      project_id: MINE,
      status: 'done',
      created_at: '2026-07-30T09:00:00.000Z',
      updated_at: '2026-08-04T19:00:00.000Z',
    });
    seedCompletion('case-older-done', '2026-07-30T15:00:00.000Z');
    seedCase({
      case_id: 'case-elsewhere',
      project_id: 'proj_other',
      created_at: '2026-08-04T09:30:00.000Z',
      updated_at: '2026-08-04T09:30:00.000Z',
    });
  });

  /**
   * "Which cases were created today in the project Arbitra Core, and what status
   * is each in? For the most recently completed one, summarise what was
   * implemented."
   *
   * The exact answer costs one search plus one `arbitra_get_case` per case that
   * finished in the window — two calls on this fixture, four if four of today's
   * cases were done. It cannot be fewer: `completed_at` lives in a case's history,
   * so no search can order by it, and the search cannot even offer `updated_at`
   * as the tie-break here because a `created_at` range must drive the sort.
   */
  it('answers exactly, in one search plus one read per completed case', async () => {
    // Call 1 — which cases, created today, in that project, and in what status.
    const today = (await searchCasesForRequester(
      {
        project: 'Arbitra Core',
        created_after: '2026-08-04',
        created_before: '2026-08-04',
      },
      ctx(MEMBER),
    )) as {
      cases: { case_id: string; status: string; created_at: string; project_name: string | null }[];
      has_more: boolean;
      ordered_by: string;
    };

    expect(today.cases.map((c) => [c.case_id, c.status])).toEqual([
      ['case-today-done', 'done'],
      ['case-today-open', 'in_build'],
    ]);
    expect(today.has_more).toBe(false);
    expect(today.ordered_by).toBe('created_at');
    expect(today.cases.every((c) => c.project_name === 'Arbitra Core')).toBe(true);

    // Call 2 — read the one case that finished, which reports both when it
    // completed and what was implemented.
    const doneToday = today.cases.filter((c) => c.status === 'done');
    const details = await Promise.all(
      doneToday.map(
        (row) =>
          readCaseForRequester({ case_id: row.case_id }, ctx(MEMBER)) as Promise<{
            found: boolean;
            completed_at: string | null;
            case: { case_id: string; title: string };
          }>,
      ),
    );
    const latest = [...details].sort((a, b) =>
      (b.completed_at ?? '').localeCompare(a.completed_at ?? ''),
    )[0]!;

    expect(details.length).toBe(1);
    expect(latest.completed_at).toBe('2026-08-04T17:45:00.000Z');
    expect(latest.case.title).toBe('Shipped the export fix');
  });

  /**
   * The plan the tool used to suggest — status 'done' ordered by updated_at —
   * answers a different question, and this fixture is the ordinary case where the
   * two disagree. The description no longer offers it as "the most recently
   * completed"; this pins why.
   */
  it('shows that ordering by last activity picks a case that was not created today', async () => {
    const byLastActivity = (await searchCasesForRequester(
      { project: 'Arbitra Core', status: 'done', order_by: 'updated_at', limit: 1 },
      ctx(MEMBER),
    )) as { cases: { case_id: string; created_at: string }[]; ordered_by: string };

    expect(byLastActivity.ordered_by).toBe('updated_at');
    expect(byLastActivity.cases.map((c) => c.case_id)).toEqual(['case-older-done']);
    expect(byLastActivity.cases[0]!.created_at.startsWith('2026-08-04')).toBe(false);
  });

  it('cannot be asked for a created_at window ordered by last activity, and says so', async () => {
    const result = (await searchCasesForRequester(
      {
        project: 'Arbitra Core',
        created_after: '2026-08-04',
        created_before: '2026-08-04',
        order_by: 'updated_at',
      },
      ctx(MEMBER),
    )) as { ordered_by: string; order_by_note?: string };

    expect(result.ordered_by).toBe('created_at');
    expect(result.order_by_note).toContain('was not applied');
  });
});

/**
 * The wrapper serialises a payload and, on overflow, replaces it with the first
 * `maxToolResultChars` characters of the JSON string. That is not a clipped list
 * the model can work with — it is a half-open string with no rows it can parse,
 * no `has_more` and no cursor. So a default page has to fit, with the titles real
 * cases carry rather than the short ones a fixture is tempted to use.
 */
describe('arbitra_search_cases — a default page fits the per-call result cap', () => {
  const REALISTIC_TITLE = 'Clerk read tools cannot answer a project-scoped question within the call budget';
  /** What `limit` defaults to when the model does not pass one. */
  const DEFAULT_PAGE = 8;

  function seedLongTitled(count: number): void {
    seedProject(MINE, [MEMBER], 'Arbitra Core Platform');
    for (let i = 0; i < count; i += 1) {
      const stamp = `2026-08-04T${String(i).padStart(2, '0')}:00:00.000Z`;
      seedCase({
        case_id: `case-solemn-meadow-${String(i).padStart(2, '0')}k9`,
        title: `${REALISTIC_TITLE} (${i})`,
        status: 'needs_human_decision',
        created_at: stamp,
        updated_at: stamp,
      });
    }
  }

  it('serialises a full default-limit page of long-titled cases well under the cap', async () => {
    const { maxToolResultChars } = resolveAssistantBounds();
    // More cases than fit one page, so has_more, next_cursor and more_note are
    // part of what has to fit.
    seedLongTitled(DEFAULT_PAGE + 4);

    // Every optional trailer key at once: the project echo, the overridden-order
    // note, both date bounds and the paging note.
    const result = (await searchCasesForRequester(
      {
        project: 'Arbitra Core Platform',
        created_after: '2026-08-04',
        created_before: '2026-08-04',
        order_by: 'updated_at',
      },
      ctx(MEMBER),
    )) as {
      cases: unknown[];
      has_more: boolean;
      order_by_note?: string;
      more_note?: string;
      rows_omitted?: number;
    };
    const serialised = JSON.stringify(result);

    expect(result.cases.length).toBe(DEFAULT_PAGE);
    expect(result.rows_omitted).toBeUndefined();
    expect(result.has_more).toBe(true);
    expect(result.order_by_note).toBeDefined();
    expect(result.more_note).toBeDefined();
    // The margin was 0.8x before #950 added `owner_name` to every row; eight
    // rows of it now land around 0.82x. Still comfortably short of the 0.95x
    // budget that would start shortening the page (see `rows_omitted` above).
    expect(serialised.length).toBeLessThan(maxToolResultChars * 0.9);
  });

  /**
   * The largest page the schema advertises is the one most likely to overflow, so
   * it is the one that must not produce a half-object. The rows that do not fit
   * become the next page rather than a textual clip.
   */
  it('shortens the largest advertised page instead of overflowing it, and pages the rest', async () => {
    // `maxToolResultChars` was raised from 4,000 to 12,000 precisely so a
    // realistic page of dense rows stops
    // overflowing by default. That means a 25-row page of these titles no
    // longer needs shortening at the DEFAULT cap — so this test forces the cap
    // back down locally to keep exercising the shortening path itself, which
    // still has to work whenever a result IS too big for whatever the
    // configured cap is.
    process.env['ARBITRA_ASSISTANT_MAX_TOOL_RESULT_CHARS'] = '4000';
    try {
      const { maxToolResultChars } = resolveAssistantBounds();
      seedLongTitled(25);

      const first = (await searchCasesForRequester({ limit: 25 }, ctx(MEMBER))) as {
        cases: { case_id: string }[];
        has_more: boolean;
        next_cursor: string | null;
        rows_omitted?: number;
      };

      expect(first.cases.length).toBeLessThan(25);
      expect(first.rows_omitted).toBe(25 - first.cases.length);
      expect(first.has_more).toBe(true);
      expect(first.next_cursor).not.toBeNull();
      expect(JSON.stringify(first).length).toBeLessThan(maxToolResultChars);

      const { served, terminated } = await pageToCompletion({ limit: 25 });
      expect(terminated).toBe(true);
      expect(new Set(served).size).toBe(25);
    } finally {
      delete process.env['ARBITRA_ASSISTANT_MAX_TOOL_RESULT_CHARS'];
    }
  });

  /**
   * The overflow the shortening exists to prevent was still reachable through the
   * tool's own documented maximum, because the room kept back for everything that
   * is not a row was a constant restating a serialised shape it did not contain:
   * 700 characters against a trailer that serialises to roughly 950 once the
   * project echo, the overridden-order note, both date bounds, the omission note,
   * the paging note and the cursor are all present. Rows were then packed up to a
   * ceiling the total exceeded — silently, at `limit: 25`.
   *
   * Whether it overflows depends on how close a whole number of rows lands under
   * that ceiling, so one title length proves little: an off-by-250 reserve only
   * bites for the row sizes whose packing leaves less than 250 characters unused.
   * The sweep covers the band real case titles fall in, and every length in it
   * has to hold. All of them pass now; several fail against a fixed reserve.
   */
  describe('at the largest advertised page, with every trailer key present', () => {
    // Same reasoning as the sibling test above: this sweep pins the reserve-vs-
    // actual-trailer-size boundary bug (700 assumed vs ~950 actual), which is a
    // FIXED number of characters, not one that scales with `maxToolResultChars`.
    // Forcing the cap back to the value this sweep was calibrated against (the
    // earlier 4,000-char default) keeps the boundary reachable now that
    // the default is 12,000.
    beforeEach(() => {
      process.env['ARBITRA_ASSISTANT_MAX_TOOL_RESULT_CHARS'] = '4000';
    });
    afterEach(() => {
      delete process.env['ARBITRA_ASSISTANT_MAX_TOOL_RESULT_CHARS'];
    });

    /** The tool's own budget: the cap, less the margin it keeps from the layer above. */
    function payloadBudget(): number {
      return Math.floor(resolveAssistantBounds().maxToolResultChars * 0.95);
    }

    function seedRealisticDay(count: number, titleChars: number): void {
      seedProject(MINE, [MEMBER], 'Arbitra Core Platform');
      for (let i = 0; i < count; i += 1) {
        // Every case created on the filtered day, so the date bounds keep them all,
        // and every stamp distinct, so the page order is total.
        const hour = String(i % 24).padStart(2, '0');
        const minute = String(i).padStart(2, '0');
        const stamp = `2026-08-04T${hour}:${minute}:00.000Z`;
        const suffix = ` (${i})`;
        seedCase({
          case_id: `case-solemn-meadow-${String(i).padStart(2, '0')}k9`,
          title: `${REALISTIC_TITLE} `.repeat(4).slice(0, titleChars - suffix.length) + suffix,
          status: 'needs_human_decision',
          created_at: stamp,
          updated_at: stamp,
        });
      }
    }

    for (const titleChars of [65, 70, 75, 78, 80, 81, 85, 90]) {
      it(`fits the cap with ${titleChars}-character titles`, async () => {
        seedRealisticDay(30, titleChars);

        const result = (await searchCasesForRequester(
          {
            project: 'Arbitra Core Platform',
            created_after: '2026-08-04',
            created_before: '2026-08-04',
            order_by: 'updated_at',
            limit: 25,
          },
          ctx(MEMBER),
        )) as {
          cases: { case_id: string; title: string }[];
          has_more: boolean;
          next_cursor: string | null;
          rows_omitted?: number;
          order_by_note?: string;
          more_note?: string;
          project_filter: unknown;
        };

        // The trailer this has to make room for is the largest one a successful
        // result can carry.
        expect(result.order_by_note).toBeDefined();
        expect(result.more_note).toBeDefined();
        expect(result.project_filter).not.toBeNull();
        expect(result.next_cursor).not.toBeNull();
        expect(result.cases[0]!.title.length).toBe(titleChars);

        expect(JSON.stringify(result).length).toBeLessThanOrEqual(payloadBudget());
        // Short, not empty — and it says by how much, so the omission is not silent.
        expect(result.cases.length).toBeGreaterThan(0);
        expect(result.rows_omitted).toBe(25 - result.cases.length);
        expect(result.has_more).toBe(true);
      });
    }

    /** The rows that did not fit are the next page, not rows lost to the budget. */
    it('reaches every row of the day across pages', async () => {
      seedRealisticDay(30, 80);

      const { served, terminated } = await pageToCompletion({
        project: 'Arbitra Core Platform',
        created_after: '2026-08-04',
        created_before: '2026-08-04',
        limit: 25,
      });

      expect(terminated).toBe(true);
      expect(new Set(served).size).toBe(30);
      expect(served.length).toBe(30);
    });
  });

  it('elides a title too long to carry rather than letting one row spend the budget', async () => {
    seedCase({ case_id: 'case-verbose', title: 'x'.repeat(500) });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { title: string }[];
    };

    expect(result.cases[0]!.title.length).toBeLessThan(140);
    expect(result.cases[0]!.title.endsWith('…')).toBe(true);
  });

  /**
   * A project name has no length bound (`project-validators.ts` requires only a
   * non-empty string), and it is echoed in a place the row shortening cannot
   * reclaim: the trailer of a successful page, and the candidate list of an
   * ambiguous-name refusal, which has no rows to trade away at all. So it is
   * clipped where a title is, and for the same reason — the identifiers beside it
   * stay exact, which is what the model acts on.
   */
  it('elides an unbounded project name in the row, the echo and a refusal', async () => {
    const huge = `Programme ${'y'.repeat(2000)}`;
    seedProject(MINE, [MEMBER], huge);
    seedProject('proj_twin', [MEMBER], `${huge} (twin)`);
    seedCase({ case_id: 'case-in-huge', project_id: MINE });

    const answered = (await searchCasesForRequester({ project: MINE }, ctx(MEMBER))) as {
      cases: { project_name: string }[];
      project_filter: { resolved: string; name: string };
    };

    expect(answered.cases[0]!.project_name.length).toBeLessThan(100);
    expect(answered.project_filter.resolved).toBe(MINE);
    expect(answered.project_filter.name.length).toBeLessThan(100);
    expect(answered.project_filter.name.endsWith('…')).toBe(true);

    // The refusal path: two projects whose names share the prefix, so neither is
    // resolved and both are listed back.
    const refused = (await searchCasesForRequester({ project: 'Programme y' }, ctx(MEMBER))) as {
      answered: boolean;
      project_filter: { candidates: { project_id: string; name: string }[] };
    };

    expect(refused.answered).toBe(false);
    expect(refused.project_filter.candidates.length).toBe(2);
    for (const candidate of refused.project_filter.candidates) {
      expect(candidate.name.length).toBeLessThan(100);
    }
    expect(JSON.stringify(refused).length).toBeLessThan(resolveAssistantBounds().maxToolResultChars);
  });
});

describe('arbitra_search_cases — a refusal is not a shape that reads as "no matches"', () => {
  type Shape = Record<string, unknown>;

  it('reports answered, the ordering and the limit on every refusal', async () => {
    seedProject('proj_docs', [MEMBER], 'Arbitra Core Docs');
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedCase({ case_id: 'case-mine' });

    const refusals = [
      await searchCasesForRequester({}, ctx('usr_nobody')),
      await searchCasesForRequester({ created_after: '2026-02-31', limit: 3 }, ctx(MEMBER)),
      await searchCasesForRequester({ cursor: 'not-a-cursor' }, ctx(MEMBER)),
      await searchCasesForRequester({ project: 'nothing like this' }, ctx(MEMBER)),
      await searchCasesForRequester({ project: 'arbitra', order_by: 'created_at' }, ctx(MEMBER)),
    ] as Shape[];

    for (const refusal of refusals) {
      expect(refusal.answered).toBe(false);
      expect(refusal.cases).toEqual([]);
      expect(typeof refusal.ordered_by).toBe('string');
      expect(refusal.order_direction).toBe('desc');
      expect(typeof refusal.limit).toBe('number');
    }
    // A date bound decides the axis even when the bound itself is refused.
    expect(refusals[1]!.ordered_by).toBe('created_at');
    expect(refusals[1]!.limit).toBe(3);
    // …and a search that genuinely found nothing is the one shape that answers.
    const empty = (await searchCasesForRequester({ query: 'nothing matches' }, ctx(MEMBER))) as Shape;
    expect(empty.answered).toBe(true);
    expect(empty.cases).toEqual([]);
  });

  /**
   * `answered: false` says the search did not run. It does not say what to do
   * next, and a real run showed why that gap matters: the refusal for a project
   * name that matches nothing IS the answer to a question scoped to that project,
   * and the model read it as a broken filter, dropped the filter and spent five
   * further calls sweeping unfiltered before it ran out of steps.
   */
  it('declares which class each refusal is, so the next move is not inferred from prose', async () => {
    seedProject('proj_docs', [MEMBER], 'Arbitra Core Docs');
    seedProject(MINE, [MEMBER], 'Arbitra Core');
    seedCase({ case_id: 'case-mine' });

    const classOf = (payload: unknown) => (payload as Shape)[READ_OUTCOME_KEY];

    // The answer class: nothing further to look for, because there is no project
    // to look in at all.
    expect(classOf(await searchCasesForRequester({}, ctx('usr_nobody')))).toBe('answer');

    // The invalid_call class: a corrected call answers, so "say it cannot be
    // done" would be wrong and so would abandoning the filter. A name that
    // matched nothing belongs here too — see the near-miss test below — because
    // "no project of yours is called that" is not the same statement as "no
    // project of yours is the one you meant".
    expect(classOf(await searchCasesForRequester({ project: 'Arbitra Core Ltd' }, ctx(MEMBER))))
      .toBe('invalid_call');
    expect(classOf(await searchCasesForRequester({ project: 'arbitra' }, ctx(MEMBER))))
      .toBe('invalid_call');
    expect(classOf(await searchCasesForRequester({ created_after: '2026-02-31' }, ctx(MEMBER))))
      .toBe('invalid_call');
    expect(classOf(await searchCasesForRequester({ cursor: 'not-a-cursor' }, ctx(MEMBER))))
      .toBe('invalid_call');

    // A search that ran declares nothing: no declaration IS the ok class, and a
    // successful payload keeps exactly the keys it always had.
    expect(classOf(await searchCasesForRequester({ query: 'nothing matches' }, ctx(MEMBER))))
      .toBeUndefined();
  });

  it('no longer answers an unknown project by inviting an unfiltered search', async () => {
    seedCase({ case_id: 'case-mine' });

    const refusal = (await searchCasesForRequester(
      { project: 'Arbitra Core Ltd' },
      ctx(MEMBER),
    )) as Shape;

    // The old message said "Repeat the call without `project`", which is the
    // sweep the model then performed — and which answers a different question.
    expect(refusal['message']).not.toMatch(/without `project`/);
    expect(refusal['message']).toMatch(/nothing to count/i);
    // Nor does it end the search: the requester HAS projects, so the call is
    // correctable and the correction is in the payload.
    expect(refusal[READ_OUTCOME_KEY]).toBe('invalid_call');
  });

  /**
   * A person says the words of a project's name, not its punctuation and not its
   * order. Id, exact name and substring all miss "Acme Atlas" against a visible
   * "Atlas (Acme)", and the miss used to be reported back as a name that matched
   * nothing — which is how a project with open cases becomes unfindable. Word
   * matching resolves it directly, so the candidate list stays the rare fallback.
   */
  it('resolves a name whose words are reordered and punctuated differently', async () => {
    seedProject('proj_atlas', [MEMBER], 'Atlas (Acme)');
    seedCase({ case_id: 'case-atlas', project_id: 'proj_atlas', status: 'open' });

    const result = (await searchCasesForRequester({ project: 'Acme Atlas' }, ctx(MEMBER))) as Shape;

    expect(result['project_filter']).toMatchObject({ resolved: 'proj_atlas' });
    expect((result['cases'] as { case_id: string }[]).map((c) => c.case_id))
      .toEqual(['case-atlas']);
  });

  it('still resolves one project when a sibling shares only some of the words', async () => {
    seedProject('proj_atlas', [MEMBER], 'Atlas (Acme)');
    seedProject('proj_atlas_2', [MEMBER], 'Atlas (Contoso)');
    seedCase({ case_id: 'case-atlas', project_id: 'proj_atlas' });
    seedCase({ case_id: 'case-contoso', project_id: 'proj_atlas_2' });

    const result = (await searchCasesForRequester({ project: 'atlas acme' }, ctx(MEMBER))) as Shape;

    // 'acme' is not a word of the Contoso project, so there is exactly one match
    // and no ambiguity to refuse.
    expect(result['project_filter']).toMatchObject({ resolved: 'proj_atlas' });
    expect((result['cases'] as { case_id: string }[]).map((c) => c.case_id))
      .toEqual(['case-atlas']);
  });

  it('does not resolve a name that is merely plausible', async () => {
    seedProject('proj_atlas', [MEMBER], 'Atlas (Acme)');
    seedCase({ case_id: 'case-atlas', project_id: 'proj_atlas' });

    // Every word must be in the name. 'Contoso' is in none of them, so the tier
    // that ignores order does not silently answer about the Acme project.
    const refusal = (await searchCasesForRequester(
      { project: 'Contoso Atlas' },
      ctx(MEMBER),
    )) as Shape;

    expect(refusal[READ_OUTCOME_KEY]).toBe('invalid_call');
    expect(refusal['project_filter']).toMatchObject({ reason: 'no_matching_project' });
    expect(refusal['cases']).toEqual([]);
  });

  /**
   * When a name still cannot be resolved, the refusal has to carry the correction:
   * the names to pick from, and whether that list is all of them.
   */
  it('treats an unresolvable project name as a correctable call and lists what to pick from', async () => {
    seedProject('proj_atlas', [MEMBER], 'Atlas (Acme)');
    seedCase({ case_id: 'case-atlas', project_id: 'proj_atlas', status: 'open' });

    const refusal = (await searchCasesForRequester(
      { project: 'Atlass Acmee' },
      ctx(MEMBER),
    )) as Shape;
    const filter = refusal['project_filter'] as {
      reason: string;
      candidates: { project_id: string; name: string }[];
      candidates_complete: boolean;
      candidates_total: number;
    };

    expect(refusal[READ_OUTCOME_KEY]).toBe('invalid_call');
    expect(filter.reason).toBe('no_matching_project');
    // The visible projects, so the next call can name one — and the fact that this
    // is all of them, which is what makes "no such project" conclusive when it is.
    expect(filter.candidates.map((c) => c.project_id)).toContain('proj_atlas');
    expect(filter.candidates_complete).toBe(true);
    // The Atlas project plus the requester's own from the shared setup.
    expect(filter.candidates_total).toBe(2);
    expect(refusal['message']).toMatch(/ALL of them/);
    expect(refusal['message']).toMatch(/project_id/);
    // The correction is IN the sentence the model acts on, not only in the sibling
    // array: every candidate name, verbatim, plus the imperative to take one. A
    // real run was handed the array and answered it by dropping the filter for a
    // free-text sweep.
    const message = refusal['message'] as string;
    for (const candidate of filter.candidates) {
      expect(message).toContain(`"${candidate.name}"`);
    }
    expect(message).toMatch(/Take ONE of those names verbatim/);
    // Correcting the call answers the question the miss was about.
    const corrected = (await searchCasesForRequester(
      { project: 'proj_atlas' },
      ctx(MEMBER),
    )) as Shape;
    expect((corrected['cases'] as { case_id: string }[]).map((c) => c.case_id))
      .toEqual(['case-atlas']);
  });

  /**
   * Past the echo bound the candidate list is a PREFIX of what the requester can
   * see, and the flag that said so was a field nobody was told to read: a model that
   * takes ten names for all of them reports a project it could not see in the list
   * as non-existent — the same defect the list was added to remove, one layer down.
   * So the guidance has to state what the partial list means and what to do next.
   */
  it('tells the model what a partial candidate list means instead of only flagging it', async () => {
    for (let i = 0; i < 14; i += 1) {
      seedProject(`proj_many_${i}`, [MEMBER], `Project ${i}`);
    }
    seedCase({ case_id: 'case-mine' });

    const refusal = (await searchCasesForRequester(
      { project: 'a name no project has' },
      ctx(MEMBER),
    )) as Shape;
    const filter = refusal['project_filter'] as {
      candidates: { project_id: string }[];
      candidates_complete: boolean;
      candidates_total: number;
    };
    const message = refusal['message'] as string;

    expect(filter.candidates).toHaveLength(10);
    expect(filter.candidates_complete).toBe(false);
    // 14 seeded here plus the requester's own project from the shared setup.
    expect(filter.candidates_total).toBe(15);
    // What the flag means, in words, with both counts …
    expect(message).toContain('candidates_complete is false');
    expect(message).toMatch(/only 10 of the 15 projects/);
    // … the conclusion it must NOT draw …
    expect(message).toMatch(/do NOT report it as non-existent/);
    // … the candidates in the sentence itself, verbatim, with the imperative …
    for (const candidate of filter.candidates as { name: string }[]) {
      expect(message).toContain(`"${candidate.name}"`);
    }
    expect(message).toMatch(/take its name verbatim/);
    // … and the two moves it can make instead.
    expect(message).toMatch(/exact project_id/);
    expect(message).toMatch(/distinctive part of the name/);
  });

  it('lists only the projects the requester can see, clipped, and says when it is a prefix', async () => {
    // Every name over the echo bound, so the clip is exercised whichever ten of
    // them the list happens to carry.
    for (let i = 0; i < 12; i += 1) {
      seedProject(`proj_many_${i}`, [MEMBER], `Project ${i} ${'o'.repeat(200)}`);
    }
    seedProject('proj_hidden', [STRANGER], 'Hidden Project');
    seedCase({ case_id: 'case-mine' });

    const refusal = (await searchCasesForRequester(
      { project: 'a name no project has' },
      ctx(MEMBER),
    )) as Shape;
    const filter = refusal['project_filter'] as {
      candidates: { project_id: string; name: string }[];
      candidates_complete: boolean;
    };

    // Bounded like every other echoed name: a project name has no length limit,
    // and an unclipped list of them would push the payload past the per-call cap
    // into a textual clip the model cannot parse.
    expect(filter.candidates).toHaveLength(10);
    expect(filter.candidates_complete).toBe(false);
    expect(filter.candidates.every((c) => c.name.length <= 80)).toBe(true);
    expect(filter.candidates.some((c) => c.name.endsWith('…'))).toBe(true);
    // And nothing outside the requester's scope is named.
    expect(filter.candidates.map((c) => c.project_id)).not.toContain('proj_hidden');
    // The refusal still fits the per-call result cap it is measured against.
    expect(JSON.stringify(refusal).length)
      .toBeLessThan(resolveAssistantBounds().maxToolResultChars);
  });

  it('classifies a case the requester may not see as the answer about that case', async () => {
    seedCase({ case_id: 'case-theirs', project_id: THEIRS });

    const result = (await readCaseForRequester({ case_id: 'case-theirs' }, ctx(MEMBER))) as Shape;

    expect(result['found']).toBe(false);
    expect(result[READ_OUTCOME_KEY]).toBe('answer');
  });

  it('echoes the status and query filters it applied, and reports the sort direction', async () => {
    seedCase({ case_id: 'case-mine', status: 'done', title: 'Invoice export' });

    const result = (await searchCasesForRequester(
      { status: 'done', query: 'invoice' },
      ctx(MEMBER),
    )) as Shape;

    expect(result.status_filter).toBe('done');
    expect(result.query_filter).toBe('invoice');
    expect(result.order_direction).toBe('desc');

    const unfiltered = (await searchCasesForRequester({}, ctx(MEMBER))) as Shape;
    expect(unfiltered.status_filter).toBeNull();
    expect(unfiltered.query_filter).toBeNull();
  });
});

/**
 * Both the accessible-project set and the project names used to come from their
 * own full read of the projects collection — two unbounded reads per search for a
 * member, one for an admin, before a single case was touched. The tool's wall
 * clock is bounded, so on a large workspace that was the term that timed out.
 */
describe('arbitra_search_cases — project lookups are bounded', () => {
  function projectCollectionReads(): number {
    return queryReads.filter((name) => name === 'projects').length;
  }

  it('reads the projects collection once for a member, not once per purpose', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE });

    const result = (await searchCasesForRequester({}, ctx(MEMBER))) as {
      cases: { project_name: string | null }[];
    };

    expect(result.cases[0]!.project_name).toBe(MINE);
    expect(projectCollectionReads()).toBe(1);
  });

  it('names an admin’s rows from the projects on the page instead of the whole collection', async () => {
    for (let i = 0; i < 40; i += 1) {
      seedProject(`proj_${String(i).padStart(2, '0')}`, [STRANGER], `Project ${i}`);
    }
    seedCase({ case_id: 'case-one', project_id: 'proj_00' });
    seedCase({ case_id: 'case-two', project_id: 'proj_01' });

    const result = (await searchCasesForRequester({}, ctx(ADMIN))) as {
      cases: { project_name: string | null }[];
    };

    expect(result.cases.map((c) => c.project_name).sort()).toEqual(['Project 0', 'Project 1']);
    expect(projectCollectionReads()).toBe(0);
    expect(documentReads.filter((path) => path.startsWith('projects/')).length).toBe(2);
  });

  /**
   * The schema requires a non-empty `project`, but ' ' satisfies it and trims to
   * nothing. Every other reason this tool can give for an unresolved project is a
   * statement about the project pool — nothing matched, several matched, the pool is
   * too large to scan by name — and none of them is true of a call that carries no
   * name: there was nothing to match and nothing to scan for. The call is still
   * correctable, so the class stays `invalid_call`; only the reason has to be true.
   */
  it('gives an admin’s blank project name a reason that is true of the call', async () => {
    seedProject('proj_target', [STRANGER], 'Target Project');

    const result = (await searchCasesForRequester({ project: ' ' }, ctx(ADMIN))) as {
      project_filter: { reason?: string } | null;
      message?: string;
      [key: string]: unknown;
    };

    expect(result[READ_OUTCOME_KEY]).toBe('invalid_call');
    expect(result.project_filter).toMatchObject({ reason: 'blank_project_name' });
    expect(result.message).toMatch(/blank/i);
    // And it does not turn a blank filter into a claim about the workspace.
    expect(result.message).toMatch(/says nothing about which projects exist/i);
    // Nothing to scan for, so nothing is scanned.
    expect(projectCollectionReads()).toBe(0);
  });

  /**
   * The same call in a workspace past the scan cap used to be answered with "this
   * workspace holds more projects than this tool scans by name" — false about a call
   * that has no name to scan, and a `failed` class where the correction (say what
   * project you mean) was available all along. The cap is about names; a blank
   * filter never reaches it.
   */
  it('does not blame the scan cap for a blank project name', async () => {
    for (let i = 0; i < 210; i += 1) {
      seedProject(`proj_${String(i).padStart(3, '0')}`, [STRANGER], `Project ${i}`);
    }

    const result = (await searchCasesForRequester({ project: '   ' }, ctx(ADMIN))) as {
      project_filter: { reason?: string } | null;
      message?: string;
      [key: string]: unknown;
    };

    expect(result.project_filter).toMatchObject({ reason: 'blank_project_name' });
    expect(result[READ_OUTCOME_KEY]).toBe('invalid_call');
    expect(result.message).not.toMatch(/too large|more projects than/i);
  });

  it('answers an admin with no projects at all rather than asking for a correction', async () => {
    collectionStore('projects').clear();

    const result = (await searchCasesForRequester({ project: 'Anything' }, ctx(ADMIN))) as {
      project_filter: { reason?: string } | null;
      [key: string]: unknown;
    };

    // Nothing exists to correct the call against, so the refusal IS the answer.
    expect(result[READ_OUTCOME_KEY]).toBe('answer');
    expect(result.project_filter).toMatchObject({ reason: 'no_accessible_projects' });
  });

  it('resolves an admin’s project by id with one document read and no scan', async () => {
    seedProject('proj_target', [STRANGER], 'Target Project');
    seedCase({ case_id: 'case-target', project_id: 'proj_target' });

    const result = (await searchCasesForRequester({ project: 'proj_target' }, ctx(ADMIN))) as {
      cases: { case_id: string }[];
      project_filter: { resolved: string | null } | null;
    };

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-target']);
    expect(result.project_filter).toMatchObject({ resolved: 'proj_target' });
    expect(projectCollectionReads()).toBe(0);
  });

  it('still resolves an admin’s project by name, through the capped scan', async () => {
    seedProject('proj_target', [STRANGER], 'Target Project');
    seedCase({ case_id: 'case-target', project_id: 'proj_target' });

    const result = (await searchCasesForRequester({ project: 'Target Project' }, ctx(ADMIN))) as {
      cases: { case_id: string }[];
      project_filter: { resolved: string | null } | null;
    };

    expect(result.cases.map((c) => c.case_id)).toEqual(['case-target']);
    expect(result.project_filter).toMatchObject({ resolved: 'proj_target' });
  });

  /**
   * Past the scan cap the name cannot be resolved and the model has no route to a
   * project_id: no tool lists projects, and a search row carries `project_name`
   * only. So this is not a call it can correct — `invalid_call` would send it
   * guessing ids until its allowance is gone — it is a request that cannot be
   * served as scoped, which is what `failed` says.
   */
  it('reports a name it could not scan far enough to resolve as a request it cannot serve', async () => {
    for (let i = 0; i < 210; i += 1) {
      seedProject(`proj_${String(i).padStart(3, '0')}`, [STRANGER], `Project ${i}`);
    }

    const result = (await searchCasesForRequester(
      { project: 'a name no project has' },
      ctx(ADMIN),
    )) as {
      answered: boolean;
      project_filter: { reason?: string } | null;
      message?: string;
      [key: string]: unknown;
    };

    expect(result.answered).toBe(false);
    expect(result.project_filter).toMatchObject({
      reason: 'too_many_projects_to_match_by_name',
    });
    expect(result[READ_OUTCOME_KEY]).toBe('failed');
    // What the model can actually do: say the project could not be identified. The
    // message may name `project_id` as what the REQUESTER could supply, never as a
    // correction the model is expected to make on its own.
    expect(result.message).toContain('project_id');
    expect(result.message).toMatch(/no way to list them/i);
    expect(result.message).not.toMatch(/repeat the call/i);
  });
});

describe('arbitra_get_case — one indistinguishable answer for absent and forbidden', () => {
  it('returns the case for a member', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE, title: 'Mine' });

    const result = (await readCaseForRequester({ case_id: 'case-mine' }, ctx(MEMBER))) as {
      found: boolean;
      case: { title: string };
    };

    expect(result.found).toBe(true);
    expect(result.case.title).toBe('Mine');
  });

  it('gives a non-member the same answer as for a case that does not exist', async () => {
    seedCase({ case_id: 'case-theirs', project_id: THEIRS });

    const forbidden = await readCaseForRequester({ case_id: 'case-theirs' }, ctx(MEMBER));
    const absent = await readCaseForRequester({ case_id: 'case-nope' }, ctx(MEMBER));

    expect(forbidden).toEqual(absent);
    expect(forbidden).toMatchObject({ found: false });
  });

  it('treats a soft-deleted case as invisible', async () => {
    seedCase({ case_id: 'case-gone', project_id: MINE, deleted_at: '2026-08-02T00:00:00.000Z' });

    const result = await readCaseForRequester({ case_id: 'case-gone' }, ctx(MEMBER));

    expect(result).toMatchObject({ found: false });
  });

  it('summarises timeline event types and evidence without dumping payloads', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE });
    collectionStore('case_events').set('evt_1', {
      event_id: 'evt_1',
      case_id: 'case-mine',
      type: 'case_created',
      actor_id: MEMBER,
      payload: { secret_note: 'do-not-leak' },
      created_at: '2026-08-01T01:00:00.000Z',
    });
    collectionStore('evidence').set('ev_1', {
      evidence_id: 'ev_1',
      case_id: 'case-mine',
      type: 'unit_test_result',
      source_type: 'automated',
      summary: '12 passed',
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-08-01T02:00:00.000Z',
      created_by: MEMBER,
    });

    const result = (await readCaseForRequester({ case_id: 'case-mine' }, ctx(MEMBER))) as {
      recent_events: { type: string }[];
      evidence: { type: string }[];
    };

    expect(result.recent_events).toEqual([
      { type: 'case_created', created_at: '2026-08-01T01:00:00.000Z' },
    ]);
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
    expect(result.evidence[0]!.type).toBe('unit_test_result');
  });

  /**
   * The case document has no completion timestamp, which is why the search must
   * not claim to order by one. The moment is not lost though: a completing case
   * records it, so this read can report it for one case — and that is what makes
   * "the most recently completed" answerable at all.
   */
  it('reports when the case completed, derived from its history', async () => {
    seedCase({ case_id: 'case-done', project_id: MINE, status: 'done' });
    seedCompletion('case-done', '2026-08-04T17:45:00.000Z');

    const result = (await readCaseForRequester({ case_id: 'case-done' }, ctx(MEMBER))) as {
      completed_at: string | null;
    };

    expect(result.completed_at).toBe('2026-08-04T17:45:00.000Z');
  });

  it('reports null rather than guessing when no completion was ever recorded', async () => {
    seedCase({ case_id: 'case-open', project_id: MINE, status: 'in_build' });

    const result = (await readCaseForRequester({ case_id: 'case-open' }, ctx(MEMBER))) as {
      completed_at: string | null;
    };

    expect(result.completed_at).toBeNull();
  });

  /** The completion is read from the full history, not from the truncated tail. */
  it('finds the completion of a case with more events than it reports back', async () => {
    seedCase({ case_id: 'case-busy', project_id: MINE, status: 'done' });
    seedCompletion('case-busy', '2026-08-01T10:00:00.000Z');
    for (let i = 0; i < 20; i += 1) {
      collectionStore('case_events').set(`evt_chatter_${i}`, {
        event_id: `evt_chatter_${i}`,
        case_id: 'case-busy',
        type: 'comment_added',
        actor_id: MEMBER,
        payload: {},
        created_at: `2026-08-02T${String(i).padStart(2, '0')}:00:00.000Z`,
      });
    }

    const result = (await readCaseForRequester({ case_id: 'case-busy' }, ctx(MEMBER))) as {
      completed_at: string | null;
      recent_events: { type: string }[];
    };

    expect(result.recent_events.length).toBe(15);
    expect(result.recent_events.some((event) => event.type === 'case_completed')).toBe(false);
    expect(result.completed_at).toBe('2026-08-01T10:00:00.000Z');
  });
});

/**
 * Legacy assistant rows created before the completion-event invariant can be
 * `done` without a recorded `case_completed` event. For compatibility,
 * `completed_at` null therefore still covers two opposite situations: the case
 * never finished, or it finished and the moment was never written down.
 *
 * Left as a bare null they are indistinguishable from each other and from an
 * older real timestamp, and a reader asked for "the most recently completed one"
 * reads null for the newer case, sorts it last or discards it as unfinished, and
 * names the older case while presenting it as the most recent. The read therefore
 * states which of the three it is, and says outright what the null means in the
 * one situation where the answer is "unknown".
 */
describe('arbitra_get_case — a missing completion time is stated, not left as a null', () => {
  it('marks a recorded completion as recorded and adds no note', async () => {
    seedCase({ case_id: 'case-done', project_id: MINE, status: 'done' });
    seedCompletion('case-done', '2026-08-04T17:30:00.000Z');

    const result = (await readCaseForRequester({ case_id: 'case-done' }, ctx(MEMBER))) as {
      completed_at: string | null;
      completion_time: string;
      completed_at_note?: string;
    };

    expect(result.completed_at).toBe('2026-08-04T17:30:00.000Z');
    expect(result.completion_time).toBe('recorded');
    expect(result.completed_at_note).toBeUndefined();
  });

  it('separates "done but never written down" from "not finished"', async () => {
    seedCase({
      case_id: 'case-assistant',
      project_id: MINE,
      status: 'done',
      case_type: 'assistant_task',
    });
    seedCase({ case_id: 'case-running', project_id: MINE, status: 'in_build' });

    const done = (await readCaseForRequester({ case_id: 'case-assistant' }, ctx(MEMBER))) as {
      completed_at: string | null;
      completion_time: string;
      completed_at_note?: string;
    };
    const running = (await readCaseForRequester({ case_id: 'case-running' }, ctx(MEMBER))) as {
      completed_at: string | null;
      completion_time: string;
      completed_at_note?: string;
    };

    expect(done.completed_at).toBeNull();
    expect(done.completion_time).toBe('not_recorded');
    expect(done.completed_at_note).toContain('UNKNOWN');
    expect(done.completed_at_note).toContain('not recorded');

    expect(running.completed_at).toBeNull();
    expect(running.completion_time).toBe('not_completed');
    expect(running.completed_at_note).toBeUndefined();
    // Same null, different account of it — which is the whole point.
    expect(running.completion_time).not.toBe(done.completion_time);
  });

  /**
   * The ranking question, with the legacy-row shape that used to answer it
   * wrongly: an assistant task finished at 19:45 before its route emitted a
   * completion event, while an ordinary case finished at 17:30 with one. Ranking
   * by `completed_at` alone puts the 17:30 case first and calls it the most recent.
   */
  it('lets a reader tell "no time" apart from an older time when ranking by completion', async () => {
    seedCase({
      case_id: 'case-assistant-1945',
      project_id: MINE,
      status: 'done',
      case_type: 'assistant_task',
    });
    seedCase({ case_id: 'case-ordinary-1730', project_id: MINE, status: 'done' });
    seedCompletion('case-ordinary-1730', '2026-08-04T17:30:00.000Z');

    const rows = await Promise.all(
      ['case-assistant-1945', 'case-ordinary-1730'].map(
        async (caseId) =>
          (await readCaseForRequester({ case_id: caseId }, ctx(MEMBER))) as {
            case: { case_id: string };
            completed_at: string | null;
            completion_time: string;
          },
      ),
    );

    const rankable = rows.filter((row) => row.completion_time === 'recorded');
    const unrankable = rows.filter((row) => row.completion_time === 'not_recorded');

    expect(rankable.map((row) => row.case.case_id)).toEqual(['case-ordinary-1730']);
    expect(unrankable.map((row) => row.case.case_id)).toEqual(['case-assistant-1945']);
    // Nothing here recovers the 19:45 moment — it was never written down. What the
    // payload does provide is the reason to say so instead of naming 17:30.
    expect(unrankable[0]!.completed_at).toBeNull();
  });
});

describe('arbitra_search_knowledge — the same visibility rule as GET /api/knowledge', () => {
  it('shows project-scoped assets only for accessible projects', async () => {
    seedKnowledge({ knowledge_id: 'ka_mine', scope_ref: MINE, title: 'Mine' });
    seedKnowledge({ knowledge_id: 'ka_theirs', scope_ref: THEIRS, title: 'Theirs' });

    const result = (await searchKnowledgeForRequester({}, ctx(MEMBER))) as {
      assets: { knowledge_id: string }[];
    };

    expect(result.assets.map((a) => a.knowledge_id)).toEqual(['ka_mine']);
  });

  it('resolves repo-scoped assets through the repository’s project, and fails closed', async () => {
    collectionStore('repositories').set('repo_mine', {
      repository_id: 'repo_mine',
      project_id: MINE,
    });
    collectionStore('repositories').set('repo_theirs', {
      repository_id: 'repo_theirs',
      project_id: THEIRS,
    });
    seedKnowledge({ knowledge_id: 'ka_repo_mine', scope_type: 'repo', scope_ref: 'repo_mine' });
    seedKnowledge({ knowledge_id: 'ka_repo_theirs', scope_type: 'repo', scope_ref: 'repo_theirs' });
    seedKnowledge({ knowledge_id: 'ka_repo_orphan', scope_type: 'repo', scope_ref: 'repo_gone' });

    const result = (await searchKnowledgeForRequester({}, ctx(MEMBER))) as {
      assets: { knowledge_id: string }[];
    };

    expect(result.assets.map((a) => a.knowledge_id)).toEqual(['ka_repo_mine']);
  });

  it('shows global assets to everyone, as the route does', async () => {
    seedKnowledge({ knowledge_id: 'ka_global', scope_type: 'global', scope_ref: '*' });

    const result = (await searchKnowledgeForRequester({}, ctx(STRANGER))) as {
      assets: { knowledge_id: string }[];
    };

    expect(result.assets.map((a) => a.knowledge_id)).toEqual(['ka_global']);
  });

  it('filters by type and free text', async () => {
    seedKnowledge({ knowledge_id: 'ka_1', type: 'pattern', title: 'Retry with backoff' });
    seedKnowledge({ knowledge_id: 'ka_2', type: 'precedent', title: 'Waiver for legacy import' });

    const byType = (await searchKnowledgeForRequester({ type: 'precedent' }, ctx(MEMBER))) as {
      assets: { knowledge_id: string }[];
    };
    expect(byType.assets.map((a) => a.knowledge_id)).toEqual(['ka_2']);

    const byText = (await searchKnowledgeForRequester({ query: 'backoff' }, ctx(MEMBER))) as {
      assets: { knowledge_id: string }[];
    };
    expect(byText.assets.map((a) => a.knowledge_id)).toEqual(['ka_1']);
  });

  /**
   * The prompt's rule that an empty result is a COMPLETE "none" has to be keyed on
   * a field this read returns, or the model is left to widen its terms on the one
   * tool the rule does not reach. It was keyed on `has_more`, which is not in this
   * payload at all.
   */
  it('says an empty result is empty in the field the prompt keys that rule on', async () => {
    const empty = (await searchKnowledgeForRequester({ query: 'nothing matches' }, ctx(MEMBER))) as {
      assets: unknown[];
      total_returned: number;
    };

    expect(empty.assets).toEqual([]);
    expect(empty.total_returned).toBe(0);
  });
});

/**
 * The failure this tool exists for: `arbitra_search_knowledge` found the roster
 * asset's id and title, and nothing could read its content — the model burned
 * its remaining step budget on detours instead of answering. These tests pin
 * the two properties that make `arbitra_get_knowledge` the fix: it hands back
 * `body` verbatim, and it enforces exactly the same visibility rule as search
 * rather than a second, possibly-diverging one.
 */
describe('arbitra_get_knowledge — reads what search can only summarise', () => {
  it('returns the body verbatim for an asset the requester may see', async () => {
    seedKnowledge({
      knowledge_id: 'ka_mine',
      scope_ref: MINE,
      title: 'Mine',
      body: 'The full body text nobody could previously read.',
    });

    const result = (await getKnowledgeForRequester(
      { knowledge_id: 'ka_mine' },
      ctx(MEMBER),
    )) as {
      found: boolean;
      asset: { knowledge_id: string; body: string };
    };

    expect(result.found).toBe(true);
    expect(result.asset.knowledge_id).toBe('ka_mine');
    expect(result.asset.body).toBe('The full body text nobody could previously read.');
  });

  /**
   * Same shape `readCaseForRequester` uses for "absent" vs. "not yours": a
   * requester must not be able to tell the two apart by calling this tool,
   * which would leak that a knowledge asset exists in a scope they cannot see.
   */
  it('gives a requester without project access the same refusal as a nonexistent id', async () => {
    seedKnowledge({ knowledge_id: 'ka_theirs', scope_ref: THEIRS, title: 'Theirs' });

    const notVisible = await getKnowledgeForRequester({ knowledge_id: 'ka_theirs' }, ctx(MEMBER));
    const notFound = await getKnowledgeForRequester({ knowledge_id: 'ka_missing' }, ctx(MEMBER));

    expect(notVisible).toEqual(notFound);
    expect(notVisible).toMatchObject({ found: false });
  });
});

describe('read tools cannot mutate anything', () => {
  it('completes every read against a Firestore double whose write surface throws', async () => {
    seedCase({ case_id: 'case-mine', project_id: MINE });
    seedKnowledge({ knowledge_id: 'ka_mine' });

    // Any set/update/create/delete — or opening a transaction — throws in this
    // double, so these four resolving is the assertion.
    await expect(searchCasesForRequester({}, ctx(MEMBER))).resolves.toBeDefined();
    await expect(readCaseForRequester({ case_id: 'case-mine' }, ctx(MEMBER))).resolves.toBeDefined();
    await expect(searchKnowledgeForRequester({}, ctx(MEMBER))).resolves.toBeDefined();
    await expect(
      getKnowledgeForRequester({ knowledge_id: 'ka_mine' }, ctx(MEMBER)),
    ).resolves.toBeDefined();
  });
});
