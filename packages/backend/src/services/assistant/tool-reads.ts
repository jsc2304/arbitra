import type { Case, CaseEvent, KnowledgeAsset } from '@arbitra/shared';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { collections } from '../../lib/firestore.js';
import {
  checkCaseAccess,
  checkIsAdmin,
  getAccessibleProjectIds,
  getAccessibleProjects,
} from '../../lib/project-access.js';
import { resolveAssistantBounds } from './assistant-bounds.js';
import { classifiedRefusal, type ToolReadOutcome } from './tool-outcomes.js';
import type {
  CountCaseTransitionsInput,
  CountCasesInput,
  GetCaseInput,
  GetKnowledgeInput,
  SearchCasesInput,
  SearchKnowledgeInput,
  ToolReadContext,
  ToolReadPayload,
} from './tool-registry.js';

/**
 * The Arbitra reads Clerk's tools are built on.
 *
 * ## Access is the requester's, never the system's
 *
 * The run executes under a system actor, but a tool must never see more than the
 * human who asked. Every function here resolves what the *requester* may see
 * through the same helpers the HTTP routes use — `checkCaseAccess`,
 * `checkIsAdmin`, `getAccessibleProjectIds`, `isEffectiveMember` (transitively)
 * — instead of reading Firestore unscoped and filtering afterwards. A tool that
 * returned cases the requester may not see would be a data leak dressed as a
 * feature, and it would be invisible in the trace, because the trace records
 * that a search happened, not what the search was allowed to touch.
 *
 * ## Read-only by construction
 *
 * Nothing in this module calls `set`, `update`, `create`, `delete` or opens a
 * transaction. `tool-reads.test.ts` runs every read against a Firestore double
 * whose write surface throws, so a mutation added later fails the suite rather
 * than production.
 */

/** Hard ceiling per call, independent of what the model asks for. */
const MAX_RESULTS = 25;
const DEFAULT_RESULTS = 8;

/** Firestore allows at most 30 values in an `in` clause. */
const IN_CLAUSE_CHUNK = 30;

/** Timeline events and evidence rows summarised for one case read. */
const MAX_CASE_EVENTS = 15;
const MAX_CASE_EVIDENCE = 15;

/**
 * The event a case records when it completes. Nothing writes a completion
 * timestamp onto the case document, but the moment is not lost: this event
 * carries it, so `arbitra_get_case` can report a real completion time for one
 * case. It stays out of `CASE_ORDER_FIELDS` because it lives in another
 * collection, which no Firestore query can sort a case search by.
 */
const CASE_COMPLETED_EVENT = 'case_completed';

/**
 * The event a case records when it is permanently rejected. Paired with
 * `CASE_COMPLETED_EVENT` as the two transitions `countCaseTransitionsForRequester`
 * counts — together they are every way a case leaves the pipeline for good.
 */
const CASE_REJECTED_EVENT = 'case_rejected';

/** The status a case that finished its lifecycle carries. */
const DONE_STATUS = 'done';

/**
 * Why a case read carries no completion time, distinguished from carrying one.
 *
 * Legacy rows written before every route into `done` emitted `case_completed`
 * can still carry a null `completed_at` despite having finished. That calls for
 * the opposite handling from a case that never finished: the first makes a
 * completion ranking unanswerable for that case, while the second excludes it.
 * A bare null cannot distinguish them, so the read retains the three-state
 * compatibility contract instead of deriving a timestamp that was never recorded.
 */
type CompletionTimeState = 'recorded' | 'not_recorded' | 'not_completed';

const COMPLETION_NOT_RECORDED_NOTE =
  'This case is done, but its history carries no completion event, so Arbitra has no completion '
  + 'time for it. completed_at null here means the time is UNKNOWN — not that the case is '
  + 'unfinished, and not that it finished before a case that does have a time. Do not rank this '
  + 'case against others by completion; report that its completion time is not recorded.';

/**
 * Timestamps a case search may sort by — the only two a case document actually
 * carries. There is deliberately no `completed_at`: it is not a field on a case,
 * so ordering by one would mean inventing a field, and a search that sorted by
 * an invented field would hand the model a confident wrong answer instead of an
 * honest approximation. `SEARCH_CASES_TOOL` spells out what `updated_at` does
 * and does not mean, and points at the call that does know when a case finished.
 */
export const CASE_ORDER_FIELDS = ['created_at', 'updated_at'] as const;

export type CaseOrderField = (typeof CASE_ORDER_FIELDS)[number];

/**
 * The literal that means "the requester themselves" wherever the `owner`
 * filter would otherwise need the requester's own user id spelled out (#950).
 */
export const CASE_OWNER_CURRENT = 'current' as const;

/** Which raw user id an `owner` filter value resolves to for this requester. */
function resolveOwnerFilter(owner: string | undefined, requesterUserId: string): string | undefined {
  if (owner === undefined) return undefined;
  return owner === CASE_OWNER_CURRENT ? requesterUserId : owner;
}

/** Candidates fetched per page so the in-memory text filter has something to cut. */
const OVER_FETCH_FACTOR = 4;

/**
 * How many projects a failed name resolution lists back — the candidates of an
 * ambiguous name, or the projects to pick from when nothing matched.
 */
const MAX_PROJECT_CANDIDATES = 10;

/**
 * Longest case title a search row carries.
 *
 * Titles are bounded at 500 characters, and a default page of ten long ones plus
 * the trailer exceeds the per-call result cap — where the overflow behaviour is
 * a *textual* clip of the serialised payload, so the model receives a half-open
 * JSON string with no rows it can parse, no `has_more` and no cursor. An elided
 * title costs a few words at the end of a sentence; an unparsable page costs the
 * answer and a retry. The projection is trimmed for the same reason: every row
 * key is one the plan the tool exists to enable actually reads.
 */
const MAX_ROW_TITLE_CHARS = 120;

/**
 * Longest project name this tool echoes back, in a row or in a refusal.
 *
 * A project name has no length bound at all (`project-validators.ts` requires
 * only a non-empty string), so it is the same hazard as an unclipped title and
 * one the row budget cannot absorb: the name appears in the `project_filter`
 * echo, which the shortening keeps whatever happens, and an ambiguous-name
 * refusal lists up to `MAX_PROJECT_CANDIDATES` of them with no rows to trade
 * away. Clipped, so no single Firestore string can push a page — or a refusal —
 * past the cap into a textual clip.
 */
const MAX_PROJECT_NAME_CHARS = 80;

/**
 * How much of the per-call result cap a successful page may spend, in total.
 *
 * The cap is enforced one layer up, and its overflow behaviour is a *textual*
 * clip of the serialised payload — the model gets a half-open JSON string with no
 * rows it can parse, no `has_more` and no cursor, and its only way out is the
 * retry this tool exists to save. Deciding here how many rows fit turns that into
 * an ordinary short page: one that says how many rows it dropped and hands back a
 * cursor for them. The share leaves the layer above a margin so the two never
 * disagree over a byte.
 *
 * The budget covers the WHOLE payload, rows and everything else, and the page is
 * measured against it whole — see `largestFittingPayload`. It deliberately does
 * not hold a fixed number of characters back for the non-row part: that number
 * would have to keep matching a serialised shape it does not contain, and every
 * note, bound, echo and cursor added since would have widened the shape without
 * moving the constant.
 */
const RESULT_BUDGET_SHARE = 0.95;

/**
 * Projects an admin's `project` name lookup may scan.
 *
 * An admin has no in-memory project list to match a name against, so resolving
 * one needs the collection — which is unbounded. Reading all of it was the
 * dominant term in this tool's wall clock, and that wall clock is itself bounded
 * (`tool_call_limit`), so an unbounded scan can turn an answerable question into
 * a timeout on a large workspace. Past the cap an unresolved name is reported as
 * such instead of being answered from whichever projects came back first.
 */
const ADMIN_PROJECT_SCAN_LIMIT = 200;

/**
 * `FieldPath.documentId()` in string form: the tiebreak Firestore applies to
 * every query anyway, appended to each composite index in the direction of its
 * last field. Ordering by it explicitly is what makes the page boundary
 * expressible as a cursor; it needs no index that does not already exist.
 */
const DOCUMENT_ID_FIELD = '__name__';

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_RESULTS;
  if (!Number.isInteger(requested) || requested < 1) return DEFAULT_RESULTS;
  return Math.min(requested, MAX_RESULTS);
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push([...values.slice(i, i + size)]);
  }
  return out;
}

/**
 * Best-effort user id → display name lookup for the `owner`/`assigned_reviewer`
 * fields (#950), batched once per call rather than once per row.
 *
 * Never widens what a case exposes: it reads exactly one field —
 * `display_name` — off each user document, the same field
 * `case-export-service.ts`'s equivalent lookup uses, and nothing else (no
 * `email`, no roles, no avatar). A user id with no document, or a document
 * whose `display_name` is missing or blank, is simply absent from the
 * returned map — callers fall back to the raw id themselves, per #950's
 * "fall back to the id rather than omitting the field". A Firestore error
 * still propagates to the caller; there is no try/catch here.
 */
async function resolveDisplayNames(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const refs = unique.map((id) => collections.users().doc(id));
  const docs = await collections.users().firestore.getAll(...refs);
  for (const doc of docs) {
    if (!doc.exists) continue;
    const displayName = (doc.data() as { display_name?: unknown } | undefined)?.display_name;
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      names.set(doc.id, displayName);
    }
  }
  return names;
}

/** The resolved display name for a user id, or the id itself when none is on record. */
function displayNameOf(userId: string, names: ReadonlyMap<string, string>): string {
  return names.get(userId) ?? userId;
}

/** Case-insensitive substring match over the fields a search may look at. */
function matchesQuery(query: string | undefined, ...fields: (string | undefined)[]): boolean {
  if (!query || query.trim() === '') return true;
  const needle = query.trim().toLowerCase();
  return fields.some((field) => (field ?? '').toLowerCase().includes(needle));
}

