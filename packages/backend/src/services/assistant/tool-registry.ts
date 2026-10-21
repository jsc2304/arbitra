import { z } from 'zod';
import { tool, type Tool, type ToolSet } from 'ai';
import type { AssistantBoundId } from './assistant-bounds.js';
import {
  CASE_ORDER_FIELDS,
  CASE_OWNER_CURRENT,
  countCaseTransitionsForRequester,
  countCasesForRequester,
  getKnowledgeForRequester,
  readCaseForRequester,
  searchCasesForRequester,
  searchKnowledgeForRequester,
} from './tool-reads.js';
import { TOOL_OUTCOME_GUIDANCE, liftReadOutcome, type ToolOutcome } from './tool-outcomes.js';

export {
  TOOL_OUTCOMES,
  TOOL_OUTCOME_GUIDANCE,
  READ_OUTCOME_KEY,
  classifiedRefusal,
  liftReadOutcome,
} from './tool-outcomes.js';
export type { ToolOutcome, ToolReadOutcome } from './tool-outcomes.js';

/**
 * Declarative registry of every tool Clerk may be handed.
 *
 * ## Why there is no `write`
 *
 * `ToolEffect` has exactly two members. There is no `'write'` arm, and adding
 * one is not a local change: the descriptor union has no variant that carries a
 * handler capable of acting, so an externally-effecting tool is not expressible
 * here at all.
 *
 * - a `read` descriptor supplies `read(input, ctx)`, which returns data;
 * - a `propose` descriptor supplies `propose(input, ctx)`, which returns a
 *   `ToolProposal` — a *description* of an intent. Nothing in this codebase
 *   applies a proposal; the recorder that would persist one does not exist yet.
 *   `propose` is present so that adding the first proposing tool is a
 *   descriptor plus a recorder, and touches neither the loop nor this union.
 * - both handlers receive only `ToolReadContext`, which carries the requester's
 *   identity and the call's abort signal. No Firestore handle, no pipeline
 *   adapter, no repository — so the capability a tool is handed cannot write.
 * - the loop is typed to accept `ReadToolDescriptor` only
 *   (`buildReadToolSet`), so even a future `propose` descriptor cannot reach it
 *   by accident.
 *
 * On top of the types, `assertToolDescriptor` re-checks each descriptor at
 * module load AND again in `buildReadToolSet`, so an untyped caller (a JS
 * consumer, an `as any` cast, a hand-rolled descriptor) cannot smuggle a write
 * handler past the boundary either. The check is wired into both paths on
 * purpose: a validator nothing calls is not a guarantee.
 *
 * ## Why this property is load-bearing
 *
 * The run-durability work this executor sits on top of can legitimately run the
 * loop more than once for one request: an expired lease produces a fresh
 * attempt, the assistant sub-sweep dispatches a run nobody claimed, and a crash
 * between claim and completion leaves a surplus run behind. All of that is safe
 * only because re-running the loop cannot repeat an outward action. Introducing
 * a tool with an external effect would invalidate that argument, not merely add
 * a feature.
 */
export const TOOL_EFFECTS = ['read', 'propose'] as const;

export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/** Blast radius if the tool misbehaves or is steered by injected content. */
export const TOOL_RISK_CLASSES = ['read_scoped', 'read_broad', 'proposal'] as const;

export type ToolRiskClass = (typeof TOOL_RISK_CLASSES)[number];

/**
 * Which system the tool reads from. `arbitra` reads are always on for every
 * requester (`assistant-policy.ts`'s "arbitra_* read tools remain always-on"
 * invariant).
 */
export const TOOL_CONNECTORS = ['arbitra'] as const;

export type ToolConnector = (typeof TOOL_CONNECTORS)[number];

/**
 * Capability names a tool declares it needs. Advisory documentation of intent
 * today — the enforcement is `tool-reads.ts` scoping every query to the
 * requester — but declared per tool so a future scope check has something to
 * check against rather than having to infer it from the implementation.
 */
export const TOOL_SCOPES = ['case:read', 'knowledge:read'] as const;

export type ToolScope = (typeof TOOL_SCOPES)[number];

/**
 * Everything a tool handler is given. Read capabilities and identity only —
 * see the `write` argument above. Frozen when built so a handler cannot even
 * decorate it for a later call.
 */
export interface ToolReadContext {
  /** Arbitra user id every read must be scoped to. Never the system actor. */
  readonly requesterUserId: string;
  /** The assistant case the attempt belongs to. Provenance, not authority. */
  readonly caseId: string;
  /** Aborts when the per-call or the attempt bound fires. */
  readonly signal: AbortSignal | undefined;
}

/** JSON-serialisable payload a read hands back. */
export type ToolReadPayload = Record<string, unknown>;

/**
 * A `propose` tool's output: a description of something a human or a separate
 * recorder could later do. Never applied by the loop.
 */
export interface ToolProposal {
  kind: string;
  summary: string;
  payload: ToolReadPayload;
}

interface ToolDescriptorBase<Input> {
  /** Stable, snake_case, `arbitra_`-prefixed. Appears in the audit trail. */
  name: string;
  /** Shown to the model. The only tool text the model ever sees. */
  description: string;
  inputSchema: z.ZodType<Input>;
  riskClass: ToolRiskClass;
  connector: ToolConnector;
  requiredScopes: readonly ToolScope[];
  /**
   * How much of a call belongs in evidence.
   *
   * The trace records exactly what this returns and nothing else — never the
   * raw input. Task text is user-authored and tool inputs are model-authored
   * from it, so echoing them wholesale into a case artifact would copy
   * arbitrary content into the audit trail. Sizes, flags and identifiers are
   * enough to reconstruct what happened.
   */
  summariseInput: (input: Input) => Record<string, string | number | boolean>;
}

export interface ReadToolDescriptor<Input> extends ToolDescriptorBase<Input> {
  effect: 'read';
  read: (input: Input, ctx: ToolReadContext) => Promise<ToolReadPayload>;
}

export interface ProposeToolDescriptor<Input> extends ToolDescriptorBase<Input> {
  effect: 'propose';
  propose: (input: Input, ctx: ToolReadContext) => Promise<ToolProposal>;
}

