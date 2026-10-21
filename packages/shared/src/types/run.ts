export const VALID_RUN_TYPES = [
  'exploration_run',
  'implementation_run',
  'review_run',
  'rule_run',
  'build_run',
  'test_run',
  'evidence_collection_run',
  'manual_validation_run',
  'assistant_task_run',
  'assistant_action_run',
] as const;

export type RunType = (typeof VALID_RUN_TYPES)[number];

export function isValidRunType(value: string): value is RunType {
  return (VALID_RUN_TYPES as readonly string[]).includes(value);
}

/**
 * Run types belonging to the assistant lifecycle (`assistant_task` cases).
 * Their recovery semantics differ from every other run type: an unclaimed
 * assistant run is claimed by whichever worker gets there first, and an
 * expired assistant lease starts a FRESH attempt under a separate attempt cap
 * (`ARBITRA_ASSISTANT_MAX_ATTEMPTS`) instead of going through the global
 * transient-retry policy — see `RunSweepService`'s assistant sub-sweep.
 */
export const ASSISTANT_RUN_TYPES: readonly RunType[] = [
  'assistant_task_run',
  'assistant_action_run',
];

export function isAssistantRunType(value: RunType): boolean {
  return ASSISTANT_RUN_TYPES.includes(value);
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export const VALID_ASSISTANT_TASK_KINDS = [
  'arbitra_data_question',
  'action_request',
  'general_question',
] as const;

/** A classifier label for telemetry. It never grants or removes tools. */
export type AssistantTaskKind = (typeof VALID_ASSISTANT_TASK_KINDS)[number];

export const ASSISTANT_TOOL_SELECTION_REASON = 'requester_scoped_read_registry' as const;

/**
 * The immutable read-tool decision bound to one assistant attempt before the
 * first model call. The enabled set comes from the allowlisted read registry;
 * `task_kind` is deliberately descriptive only.
 */
export interface AssistantToolPolicyTrace {
  schema_version: 1;
  task_kind: AssistantTaskKind;
  enabled_tools: string[];
  tool_selection_reason: typeof ASSISTANT_TOOL_SELECTION_REASON;
}

export interface AssistantCancelIntent {
  revision: number;
  requested_at: string;
  requested_by: string;
}

export type AssistantCancelReconciler = 'executor' | 'cancel_service' | 'assistant_sweeper';

/**
 * Durable acknowledgement that a cancelled attempt's metering and redacted
 * read trace have either been recorded or are provably unavailable.
 *
 * The cancellation transaction cannot know what an in-flight executor has
 * already observed in memory. It therefore marks the Run as awaiting
 * reconciliation; exactly one executor or sweeper later writes this receipt
 * together with the immutable `run_cancelled` event it names.
 */
export interface AssistantCancelReceipt {
  revision: number;
  reconciled_at: string;
  reconciled_by: AssistantCancelReconciler;
  usage_status: 'complete' | 'partial' | 'unavailable';
  trace_status: 'recorded' | 'unavailable';
  event_id: string;
}

/**
 * Stable serialization used for Run/result parity. Always strict. Re-binding
 * an already-bound attempt does NOT go through this function or through
 * `assistantToolPoliciesEqual`; it asks the weaker
 * `assistantToolPolicyRebindable` below. Everything else — the Run/result
 * artifact parity checks — must keep comparing exactly what was persisted,
 * with no leniency of its own.
 *
 * `enabled_tools` is always emitted in registry order by
 * `decideAssistantPolicy`, so it is compared as stored: silently accepting a
 * reordering would accept a different loop-visible tool set (the AI SDK is
 * handed tools in this order; see `buildReadToolSet`).
 */
export function canonicalAssistantToolPolicy(policy: AssistantToolPolicyTrace): string {
  return JSON.stringify({
    schema_version: policy.schema_version,
    task_kind: policy.task_kind,
    enabled_tools: policy.enabled_tools,
    tool_selection_reason: policy.tool_selection_reason,
  });
}

export function assistantToolPoliciesEqual(
  left: AssistantToolPolicyTrace,
  right: AssistantToolPolicyTrace,
): boolean {
  return canonicalAssistantToolPolicy(left) === canonicalAssistantToolPolicy(right);
}

/**
 * May an already-bound attempt keep running under its STORED policy, given the
 * policy a re-entering executor just computed? Used by
 * `bindAssistantToolPolicy` (`assistant-tool-policy-binding.ts`) and nowhere
 * else — every other caller (Run/result artifact parity) keeps comparing with
 * strict `assistantToolPoliciesEqual` above.
 *
 * Directional and deliberately not an equality. The question a re-bind has to
 * answer is not "did these two decisions come out the same" but "is every tool
 * this attempt was already allowed to use still allowed": on replay the
 * executor keeps handing the model the STORED enabled set
 * (`assistant-task-executor.ts`, `selectReadTools(policy.enabled_tools)` on the
 * value read back from the Run), so a fresh policy that enables MORE cannot
 * widen the live attempt. Hence:
 *
 * - `task_kind` and `tool_selection_reason` must match — a different task kind
 *   or a different selection mechanism is a different decision, not a wider one;
 * - every stored `enabled_tools` name must still be in `fresh.enabled_tools`.
 *
 * This replaces strict equality, which failed an otherwise-healthy attempt with
 * `policy_binding_failed` (`run-retry-policy.ts` classifies that message
 * permanent, so the case is rejected with no retry) whenever the registry grew
 * between the bind and the re-entry: every tool addition changes the freshly
 * computed `enabled_tools`, so under strict equality every in-flight attempt
 * crossing that deploy died. Under the subset rule the stored set is still
 * fully available, so the replay proceeds.
 *
 * Not tolerated, on purpose: REMOVING a tool from the registry while attempts
 * are in flight. Those attempts' stored sets stop being a subset, so they
 * conflict, classify permanent, and reject their cases — fail-closed, which is
 * why a tool should be deprecated before it is removed.
 */
export function assistantToolPolicyRebindable(
  stored: AssistantToolPolicyTrace,
  fresh: AssistantToolPolicyTrace,
): boolean {
  if (stored.task_kind !== fresh.task_kind) return false;
  if (stored.tool_selection_reason !== fresh.tool_selection_reason) return false;
  const freshEnabled = new Set(fresh.enabled_tools);
  return stored.enabled_tools.every((name) => freshEnabled.has(name));
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  model: string;
}

export interface Run {
  run_id: string;
  case_id: string;
  run_type: RunType;
  trigger_source: string;
  status: RunStatus;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  input_refs: string[];
  output_refs: string[];
  summary?: string;
  token_usage?: TokenUsage;
  /** Identifies which prompt version produced the review, e.g. 'review_system:v3' or 'review_system:hardcoded' */
  prompt_version?: string;
  /**
   * ISO timestamp after which this run's lease is considered expired. A
   * `pending`/`running` run whose lease has lapsed (worker crashed, instance
   * killed mid-execution) is a candidate for the stale-run sweep — see
   * `ARBITRA_RUN_LEASE_TTL_MS`. Cleared on `completed`/`failed`.
   */
  lease_expires_at?: string;
  /** Random id of the worker instance currently holding this run's lease. Cleared on `completed`/`failed`. */
  worker_id?: string;
  /**
   * Marks a run whose ABSENCE of `lease_expires_at`/`worker_id` is intentional:
   * it was created through `createUnclaimedRun` and is waiting for a worker to
   * win `claimRun`, which stamps the lease/worker and deletes this flag.
   *
   * This flag is what separates the intended unclaimed state from the
   * stale-run sweep's "legacy / no lease" cohort, which fails any
   * `pending`/`running` run that has no lease and is older than
   * `ARBITRA_RUN_LEGACY_MAX_AGE_MS` (default 30 min). Without it, every
   * deliberately-unclaimed run would look exactly like a run whose writer
   * forgot to stamp a lease and would eventually be failed by that policy.
   * No run created via `createRun` ever carries it, so the legacy policy is
   * unchanged for every pre-existing run type.
   */
  awaiting_claim?: boolean;
  /** Number of execution attempts made for this run (retry bookkeeping). */
  attempt?: number;
  /**
   * Line count of the diff this review run was resolved against, BEFORE any
   * truncation. Review runs only.
   */
  diff_line_count?: number;
  /**
   * True when the reviewed diff was cut at the resolver's line cap, i.e. the
   * reviewer saw a prefix of the change and not the change (issue #877).
   * Recorded so an audit can tell after the fact what a review covered; the
   * gating consequence rides on the `diff_exceeds_limit` finding the run
   * raises, not on this field.
   */
  diff_truncated?: boolean;
  /**
   * The commit SHA `DiffResolver` actually fetched the reviewed diff for
   * (issue #1054). `review_run` only; absent on every run created before
   * this field existed and on any run whose diff did not come from
   * `DiffResolver`.
   *
   * This is what makes a completed `review_run` an assertion about a
   * SPECIFIC commit rather than "a review happened at some point this
   * iteration": for a case with a PR reference, `review_run_completed` /
   * `auto_approve_criteria_met` (`preconditions.ts`) require this to equal
   * `Case.current_head_sha` before the run counts toward the gate. Before
   * this field existed, the cheapest bypass of the review gate was: push a
   * trivial commit, obtain a genuine clean review of it, then push the real
   * change before approval — `currentIterationRuns` scoped only by time
   * since the last `changes_requested`, so the stale review still satisfied
   * both preconditions. `approved_head_sha` (`case.ts`) mitigates the
   * outcome (a later push downgrades the published commit status), but does
   * not make the review gate itself honest — the case still holds a
   * completed review of a commit nobody intended to ship. This field closes
   * that.
   *
   * A case with NO PR reference never has this requirement enforced —
   * `preconditions.ts`'s `completedReviewSatisfiesCommitBinding` falls back
   * to "any completed review_run this iteration" for that class, because no
   * GitHub commit status is ever published for it either (see that
   * function's doc comment; issue #1054 gap 1).
   */
  reviewed_head_sha?: string;
  /**
   * Set once a "run is taking too long" warning notification has fired for
   * this run (`RunCompletionHandler.scheduleRunTimeoutCheck`). Persisted on
   * the run doc (idempotent claim via a Firestore transaction) instead of
   * the old in-memory `Set` so the de-dupe survives an instance restart —
   * see `ARBITRA_RUN_TIMEOUT_MS` / the stale-run sweeper.
   */
  timeout_notified?: boolean;
  /**
   * Durable retry backstop (PR #742).
   * Set on a `failed` run when `RunCompletionHandler.handleRunFailure`
   * decides to retry: an in-process `setTimeout` is the fast path, but if
   * the instance dies before the timer fires (scale-to-zero, rolling
   * deploy), the retry would otherwise be silently lost — invisible to the
   * stale-run sweep, which only looks at `pending`/`running` runs. The
   * sweeper additionally queries `failed` runs with `retry_at <= now` and
   * `retry_dispatched` not set, and dispatches them via the same
   * claim-based path as the in-process timer.
   */
  retry_at?: string;
  /**
   * Idempotency flag for the durable retry backstop above: set (via a
   * Firestore transaction, `FirestorePipelineAdapter.claimRunRetryDispatch`)
   * by whichever of {in-process timer, stale-run sweep} gets there first, so
   * the other one is guaranteed to no-op instead of dispatching a second
   * retry run for the same failure.
   */
  retry_dispatched?: boolean;
  /**
   * Set while an assistant run has failed permanently and the case-side
   * documentation of that terminal failure (`assistant_context.wait_reason =
   * 'failed_permanently'` plus its `assistant_task_abandoned` event) is not yet
   * known to be written; cleared once it is.
   *
   * `RunCompletionHandler.handleRunFailure`'s permanent branch writes the
   * documentation in-process, but it is best-effort by contract — a Firestore
   * error there is swallowed so it cannot mask the original run failure, and an
   * instance can die mid-repair. Without a marker the case would then sit in
   * `open`/`in_build` with a failed run and no edge out of it, which is exactly
   * the wedge this documentation exists to prevent. The assistant sub-sweep
   * selects `failed` runs still carrying the marker on a single equality filter
   * and re-drives the (idempotent) repair.
   */
  assistant_failure_repair_pending?: boolean;
  /**
   * Durable tombstone written when the case-side terminal-failure repair is
   * discharged. It keeps the bounded marker-loss safety-net from selecting the
   * same historical failed Run on every sweep after a successful repair.
   */
  assistant_failure_repair_settled_at?: string;
  /**
   * New assistant task attempts start `unbound` and become `bound` exactly once
   * under the executor's ownership transaction. Legacy rows may have neither
   * field and are reported as unavailable rather than rewritten in bulk.
   */
  assistant_policy_state?: 'unbound' | 'bound';
  /** Immutable policy snapshot present exactly when the state is `bound`. */
  assistant_tool_policy?: AssistantToolPolicyTrace;
  /** Persisted cancellation fence; written by the #782 cancellation slice. */
  assistant_cancel_intent?: AssistantCancelIntent;
  /** True until the cancelled attempt's retained trace/usage has a receipt. */
  assistant_cancel_reconcile_pending?: boolean;
  /** Terminal, idempotent acknowledgement of cancellation trace reconciliation. */
  assistant_cancel_receipt?: AssistantCancelReceipt;
  created_at: string;
  updated_at: string;
}

export interface CreateRunInput {
  case_id: string;
  run_type: RunType;
  trigger_source: string;
  input_refs?: string[];
}
