import type { AssistantCancelIntent } from './run.js';

export type CaseStatus =
  | 'open'
  | 'exploration'
  | 'ready_for_build'
  | 'in_build'
  | 'in_validation'
  | 'in_review'
  | 'needs_human_decision'
  | 'verification_pending'
  | 'approved'
  | 'pending_merge'
  | 'done'
  | 'rejected';

export type ValidationTrack = 'direct' | 'manual';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export type SourceType = 'jira' | 'manual' | 'git' | 'google_chat' | 'other';

export type CaseType =
  | 'ticket_implementation'
  | 'bugfix'
  | 'refactoring'
  | 'security_review'
  | 'pr_review'
  | 'manual_verification'
  | 'assistant_task'
  /**
   * Auto-created from a Session Signal or PR webhook when no case is bound
   * to the (repository, branch) pair yet (issue #986 / ADR-0001). Runs the
   * shortened `observed` lifecycle slice in `status-transitions.ts`
   * (open → in_build → done, all auto-trigger) instead of the full
   * engineering lifecycle — see `SCOPED_CASE_TYPES` there. Escalation to the
   * full governed lifecycle is a separate, later change (issue #987); this
   * type alone never blocks anything.
   */
  | 'observed'
  | 'other';

/**
 * Case types that produce code changes and therefore must live on a
 * dedicated feature branch — never on `main`/`master`.
 */
export const CODE_PRODUCING_CASE_TYPES = [
  'ticket_implementation',
  'bugfix',
  'refactoring',
  'security_review',
] as const satisfies readonly CaseType[];

export type CodeProducingCaseType = (typeof CODE_PRODUCING_CASE_TYPES)[number];

export function isCodeProducingCaseType(
  type: CaseType | undefined,
): type is CodeProducingCaseType {
  return !!type && (CODE_PRODUCING_CASE_TYPES as readonly CaseType[]).includes(type);
}

export function isProtectedBranch(branch: string | undefined): boolean {
  if (!branch) return false;
  const normalized = branch.trim().toLowerCase();
  return normalized === 'main' || normalized === 'master';
}

const BRANCH_PREFIX_BY_CASE_TYPE: Record<CodeProducingCaseType, string> = {
  ticket_implementation: 'feat',
  bugfix: 'fix',
  refactoring: 'refactor',
  security_review: 'security',
};

export function branchPrefixForCaseType(type: CodeProducingCaseType): string {
  return BRANCH_PREFIX_BY_CASE_TYPE[type];
}

export function slugifyForBranch(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return '';
  if (cleaned.length <= 40) return cleaned;
  const trimmed = cleaned.slice(0, 40).replace(/-+[^-]*$/, '');
  return (trimmed || cleaned.slice(0, 40)).replace(/-+$/, '');
}

export function suggestBranchForCaseType(
  type: CodeProducingCaseType,
  title: string,
): string {
  const slug = slugifyForBranch(title) || 'change';
  return `${branchPrefixForCaseType(type)}/${slug}`;
}

/**
 * A single intelligence finding attached directly to the target Case. Replaces
 * the legacy "create a nudge case per detection" model (Phase 1 of the
 * intelligence-detector refactor): when a detector's `target_kind === 'case'`
 * the finding is appended to the case's `intelligence_flags` instead of
 * spawning a new case. Dedup is on `signature` (same format as
 * `buildSignature(detector_id, target_kind, target_id)`).
 */
export interface IntelligenceFlag {
  detector_id: string;
  /** detector_id:target_kind:target_id — same buildSignature() format. */
  signature: string;
  severity: 'low' | 'medium';
  summary: string;
  evidence: Record<string, unknown>;
  /** ISO timestamp the flag was (re-)written. */
  flagged_at: string;
}

export interface PendingGate {
  gate_id: import('./lifecycle-profile.js').GateId;
  target_status: CaseStatus;
  since: string; // ISO timestamp
}

/**
 * Why the assistant lifecycle ended without a result.
 *
 * New writes use only `failed_permanently`: both a permanent failure and an
 * exhausted retry ladder end terminally in `rejected`. `clarification` and
 * `retry_exhausted` remain parseable solely for old stored documents; the live
 * assistant matrix has no hold/resume edge and no writer may create them.
 */
export type AssistantWaitReason = 'clarification' | 'retry_exhausted' | 'failed_permanently';