export type AssistantToolDescriptor<Input> =
  | ReadToolDescriptor<Input>
  | ProposeToolDescriptor<Input>;

/**
 * Input-erased descriptor types, for the heterogeneous registry and for the
 * loop. `any` here is the input type only — the effect union, the handler
 * shapes and the context type are all still enforced, which is where the
 * guarantee lives.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyToolDescriptor = AssistantToolDescriptor<any>;
export type AnyReadToolDescriptor = ReadToolDescriptor<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Keys that would indicate a handler able to act. Rejected at the boundary. */
const FORBIDDEN_DESCRIPTOR_KEYS = [
  'write',
  'mutate',
  'apply',
  'commit',
  'execute',
  'send',
  'delete',
] as const;

const TOOL_NAME_PATTERN = /^arbitra_[a-z0-9_]{3,48}$/;

export class ToolDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDescriptorError';
  }
}

/**
 * Runtime half of the "no externally-effecting tool" guarantee. Called for
 * every registry entry at module load and again for every descriptor handed to
 * `buildReadToolSet`.
 */
export function assertToolDescriptor(descriptor: AnyToolDescriptor): void {
  const candidate = descriptor as unknown as Record<string, unknown>;
  const name = typeof candidate['name'] === 'string' ? (candidate['name'] as string) : '<unnamed>';

  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ToolDescriptorError(
      `Tool name '${name}' must match ${TOOL_NAME_PATTERN} so tool identities in the audit trail are unambiguous.`,
    );
  }
  const effect = candidate['effect'];
  if (typeof effect !== 'string' || !(TOOL_EFFECTS as readonly string[]).includes(effect)) {
    throw new ToolDescriptorError(
      `Tool '${name}' declares effect '${String(effect)}'; only ${TOOL_EFFECTS.join(' | ')} exist. `
        + 'A tool with an external effect is not representable — see tool-registry.ts.',
    );
  }
  for (const forbidden of FORBIDDEN_DESCRIPTOR_KEYS) {
    if (forbidden in candidate) {
      throw new ToolDescriptorError(
        `Tool '${name}' exposes a '${forbidden}' handler. Tool descriptors carry no handler that can act.`,
      );
    }
  }
  if (effect === 'read' && typeof candidate['read'] !== 'function') {
    throw new ToolDescriptorError(`Read tool '${name}' has no read handler.`);
  }
  if (effect === 'propose' && typeof candidate['propose'] !== 'function') {
    throw new ToolDescriptorError(`Propose tool '${name}' has no propose handler.`);
  }
  if (!Array.isArray(candidate['requiredScopes']) || candidate['requiredScopes'].length === 0) {
    throw new ToolDescriptorError(`Tool '${name}' declares no required scopes.`);
  }
  if (typeof candidate['summariseInput'] !== 'function') {
    throw new ToolDescriptorError(
      `Tool '${name}' does not declare which part of a call belongs in evidence.`,
    );
  }
}

/** Narrows to the descriptors the loop may be handed. */
export function isReadToolDescriptor(
  descriptor: AnyToolDescriptor,
): descriptor is AnyReadToolDescriptor {
  return descriptor.effect === 'read';
}

// ── The tools ────────────────────────────────────────────────────────

/**
 * Accepted date shapes for the `created_at` bounds: a bare UTC day, or a full
 * ISO-8601 instant carrying a zone. A zone-less date-time is refused on purpose
 * — `new Date('2026-08-04T09:00')` is local time, which would silently shift the
 * window by the server's offset.
 */
const ISO_DAY_OR_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Every input schema is `.strict()`.
 *
 * The default zod behaviour — drop what you do not recognise — is the wrong
 * failure mode for a tool a model calls: a model that guesses `project_id`
 * (a field this very tool returns) would have the filter removed and receive an
 * UNFILTERED result set that looks exactly like a filtered one. The wrong answer
 * it then reports is indistinguishable from a right one. Refusing the call
 * instead costs one retry and names the offending key, so the model can fix it;
 * see `buildReadToolSet`, which turns the rejection into an actionable message
 * and records `unknown_input_keys` in the trace.
 */
const searchCasesInput = z
  .object({
    query: z
      .string()
      // `.min(1)`, not just `.max()`: an empty string passes a truthiness test
      // nowhere and silently disables the filter everywhere, which returns an
      // UNFILTERED set that looks exactly like a filtered one — the same failure
      // `.strict()` exists to prevent, one level down. Omit the key instead.
      .min(1)
      .max(200)
      .optional()
      .describe('Free-text filter matched against case title and description (substring, case-insensitive).'),
    status: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Exact case status, e.g. 'open', 'in_review', 'done'."),
    project: z
      .string()
      .min(1)
      .max(160)
      .optional()
      .describe(
        'Restrict to one project, given as its name (e.g. "Arbitra Core") or its project_id. '
        + 'Resolved against the projects you may see, and word order, case and punctuation do '
        + 'not matter — "Acme Atlas" finds "Atlas (Acme)" — but every word you give must be in '
        + 'the name. If a name matches several projects, or none, the result lists projects to '
        + 'pick from instead of guessing, and says whether that list is all of them.',
      ),
    created_after: z
      .string()
      .max(40)
      .regex(ISO_DAY_OR_INSTANT)
      .optional()
      .describe(
        'Only cases created at or after this point. Either a UTC day (YYYY-MM-DD, taken from '
        + '00:00:00Z) or a full ISO-8601 instant with a zone.',
      ),
    created_before: z
      .string()
      .max(40)
      .regex(ISO_DAY_OR_INSTANT)
      .optional()
      .describe(
        'Only cases created at or before this point. A UTC day (YYYY-MM-DD) covers that whole '
        + 'day, so passing the same day as created_after and created_before means "created on '
        + 'that day".',
      ),
    order_by: z
      .enum(CASE_ORDER_FIELDS)
      .optional()
      .describe(
        "Sort key, always descending. Defaults to 'updated_at'. A created_after/created_before "
        + "filter OVERRIDES it with 'created_at', because Firestore requires the field a range "
        + 'filter applies to to be the first sort key — so "created in this window, ordered by '
        + 'last activity" cannot be requested in one call; filter by date and order the returned '
        + 'rows yourself. The result reports the ordering actually used as ordered_by.',
      ),
    owner: z
      .literal(CASE_OWNER_CURRENT)
      .optional()
      .describe(
        "Restrict to cases owned by the requester themselves — pass 'current' for \"which/how "
        + 'many of mine are open\" in ONE call, instead of reading every visible case to check its '
        + 'owner. This narrows WITHIN the projects you may already see; it can never surface a '
        + "case in a project you cannot see, even one you happen to own. Every row's owner_name is "
        + "returned either way, filtered or not — see this tool's own description.",
      ),
    cursor: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe(
        'Continue a previous search: pass the next_cursor it returned and keep query, status, '
        + 'project, created_after, created_before, owner and order_by identical to the call that '
        + 'issued it. A cursor from a different filter set is refused, not answered off the wrong '
        + 'set; only limit may change between pages.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(
        'Maximum cases to return, 1 to 25. Defaults to 8. A page may come back shorter when the '
        + 'rows are large; rows_omitted says so and next_cursor continues from there.',
      ),
  })
  .strict();