/**
 * Compare two strings the way Firestore orders them: by code unit, not by
 * locale.
 *
 * `String#localeCompare` puts 'a' before 'B' and ignores some punctuation
 * outright, so an in-memory page ordered with it can disagree with the order the
 * cursor resumes in — and a disagreement there means rows served twice or never
 * served at all. Every value compared here (ISO timestamps, case ids) is ASCII,
 * where code-unit order and the UTF-8 byte order Firestore uses coincide.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LEADING_DAY = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Normalise a date bound to the exact shape `created_at` is stored in.
 *
 * Case timestamps are `Date#toISOString()` output and are compared by byte order
 * in Firestore, so a bound must carry milliseconds or the comparison silently
 * shifts: `'…T10:00:00Z' > '…T10:00:00.000Z'` is true because `'Z'` sorts after
 * `'.'`, which would drop every case created in that second from a `>=` lower
 * bound.
 *
 * A bare `YYYY-MM-DD` is widened to the whole UTC day so that passing the same
 * date as both bounds means "created on that day".
 *
 * The calendar day is validated first, whatever shape the bound arrives in.
 * `new Date('2026-04-31T23:59:59Z')` is 1 May rather than an error, so checking
 * only the bare-day form would refuse `2026-04-31` by name while answering a
 * silently different question for `2026-04-31T23:59:59Z` — the same input
 * mistake with two behaviours.
 */
function normaliseDateBound(raw: string, edge: 'lower' | 'upper'): string | undefined {
  const value = raw.trim();
  const day = LEADING_DAY.exec(value)?.[1];
  if (day === undefined) return undefined;
  const asDay = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(asDay.getTime())) return undefined;
  if (!asDay.toISOString().startsWith(day)) return undefined;
  if (DATE_ONLY.test(value)) {
    return edge === 'lower' ? `${day}T00:00:00.000Z` : `${day}T23:59:59.999Z`;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  return instant.toISOString();
}

interface CreatedBounds {
  after?: string;
  before?: string;
}

/** The offending input field, so a rejection can name it without echoing its value. */
type CreatedBoundsError = { invalidField: 'created_after' | 'created_before' };

function resolveCreatedBounds(
  input: Pick<SearchCasesInput, 'created_after' | 'created_before'>,
): CreatedBounds | CreatedBoundsError {
  const bounds: CreatedBounds = {};
  if (input.created_after !== undefined) {
    const after = normaliseDateBound(input.created_after, 'lower');
    if (!after) return { invalidField: 'created_after' };
    bounds.after = after;
  }
  if (input.created_before !== undefined) {
    const before = normaliseDateBound(input.created_before, 'upper');
    if (!before) return { invalidField: 'created_before' };
    bounds.before = before;
  }
  return bounds;
}

/** The offending input field for the transition-count tool's own date pair. */
type OccurredBoundsError = { invalidField: 'occurred_after' | 'occurred_before' };

/**
 * Same grammar and the same widening rule as `resolveCreatedBounds`, applied
 * to `occurred_after`/`occurred_before` instead — the moment a transition
 * EVENT was recorded, not when its case was created.
 */
function resolveOccurredBounds(
  input: Pick<CountCaseTransitionsInput, 'occurred_after' | 'occurred_before'>,
): CreatedBounds | OccurredBoundsError {
  const bounds: CreatedBounds = {};
  if (input.occurred_after !== undefined) {
    const after = normaliseDateBound(input.occurred_after, 'lower');
    if (!after) return { invalidField: 'occurred_after' };
    bounds.after = after;
  }
  if (input.occurred_before !== undefined) {
    const before = normaliseDateBound(input.occurred_before, 'upper');
    if (!before) return { invalidField: 'occurred_before' };
    bounds.before = before;
  }
  return bounds;
}

/**
 * A row's position in the total order the search pages by.
 *
 * A timestamp alone is not a position. Any batch write leaves many cases sharing
 * one `updated_at` — a migration, a seeded environment, the bulk status sweep in
 * `scripts/cleanup-zombie-intelligence-cases.ts` — and a boundary that cannot
 * separate tied rows can only be resumed by counting how far into the tie the
 * previous page got. That count is bounded by the fetch window, so a tie deeper
 * than one window stops advancing: pages repeat, the rows below the window
 * become unreachable, and `has_more` stays true forever.
 *
 * The document id makes the boundary total, and it is exactly the tiebreak
 * Firestore already applies (`__name__`, in the direction of the last sort key),
 * so `startAfter(value, docId)` resumes precisely after the row last served — at
 * any tie depth, with nothing to count.
 */
interface RowKey {
  value: string;
  docId: string;
}

/** One fetched case with its page position. */
interface CollectedRow {
  key: RowKey;
  case_: Case;
}

/** Descending, matching `orderBy(field,'desc').orderBy('__name__','desc')`. */
function compareKeysDesc(a: RowKey, b: RowKey): number {
  const byValue = compareCodeUnits(b.value, a.value);
  return byValue !== 0 ? byValue : compareCodeUnits(b.docId, a.docId);
}

/**
 * A page boundary. Opaque to the model, deliberately: it carries the ordering
 * AND the filter set it was issued for, so replaying it under either changed is
 * refused rather than answered off a different result set.
 */
interface SearchCursor {
  order: CaseOrderField;
  value: string;
  docId: string;
  /** Fingerprint of the filters the cursor was issued under. */
  filters: string;
}

/** Longest string a cursor field may carry, so a forged one cannot be a payload. */
const MAX_CURSOR_FIELD_CHARS = 200;

function encodeCursor(cursor: SearchCursor): string {
  const compact = { o: cursor.order, v: cursor.value, d: cursor.docId, f: cursor.filters };
  return Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
}

/**
 * Why a cursor was refused. Named rather than a single boolean because the three
 * cases need different corrections from the model: start over, restore
 * `order_by`, or restore the filters.
 */
type CursorRejection = 'malformed' | 'order_mismatch' | 'filters_changed';

type CursorDecode = { ok: true; cursor: SearchCursor } | { ok: false; reason: CursorRejection };

const CURSOR_REJECTION_MESSAGES: Record<CursorRejection, string> = {
  malformed:
    'That cursor was not issued by this tool. Retry without `cursor` to run the search from the '
    + 'beginning.',
  order_mismatch:
    'That cursor was issued for a different ordering, so continuing from it would answer off the '
    + 'wrong axis. Keep `order_by` — and the `created_after`/`created_before` bounds, which '
    + 'override it — identical to the call that issued it, or retry without `cursor`.',
  filters_changed:
    'That cursor was issued for a different filter set, so continuing from it would answer off '
    + 'another result set. Keep `project`, `status`, `query`, `created_after` and `created_before` '
    + 'identical to the call that issued it; only `limit` may change between pages. Retry without '
    + '`cursor` to run the changed search from the beginning.',
};

function isCursorField(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_CURSOR_FIELD_CHARS;
}

function decodeCursor(raw: string, order: CaseOrderField, filters: string): CursorDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
  const { o, v, d, f } = parsed as Record<string, unknown>;
  if (!isCursorField(o) || !isCursorField(v) || !isCursorField(d) || !isCursorField(f)) {
    return { ok: false, reason: 'malformed' };
  }
  if (o !== order) return { ok: false, reason: 'order_mismatch' };
  if (f !== filters) return { ok: false, reason: 'filters_changed' };
  return { ok: true, cursor: { order, value: v, docId: d, filters } };
}

/**
 * Binds a cursor to the filter set it was issued for.
 *
 * A cursor is a position in one ordering of one result set, and nothing about it
 * is self-describing. Replayed against a different `project`, `status`, `query`
 * or date window it would still decode, still clip the new set at a boundary
 * that means nothing in it, and still report `has_more: false` — an explicit
 * claim of completeness over a wrong answer, which is the exact hazard the rest
 * of this tool is built to remove. The model has to restate every filter by hand
 * on each page, so a mismatch is an ordinary slip rather than misuse: refusing it
 * costs one call, accepting it costs the answer.
 *
 * The project enters by its RESOLVED id, so a page requested by project name and
 * the next one requested by id continue each other. `limit` is deliberately
 * absent: a different page size resumes from the same position correctly.
 */
function filterFingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 12);
}

interface VisibleProject {
  project_id: string;
  name: string;
}

type ProjectResolution =
  | { kind: 'resolved'; project: VisibleProject }
  /**
   * Nothing matched. `searched` is the pool the name was matched against — the
   * requester's own projects, or an admin's scanned page of them — and the caller
   * needs it for two different decisions: whether the call is CORRECTABLE (a
   * near-miss name against a non-empty pool is) and, if so, which project names to
   * hand back so it can be corrected.
   */
  | { kind: 'unknown'; searched: readonly VisibleProject[] }
  | { kind: 'ambiguous'; candidates: VisibleProject[] }
  /**
   * The filter held no name at all — `' '` passes the schema's `.min(1)` and trims
   * away. Its own kind because every other outcome here is a statement about the
   * project pool, and none of those statements is true of a call that named
   * nothing to look up.
   */
  | { kind: 'blank_name' }
  | { kind: 'too_many_to_scan' };

/**
 * The words a project name or a typed needle is made of: lowercased, with
 * punctuation, spacing and ordering discarded. Unicode-aware, because a project
 * name may hold any letters at all and `\w` would split 'Müller' in two.
 */
function nameWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** Whether every word of the needle appears as a word of `name`. */
function coversEveryWord(needleWords: readonly string[], name: string): boolean {
  if (needleWords.length === 0) return false;
  const words = new Set(nameWords(name));
  return needleWords.every((word) => words.has(word));
}

/** The first tier that matched anything, so a stronger match shadows a weaker one. */
function firstNonEmpty<T>(...tiers: readonly T[][]): T[] {
  return tiers.find((tier) => tier.length > 0) ?? [];
}