export interface AssistantContext {
  /** Entry point the request arrived on — see `AssistantIntakeChannel`. */
  channel: string;
  /**
   * Google-Chat coordinates. Optional because they only exist for the Chat
   * channel: the in-app route (`POST /api/assistant/tasks`) has no space,
   * thread, or message to point at, and intake records only what it knows
   * rather than filling these with placeholders.
   */
  space_name?: string;
  thread_name?: string;
  source_message_name?: string;
  /** Channel-scoped requester identity (Chat: `users/<id>`). */
  chat_user_name?: string;
  conversation_visibility: 'direct' | 'space';
  /**
   * Arbitra user id of the requester, i.e. the identity the case is owned by
   * and whose per-user limits and Clerk project were resolved at intake.
   * Channel-independent, unlike `chat_user_name`.
   */
  requester_user_id?: string;
  /**
   * Classification of the request (e.g. answer a question vs. change code).
   * Absent until the executor classifies it — intake deliberately does not
   * guess, so an absent value means "not classified yet", not "unknown kind".
   */
  task_kind?: string;
  risk_level: string;
  policy_version: string;
  prompt_version: string;
  wait_reason?: AssistantWaitReason;
  /**
   * The assistant run whose outcome produced `wait_reason`, and its attempt
   * number.
   *
   * The terminal-failure precondition compares `wait_run_id` against the case's
   * most recent assistant run, so an older attempt cannot reject a newer one.
   *
   * Required for `wait_reason: 'failed_permanently'` (enforced in
   * `assistantContextSchema`): that reason is only satisfiable as a terminal
   * verdict attributed to a specific run, so an unattributed one would leave the
   * case with no auto edge at all. It may be absent only on legacy
   * `clarification` / `retry_exhausted` documents, which are readable but no
   * longer drive a live transition.
   */
  wait_run_id?: string;
  wait_attempt?: number;
  /**
   * Flat, queryable blueprint reference (`docs/specs/clerk-config-scheduling-chat.md`
   * Slice B). Present only on a case created through the `blueprint` channel.
   * Kept as its own top-level field — rather than only inside
   * `blueprint_context` — because the overlap-'skip' check
   * (`TaskBlueprintService`) needs to find "a non-terminal case carrying this
   * blueprint_id" with a plain equality filter; querying into a nested object
   * works in Firestore but this mirrors how every other queryable reference
   * on this type (e.g. `wait_run_id`) is already flat.
   */
  blueprint_id?: string;
  /**
   * Immutable snapshot of the blueprint version and content that produced
   * this occurrence, stamped by `AssistantIntakeService` at intake time —
   * NOT re-read from the (mutate-in-place) `TaskBlueprint` row. This is what
   * makes an occurrence's prompt reproducible after the blueprint is later
   * edited: `blueprint_id` above always names the CURRENT blueprint,
   * `blueprint_context.blueprint_version`/`.prompt_text` name what was
   * effective WHEN THIS CASE WAS CREATED.
   */
  blueprint_context?: {
    blueprint_id: string;
    blueprint_version: number;
    prompt_text: string;
  };
  /**
   * Set by `AssistantTaskExecutor` on the same `done`-transition write that
   * classifies `task_kind` — see that method's `extraCaseUpdates`. Absent
   * until the run finishes; a non-terminal (pending) case never has this
   * field, so callers reading it for occurrence history must not treat
   * "absent" as "no reads were withheld".
   */
  reads_withheld?: boolean;
  /** Present only alongside `reads_withheld: true`; the read-budget reason recorded on the same run. */
  reads_withheld_reason?: string;
  /**
   * Stamped by `EventNotifier` (Slice F completion hook,
   * `docs/specs/clerk-config-scheduling-chat.md`) the first time it attempts
   * to post this case's terminal outcome (done or rejected) back into its
   * originating Google Chat thread — set on every attempt, success or
   * failure alike, since a failed Chat POST is not retried any more than
   * `notifyRequesterChat`'s webhook send is. Guards against posting the
   * outcome a second time if `EventNotifier.onCaseEvent` is ever invoked
   * again for the same case (e.g. a notification-reconciliation replay).
   */
  chat_reply_posted_at?: string;
}

/**
 * Immutable provenance for a Clerk follow-up Case.
 *
 * The field exists only on persisted `Case` documents. It is deliberately
 * absent from `CreateCaseInput` and `UpdateCaseInput`, so public case routes
 * cannot forge or rewrite a thread edge; only the dedicated assistant intake
 * transaction may write it.
 */