export type SearchCasesInput = z.infer<typeof searchCasesInput>;

const countCasesInput = z
  .object({
    status: z
      .enum([
        'open', 'exploration', 'ready_for_build', 'in_build', 'in_validation',
        'in_review', 'needs_human_decision', 'verification_pending',
        'approved', 'pending_merge', 'done', 'rejected',
      ])
      .optional()
      .describe('Count only cases in this exact lifecycle status.'),
    case_type: z
      .enum([
        'ticket_implementation', 'bugfix', 'refactoring', 'security_review',
        'pr_review', 'manual_verification', 'assistant_task', 'other',
      ])
      .optional()
      .describe('Count only cases of this exact type.'),
    project: z
      .string()
      .min(1)
      .max(160)
      .optional()
      .describe(
        'Restrict to one project, given as its name or project_id. Resolution is requester-scoped '
        + 'and uses the same exact, substring and word matching as arbitra_search_cases; an '
        + 'unknown or ambiguous name is refused rather than silently broadened.',
      ),
    created_after: z
      .string()
      .max(40)
      .regex(ISO_DAY_OR_INSTANT)
      .optional()
      .describe(
        'Count only cases created at or after this UTC day (YYYY-MM-DD) or zoned ISO instant.',
      ),
    created_before: z
      .string()
      .max(40)
      .regex(ISO_DAY_OR_INSTANT)
      .optional()
      .describe(
        'Count only cases created at or before this UTC day or zoned ISO instant. A day includes '
        + 'its full 24 hours.',
      ),
    group_by_status: z
      .boolean()
      .optional()
      .describe(
        'Also return exact counts by lifecycle status. With status set, the map contains only '
        + 'that status; otherwise it contains every status, including zeros.',
      ),
    owner: z
      .literal(CASE_OWNER_CURRENT)
      .optional()
      .describe(
        "Count only cases owned by the requester themselves — pass 'current' for \"how many of "
        + 'mine are open\" as one exact count, instead of paging through arbitra_search_cases and '
        + 'checking each row\'s owner_name. Narrows WITHIN project/status/case_type/date filters '
        + 'and within the projects you may already see; it can never make a case in an invisible '
        + 'project countable, even one you own.',
      ),
  })
  .strict();

export type CountCasesInput = z.infer<typeof countCasesInput>;

/**
 * Every field this schema restricts is validated a second time inside
 * `resolveOccurredBounds`/`countCaseTransitionsForRequester`
 * (`tool-reads.ts`): this schema only admits a calendar SHAPE
 * (`ISO_DAY_OR_INSTANT`), not a calendar day that actually exists.
 */
const countCaseTransitionsInput = z
  .object({
    outcome: z
      .enum(['completed', 'rejected', 'any'])
      .optional()
      .describe(
        "Which terminal transition to count. 'completed' counts only case_completed events (the "
        + "case reached done through the normal pipeline). 'rejected' counts only case_rejected "
        + "events. 'any' — the default when omitted — counts both together: this is the number "
        + "for 'how many cases closed' or 'what was the throughput', because a rejected case is "
        + 'closed and counts toward throughput exactly as a completed one does.',
      ),
    occurred_after: z
      .string()
      .max(40)
      .regex(ISO_DAY_OR_INSTANT)
      .optional()
      .describe(
        'Only transitions recorded at or after this point — the moment the case actually reached '
        + 'done or was rejected, never when it was created and never its last activity. A UTC day '
        + '(YYYY-MM-DD, from 00:00:00Z) or a full ISO-8601 instant with a zone.',
      ),
    occurred_before: z
      .string()
      .max(40)
      .regex(ISO_DAY_OR_INSTANT)
      .optional()
      .describe(
        'Only transitions recorded at or before this point. A UTC day covers its full 24 hours, '
        + 'so passing the same day as occurred_after and occurred_before means "on that day".',
      ),
    project: z
      .string()
      .min(1)
      .max(160)
      .optional()
      .describe(
        'Restrict to one project, given as its name or project_id. Resolved exactly like '
        + 'arbitra_count_cases: word-order- and punctuation-insensitive against the projects you '
        + 'may see, refused rather than silently broadened when the name is unknown or ambiguous.',
      ),
    group_by_project: z
      .boolean()
      .optional()
      .describe(
        'Also return exact counts broken down by project — only projects you may see ever '
        + 'appear. With zero matches this is an empty list, never one row per visible project.',
      ),
    group_by_outcome: z
      .boolean()
      .optional()
      .describe(
        "Also return exact counts broken down by outcome (completed vs rejected). With outcome "
        + "set to a single value the breakdown has exactly one row; it is most useful with 'any'.",
      ),
  })
  .strict();

export type CountCaseTransitionsInput = z.infer<typeof countCaseTransitionsInput>;

const getCaseInput = z
  .object({
    case_id: z.string().min(3).max(120).describe('The case id, e.g. case-mild-coast-ab12.'),
  })
  .strict();