/**
 * Resolve what a requester typed into one of the projects they may see.
 *
 * ## Why word matching, and why last
 *
 * A person says the words of a project's name, not its punctuation and not its
 * order: "Acme Atlas" for a project called "Atlas (Acme)". Id, exact name and
 * substring all miss that, and the miss used to be reported as a name that matched
 * nothing — which is how a project with open cases became unfindable. So a fourth
 * tier accepts a name whose WORDS all appear in the candidate's, in any order and
 * with any punctuation between them, and the candidate list goes back to being the
 * rare fallback it was meant to be.
 *
 * A match is "all of the needle's words are present", not "some" — 'Billing' must
 * not resolve 'Billing Platform Migration' by sharing one word — and the tier runs
 * only when substring matching found nothing at all. Both restrictions exist to
 * keep the tier purely additive: no call that resolved before now resolves
 * differently, and no call that was ambiguous before becomes a silent pick. A
 * needle whose words match two projects still comes back as an ambiguity, which is
 * the correct refusal and the one the caller already handles.
 *
 * Two matches are reported back as an ambiguity with both ids rather than resolved
 * by picking the first — a silent pick produces a plausible answer about the wrong
 * project, which is worse than a question.
 *
 * `visible` is the requester's accessible set, so resolution can only ever narrow
 * the search, never widen it past that scope: every tier filters that same pool.
 */
function resolveProject(raw: string, visible: readonly VisibleProject[]): ProjectResolution {
  const needle = raw.trim().toLowerCase();
  // Its own outcome, and checked before the tiers: every name CONTAINS the empty
  // string, so a blank needle falling through would come back as an ambiguity
  // between all of them — a statement about the pool, for a call that named nothing.
  if (needle === '') return { kind: 'blank_name' };

  const byId = visible.find((project) => project.project_id.toLowerCase() === needle);
  if (byId) return { kind: 'resolved', project: byId };

  const needleWords = nameWords(needle);
  const candidates = firstNonEmpty(
    visible.filter((project) => project.name.trim().toLowerCase() === needle),
    visible.filter((project) => project.name.toLowerCase().includes(needle)),
    visible.filter((project) => coversEveryWord(needleWords, project.name)),
  );

  if (candidates.length === 1) return { kind: 'resolved', project: candidates[0]! };
  if (candidates.length === 0) return { kind: 'unknown', searched: visible };
  return { kind: 'ambiguous', candidates: candidates.slice(0, MAX_PROJECT_CANDIDATES) };
}

/**
 * Resolve `project` for a requester whose scope is every project.
 *
 * An admin has no accessible-project list to match against, so the lookup has to
 * reach Firestore. An id costs one document read; only a name needs names, and
 * that scan is capped (see `ADMIN_PROJECT_SCAN_LIMIT`) with the ceiling reported
 * rather than swallowed. Same authority as `GET /api/projects`, which an admin
 * already has.
 */
async function resolveProjectForAdmin(raw: string): Promise<ProjectResolution> {
  const needle = raw.trim();

  // Nothing to resolve, and no reading of the workspace could change that. Running
  // the scan anyway is what made a blank name past the cap come back as "too many
  // projects to match by name" — false about a call that carries no name to match.
  if (needle === '') return { kind: 'blank_name' };

  // A slash is not a document id; `doc()` would throw on it.
  if (!needle.includes('/')) {
    const byId = await collections.projects().doc(needle).get();
    if (byId.exists) {
      const project = byId.data()!;
      return {
        kind: 'resolved',
        project: { project_id: project.project_id ?? needle, name: project.name ?? '' },
      };
    }
  }

  const snapshot = await collections.projects().limit(ADMIN_PROJECT_SCAN_LIMIT).get();
  const scanned = snapshot.docs
    .map((doc) => doc.data())
    .map((project) => ({ project_id: project.project_id ?? '', name: project.name ?? '' }));
  const resolution = resolveProject(needle, scanned);
  if (resolution.kind === 'unknown' && scanned.length === ADMIN_PROJECT_SCAN_LIMIT) {
    return { kind: 'too_many_to_scan' };
  }
  return resolution;
}

function orderValueOf(case_: Case, field: CaseOrderField): string {
  return case_[field] ?? '';
}

/**
 * Elide display text that a payload carries but does not depend on the full form
 * of. See `MAX_ROW_TITLE_CHARS` and `MAX_PROJECT_NAME_CHARS` for why each bound
 * exists; the identifiers next to these strings are never clipped, so what the
 * model needs to act on stays exact.
 */