export interface AssistantThreadLink {
  schema_version: 1;
  /** First Case in the conversation. */
  root_case_id: string;
  /** Immediate predecessor whose result is supplied to this turn. */
  parent_case_id: string;
  /** Exact completed assistant attempt used as context. */
  prior_run_id: string;
  /** Exact task_result Evidence row used as context. */
  prior_result_evidence_id: string;
  /** Exact result Artifact referenced by that Evidence row. */
  prior_result_artifact_id: string;
  /** Root is depth 0; its first follow-up is depth 1. */
  depth: number;
}

export interface Case {
  case_id: string;
  title: string;
  description: string;
  source_type: SourceType;
  source_ref: string;
  project_id: string;
  repository_id: string;
  owner_user_id: string;
  assigned_reviewer_id?: string;
  status: CaseStatus;
  validation_track: ValidationTrack;
  risk_level: RiskLevel;
  priority: Priority;
  case_type?: CaseType;
  assistant_context?: AssistantContext;
  /** System-owned link to the immutable preceding Clerk result. */
  assistant_thread?: AssistantThreadLink;
  /**
   * System-owned cancellation fence for an assistant task. Public create and
   * update schemas intentionally cannot set it; the dedicated cancellation
   * transaction writes the same revision to the Case and its active Runs.
   */
  assistant_cancel_intent?: AssistantCancelIntent;
  current_branch?: string;
  current_pr_ref?: string;
  /**
   * The most recent PR head SHA Arbitra has OBSERVED for this case, written
   * by the webhook on every `pull_request.opened`/`synchronize`/`push` that
   * links or enriches the case (issue #1045).
   *
   * Exists so the approval pin below can be stamped inside the transition
   * transaction: `applyTransitionInTransaction` cannot call GitHub, so the
   * commit an approval covers has to already be on the case document when
   * the transition runs. Also more honest than a live GitHub read would be
   * — it is the commit Arbitra actually saw, not whatever HEAD happens to be
   * at the moment of the read.
   *
   * System-owned; absent on cases whose PR Arbitra has never received a
   * webhook for.
   */
  current_head_sha?: string;
  /**
   * The PR head SHA the case's approval covers (issue #1045).
   *
   * Before this field existed, `arbitra/case` was published from case STATUS
   * alone: an `approved` case re-published `success` onto ANY later head SHA,
   * so pushing a fixup after approval certified a never-reviewed commit past
   * a required status check. A published status has to be a statement about a
   * SPECIFIC commit, so the approval carries the commit it was made against.
   *
   * Stamped on any transition into `approved`, copying `current_head_sha`
   * in the same atomic write as the status. There is NO single write path
   * for a case's status — three sites write it, and all three stamp this
   * field: `applyTransitionInTransaction` (every human decision),
   * `Pipeline.executeTransition` (the autonomous auto-approve) and
   * `Pipeline.executeGateConfirmation` (the gate confirm). The RULE lives in
   * exactly one place, `approval-pin.ts`; see its doc comment for why that
   * distinction matters and how assuming a universal write path hid this.
   *
   * Written with the status rather than afterwards by the notifier that
   * publishes the commit status: a pin written there could lose the race
   * against the auto `approved → pending_merge` publish (non-deterministic
   * red on a legitimately approved PR), and `onCaseEvent` is never awaited,
   * so a dropped notification would leave the case permanently unpinned with
   * no recovery path.
   *
   * System-owned, exactly like `assistant_thread` and
   * `assistant_cancel_intent`: deliberately absent from `CreateCaseInput` and
   * `UpdateCaseInput` so no public case route can forge or move the pin.
   * Cleared (not left stale) when a case enters `approved` with no observed
   * head SHA, so the field never describes an older approval.
   *
   * PARTIALLY-CLOSED GAP (issue #1054): this pins the last commit Arbitra
   * OBSERVED at approval time, which is not necessarily the commit the
   * review ran against. #1054 gave `Run` a `reviewed_head_sha` and made
   * `review_run_completed` / `auto_approve_criteria_met` require it to match
   * `current_head_sha`, which closes this for the AUTONOMOUS
   * `in_review → approved` transition. It does NOT close it for a human's
   * approve click out of `needs_human_decision` — that transition never
   * re-checks `review_run_completed` — so a push landing after the case
   * reaches `needs_human_decision` and before a human approves is still
   * pinned and certified here; see `approval-pin.ts`'s `approvedCommitFor`
   * doc comment for the full accounting.
   *
   * Absent means "this approval is not pinned to any commit" — legacy cases
   * approved before #1045 shipped, or a case that reached
   * `approved`/`pending_merge`/`done` without ever being approved (e.g.
   * auto-close on merge). `applyApprovalCommitPin` treats absence as NOT
   * covered and publishes a failure: the honest answer is that Arbitra cannot
   * prove which commit the approval was for.
   */
  approved_head_sha?: string;
  jira_refs?: string[];
  active_rule_set_refs: string[];
  knowledge_context_refs: string[];
  decision_ready: boolean;
  /** Set when a confirm gate blocks an auto-transition. Cleared on confirmation or rejection. */
  pending_gate?: PendingGate;
  /**
   * Stable signature for cases proactively created by Arbitra Code Intelligence
   * (system actor `system:arbitra-intelligence`). Used by the intelligence
   * scheduler to dedup: a detector skips creating a new nudge when a
   * non-terminal case with the same signature already exists. Undefined on
   * human- and agent-created cases.
   */
  intelligence_signature?: string;
  /**
   * Intelligence findings attached to this case by the scheduler. Replaces
   * the legacy "autonomous nudge case per detection" pattern (Phase 1 of the
   * detector refactor). Each entry's `signature` is unique per
   * (detector, target) tuple; the service upserts in place. Absent on cases
   * that have never been flagged.
   */
  intelligence_flags?: IntelligenceFlag[];
  /**
   * Set to `true` by the orchestration pipeline when the auto-review cannot
   * run for this case — e.g. a manual-track packaging-only case on `main`
   * with no PR and no fetchable diff. When set, the
   * `review_run_completed` precondition is satisfied without requiring an
   * actual review_run, allowing approve/verification to proceed.
   *
   * Optional field; absent is treated as `false`. Written by the pipeline
   * (no data migration required for legacy cases). Never written by the UI.
   */
  review_not_applicable?: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Soft-delete marker. `null` on active cases, ISO timestamp when deleted.
   * Repository/service reads treat a non-null value as "not found".
   * Optional at the type level to keep existing fixtures/tests compiling;
   * new cases created via `CaseService.createCase` always set it to `null`.
   * Legacy docs missing the field are patched to `null` by
   * `scripts/backfill-case-soft-delete.ts`.
   */
  deleted_at?: string | null;
  /** Actor id that performed the soft delete. `null` on active cases. */
  deleted_by?: string | null;
}