export type GetCaseInput = z.infer<typeof getCaseInput>;

const searchKnowledgeInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Free-text filter matched against title, summary and tags.'),
    type: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Knowledge type, e.g. 'pattern', 'precedent'."),
    limit: z.number().int().min(1).max(25).optional().describe('Maximum assets to return (max 25).'),
  })
  .strict();

export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInput>;

const getKnowledgeInput = z
  .object({
    knowledge_id: z
      .string()
      .min(3)
      .max(120)
      .describe('The knowledge asset id, e.g. ka_1a2b3c4d, as returned by arbitra_search_knowledge.'),
  })
  .strict();

export type GetKnowledgeInput = z.infer<typeof getKnowledgeInput>;

export const SEARCH_CASES_TOOL: ReadToolDescriptor<SearchCasesInput> = {
  name: 'arbitra_search_cases',
  description:
    'Search Arbitra cases the requesting user may see, filtered by free text, status, project, '
    + 'owner and creation date. Each row carries case_id, title, status, project_name, owner_name, '
    + 'created_at and updated_at, plus assigned_reviewer_name when the case has a reviewer '
    + 'assigned — enough to answer "which cases, in which project, owned by whom, created when, in '
    + 'what state" from this one call, without a per-case follow-up. owner_name is a display name '
    + 'when one is on record, otherwise the owner\'s raw user id — never omitted. Long titles are '
    + 'elided. No comments, evidence, decisions, risk or priority; arbitra_get_case has those. '
    + 'Read-only.\n'
    + 'owner: pass \'current\' to restrict to cases the requester themselves owns — "which/how many '
    + 'of mine are open" in this one call, rather than reading owner_name off every visible row. It '
    + 'narrows WITHIN the projects and other filters already applied; it can never surface a case '
    + 'in a project the requester cannot see.\n'
    + 'Ordering: descending by updated_at, or by created_at (see order_by). updated_at is LAST '
    + 'ACTIVITY — the last time anything about the case changed: a comment, a field edit, a status '
    + 'move. Ordering by it is NOT ordering by completion, and the newest updated_at is often a '
    + 'case that finished long ago and has merely been touched since. A case document carries no '
    + 'completion timestamp, so this search cannot sort by completion at all. A case that did '
    + 'complete usually records the moment in its history: arbitra_get_case reports it as '
    + 'completed_at, with completion_time saying whether that moment exists at all. To find "the '
    + 'most recently completed" of a set, read those two for the done rows with arbitra_get_case, '
    + 'or state plainly that your ranking is by last activity. Some done cases have no recorded '
    + 'completion time; such a case cannot be ranked by completion and must be reported as such '
    + 'rather than assumed to be the older one.\n'
    + 'Paging: has_more tells you whether the answer is complete; when it is true, repeat the call '
    + 'with next_cursor and every other filter unchanged. answered is false on a refusal, so an '
    + 'empty result that was refused is distinguishable from one that found nothing. Unknown input '
    + 'keys are refused, not ignored.',
  effect: 'read',
  inputSchema: searchCasesInput,
  riskClass: 'read_scoped',
  connector: 'arbitra',
  requiredScopes: ['case:read'],
  // Free-text inputs contribute their size only; the date bounds are recorded
  // verbatim because the schema already restricts them to a calendar shape, so
  // they cannot carry arbitrary text into the case's audit trail.
  summariseInput: (input) => ({
    query_chars: input.query?.length ?? 0,
    status: input.status ?? '',
    project_chars: input.project?.length ?? 0,
    created_after: input.created_after ?? '',
    created_before: input.created_before ?? '',
    order_by: input.order_by ?? '',
    // Structural, not free text — the schema admits only the literal
    // 'current', same reasoning as `case_id`/`knowledge_id` elsewhere in this
    // file being recorded verbatim.
    owner: input.owner ?? '',
    paged: input.cursor !== undefined,
    limit: input.limit ?? 0,
  }),
  read: (input, ctx) => searchCasesForRequester(input, ctx),
};

export const COUNT_CASES_TOOL: ReadToolDescriptor<CountCasesInput> = {
  name: 'arbitra_count_cases',
  description:
    'Return an exact server-side count of active, non-deleted Arbitra cases the requesting user '
    + 'may see. Filter by project, lifecycle status, case type, owner and creation date; '
    + 'optionally return exact counts grouped by status. Use this for questions such as "which '
    + 'project has more open work" or "how many of mine are open" — pass owner: \'current\' for '
    + 'the latter — instead of paging through arbitra_search_cases and counting rows yourself. '
    + 'The owner filter narrows WITHIN whatever else is visible; it can never make a case in an '
    + 'invisible project countable. The result contains numbers and applied-filter metadata only '
    + '— never case ids, titles or other case content. Read-only. This tool does not calculate '
    + 'average lifecycle duration: completion time is not '
    + 'materialized on Case documents, so an exact average requires a separate metric rather than '
    + 'an unbounded scan. It also does not answer "how many cases closed/completed/were rejected '
    + 'in this window" or throughput questions — status is CURRENT state, not when a case got '
    + 'there. Call arbitra_count_case_transitions for those instead.',
  effect: 'read',
  inputSchema: countCasesInput,
  riskClass: 'read_scoped',
  connector: 'arbitra',
  requiredScopes: ['case:read'],
  summariseInput: (input) => ({
    status: input.status ?? '',
    case_type: input.case_type ?? '',
    project_chars: input.project?.length ?? 0,
    created_after: input.created_after ?? '',
    created_before: input.created_before ?? '',
    group_by_status: input.group_by_status === true,
    // Structural, not free text — see SEARCH_CASES_TOOL's `owner`.
    owner: input.owner ?? '',
  }),
  read: (input, ctx) => countCasesForRequester(input, ctx),
};