function clipDisplayText(text: string | undefined, max: number): string {
  const value = text ?? '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Return the answer for the longest prefix of a page whose SERIALISED FORM fits
 * the budget. See `RESULT_BUDGET_SHARE`.
 *
 * `assemble` builds the complete payload for a row count, so what is measured is
 * exactly what is returned — no part of it is estimated. Dropping the first row
 * is not monotone (it adds the omission count and its note), so the loop measures
 * after every drop instead of assuming one drop is enough. It costs at most
 * `limit` stringifies of a payload already bounded by the same budget.
 *
 * One row always survives: a page of zero rows with `has_more` true reads as
 * "nothing matches" and makes no progress.
 */
function largestFittingPayload(
  assemble: (rowCount: number) => ToolReadPayload,
  rowCount: number,
  budget: number,
): ToolReadPayload {
  let kept = rowCount;
  let payload = assemble(kept);
  while (kept > 1 && JSON.stringify(payload).length > budget) {
    kept -= 1;
    payload = assemble(kept);
  }
  return payload;
}

/**
 * The shape every refusal shares.
 *
 * `answered: false` is the discriminator. Without it a refusal is `cases: []`
 * plus `has_more: false` — indistinguishable from a search that ran and found
 * nothing, except by noticing an extra key, so a model that checks `has_more`
 * first concludes "no cases match" and reports a refusal as an answer.
 * `ordered_by`, `order_direction` and `limit` travel with it because the
 * `order_by` description tells the model to read the ordering actually used back
 * off the result, and a field present on success but absent on refusal cannot be
 * relied on for that. The applied `status`/`query` are echoed for the same
 * reason: a filter the model cannot see in the answer is a filter it cannot
 * verify was applied.
 *
 * `answered: false` says the search did not run. It does NOT say what the model
 * should do next, and that gap is what `outcome` closes: every refusal here also
 * declares its class (`tool-outcomes.ts`), because "no project of yours is called
 * that, here are the ones that are" is the ANSWER to the request, while a filter
 * combination the backend cannot serve is a failed approach. Both were
 * `answered: false` with a message, and a model that has to tell them apart by
 * reading the message tells them apart unreliably.
 */
function refusedCaseSearch(
  input: SearchCasesInput,
  orderField: CaseOrderField,
  limit: number,
  outcome: ToolReadOutcome,
  extra: ToolReadPayload,
): ToolReadPayload {
  return classifiedRefusal(outcome, {
    answered: false,
    cases: [],
    total_returned: 0,
    has_more: false,
    next_cursor: null,
    limit,
    ordered_by: orderField,
    order_direction: 'desc',
    status_filter: input.status ?? null,
    query_filter: input.query ?? null,
    owner_filter: input.owner ?? null,
    ...extra,
  });
}

const COUNTABLE_CASE_STATUSES = [
  'open',
  'exploration',
  'ready_for_build',
  'in_build',
  'in_validation',
  'in_review',
  'needs_human_decision',
  'verification_pending',
  'approved',
  'pending_merge',
  'done',
  'rejected',
] as const;

function refusedCaseCount(
  input: CountCasesInput,
  outcome: ToolReadOutcome,
  extra: ToolReadPayload,
): ToolReadPayload {
  return classifiedRefusal(outcome, {
    answered: false,
    exact: false,
    count: null,
    status_counts: null,
    status_filter: input.status ?? null,
    case_type_filter: input.case_type ?? null,
    owner_filter: input.owner ?? null,
    ...extra,
  });
}

function caseCountAnswer(
  input: CountCasesInput,
  bounds: CreatedBounds,
  count: number,
  statusCounts: Record<string, number> | undefined,
  visible: VisibleProject[] | 'all',
  resolvedProject: VisibleProject | undefined,
): ToolReadPayload {
  return {
    answered: true,
    exact: true,
    count,
    status_counts: statusCounts ?? null,
    scope: visible === 'all' ? 'all_projects' : 'requester_projects',
    project_filter: resolvedProject
      ? {
          resolved: resolvedProject.project_id,
          name: clipDisplayText(resolvedProject.name, MAX_PROJECT_NAME_CHARS),
        }
      : null,
    status_filter: input.status ?? null,
    case_type_filter: input.case_type ?? null,
    owner_filter: input.owner ?? null,
    created_after: bounds.after ?? null,
    created_before: bounds.before ?? null,
  };
}

/**
 * Exact Case cardinality without exposing or paging through the matching rows.
 *
 * Access is narrowed before any Case query, exactly like `searchCasesForRequester`:
 * admins may count the whole collection, while members count only chunks of project
 * ids they can access. Firestore's aggregation query reads index entries rather than
 * downloading documents into the assistant process, so the answer remains exact even
 * when the matching set is much larger than Clerk's per-call result budget.
 */
export async function countCasesForRequester(
  input: CountCasesInput,
  ctx: ToolReadContext,
): Promise<ToolReadPayload> {
  const refuse = (outcome: ToolReadOutcome, extra: ToolReadPayload) =>
    refusedCaseCount(input, outcome, extra);
  const bounds = resolveCreatedBounds(input);
  if ('invalidField' in bounds) {
    return refuse('invalid_call', {
      invalid_input: bounds.invalidField,
      message:
        `'${bounds.invalidField}' is not a real UTC day or zoned ISO-8601 instant. Correct the `
        + 'date and repeat the count.',
    });
  }

  const isAdmin = await checkIsAdmin(ctx.requesterUserId);
  const accessible = await getAccessibleProjects(ctx.requesterUserId, isAdmin);
  const visible: VisibleProject[] | 'all' = accessible === 'all'
    ? 'all'
    : accessible.map((project) => ({
        project_id: project.project_id ?? '',
        name: project.name ?? '',
      }));

  if (visible !== 'all' && visible.length === 0) {
    return caseCountAnswer(input, bounds, 0, input.group_by_status
      ? Object.fromEntries(
          (input.status ? [input.status] : COUNTABLE_CASE_STATUSES).map((status) => [status, 0]),
        )
      : undefined, visible, undefined);
  }

  let scopedProjectIds: string[] | undefined = visible === 'all'
    ? undefined
    : visible.map((project) => project.project_id);
  let resolvedProject: VisibleProject | undefined;
  if (input.project !== undefined) {
    const resolution = visible === 'all'
      ? await resolveProjectForAdmin(input.project)
      : resolveProject(input.project, visible);
    if (resolution.kind === 'blank_name') {
      return refuse('invalid_call', {
        project_filter: { resolved: null, reason: 'blank_project_name' },
        message:
          'The project filter was blank after trimming. Repeat with a project name or project_id, '
          + 'or omit project to count every project you can see.',
      });
    }
    if (resolution.kind === 'unknown') {
      if (resolution.searched.length === 0) {
        return caseCountAnswer(input, bounds, 0, input.group_by_status
          ? Object.fromEntries(
              (input.status ? [input.status] : COUNTABLE_CASE_STATUSES)
                .map((status) => [status, 0]),
            )
          : undefined, visible, undefined);
      }
      const total = resolution.searched.length;
      const candidates = resolution.searched.slice(0, MAX_PROJECT_CANDIDATES).map((project) => ({
        project_id: project.project_id,
        name: clipDisplayText(project.name, MAX_PROJECT_NAME_CHARS),
      }));
      return refuse('invalid_call', {
        project_filter: {
          resolved: null,
          reason: 'no_matching_project',
          candidates,
          candidates_complete: total <= MAX_PROJECT_CANDIDATES,
          candidates_total: total,
        },
        message:
          'No visible project matched that name or id. Pick one candidate name or project_id and '
          + 'repeat the count; do not drop the project filter, because that answers a different '
          + 'question.',
      });
    }
    if (resolution.kind === 'too_many_to_scan') {
      return refuse('failed', {
        project_filter: { resolved: null, reason: 'too_many_projects_to_match_by_name' },
        message:
          'The workspace has more projects than this bounded name lookup scans. The count can be '
          + 'answered with the exact project_id, but must not guess or silently broaden by name.',
      });
    }
    if (resolution.kind === 'ambiguous') {
      return refuse('invalid_call', {
        project_filter: {
          resolved: null,
          reason: 'ambiguous_project',
          candidates: resolution.candidates.map((project) => ({
            project_id: project.project_id,
            name: clipDisplayText(project.name, MAX_PROJECT_NAME_CHARS),
          })),
        },
        message:
          'That name matches more than one visible project. Repeat the count with one listed '
          + 'project_id.',
      });
    }
    resolvedProject = resolution.project;
    scopedProjectIds = [resolvedProject.project_id];
  }

  const projectChunks: (string[] | undefined)[] = scopedProjectIds === undefined
    ? [undefined]
    : chunk(scopedProjectIds, IN_CLAUSE_CHUNK);

  // Ownership is a filter WITHIN the visibility already established above, never
  // a route to widen it: `owner` only ever adds an equality clause alongside the
  // `project_id` scoping already applied to `projectChunks`, so a case in a
  // project this requester cannot see is excluded before ownership is even
  // considered (#950).
  const ownerFilterId = resolveOwnerFilter(input.owner, ctx.requesterUserId);

  const countStatus = async (status: string | undefined): Promise<number> => {
    const counts = await Promise.all(projectChunks.map(async (projectChunk) => {
      let query: FirebaseFirestore.Query<Case> = collections.activeCases();
      if (projectChunk) {
        query = projectChunk.length === 1
          ? query.where('project_id', '==', projectChunk[0])
          : query.where('project_id', 'in', projectChunk);
      }
      if (status !== undefined) query = query.where('status', '==', status);
      if (input.case_type !== undefined) {
        query = query.where('case_type', '==', input.case_type);
      }
      if (ownerFilterId !== undefined) query = query.where('owner_user_id', '==', ownerFilterId);
      if (bounds.after !== undefined) query = query.where('created_at', '>=', bounds.after);
      if (bounds.before !== undefined) query = query.where('created_at', '<=', bounds.before);
      if (bounds.after !== undefined || bounds.before !== undefined) {
        // Select the same deployed descending composites as Case search. Ordering
        // does not change an aggregation count, but leaving it implicit would make
        // Firestore select an ascending range index that the product does not use.
        query = query.orderBy('created_at', 'desc');
      }
      const snapshot = await query.count().get();
      return snapshot.data().count;
    }));
    return counts.reduce((sum, value) => sum + value, 0);
  };

  if (input.group_by_status === true) {
    const statuses = input.status ? [input.status] : [...COUNTABLE_CASE_STATUSES];
    const values = await Promise.all(statuses.map((status) => countStatus(status)));
    const statusCounts = Object.fromEntries(
      statuses.map((status, index) => [status, values[index]!] as const),
    );
    const total = values.reduce((sum, value) => sum + value, 0);
    return caseCountAnswer(input, bounds, total, statusCounts, visible, resolvedProject);
  }

  const total = await countStatus(input.status);
  return caseCountAnswer(input, bounds, total, undefined, visible, resolvedProject);
}

/** Which side of `TRANSITION_EVENT_TYPES` a call asked for, applied together or apart. */
type TransitionOutcome = 'completed' | 'rejected' | 'any';

/**
 * The event type(s) one `outcome` value counts.
 *
 * Settles, in code, the question #807 asks explicitly: neither "closed" nor
 * "throughput" is a stored field, so this module fixes what they mean instead
 * of leaving each call to guess. `'any'` — both together — is that meaning:
 * a rejected case is closed and counts toward throughput exactly as a
 * completed one does. `COUNT_CASE_TRANSITIONS_TOOL`'s description and the
 * Clerk prompt both point here.
 */
const TRANSITION_EVENT_TYPES: Record<TransitionOutcome, readonly string[]> = {
  completed: [CASE_COMPLETED_EVENT],
  rejected: [CASE_REJECTED_EVENT],
  any: [CASE_COMPLETED_EVENT, CASE_REJECTED_EVENT],
};

function outcomeForEventType(eventType: string): 'completed' | 'rejected' {
  return eventType === CASE_REJECTED_EVENT ? 'rejected' : 'completed';
}

/** One-sentence definitions echoed on every successful answer — see `TRANSITION_EVENT_TYPES`. */
const OUTCOME_DEFINITION: Record<TransitionOutcome, string> = {
  completed: 'Cases that reached done through a recorded case_completed transition event.',
  rejected: 'Cases permanently rejected through a recorded case_rejected transition event.',
  any: 'Both together: every case that left the pipeline, completed or rejected — this is what '
    + '"closed" and "throughput" mean here.',
};

/**
 * How many terminal-transition events one call may read to resolve project
 * scope, before refusing rather than guessing at a partial count.
 *
 * `case_events` carries no `project_id` (see the docblock on
 * `countCaseTransitionsForRequester`), so a scoped count has to read the
 * matching events and join each one's `case_id` to its Case document. That
 * read is bounded exactly the way `ADMIN_PROJECT_SCAN_LIMIT` bounds a project
 * name scan: capped, with the cap reported as a `failed` refusal rather than
 * silently answering from whichever events came back first. 500 covers a
 * busy workspace's terminal-case volume for the day- and week-long windows
 * this tool exists to answer; a materially wider window with no project
 * filter is exactly the shape that should be refused rather than guessed at.
 */
const EVENT_SCAN_LIMIT = 500;

/** One row of a `group_by_project`/`group_by_outcome` breakdown. */
interface TransitionCountGroupRow {
  project_id?: string;
  project_name?: string;
  outcome?: 'completed' | 'rejected';
  count: number;
}

/**
 * Bucket already-scoped rows into `groups`, honouring `tighten structural
 * types`: an explicit array of rows rather than a nested map, so the axes
 * requested are exactly the keys present on each row instead of an implicit
 * position in a `Record<string, Record<string, number>>`.
 *
 * The two axes are zero-filled differently on purpose. `outcome` is a fixed,
 * two-value enum — zero-filling it when it is the ONLY axis mirrors
 * `countCasesForRequester`'s complete `status_counts` map. `project` has no
 * such bound: zero-filling it would mean listing every project the requester
 * can see at `count: 0`, which is not the same kind of small and is not what
 * was asked. With zero matching rows and `project` among the requested axes,
 * `groups` is an empty array — a complete, honest "nothing matched" — never
 * one row per visible project.
 */
function buildTransitionGroups(
  rows: readonly { projectId: string; outcome: 'completed' | 'rejected' }[],
  byProject: boolean,
  byOutcome: boolean,
  eventTypes: readonly string[],
  projectNameById: ReadonlyMap<string, string>,
): TransitionCountGroupRow[] | undefined {
  if (!byProject && !byOutcome) return undefined;
  const buckets = new Map<string, TransitionCountGroupRow>();
  for (const row of rows) {
    const key = `${byProject ? row.projectId : ''} ${byOutcome ? row.outcome : ''}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    buckets.set(key, {
      ...(byProject
        ? {
            project_id: row.projectId,
            project_name: clipDisplayText(projectNameById.get(row.projectId) ?? '', MAX_PROJECT_NAME_CHARS),
          }
        : {}),
      ...(byOutcome ? { outcome: row.outcome } : {}),
      count: 1,
    });
  }
  if (byOutcome && !byProject) {
    for (const eventType of eventTypes) {
      const outcome = outcomeForEventType(eventType);
      const key = ` ${outcome}`;
      if (!buckets.has(key)) buckets.set(key, { outcome, count: 0 });
    }
  }
  return [...buckets.values()];
}

function refusedTransitionCount(
  outcomeFilter: TransitionOutcome,
  outcome: ToolReadOutcome,
  extra: ToolReadPayload,
): ToolReadPayload {
  return classifiedRefusal(outcome, {
    answered: false,
    exact: false,
    count: null,
    groups: null,
    outcome: outcomeFilter,
    ...extra,
  });
}

function transitionCountAnswer(
  bounds: CreatedBounds,
  outcomeFilter: TransitionOutcome,
  count: number,
  groups: TransitionCountGroupRow[] | undefined,
  visible: VisibleProject[] | 'all',
  resolvedProject: VisibleProject | undefined,
  excludedUnresolvedCases: number,
): ToolReadPayload {
  return {
    answered: true,
    exact: true,
    count,
    outcome: outcomeFilter,
    outcome_definition: OUTCOME_DEFINITION[outcomeFilter],
    scope: visible === 'all' ? 'all_projects' : 'requester_projects',
    project_filter: resolvedProject
      ? {
          resolved: resolvedProject.project_id,
          name: clipDisplayText(resolvedProject.name, MAX_PROJECT_NAME_CHARS),
        }
      : null,
    occurred_after: bounds.after ?? null,
    occurred_before: bounds.before ?? null,
    as_of: new Date().toISOString(),
    groups: groups ?? null,
    ...(excludedUnresolvedCases > 0
      ? {
          excluded_unresolved_cases: excludedUnresolvedCases,
          excluded_unresolved_note:
            'This many matching transition events name a case this call could not verify as '
            + 'visible to you — deleted, soft-deleted, or otherwise unresolvable — and were '
            + 'excluded from the count rather than guessed into or out of it.',
        }
      : {}),
  };
}

/**
 * Exact count of terminal case transitions in a window, without an unbounded
 * per-case scan (#807).
 *
 * ## Why `countCasesForRequester` cannot answer this
 *
 * That function counts Case documents by `status` — the case's CURRENT
 * state — and by `created_at`. Neither is completion time: `status` does not
 * say WHEN a case reached it, and no field on a Case document records that
 * moment at all. `readCaseForRequester`'s `completed_at` recovers it from one
 * case's own `case_events` history, one case at a time — the exact per-case
 * fan-out #807 exists to make unnecessary for a window over many cases.
 *
 * ## Why a scoped count here cannot be a pure Firestore aggregation
 *
 * `countCasesForRequester` filters `cases` by `project_id` directly, because
 * every Case document carries one, so member scoping there is an index-only
 * `.count()`. A `CaseEvent` document carries no `project_id` at all — see
 * `firestore.ts`'s `caseEvents` collection and `docs/database-schema.md` — so
 * this function cannot filter case_events by project the same way.
 *
 * When NOTHING needs a project — an admin, no `project` filter, no
 * `group_by_project` — this stays a pure aggregation: `.count()` per
 * outcome's event type, filtered by `type` and the `created_at` window, using
 * the SAME composite index `firestore.indexes.json` already carries for
 * `case_events` (`type ASC, created_at ASC` — the one `activity-service.ts`'s
 * leaderboard already queries for `case_created`). An `in`/`==` equality
 * filter plus a range on the other field needs exactly that shape of index
 * regardless of how many rows match, so no new index is needed for this path.
 *
 * Otherwise — a member whose visible projects are a subset, an explicit
 * `project` filter, or `group_by_project` — the count needs each matching
 * event's case's `project_id`, which means reading the events themselves and
 * joining their `case_id`s to Case documents (a `__name__ in [...]` lookup,
 * which Firestore answers directly from document keys and needs no index of
 * its own). That read is capped at `EVENT_SCAN_LIMIT`: past it, this refuses
 * (`failed`) rather than joining a truncated set and reporting it as exact.
 *
 * ## Legacy and missing events
 *
 * A case with no recorded `case_completed`/`case_rejected` event — one done
 * before that invariant existed, or one since soft-deleted — is invisible to
 * this count exactly as it is invisible to `readCaseForRequester`'s
 * `completed_at`: never inferred from `status` or from `updated_at`, and
 * reported honestly via `excluded_unresolved_cases` when a matching event's
 * case cannot be resolved at all, rather than silently included or dropped.
 */
export async function countCaseTransitionsForRequester(
  input: CountCaseTransitionsInput,
  ctx: ToolReadContext,
): Promise<ToolReadPayload> {
  const outcomeFilter: TransitionOutcome = input.outcome ?? 'any';
  const eventTypes = TRANSITION_EVENT_TYPES[outcomeFilter];
  const wantsProjectGroups = input.group_by_project === true;
  const wantsOutcomeGroups = input.group_by_outcome === true;
  const refuse = (outcome: ToolReadOutcome, extra: ToolReadPayload) =>
    refusedTransitionCount(outcomeFilter, outcome, extra);

  const bounds = resolveOccurredBounds(input);
  if ('invalidField' in bounds) {
    return refuse('invalid_call', {
      invalid_input: bounds.invalidField,
      message:
        `'${bounds.invalidField}' is not a real UTC day or zoned ISO-8601 instant. Correct the `
        + 'date and repeat the count.',
    });
  }

  const isAdmin = await checkIsAdmin(ctx.requesterUserId);
  const accessible = await getAccessibleProjects(ctx.requesterUserId, isAdmin);
  const visible: VisibleProject[] | 'all' = accessible === 'all'
    ? 'all'
    : accessible.map((project) => ({
        project_id: project.project_id ?? '',
        name: project.name ?? '',
      }));

  if (visible !== 'all' && visible.length === 0) {
    const groups = buildTransitionGroups([], wantsProjectGroups, wantsOutcomeGroups, eventTypes, new Map());
    return transitionCountAnswer(bounds, outcomeFilter, 0, groups, visible, undefined, 0);
  }

  let resolvedProject: VisibleProject | undefined;
  if (input.project !== undefined) {
    const resolution = visible === 'all'
      ? await resolveProjectForAdmin(input.project)
      : resolveProject(input.project, visible);
    if (resolution.kind === 'blank_name') {
      return refuse('invalid_call', {
        project_filter: { resolved: null, reason: 'blank_project_name' },
        message:
          'The project filter was blank after trimming. Repeat with a project name or project_id, '
          + 'or omit project to count every project you can see.',
      });
    }
    if (resolution.kind === 'unknown') {
      if (resolution.searched.length === 0) {
        const groups = buildTransitionGroups([], wantsProjectGroups, wantsOutcomeGroups, eventTypes, new Map());
        return transitionCountAnswer(bounds, outcomeFilter, 0, groups, visible, undefined, 0);
      }
      const total = resolution.searched.length;
      const candidates = resolution.searched.slice(0, MAX_PROJECT_CANDIDATES).map((project) => ({
        project_id: project.project_id,
        name: clipDisplayText(project.name, MAX_PROJECT_NAME_CHARS),
      }));
      return refuse('invalid_call', {
        project_filter: {
          resolved: null,
          reason: 'no_matching_project',
          candidates,
          candidates_complete: total <= MAX_PROJECT_CANDIDATES,
          candidates_total: total,
        },
        message:
          'No visible project matched that name or id. Pick one candidate name or project_id and '
          + 'repeat the count; do not drop the project filter, because that answers a different '
          + 'question.',
      });
    }
    if (resolution.kind === 'too_many_to_scan') {
      return refuse('failed', {
        project_filter: { resolved: null, reason: 'too_many_projects_to_match_by_name' },
        message:
          'The workspace has more projects than this bounded name lookup scans. The count can be '
          + 'answered with the exact project_id, but must not guess or silently broaden by name.',
      });
    }
    if (resolution.kind === 'ambiguous') {
      return refuse('invalid_call', {
        project_filter: {
          resolved: null,
          reason: 'ambiguous_project',
          candidates: resolution.candidates.map((project) => ({
            project_id: project.project_id,
            name: clipDisplayText(project.name, MAX_PROJECT_NAME_CHARS),
          })),
        },
        message:
          'That name matches more than one visible project. Repeat the count with one listed '
          + 'project_id.',
      });
    }
    resolvedProject = resolution.project;
  }

  const needsProjectJoin = visible !== 'all' || resolvedProject !== undefined || wantsProjectGroups;

  if (!needsProjectJoin) {
    // Fast path: nothing here needs a project per event, so this stays a pure
    // aggregation exactly like `countCasesForRequester`'s `.count()` — see the
    // docblock above for why the existing `case_events` index already covers it.
    const countType = async (eventType: string): Promise<number> => {
      let query: FirebaseFirestore.Query<CaseEvent> = collections.caseEvents()
        .where('type', '==', eventType);
      if (bounds.after !== undefined) query = query.where('created_at', '>=', bounds.after);
      if (bounds.before !== undefined) query = query.where('created_at', '<=', bounds.before);
      const snapshot = await query.count().get();
      return snapshot.data().count;
    };
    const perType = await Promise.all(eventTypes.map((eventType) => countType(eventType)));
    const total = perType.reduce((sum, value) => sum + value, 0);
    const groups = wantsOutcomeGroups
      ? eventTypes.map((eventType, index) => ({
          outcome: outcomeForEventType(eventType),
          count: perType[index]!,
        }))
      : undefined;
    return transitionCountAnswer(bounds, outcomeFilter, total, groups, visible, resolvedProject, 0);
  }

  // Join path: read the matching events (capped), then resolve each one's
  // case's project_id and keep only what the requester may see.
  const fetchEvents = async (eventType: string): Promise<CaseEvent[]> => {
    let query: FirebaseFirestore.Query<CaseEvent> = collections.caseEvents()
      .where('type', '==', eventType);
    if (bounds.after !== undefined) query = query.where('created_at', '>=', bounds.after);
    if (bounds.before !== undefined) query = query.where('created_at', '<=', bounds.before);
    const snapshot = await query.limit(EVENT_SCAN_LIMIT + 1).get();
    return snapshot.docs.map((doc) => doc.data());
  };
  const fetched = await Promise.all(eventTypes.map((eventType) => fetchEvents(eventType)));
  const allEvents = fetched.flat();

  if (allEvents.length > EVENT_SCAN_LIMIT) {
    return refuse('failed', {
      event_scan_limit: EVENT_SCAN_LIMIT,
      message:
        `This window holds more than ${EVENT_SCAN_LIMIT} matching transition events — too many `
        + 'for this call to join to project scope and still report an exact count. Narrow '
        + 'occurred_after/occurred_before, or add a project filter, and repeat.',
    });
  }

  if (allEvents.length === 0) {
    const groups = buildTransitionGroups([], wantsProjectGroups, wantsOutcomeGroups, eventTypes, new Map());
    return transitionCountAnswer(bounds, outcomeFilter, 0, groups, visible, resolvedProject, 0);
  }

  const caseIds = [...new Set(allEvents.map((event) => event.case_id))];
  const projectByCaseId = new Map<string, string>();
  await Promise.all(chunk(caseIds, IN_CLAUSE_CHUNK).map(async (idsChunk) => {
    const snapshot = await collections.activeCases()
      .where(DOCUMENT_ID_FIELD, 'in', idsChunk)
      .get();
    for (const doc of snapshot.docs) {
      projectByCaseId.set(doc.id, doc.data().project_id);
    }
  }));

  const visibleProjectIds = visible === 'all' ? undefined : new Set(visible.map((p) => p.project_id));
  const projectNameById = new Map<string, string>(
    visible === 'all' ? [] : visible.map((p) => [p.project_id, p.name] as const),
  );

  // `excludedUnresolved` is an HONESTY signal — a matching event whose case
  // could not be verified at all (deleted, soft-deleted) — never a count of
  // routine scoping. An event that resolved cleanly to a project the
  // requester simply may not see, or to a project other than an explicit
  // filter, is filtered out exactly as silently as `countCasesForRequester`
  // scopes by `project_id in [...]`: that is normal visibility, not a gap.
  let excludedUnresolved = 0;
  const rows: { projectId: string; outcome: 'completed' | 'rejected' }[] = [];
  for (const event of allEvents) {
    const projectId = projectByCaseId.get(event.case_id);
    if (projectId === undefined) {
      excludedUnresolved += 1;
      continue;
    }
    if (resolvedProject !== undefined) {
      if (projectId !== resolvedProject.project_id) continue;
    } else if (visibleProjectIds !== undefined && !visibleProjectIds.has(projectId)) {
      continue;
    }
    rows.push({ projectId, outcome: outcomeForEventType(event.type) });
  }

  if (wantsProjectGroups) {
    const missingNameIds = [...new Set(rows.map((row) => row.projectId))]
      .filter((projectId) => !projectNameById.has(projectId));
    await Promise.all(chunk(missingNameIds, IN_CLAUSE_CHUNK).map(async (idsChunk) => {
      const snapshot = await collections.projects().where(DOCUMENT_ID_FIELD, 'in', idsChunk).get();
      for (const doc of snapshot.docs) {
        projectNameById.set(doc.id, doc.data().name ?? '');
      }
    }));
  }

  const groups = buildTransitionGroups(rows, wantsProjectGroups, wantsOutcomeGroups, eventTypes, projectNameById);
  return transitionCountAnswer(
    bounds,
    outcomeFilter,
    rows.length,
    groups,
    visible,
    resolvedProject,
    excludedUnresolved,
  );
}

/**
 * Cases the requester may see, newest first.
 *
 * Scoping strategy: resolve the requester's accessible project ids FIRST and
 * query only those projects. The alternative — query broadly, then filter —
 * would put documents the requester may not see into this process's memory,
 * where a later refactor could leak them into a result, a log line or the
 * trace.
 *
 * Admins (and the `'all'` answer from `getAccessibleProjectIds`) query
 * unrestricted, which is the same authority they already have on
 * `GET /api/cases`.
 *
 * ## Why the filters look like this
 *
 * A project- and date-scoped question ("which cases were created today in
 * project X, and what state is each in") used to be unanswerable within any
 * sane call budget: there was no project filter, no date filter, no
 * `created_at` in the projection and no cursor, so the only available plan was
 * an unfiltered sweep plus one single-case read per candidate. Each filter here
 * exists to remove one of those forced extra calls.
 *
 * `project` accepts a NAME as well as an id because a name is what a person
 * says, and it is resolved here — against the projects this requester may see —
 * rather than by handing the model a fourth tool to look projects up with.
 *
 * ## Firestore constraints this has to live with
 *
 * A range filter must drive the sort, so `created_after`/`created_before` force
 * the ordering to `created_at`. That is reported back as `ordered_by` on every
 * result, never applied silently, and it means "created in a window, ordered by
 * last activity" is not expressible in one call at all — `SEARCH_CASES_TOOL`
 * says so rather than letting the model assume otherwise. The
 * equality+range+sort combinations used here need composite indexes on `cases`;
 * the `created_at DESC` variants were added to `firestore.indexes.json` alongside
 * the existing `updated_at DESC` ones. The document-id tiebreak needs none: every
 * composite index already carries `__name__` in its last field's direction.
 */
export async function searchCasesForRequester(
  input: SearchCasesInput,
  ctx: ToolReadContext,
): Promise<ToolReadPayload> {
  const limit = clampLimit(input.limit);

  // Firestore requires the range field to be the first sort key, so a requested
  // date bound decides the axis. Derived from the PRESENCE of the bounds rather
  // than from successfully parsed ones, so every refusal below can still report
  // the ordering the call would have used.
  const dateRequested = input.created_after !== undefined || input.created_before !== undefined;
  const orderField: CaseOrderField = dateRequested
    ? 'created_at'
    : (input.order_by ?? 'updated_at');
  const orderOverridden = input.order_by !== undefined && input.order_by !== orderField;
  const refuse = (outcome: ToolReadOutcome, extra: ToolReadPayload) =>
    refusedCaseSearch(input, orderField, limit, outcome, extra);

  const bounds = resolveCreatedBounds(input);
  if ('invalidField' in bounds) {
    // The schema's regex admits a calendar shape, not a real day, so `2026-04-31`
    // arrives here. A corrected call works, which is what `invalid_call` means.
    return refuse('invalid_call', {
      invalid_input: bounds.invalidField,
      message:
        `'${bounds.invalidField}' is not a date this tool can read. Pass a UTC day as `
        + 'YYYY-MM-DD, or a full ISO-8601 instant with a zone such as 2026-08-04T09:00:00Z. A day '
        + 'that does not exist in its month is refused rather than moved to the next one.',
    });
  }

  const isAdmin = await checkIsAdmin(ctx.requesterUserId);
  // One read of the projects collection, not two: the accessible set and the
  // project names come from the same documents.
  const accessible = await getAccessibleProjects(ctx.requesterUserId, isAdmin);
  const visible: VisibleProject[] | 'all' = accessible === 'all'
    ? 'all'
    : accessible.map((project) => ({
        project_id: project.project_id ?? '',
        name: project.name ?? '',
      }));

  if (visible !== 'all' && visible.length === 0) {
    // Not a failure to work around: this requester can see no project at all, so
    // "no cases" is the complete and correct answer to any case question.
    return refuse('answer', { scope: 'no_accessible_projects' });
  }

  let scopedProjectIds: string[] | undefined = visible === 'all'
    ? undefined
    : visible.map((project) => project.project_id);
  let resolvedProject: VisibleProject | undefined;
  if (input.project !== undefined) {
    const resolution = visible === 'all'
      ? await resolveProjectForAdmin(input.project)
      : resolveProject(input.project, visible);
    if (resolution.kind === 'blank_name') {
      // `project` is `.min(1)`, but ' ' satisfies that and trims to nothing. Every
      // other refusal here states something about the project pool — no name
      // matched, several did, the pool is too large to scan — and none of those is
      // true of a call that carries no name: there was nothing to match and nothing
      // to scan for. `invalid_call`, because the correction is in the call.
      return refuse('invalid_call', {
        project_filter: { resolved: null, reason: 'blank_project_name' },
        message:
          'The project filter was blank after trimming, so it named no project to resolve. This '
          + 'says nothing about which projects exist. Repeat the call with the project name or '
          + 'project_id the request actually names; if it names none, omit the project key rather '
          + 'than passing an empty one, and say in your answer that it covers every project you '
          + 'can see.',
      });
    }
    if (resolution.kind === 'unknown') {
      // Two situations, and conflating them is what made a project invisible: the
      // name did not match, which says nothing about whether the project exists. A
      // near miss the four matching tiers cannot bridge — a misremembered word, a
      // spelling — is not an absence. That call is CORRECTABLE, and correcting it
      // needs the names, so they travel with the refusal exactly as an ambiguity's
      // candidates do. Reporting "no such project" and stopping there is how a
      // project that exists, with open cases, becomes unfindable; sweeping without
      // the filter (what the message used to invite, for five wasted calls on a
      // real run) answers a different question. Picking from the list is the move.
      if (resolution.searched.length > 0) {
        // A name has no length bound and there is no bound on how many projects a
        // requester can reach, so the list is capped like every other echoed name.
        // Whether it is a prefix changes what the absence MEANS, so it is both
        // flagged and spelled out in the message: a flag the model was never told
        // to read is not a safeguard, and reading a partial list as "these are all
        // of them" is exactly the non-existence claim this refusal exists to stop.
        const total = resolution.searched.length;
        const complete = total <= MAX_PROJECT_CANDIDATES;
        const candidates = resolution.searched
          .slice(0, MAX_PROJECT_CANDIDATES)
          .map((p) => ({
            project_id: p.project_id,
            name: clipDisplayText(p.name, MAX_PROJECT_NAME_CHARS),
          }));
        // The names go INTO the sentence, not only into the sibling array. A real
        // run was handed this refusal with the candidates as structure and
        // answered it by dropping the filter for a free-text sweep: the message is
        // what the model acts on, so the correction — pick ONE listed name and
        // repeat the call with it — has to be where it reads first, names
        // included. The array stays for anything that consumes the structure.
        const listedNames = candidates.map((p) => `"${p.name}"`).join(', ');
        return refuse('invalid_call', {
          project_filter: {
            resolved: null,
            reason: 'no_matching_project',
            candidates,
            candidates_complete: complete,
            candidates_total: total,
          },
          message: complete
            ? 'No project you can see matches that name or id exactly enough to resolve. The '
              + `projects you can see are ${listedNames} — ALL of them. Take ONE of those names `
              + 'verbatim (or its project_id from candidates) and repeat the call with it. If '
              + 'none of them is the project asked about, then no such project exists in your '
              + 'view and a request scoped to it has nothing to count — say that rather than '
              + 'repeating the call without the project filter, which answers a different '
              + 'question.'
            : 'No project you can see matches that name or id exactly enough to resolve. '
              + `Candidates: ${listedNames} — only ${MAX_PROJECT_CANDIDATES} of the ${total} `
              + 'projects you can see (candidates_complete is false), so the project asked about '
              + 'may well be one of the others: do NOT report it as non-existent. If one of those '
              + 'candidates is the project meant, take its name verbatim (or its project_id) and '
              + 'repeat the call with it. Otherwise repeat with the exact project_id, or with a '
              + 'more distinctive part of the name — word order and punctuation do not matter, a '
              + 'missing or misspelled word does. If neither is available, say that the project '
              + 'could not be identified from that name rather than repeating the call without '
              + 'the project filter, which answers a different question.',
        });
      }
      // Nothing to correct against: this requester can reach no project at all, so
      // "no cases" is the complete answer to any case question. (A member with no
      // projects is caught earlier; this is the admin of an empty workspace.)
      return refuse('answer', {
        project_filter: { resolved: null, reason: 'no_accessible_projects' },
        scope: 'no_accessible_projects',
        message:
          'There are no projects you can see, so a request scoped to one has nothing to count.',
      });
    }
    if (resolution.kind === 'too_many_to_scan') {
      // NOT `invalid_call`: that class promises a correction the model can make,
      // and there is none. No tool lists projects, a search row carries
      // `project_name` and never `project_id`, and the name it was given did not
      // resolve — so "call again with an exact project_id" names a value it has no
      // route to obtain, and it would spend its remaining calls guessing. What it
      // can do is say the project could not be identified, which is `failed`.
      return refuse('failed', {
        project_filter: { resolved: null, reason: 'too_many_projects_to_match_by_name' },
        message:
          'That name could not be resolved: this workspace holds more projects than this tool '
          + 'scans by name, and you have no way to list them. Say that the project could not be '
          + 'identified from its name, and that naming it by its exact project_id would let the '
          + 'request be answered.',
      });
    }
    if (resolution.kind === 'ambiguous') {
      // A retry with one of the listed ids answers the request, so this is a call
      // to correct rather than an answer to report or an approach to abandon.
      return refuse('invalid_call', {
        project_filter: {
          resolved: null,
          reason: 'ambiguous_project',
          candidates: resolution.candidates.map((p) => ({
            project_id: p.project_id,
            name: clipDisplayText(p.name, MAX_PROJECT_NAME_CHARS),
          })),
        },
        message:
          'That name matches more than one project you can see. Repeat the call with one of the '
          + 'listed project_id values.',
      });
    }
    resolvedProject = resolution.project;
    scopedProjectIds = [resolvedProject.project_id];
  }

  // Ownership narrows WITHIN the project scoping above, never around it: the
  // `owner_user_id` clause below is added alongside `project_id`, so a case in
  // a project this requester cannot see never reaches the query regardless of
  // who owns it (#950).
  const ownerFilterId = resolveOwnerFilter(input.owner, ctx.requesterUserId);

  const fingerprint = filterFingerprint([
    orderField,
    resolvedProject?.project_id ?? '',
    input.status ?? '',
    // The matcher lowercases and trims, so two spellings that select the same
    // rows page interchangeably.
    (input.query ?? '').trim().toLowerCase(),
    bounds.after ?? '',
    bounds.before ?? '',
    ownerFilterId ?? '',
  ]);

  let cursor: SearchCursor | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, orderField, fingerprint);
    if (!decoded.ok) {
      return refuse('invalid_call', {
        invalid_cursor: true,
        cursor_error: decoded.reason,
        message: CURSOR_REJECTION_MESSAGES[decoded.reason],
      });
    }
    cursor = decoded.cursor;
  }

  const projectChunks: (string[] | undefined)[] = scopedProjectIds === undefined
    ? [undefined]
    : chunk(scopedProjectIds, IN_CLAUSE_CHUNK);

  const fetchLimit = limit * OVER_FETCH_FACTOR;
  const collected: CollectedRow[] = [];
  /**
   * The shallowest position at which some chunk query stopped at its fetch
   * ceiling. Every chunk scanned everything at or above it, so the union is
   * complete down to and including that row and incomplete below it.
   */
  let frontier: RowKey | undefined;

  for (const projectChunk of projectChunks) {
    let query: FirebaseFirestore.Query<Case> = collections.activeCases();
    if (projectChunk) {
      query = projectChunk.length === 1
        ? query.where('project_id', '==', projectChunk[0])
        : query.where('project_id', 'in', projectChunk);
    }
    if (input.status !== undefined) {
      query = query.where('status', '==', input.status);
    }
    if (ownerFilterId !== undefined) {
      query = query.where('owner_user_id', '==', ownerFilterId);
    }
    if (bounds.after !== undefined) {
      query = query.where('created_at', '>=', bounds.after);
    }
    if (bounds.before !== undefined) {
      query = query.where('created_at', '<=', bounds.before);
    }
    query = query.orderBy(orderField, 'desc').orderBy(DOCUMENT_ID_FIELD, 'desc');
    if (cursor) {
      // Exclusive on the whole position, so a tie of any depth advances by
      // exactly the rows already served — no counting, no ceiling.
      query = query.startAfter(cursor.value, cursor.docId);
    }
    // Over-fetch so the in-memory text filter still has candidates to work
    // with; Firestore cannot filter on a substring.
    const snapshot = await query.limit(fetchLimit).get();
    const rows: CollectedRow[] = snapshot.docs.map((doc) => {
      const case_ = doc.data();
      return { key: { value: orderValueOf(case_, orderField), docId: doc.id }, case_ };
    });
    collected.push(...rows);
    if (rows.length === fetchLimit) {
      const deepest = rows[rows.length - 1]!.key;
      if (frontier === undefined || compareKeysDesc(deepest, frontier) < 0) frontier = deepest;
    }
  }

  // Rows below the frontier were not scanned by every chunk, so serving them
  // would claim a completeness the queries did not establish. Unlike a
  // count-based boundary this can never discard the whole window: the frontier is
  // itself a fetched row, so everything above it in its own chunk survives.
  const scanned = frontier === undefined
    ? collected
    : collected.filter((row) => compareKeysDesc(row.key, frontier!) <= 0);

  const matched = scanned
    .filter((row) => matchesQuery(input.query, row.case_.title, row.case_.description))
    .sort((a, b) => compareKeysDesc(a.key, b.key));

  const page = matched.slice(0, limit);

  const projectNames = new Map<string, string>();
  if (visible !== 'all') {
    for (const project of visible) projectNames.set(project.project_id, project.name);
  } else {
    if (resolvedProject) projectNames.set(resolvedProject.project_id, resolvedProject.name);
    // An admin has no accessible-project list to read names from. Naming the
    // projects actually on the page costs at most `limit` document reads, where
    // reading the collection costs one per project in the workspace.
    const unnamed = [
      ...new Set(
        page
          .map((row) => row.case_.project_id)
          .filter((projectId) => projectId && !projectNames.has(projectId)),
      ),
    ];
    await Promise.all(
      unnamed.map(async (projectId) => {
        const doc = await collections.projects().doc(projectId).get();
        if (doc.exists) projectNames.set(projectId, doc.data()!.name ?? '');
      }),
    );
  }

  // Batched once for the whole page, never per row (#950): every owner and
  // assigned reviewer actually on the page, deduplicated, resolved in the same
  // shape `readCaseForRequester` uses below.
  const ownerIds: string[] = [];
  for (const { case_ } of page) {
    if (case_.owner_user_id) ownerIds.push(case_.owner_user_id);
    if (case_.assigned_reviewer_id) ownerIds.push(case_.assigned_reviewer_id);
  }
  const ownerNames = await resolveDisplayNames(ownerIds);

  const projected = page.map(({ case_ }) => {
    const projectName = projectNames.get(case_.project_id);
    return {
      case_id: case_.case_id,
      title: clipDisplayText(case_.title, MAX_ROW_TITLE_CHARS),
      status: case_.status,
      project_name: projectName === undefined
        ? null
        : clipDisplayText(projectName, MAX_PROJECT_NAME_CHARS),
      created_at: case_.created_at,
      updated_at: case_.updated_at,
      // Display name when one is on record, the raw user id otherwise — never
      // omitted, per #950. `assigned_reviewer_name` is omitted (not `null`)
      // when the case carries no reviewer, matching "the assigned reviewer
      // WHERE PRESENT" rather than asserting an absence as a value.
      owner_name: displayNameOf(case_.owner_user_id, ownerNames),
      ...(case_.assigned_reviewer_id
        ? { assigned_reviewer_name: displayNameOf(case_.assigned_reviewer_id, ownerNames) }
        : {}),
    };
  });
  /**
   * The complete answer for a prefix of the page. Everything that depends on how
   * many rows are served — the omission count and its note, whether a next page
   * exists, and where it resumes — is derived in here rather than decided before
   * the size is known, so the payload measured against the budget is the payload
   * returned.
   */
  const assemble = (rowCount: number): ToolReadPayload => {
    const rows = projected.slice(0, rowCount);
    const rowsOmitted = projected.length - rows.length;
    const served = page.slice(0, rows.length);

    /**
     * Where the next page resumes, or `undefined` when this page completes the
     * search. Every arm is a row this call fetched, and every fetched row lies
     * strictly after the incoming cursor, so the boundary strictly advances on
     * every page: paging terminates, no row is served twice, and no row becomes
     * unreachable. When the text filter rejected the whole window the frontier
     * still advances, which is why an empty page is not a dead end.
     */
    const resumeAt = rowsOmitted > 0 || matched.length > limit
      ? served[served.length - 1]?.key ?? frontier
      : frontier;
    const hasMore = resumeAt !== undefined;
    const nextCursor = resumeAt === undefined
      ? null
      : encodeCursor({
          order: orderField,
          value: resumeAt.value,
          docId: resumeAt.docId,
          filters: fingerprint,
        });

    return {
      answered: true,
      cases: rows,
      total_returned: rows.length,
      limit,
      ordered_by: orderField,
      order_direction: 'desc',
      has_more: hasMore,
      next_cursor: nextCursor,
      status_filter: input.status ?? null,
      query_filter: input.query ?? null,
      owner_filter: input.owner ?? null,
      created_after: bounds.after ?? null,
      created_before: bounds.before ?? null,
      project_filter: resolvedProject
        ? {
            resolved: resolvedProject.project_id,
            name: clipDisplayText(resolvedProject.name, MAX_PROJECT_NAME_CHARS),
          }
        : null,
      ...(orderOverridden
        ? {
            order_by_note:
              'A created_at range filter must drive the sort, so order_by '
              + `'${String(input.order_by)}' was not applied. Order the returned rows yourself if `
              + 'you need that axis.',
          }
        : {}),
      ...(rowsOmitted > 0
        ? {
            rows_omitted: rowsOmitted,
            rows_omitted_note:
              'The requested limit did not fit the per-call result size, so this page is shorter. '
              + 'The omitted rows are the next ones behind next_cursor.',
          }
        : {}),
      ...(hasMore
        ? {
            more_note:
              'This is a partial result: pass next_cursor with every other filter unchanged to '
              + 'continue. A complete result has has_more false.',
          }
        : {}),
    };
  };

  const budget = Math.floor(resolveAssistantBounds().maxToolResultChars * RESULT_BUDGET_SHARE);
  return largestFittingPayload(assemble, projected.length, budget);
}

/**
 * One case, with its timeline event types and evidence summaries.
 *
 * `checkCaseAccess` returns `true` for a case that does not exist ("let the
 * route handle 404"), so existence is established separately here — otherwise a
 * non-existent id would look like an access grant, and the difference between
 * "no such case" and "not yours" would leak the existence of cases in other
 * projects.
 *
 * This is also the only read that can answer *when* a case was completed. The
 * case document carries no completion timestamp; current completion transitions
 * record a `case_completed` event, so the moment is recoverable from the history
 * — for one case at a time. `completed_at` is derived from the full event list
 * rather than from the truncated `recent_events`, so a long-running case still
 * reports it.
 *
 * Legacy done rows created before that invariant may still lack the event.
 * `completion_time` keeps those rows honest as `not_recorded`; it never derives a
 * replacement timestamp. See `CompletionTimeState`.
 */
export async function readCaseForRequester(
  input: GetCaseInput,
  ctx: ToolReadContext,
): Promise<ToolReadPayload> {
  const snapshot = await collections.cases().doc(input.case_id).get();
  const case_ = snapshot.exists ? snapshot.data() : undefined;

  const allowed = await checkCaseAccess(input.case_id, ctx.requesterUserId);
  if (!case_ || case_.deleted_at || !allowed) {
    // One indistinguishable answer for "absent", "deleted" and "not yours" — and
    // the `answer` class, because that IS the answer about this case. Searching
    // for it by other means would only rediscover the same visibility rule.
    return classifiedRefusal('answer', {
      found: false,
      reason: 'No case with that id is visible to you.',
    });
  }

  const ownerIds = [case_.owner_user_id, case_.assigned_reviewer_id].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const [eventsSnap, evidenceSnap, ownerNames] = await Promise.all([
    collections.caseEvents().where('case_id', '==', input.case_id).get(),
    collections.evidence().where('case_id', '==', input.case_id).get(),
    resolveDisplayNames(ownerIds),
  ]);

  const allEvents = eventsSnap.docs
    .map((doc) => doc.data())
    .sort((a, b) => compareCodeUnits(b.created_at ?? '', a.created_at ?? ''));
  const completedAt = allEvents.find((event) => event.type === CASE_COMPLETED_EVENT)?.created_at
    ?? null;
  // Status decides whether the case finished; the event decides whether the
  // moment was written down. Keeping the two apart is what makes a null readable.
  const completionTime: CompletionTimeState = completedAt !== null
    ? 'recorded'
    : case_.status === DONE_STATUS
      ? 'not_recorded'
      : 'not_completed';
  const events = allEvents
    .slice(0, MAX_CASE_EVENTS)
    .map((event) => ({ type: event.type, created_at: event.created_at }));

  const evidence = evidenceSnap.docs
    .map((doc) => doc.data())
    .sort((a, b) => compareCodeUnits(b.created_at ?? '', a.created_at ?? ''))
    .slice(0, MAX_CASE_EVIDENCE)
    .map((row) => ({
      type: row.type,
      source_type: row.source_type,
      summary: row.summary ?? null,
      created_at: row.created_at,
    }));

  return {
    found: true,
    case: {
      case_id: case_.case_id,
      title: case_.title,
      description: case_.description,
      status: case_.status,
      case_type: case_.case_type ?? null,
      project_id: case_.project_id,
      repository_id: case_.repository_id,
      validation_track: case_.validation_track,
      risk_level: case_.risk_level,
      priority: case_.priority,
      decision_ready: case_.decision_ready,
      current_branch: case_.current_branch ?? null,
      current_pr_ref: case_.current_pr_ref ?? null,
      created_at: case_.created_at,
      updated_at: case_.updated_at,
      // Display name when one is on record, the raw user id otherwise — never
      // omitted (#950). `assigned_reviewer_name` is omitted entirely, not sent
      // as `null`, when the case carries no reviewer.
      owner_name: displayNameOf(case_.owner_user_id, ownerNames),
      ...(case_.assigned_reviewer_id
        ? { assigned_reviewer_name: displayNameOf(case_.assigned_reviewer_id, ownerNames) }
        : {}),
    },
    // Not a case field: the moment the case recorded its completion, or null when
    // it never did. `completion_time` says which reason the null has, and the
    // note appears only for the one a model would otherwise read as a fact.
    completed_at: completedAt,
    completion_time: completionTime,
    ...(completionTime === 'not_recorded'
      ? { completed_at_note: COMPLETION_NOT_RECORDED_NOTE }
      : {}),
    recent_events: events,
    evidence,
  };
}

/**
 * Knowledge assets in scopes the requester may see.
 *
 * Visibility follows the rule `GET /api/knowledge` already applies, so the tool
 * cannot become a second, more permissive door onto the same collection:
 *
 * - `project` scope → the requester's accessible project ids;
 * - `repo` scope → the repository's `project_id`, then the same check;
 * - `global` / `org` / `team` → visible to every authenticated user.
 *
 * An unresolvable `repo` scope_ref is dropped rather than shown (fail closed).
 */
export async function searchKnowledgeForRequester(
  input: SearchKnowledgeInput,
  ctx: ToolReadContext,
): Promise<ToolReadPayload> {
  const limit = clampLimit(input.limit);
  const isAdmin = await checkIsAdmin(ctx.requesterUserId);
  const accessible = await getAccessibleProjectIds(ctx.requesterUserId, isAdmin);

  let query: FirebaseFirestore.Query<KnowledgeAsset> = collections.knowledgeAssets();
  if (input.type) {
    query = query.where('type', '==', input.type);
  }
  const snapshot = await query.get();
  const assets = snapshot.docs.map((doc) => doc.data());

  const visible = accessible === 'all'
    ? assets
    : await filterVisibleAssets(assets, new Set(accessible));

  const matched = visible
    .filter((asset) =>
      matchesQuery(input.query, asset.title, asset.summary, (asset.tags ?? []).join(' ')),
    )
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, limit);

  return {
    assets: matched.map((asset) => ({
      knowledge_id: asset.knowledge_id,
      type: asset.type,
      title: asset.title,
      summary: asset.summary,
      status: asset.status,
      scope_type: asset.scope_type,
      tags: asset.tags ?? [],
      trust_level: asset.trust_level,
      updated_at: asset.updated_at,
    })),
    total_returned: matched.length,
    limit,
  };
}

async function filterVisibleAssets(
  assets: readonly KnowledgeAsset[],
  accessibleProjectIds: ReadonlySet<string>,
): Promise<KnowledgeAsset[]> {
  // Batch the unique repo ids once instead of a Firestore read per asset.
  const repoIds = [
    ...new Set(assets.filter((a) => a.scope_type === 'repo').map((a) => a.scope_ref)),
  ];
  const repoProjects = new Map<string, string | undefined>();
  await Promise.all(
    repoIds.map(async (repoId) => {
      const doc = await collections.repositories().doc(repoId).get();
      repoProjects.set(repoId, doc.exists ? doc.data()!.project_id : undefined);
    }),
  );

  return assets.filter((asset) => {
    if (asset.scope_type === 'project') return accessibleProjectIds.has(asset.scope_ref);
    if (asset.scope_type === 'repo') {
      const projectId = repoProjects.get(asset.scope_ref);
      return projectId !== undefined && accessibleProjectIds.has(projectId);
    }
    // global / org / team: visible to every authenticated user, same as the route.
    return true;
  });
}

/**
 * One knowledge asset the requester may see, body included.
 *
 * `arbitra_search_knowledge` deliberately never returns `body` — that field has
 * no bound and a page of them would blow the per-call result budget for every
 * OTHER row on the page. That left a real gap: a model that found the right
 * asset by title and summary had no call that could read what it actually
 * says, and burned its remaining step budget on detours instead. This is that
 * call, for exactly one asset at a time.
 *
 * Visibility reuses `getAccessibleProjectIds` and `filterVisibleAssets` — the
 * SAME helpers `searchKnowledgeForRequester` scopes its rows with — rather than
 * re-deriving the rule, so the two can never diverge: a project- or repo-scoped
 * asset a requester cannot see through search is exactly as invisible here.
 *
 * Absent and not-visible collapse to the one refusal, the same way
 * `readCaseForRequester` treats "no such case" and "not yours": a caller must
 * not be able to distinguish "this id does not exist" from "it exists in a
 * scope you cannot see" by trying it here.
 *
 * The full asset, body included, can still be large. Nothing here re-bounds
 * it: `buildReadToolSet`'s `truncateJson` already clips any oversized tool
 * result against `maxToolResultChars` and tells the model so — a second cap in
 * this function would just be a lower, undocumented duplicate of that one.
 */
export async function getKnowledgeForRequester(
  input: GetKnowledgeInput,
  ctx: ToolReadContext,
): Promise<ToolReadPayload> {
  const doc = await collections.knowledgeAssets().doc(input.knowledge_id).get();
  const asset = doc.exists ? doc.data() : undefined;

  const isAdmin = await checkIsAdmin(ctx.requesterUserId);
  const accessible = await getAccessibleProjectIds(ctx.requesterUserId, isAdmin);
  const visible = asset === undefined
    ? false
    : accessible === 'all'
      ? true
      : (await filterVisibleAssets([asset], new Set(accessible))).length > 0;

  if (!asset || !visible) {
    return classifiedRefusal('answer', {
      found: false,
      reason: 'No knowledge asset with that id is visible to you.',
    });
  }

  return {
    found: true,
    asset: {
      knowledge_id: asset.knowledge_id,
      type: asset.type,
      title: asset.title,
      summary: asset.summary,
      body: asset.body,
      status: asset.status,
      scope_type: asset.scope_type,
      tags: asset.tags ?? [],
      trust_level: asset.trust_level,
      updated_at: asset.updated_at,
    },
  };
}