export interface CreateCaseInput {
  title: string;
  description: string;
  source_type: SourceType;
  source_ref?: string;
  project_id: string;
  repository_id: string;
  /** Explicit override. When omitted, falls back to the project's default_validation_track, then 'direct'. */
  validation_track?: ValidationTrack;
  risk_level: RiskLevel;
  priority: Priority;
  case_type?: CaseType;
  assistant_context?: AssistantContext;
  current_branch?: string;
  current_pr_ref?: string;
  jira_refs?: string[];
  assigned_reviewer_id?: string;
  active_rule_set_refs?: string[];
  knowledge_context_refs?: string[];
  /** Inline file attachments (base64-encoded). Stored as Artifacts after case creation. */
  attachments?: import('./artifact.js').InlineAttachment[];
  /** Git context auto-detected by IDE/CLI. Used to populate branch, repo, and PR fields. */
  git_context?: import('./artifact.js').GitContext;
}

export interface UpdateCaseInput {
  title?: string;
  description?: string;
  project_id?: string;
  validation_track?: ValidationTrack;
  risk_level?: RiskLevel;
  priority?: Priority;
  case_type?: CaseType;
  assistant_context?: AssistantContext;
  current_branch?: string;
  current_pr_ref?: string;
  jira_refs?: string[];
  assigned_reviewer_id?: string;
  active_rule_set_refs?: string[];
  knowledge_context_refs?: string[];
}

export interface CaseFilters {
  status?: CaseStatus;
  project_id?: string;
  repository_id?: string;
  owner_user_id?: string;
  validation_track?: ValidationTrack;
  risk_level?: RiskLevel;
  priority?: Priority;
  current_branch?: string;
  cursor?: string;
  limit?: number;
}