export const COUNT_CASE_TRANSITIONS_TOOL: ReadToolDescriptor<CountCaseTransitionsInput> = {
  name: 'arbitra_count_case_transitions',
  description:
    'Return an exact server-side count of case_completed and/or case_rejected transition events '
    + 'the requesting user may see, in a time window. Use this — never arbitra_search_cases plus '
    + 'a per-case arbitra_get_case read for each row — for any question about how many cases '
    + 'finished, closed, or were rejected, or the throughput over a window: "how many cases '
    + 'closed today", "what was the throughput in the last 24 hours". Case status is CURRENT '
    + 'state and updated_at is LAST ACTIVITY, not completion — neither bounds a window like this '
    + 'at all — so this tool counts the recorded transition events directly instead of '
    + 'enumerating cases and reading each one.\n'
    + "outcome picks what counts: 'completed' (case_completed only), 'rejected' (case_rejected "
    + "only), or 'any' — the default — for both together. 'any' is what \"closed\" and "
    + '"throughput" mean here: a rejected case is closed and counts toward throughput exactly as '
    + 'a completed one does. occurred_after/occurred_before bound the moment of the TRANSITION '
    + 'itself, never case creation and never last activity. Optional project (name or '
    + 'project_id, resolved the same way arbitra_count_cases resolves it), and optional '
    + 'group_by_project / group_by_outcome for an exact breakdown alongside the total. The result '
    + 'carries the applied window, the outcome_definition in force, an as_of timestamp and the '
    + 'requester-visible scope — never case ids, titles or other case content.\n'
    + 'A case with no recorded transition event — done before the completion-event invariant '
    + 'existed, or since deleted — is honestly absent from this count, never inferred from '
    + "status or updated_at; excluded_unresolved_cases says so when it happens. When a bounded "
    + 'exact answer is not possible (the window holds more matching events than one call can '
    + 'join to project scope), this tool refuses explicitly rather than guessing at a partial '
    + 'number — narrow the window or add a project filter and repeat. Read-only.',
  effect: 'read',
  inputSchema: countCaseTransitionsInput,
  riskClass: 'read_scoped',
  connector: 'arbitra',
  requiredScopes: ['case:read'],
  summariseInput: (input) => ({
    outcome: input.outcome ?? 'any',
    project_chars: input.project?.length ?? 0,
    occurred_after: input.occurred_after ?? '',
    occurred_before: input.occurred_before ?? '',
    group_by_project: input.group_by_project === true,
    group_by_outcome: input.group_by_outcome === true,
  }),
  read: (input, ctx) => countCaseTransitionsForRequester(input, ctx),
};

export const GET_CASE_TOOL: ReadToolDescriptor<GetCaseInput> = {
  name: 'arbitra_get_case',
  description:
    'Read one Arbitra case the requesting user may see: its fields, its recent timeline event '
    + 'types and its evidence summaries. Fields include owner_name (a display name when one is on '
    + 'record, otherwise the owner\'s raw user id — never omitted) and assigned_reviewer_name, '
    + 'present only when the case has a reviewer assigned. Also returns completed_at — the moment '
    + 'this case recorded its completion, taken from its history. That is the only real completion '
    + 'time Arbitra has; arbitra_search_cases cannot sort by it, so ranking several cases by '
    + 'completion means reading each one here. Read-only.\n'
    + 'For legacy rows, completed_at null does NOT mean "not completed": done rows created before '
    + 'the completion-event invariant can have no recorded completion time. completion_time '
    + "says which it is — 'recorded' (completed_at is the real moment), 'not_recorded' (the case is "
    + "done but the moment was never written down) or 'not_completed' (the case has not finished). "
    + "On 'not_recorded' the time is UNKNOWN: do not treat it as older than a case that has one "
    + 'and do not rank the case by completion — say its completion time is not recorded.',
  effect: 'read',
  inputSchema: getCaseInput,
  riskClass: 'read_scoped',
  connector: 'arbitra',
  requiredScopes: ['case:read'],
  summariseInput: (input) => ({ case_id: input.case_id }),
  read: (input, ctx) => readCaseForRequester(input, ctx),
};

export const SEARCH_KNOWLEDGE_TOOL: ReadToolDescriptor<SearchKnowledgeInput> = {
  name: 'arbitra_search_knowledge',
  description:
    'Search Arbitra knowledge assets in scopes the requesting user may see. Returns title, '
    + 'summary, type, status and tags — never the body. Read-only. Once you have found the asset '
    + 'you need, call arbitra_get_knowledge with its knowledge_id to read the full content.',
  effect: 'read',
  inputSchema: searchKnowledgeInput,
  riskClass: 'read_scoped',
  connector: 'arbitra',
  requiredScopes: ['knowledge:read'],
  summariseInput: (input) => ({
    query_chars: input.query?.length ?? 0,
    type: input.type ?? '',
    limit: input.limit ?? 0,
  }),
  read: (input, ctx) => searchKnowledgeForRequester(input, ctx),
};

export const GET_KNOWLEDGE_TOOL: ReadToolDescriptor<GetKnowledgeInput> = {
  name: 'arbitra_get_knowledge',
  description:
    'Read one Arbitra knowledge asset the requesting user may see, by its knowledge_id. Returns '
    + 'everything arbitra_search_knowledge does — title, summary, type, status, scope_type, tags, '
    + 'trust_level, updated_at — PLUS body, the full content search never returns. Use this once '
    + 'arbitra_search_knowledge has found the asset you need, to read what it actually says rather '
    + 'than only its summary. A knowledge_id that does not exist and one you may not see get the '
    + 'exact same refusal, so this cannot be used to learn what exists outside scopes you can see. '
    + 'Read-only.',
  effect: 'read',
  inputSchema: getKnowledgeInput,
  riskClass: 'read_scoped',
  connector: 'arbitra',
  requiredScopes: ['knowledge:read'],
  // The id is structural, not content: it names which asset was read, the same
  // way GET_CASE_TOOL's `case_id` names which case was read. Recording it
  // verbatim is what makes the evidence row auditable. `query_chars` on
  // SEARCH_KNOWLEDGE_TOOL is reduced to a length for the opposite reason — a
  // free-text query carries the requester's own words.
  summariseInput: (input) => ({ knowledge_id: input.knowledge_id }),
  read: (input, ctx) => getKnowledgeForRequester(input, ctx),
};

/**
 * Every tool Clerk may expose. The policy snapshot takes the allowlisted read
 * descriptors in this stable order; requester authorization is enforced again
 * by each descriptor when called. A future non-read descriptor cannot enter
 * the model-visible set through classification (see `AssistantPolicyDecision`).
 */
export const ASSISTANT_TOOL_REGISTRY: readonly AnyToolDescriptor[] = [
  SEARCH_CASES_TOOL,
  COUNT_CASES_TOOL,
  COUNT_CASE_TRANSITIONS_TOOL,
  GET_CASE_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  GET_KNOWLEDGE_TOOL,
];

// Wired, not dormant: an externally-effecting descriptor cannot be added
// without this throwing on import of the module that would use it.
for (const descriptor of ASSISTANT_TOOL_REGISTRY) {
  assertToolDescriptor(descriptor);
}

export function toolDescriptorNames(): string[] {
  return ASSISTANT_TOOL_REGISTRY.map((d) => d.name);
}

export function findToolDescriptor(name: string): AnyToolDescriptor | undefined {
  return ASSISTANT_TOOL_REGISTRY.find((d) => d.name === name);
}

/** Read descriptors for a bound policy, in registry order. Invalid names fail closed. */
export function selectReadTools(names: readonly string[]): AnyReadToolDescriptor[] {
  const wanted = new Set(names);
  for (const name of wanted) {
    const descriptor = findToolDescriptor(name);
    if (!descriptor) {
      throw new ToolDescriptorError(
        `Bound assistant policy names unknown tool '${name}'; refusing the model boundary.`,
      );
    }
    if (!isReadToolDescriptor(descriptor)) {
      throw new ToolDescriptorError(
        `Bound assistant policy names non-read tool '${name}'; refusing the model boundary.`,
      );
    }
  }
  return ASSISTANT_TOOL_REGISTRY.filter(
    (d): d is AnyReadToolDescriptor => wanted.has(d.name) && isReadToolDescriptor(d),
  );
}

// ── Bridging descriptors into the AI SDK ─────────────────────────────

export interface ToolCallRecord {
  name: string;
  /** Whatever `summariseInput` declared belongs in evidence. Never raw input. */
  params: Record<string, string | number | boolean>;
  result_bytes: number;
  duration_ms: number;
  outcome: 'ok' | 'error' | 'bound_exceeded';
  /**
   * The class the model was handed for this call (`TOOL_OUTCOMES`). Recorded
   * next to `outcome`, which says whether the CALL worked, because the two
   * differ in the case that matters: a read that ran fine and refused carries
   * `outcome: 'ok'` with `result_outcome: 'answer'`. An audit that wants to know
   * whether the model was told it had its answer can then read it instead of
   * inferring it from the trace shape.
   */
  result_outcome?: ToolOutcome;
  /** Present on `error`/`bound_exceeded`. Never contains tool output. */
  detail?: string;
}

/**
 * The bounds enforcement the loop injects around every tool body. Implemented
 * by `AssistantLoopGuard` (`assistant-loop.ts`); an interface here so the
 * registry does not depend on the loop.
 */
export interface ToolCallGuard {
  readonly perCallLimitMs: number;
  readonly maxResultChars: number;
  /** Claims one call slot. Returns the bound that refuses it, or `null`. */
  claimCall(name: string): AssistantBoundId | null;
  record(record: ToolCallRecord): void;
  /** Reports a bound so the loop can abort and end the attempt cleanly. */
  reportBound(bound: AssistantBoundId): void;
  /**
   * Counts a completed read against its repetition signature (see
   * `readSignature`) and returns how many times this attempt has now seen it,
   * so the wrapper can mark the read as a repeat from the third one on.
   */
  noteReadSignature(signature: string): number;
}

/**
 * Wrap read descriptors as AI SDK tools.
 *
 * Accepts `ReadToolDescriptor` only — the compiler will not let a `propose`
 * descriptor through, and `assertToolDescriptor` re-checks at runtime.
 *
 * The wrapper never throws. A bound or a tool error is reported to the guard
 * (which aborts the attempt) and ALSO returned to the model as a classified
 * envelope, so the outcome does not depend on how the SDK handles a rejected
 * `execute`.
 *
 * Every result the model receives carries `outcome` (see `TOOL_OUTCOMES`) as its
 * first key, so the class is in ONE place on every call rather than something to
 * be inferred from which keys happen to be present. A successful read's payload
 * is passed through byte-for-byte under `untrusted_tool_result`; the envelope
 * around it is what gained the field.
 */
export function buildReadToolSet(
  descriptors: readonly AnyReadToolDescriptor[],
  ctx: ToolReadContext,
  guard: ToolCallGuard,
  /** Durable cancellation fence checked immediately before every read starts. */
  beforeExecute?: () => Promise<void>,
): ToolSet {
  const frozenCtx: ToolReadContext = Object.freeze({
    requesterUserId: ctx.requesterUserId,
    caseId: ctx.caseId,
    signal: ctx.signal,
  });

  const set: Record<string, Tool> = {};
  for (const descriptor of descriptors) {
    assertToolDescriptor(descriptor);
    // Unreachable through the typed path — the parameter type already excludes
    // it — but kept so the guarantee does not rest on the type system alone: an
    // untyped caller passing a `propose` descriptor is refused here too.
    if (!isReadToolDescriptor(descriptor as AnyToolDescriptor)) {
      throw new ToolDescriptorError(
        `Tool '${descriptor.name}' is not a read tool and must not reach the loop.`,
      );
    }
    set[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: descriptor.inputSchema as z.ZodType<unknown>,
      execute: async (rawInput: unknown) => {
        // This is intentionally outside the wrapper's classified-error path:
        // cancellation is control flow for the whole attempt, not a failed
        // read result the model may reason over. The next model boundary is
        // fenced too, so even providers that materialise a tool exception as a
        // result cannot turn it into another post-cancel call.
        await beforeExecute?.();
        const refused = guard.claimCall(descriptor.name);
        if (refused) {
          guard.reportBound(refused);
          guard.record({
            name: descriptor.name,
            params: {},
            result_bytes: 0,
            duration_ms: 0,
            outcome: 'bound_exceeded',
            result_outcome: 'failed',
            detail: refused,
          });
          // `failed`, not `transient`: the allowance does not come back inside
          // this attempt, so "the same call may work again" would be false and
          // would buy another wasted read.
          return failedResult(`Refused: the ${refused} bound is exhausted.`);
        }

        const parsed = (descriptor.inputSchema as z.ZodType<unknown>).safeParse(rawInput);
        if (!parsed.success) {
          const unknownKeys = unrecognisedKeys(parsed.error);
          guard.record({
            name: descriptor.name,
            params: unknownKeys.length > 0 ? { unknown_input_keys: unknownKeys.length } : {},
            result_bytes: 0,
            duration_ms: 0,
            outcome: 'error',
            // The drop is nameable in the trace; the key names themselves are
            // model-authored text and stay out of it, same rule as raw input.
            result_outcome: 'invalid_call',
            detail: unknownKeys.length > 0 ? 'unknown_input_keys' : 'invalid_input',
          });
          return {
            outcome: 'invalid_call' as const,
            guidance: TOOL_OUTCOME_GUIDANCE.invalid_call,
            message: describeInputRejection(descriptor.inputSchema, parsed.error),
          };
        }
        const input = parsed.data;
        const params = descriptor.summariseInput(input);

        const startedAt = Date.now();
        try {
          const raw = await withCallLimit(
            () => descriptor.read(input, frozenCtx),
            guard.perCallLimitMs,
          );
          // A read that could not answer declares which class its refusal is;
          // the declaration is lifted out so the payload the model sees is the
          // data and nothing about the plumbing.
          const { outcome, payload } = liftReadOutcome(raw);
          const serialised = truncateJson(payload, guard.maxResultChars);
          const repeats = guard.noteReadSignature(
            readSignature(descriptor.name, params, serialised.bytes, rawCursor(input)),
          );
          guard.record({
            name: descriptor.name,
            params,
            result_bytes: serialised.bytes,
            duration_ms: Date.now() - startedAt,
            // The CALL worked either way — a refusal is a read that ran.
            outcome: 'ok',
            result_outcome: outcome,
          });
          // Delimited as data: the system prompt states that anything under
          // `untrusted_tool_result` is content, never instructions.
          const envelope = outcome === 'ok'
            ? { outcome, untrusted_tool_result: serialised.value }
            : {
                outcome,
                guidance: TOOL_OUTCOME_GUIDANCE[outcome],
                untrusted_tool_result: serialised.value,
              };
          // A FIELD, not prose alone: the classified-outcome work established that
          // this model branches on fields it can read and only unreliably on prose
          // it has to interpret. Never a refusal — pagination through a long
          // result legitimately repeats a call shape, so the repetition is made
          // visible and the model decides.
          return repeats < REPEAT_READ_THRESHOLD
            ? envelope
            : { ...envelope, repeat_read: true, repeat_read_guidance: REPEAT_READ_GUIDANCE };
        } catch (err) {
          const overCallLimit = err instanceof ToolCallLimitError;
          if (overCallLimit) guard.reportBound('tool_call_limit');
          // A read that threw is classified rather than flattened into one
          // message: an index that is still building and a filter that can never
          // be served call for opposite next moves, and the model cannot pick
          // between them from prose it has to interpret.
          const outcome: ToolOutcome = overCallLimit ? 'failed' : classifyReadError(err);
          guard.record({
            name: descriptor.name,
            params,
            result_bytes: 0,
            duration_ms: Date.now() - startedAt,
            outcome: overCallLimit ? 'bound_exceeded' : 'error',
            result_outcome: outcome,
            detail: overCallLimit ? 'tool_call_limit' : errorDetail(err),
          });
          if (overCallLimit) {
            return failedResult('Refused: the tool_call_limit bound is exhausted.');
          }
          return outcome === 'transient'
            ? {
                outcome: 'transient' as const,
                guidance: TOOL_OUTCOME_GUIDANCE.transient,
                message: TRANSIENT_READ_MESSAGE,
              }
            : failedResult(readFailureMessage(err));
        }
      },
    }) as Tool;
  }
  return set as ToolSet;
}

/**
 * From which occurrence an identical read is marked as a repeat.
 *
 * Three, not two: a follow-up page of the same search is an ordinary second
 * occurrence, and warning on it would train the model to distrust pagination.
 * The observed defect this exists for was longer: four consecutive pages of one
 * free-text search, each ~525 bytes of no rows, burned four of five reads on
 * information the first page had already delivered.
 */
export const REPEAT_READ_THRESHOLD = 3;

/**
 * Result sizes are compared in buckets of this many bytes, because two
 * near-empty pages of the same search differ by a few bytes of cursor while
 * saying the same thing. Pages carrying real rows vary in size far more than a
 * bucket and separate on their own.
 */
const REPEAT_READ_SIZE_BUCKET_BYTES = 100;

/** One sentence, in the same channel as the result it qualifies. */
export const REPEAT_READ_GUIDANCE =
  'This read keeps returning essentially the same result; the next identical call counts '
  + 'against your read budget without adding information — change the call or answer from '
  + 'what you already have.';

/**
 * What makes two reads "the same" for the repeat warning: the tool, the
 * parameter summary the trace already records (sizes, flags and identifiers —
 * never raw input), the result-size bucket, and the raw pagination cursor, if
 * this call carried one.
 *
 * The cursor is read separately from `params` because `summariseInput`
 * reduces it to a boolean for the trace (`paged: input.cursor !== undefined`
 * on `SEARCH_CASES_TOOL`) — right for the audit record, which must not carry
 * an opaque continuation token verbatim, but wrong for this check: every page
 * from the second on then differs from every other page only by its byte
 * count, so several full pages of one search landing in the same 100-byte
 * bucket (they do — real rows vary far less than that) collide into one
 * signature and trip the warning on legitimate pagination. Folding the cursor
 * in here, before it is summarised away, makes every page's signature unique
 * by construction; a genuinely repeated call (the same cursor, or no cursor,
 * fetched again) still collides, which is the repetition this check exists to
 * catch. The cursor never leaves this string — not logged, not stored beyond
 * it — so nothing extra reaches the trace.
 */
function readSignature(
  name: string,
  params: Record<string, string | number | boolean>,
  resultBytes: number,
  cursor: string | undefined,
): string {
  return JSON.stringify([
    name,
    params,
    Math.floor(resultBytes / REPEAT_READ_SIZE_BUCKET_BYTES),
    cursor ?? null,
  ]);
}

/**
 * The one raw-input field this file reads directly rather than through
 * `summariseInput`. Structural, not tied to any one descriptor's schema — a
 * read tool with no `cursor` field simply always resolves to `undefined` here,
 * which changes nothing about its signature.
 */
function rawCursor(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const cursor = (input as { cursor?: unknown }).cursor;
  return typeof cursor === 'string' ? cursor : undefined;
}

/** The `failed` envelope, which three separate paths hand back. */
function failedResult(message: string): {
  outcome: 'failed';
  guidance: string;
  message: string;
} {
  return { outcome: 'failed', guidance: TOOL_OUTCOME_GUIDANCE.failed, message };
}

/**
 * gRPC status codes Firestore reports for conditions that pass on their own.
 * Numbers rather than names because that is what `err.code` carries: 4
 * DEADLINE_EXCEEDED, 8 RESOURCE_EXHAUSTED, 10 ABORTED, 13 INTERNAL, 14
 * UNAVAILABLE.
 */
const TRANSIENT_GRPC_CODES: readonly number[] = [4, 8, 10, 13, 14];

const TRANSIENT_READ_PATTERNS: readonly RegExp[] = [
  // A composite index that exists but is not usable yet. This is the exact
  // condition that made one call fail mid-attempt and had the model conclude the
  // filter was unsupported.
  /currently building/i,
  /\b(?:UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|ABORTED)\b/,
  /deadline[- ]exceeded/i,
  /rate[- ]?limit/i,
  /\b(?:429|503|504)\b/,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/,
  /socket hang up/i,
];

/** A query whose index is missing outright, as opposed to still building. */
const INDEX_UNAVAILABLE = /requires an index|FAILED_PRECONDITION/i;

/**
 * Fixed text, never the caught error's own message.
 *
 * Firestore's index errors carry the query shape and a project-specific console
 * URL, and its permission errors carry document paths — none of which belongs in
 * a model's context or, through the answer, in a case artifact. What the model
 * needs is the class and the next move, both of which are constant per class.
 */
const TRANSIENT_READ_MESSAGE =
  'The tool could not complete this call right now. This says nothing about the filters you used.';

const INDEX_UNAVAILABLE_MESSAGE =
  'This tool cannot serve that combination of filters. The filters themselves are valid, so '
  + 'repeating the call without them would answer a different question — report that this '
  + 'combination could not be read instead.';

const GENERIC_READ_FAILURE_MESSAGE = 'The tool could not complete this call.';

function classifyReadError(err: unknown): Extract<ToolOutcome, 'transient' | 'failed'> {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && TRANSIENT_GRPC_CODES.includes(code)) {
    // FAILED_PRECONDITION is code 9 and deliberately absent from that list: a
    // missing index does not appear on its own, so retrying it is the wasted
    // read this classification exists to prevent.
    return 'transient';
  }
  return TRANSIENT_READ_PATTERNS.some((pattern) => pattern.test(message)) ? 'transient' : 'failed';
}

function readFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return INDEX_UNAVAILABLE.test(message)
    ? INDEX_UNAVAILABLE_MESSAGE
    : GENERIC_READ_FAILURE_MESSAGE;
}

/** Input keys the model sent that the schema does not declare. */
function unrecognisedKeys(error: z.ZodError): string[] {
  const keys = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) keys.add(String(key));
    }
  }
  return [...keys];
}

/** Top-level keys a schema declares, for the "here is what exists" half of a rejection. */
function declaredInputKeys(schema: z.ZodType<unknown>): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

const MAX_REPORTED_ISSUES = 5;
const MAX_REPORTED_KEY_CHARS = 60;

/**
 * Turn a schema rejection into something the model can act on.
 *
 * The previous message ("Invalid tool input. Check the schema and try again.")
 * named neither the field nor the problem, so the only available next move was
 * to guess — and a guess costs a call out of the attempt's budget. Field names
 * and zod's own messages are safe to hand back: both are structural, and the
 * offending keys were written by the model in the first place.
 */
function describeInputRejection(schema: z.ZodType<unknown>, error: z.ZodError): string {
  const unknownKeys = unrecognisedKeys(error);
  if (unknownKeys.length > 0) {
    const listed = unknownKeys
      .slice(0, MAX_REPORTED_ISSUES)
      .map((key) => key.slice(0, MAX_REPORTED_KEY_CHARS))
      .join(', ');
    const declared = declaredInputKeys(schema).join(', ');
    return (
      `Rejected: unknown input key(s) ${listed}. This tool accepts only: ${declared}. `
      + 'Nothing was silently ignored — the call did not run. Retry with supported keys.'
    );
  }
  const problems = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `Invalid tool input — ${problems}. The call did not run; fix these and retry.`;
}

class ToolCallLimitError extends Error {
  constructor() {
    super('tool_call_limit');
    this.name = 'ToolCallLimitError';
  }
}

async function withCallLimit<T>(run: () => Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ToolCallLimitError()), limitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound the bytes a tool can push into the next model call. Truncation is
 * reported to the model so it cannot mistake a clipped list for a complete one.
 */
function truncateJson(
  payload: ToolReadPayload,
  maxChars: number,
): { value: unknown; bytes: number } {
  const serialised = JSON.stringify(payload) ?? '';
  if (serialised.length <= maxChars) {
    return { value: payload, bytes: serialised.length };
  }
  return {
    value: {
      truncated: true,
      reason: 'The result exceeded the per-call result size limit and was clipped.',
      partial: serialised.slice(0, maxChars),
    },
    bytes: serialised.length,
  };
}

/** Error text safe for the trace: message only, no stack, no tool output. */
function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 200);
}
