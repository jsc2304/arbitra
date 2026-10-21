import { createHash } from 'node:crypto';
import {
  ArbitraError,
  assertAssistantRunPolicyInvariant,
  ForbiddenError,
  TERMINAL_CASE_STATUSES,
  ValidationError,
  type AssistantContext,
  type AssistantIntakeChannel,
  type AssistantIntakeReceipt,
  type AssistantIntakeRequest,
  type AssistantFollowUpRequest,
  type AssistantThreadLink,
  type Case,
  type CaseEvent,
  type CreateCaseInput,
  type Project,
  type Run,
  type SourceType,
} from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { isEffectiveMember } from '../../lib/project-access.js';
import { assertBranchAllowsCaseType } from '../case/case-service.js';
import { clerkCoreIds } from './clerk-core.js';
import {
  AssistantFollowUpService,
  assertPinnedFollowUpSources,
} from './assistant-follow-up-service.js';

/** Longest title we derive from the request text before eliding. */
const MAX_DERIVED_TITLE_CHARS = 120;

/** How long an idempotency receipt stays useful. 30 days. */
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Salt for the receipt document id. Same shape as `CLERK_CORE_ID_SALT`. */
const RECEIPT_ID_SALT = 'arbitra-assistant-intake';

/**
 * Per-user intake limits, read from the environment on every call so a
 * configuration change takes effect without a restart (and so tests can set
 * them per case).
 */
export interface AssistantIntakeLimits {
  maxActivePerUser: number;
  dailyLimit: number;
  maxInputChars: number;
}

export function resolveAssistantIntakeLimits(): AssistantIntakeLimits {
  return {
    maxActivePerUser: readPositiveInt('ARBITRA_ASSISTANT_MAX_ACTIVE_PER_USER', 10),
    dailyLimit: readPositiveInt('ARBITRA_ASSISTANT_DAILY_LIMIT', 30),
    maxInputChars: readPositiveInt('ARBITRA_ASSISTANT_MAX_INPUT_CHARS', 8000),
  };
}

function readPositiveInt(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  // A malformed or non-positive override would silently disable the limit, so
  // fall back to the documented default rather than trust it.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Policy/prompt versions stamped on the case at intake, from configuration. */
export function resolveAssistantVersions(): { policyVersion: string; promptVersion: string } {
  return {
    policyVersion: process.env['ARBITRA_ASSISTANT_POLICY_VERSION'] ?? 'assistant_policy:v1',
    promptVersion: process.env['ARBITRA_ASSISTANT_PROMPT_VERSION'] ?? 'assistant_task:v1',
  };
}

export interface AssistantIntakeResult {
  /** The case this request resolved to — newly created, or the replayed one. */
  case: Case;
  /**
   * The unclaimed run the caller should dispatch. `null` on a replay: the
   * original request already created and dispatched one, and the assistant
   * sub-sweep recovers it if that dispatch died before claiming.
   */
  run: Run | null;
  /** Run id in both cases (a replay reads it off the receipt). */
  run_id: string;
  event_id: string;
  /** True when an idempotency receipt already existed for this key. */
  replayed: boolean;
}

/**
 * Raised when the requester has no provisioned Clerk core. Not a 404 —
 * the ids are derived from the caller's own user id, so there is nothing to
 * hide, and the actionable answer is "run the provisioning script".
 */
export class ClerkCoreNotProvisionedError extends ArbitraError {
  constructor(userId: string, missing: string[]) {
    super(
      `Clerk is not provisioned for user '${userId}' (missing: ${missing.join(', ')}). `
        + `Run: npx tsx scripts/setup-clerk-core.ts --user-id ${userId} --apply`,
      'CLERK_CORE_NOT_PROVISIONED',
      409,
      { user_id: userId, missing },
    );
    this.name = 'ClerkCoreNotProvisionedError';
  }
}

/** Raised when a per-user intake limit is already met. */
export class AssistantIntakeLimitError extends ArbitraError {
  constructor(
    public readonly limitName: 'active_per_user' | 'daily' | 'input_chars',
    message: string,
    details: Record<string, unknown>,
  ) {
    super(message, 'ASSISTANT_INTAKE_LIMIT', 429, { limit: limitName, ...details });
    this.name = 'AssistantIntakeLimitError';
  }
}

/**
 * Deterministic receipt document id for one (channel, requester, key) triple.
 *
 * Scoped by channel and requester so two callers cannot collide on a key
 * neither of them controls, and so the same string means different things on
 * different channels. The Chat entry point passes the Chat message name as the
 * key and needs nothing else from this function — which is the whole point:
 * that channel gets idempotency by supplying a key, not by adding a second
 * intake path.
 */
export function assistantIntakeReceiptId(
  channel: AssistantIntakeChannel,
  requesterUserId: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${RECEIPT_ID_SALT}\0${channel}\0${requesterUserId}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  return `air_${digest}`;
}

/** Namespace a browser key to its parent without retaining either raw value. */
export function assistantFollowUpReceiptKey(parentCaseId: string, idempotencyKey: string): string {
  return `afu_${createHash('sha256')
    .update(`arbitra-assistant-follow-up\0${parentCaseId}\0${idempotencyKey}`)
    .digest('hex')}`;
}

/**
 * Creates an `assistant_task` case together with everything that has to exist
 * for it to be processable: the `assistant_task_received` event that makes it
 * auditable, and the unclaimed `assistant_task_run` that makes it executable.
 *
 * ## Why this does not call `CaseService.createCase`
 *
 * `createCase` writes the case document and its `case_created` event as two
 * independent, unordered writes. A crash between them leaves a case with no
 * history — and for an assistant task, also no run, so nothing would ever pick
 * it up and nothing would explain why. This service writes all three documents
 * in one Firestore transaction instead, and reuses `createCase`'s building
 * blocks (`generateId`, `assertBranchAllowsCaseType`, and its field defaults)
 * rather than its write sequence. `assistant-intake-service.test.ts` asserts the
 * field defaults still agree with `createCase`'s, so the duplication cannot
 * drift unnoticed.
 *
 * ## Ordering: receipt before limits, receipt again inside the transaction
 *
 * Firestore forbids reads after writes inside a transaction, and it has no
 * transactional aggregation query at all — so the per-user limits, which need
 * `count()` queries, are evaluated before the transaction opens. A computed
 * receipt point-read happens before those queries, so a legitimate replay is
 * never rejected for a quota the original request already consumed. The
 * receipt is still re-checked INSIDE the transaction: the pre-read is only a
 * fast path, and concurrent callers that both miss it still resolve to one
 * case transactionally.
 *
 * The consequence is deliberate and accepted: simultaneous requests from one
 * user can exceed a limit by a small number of cases, because each request's
 * count predates the others' writes. A limit is an abuse bound and tolerates
 * that slack; idempotency is a correctness property — "one key, one case" must
 * hold under any interleaving — so it gets the transactional guarantee.
 */
export class AssistantIntakeService {
  private readonly followUps = new AssistantFollowUpService();

  async intake(request: AssistantIntakeRequest, actorId: string): Promise<AssistantIntakeResult> {
    const limits = resolveAssistantIntakeLimits();
    const channel: AssistantIntakeChannel = request.channel ?? 'web';
    const text = (request.text ?? '').trim();

    if (text.length === 0) {
      throw new ValidationError('Assistant task text must not be empty.', { field: 'text' });
    }
    if (text.length > limits.maxInputChars) {
      throw new AssistantIntakeLimitError(
        'input_chars',
        `Assistant task text is ${text.length} characters; the limit is ${limits.maxInputChars}.`,
        { length: text.length, max: limits.maxInputChars },
      );
    }

    const ids = clerkCoreIds(actorId);

    await this.assertClerkCore(actorId, ids);

    const replay = await this.findReplay(channel, actorId, request.idempotency_key);
    if (replay) return replay;

    // Aggregation queries — impossible inside a transaction, hence here. They
    // intentionally follow the receipt fast path: a replay must not be
    // rejected because its original case has since filled a quota.
    await this.assertWithinPerUserLimits(actorId, limits);

    const input = this.buildCreateCaseInput(request, channel, text, actorId, ids);
    // The one piece of `createCase` validation that can reject an
    // `assistant_task`: a no-op today (the type produces no code), kept so a
    // later reclassification of the type cannot bypass the branch guard.
    assertBranchAllowsCaseType(input);

    return this.commit(request, channel, input, actorId, ids.projectId);
  }

  /**
   * Append a new Case to a completed Clerk conversation. This deliberately
   * enters through the same quota and transaction path as first-turn intake.
   *
   * ## Receipt namespace: scoped-by-parent only for `web`
   *
   * The browser's follow-up key is a client-generated nonce guaranteed
   * unique only WITHIN one parent thread, so `assistantFollowUpReceiptKey`
   * namespaces it to `parentCaseId` before it becomes a receipt key. A
   * Chat-originated follow-up's key (`message.sourceMessageName`, passed
   * with `channel: 'google_chat'`) is already globally unique — Google's own
   * Chat message resource name — and scoping it to `parentCaseId` on top
   * would be actively wrong: `runChatIntake` in the Chat route re-reads the
   * thread's MUTABLE pointer on every delivery to decide root-vs-follow-up,
   * so a REDELIVERY of the exact same Chat message can be offered a
   * DIFFERENT `parentCaseId` than the one its first delivery used (e.g. the
   * thread's case reached `done` in between, or a later message already
   * advanced the tip). Scoping by `parentCaseId` in that world means the
   * same message computes a DIFFERENT receipt id on each delivery, so the
   * idempotency guarantee silently stops holding — a second Case (and a
   * second ack) gets created for one Chat message. Keying non-`web`
   * channels on the raw, unscoped key instead makes the receipt land in the
   * exact same place `intake()` would use for that channel/key, regardless
   * of which of the two methods — or which delivery — is doing the
   * writing/checking. See `assistant-intake-service.test.ts`'s "redelivery
   * after the thread's case reaches a terminal status" coverage.
   */
  async intakeFollowUp(
    request: AssistantFollowUpRequest,
    actorId: string,
    parentCaseId: string,
  ): Promise<AssistantIntakeResult> {
    const limits = resolveAssistantIntakeLimits();
    const text = (request.text ?? '').trim();
    if (text.length === 0) {
      throw new ValidationError('Assistant follow-up text must not be empty.', { field: 'text' });
    }
    if (text.length > limits.maxInputChars) {
      throw new AssistantIntakeLimitError(
        'input_chars',
        `Assistant follow-up text is ${text.length} characters; the limit is ${limits.maxInputChars}.`,
        { length: text.length, max: limits.maxInputChars },
      );
    }

    const channel: AssistantIntakeChannel = request.channel ?? 'web';
    const effectiveIdempotencyKey = channel === 'web'
      ? assistantFollowUpReceiptKey(parentCaseId, request.idempotency_key)
      : request.idempotency_key;
    const effectiveRequest: AssistantIntakeRequest = {
      text,
      channel,
      idempotency_key: effectiveIdempotencyKey,
      // Carries THIS message's own reply target (never the parent's) into
      // `buildCreateCaseInput`, which already knows how to fold a `chat`
      // block into `assistant_context` for `intake()` — reused as-is here so
      // a follow-up case gets the same `space_name`/`thread_name`/etc. and
      // `EventNotifier.notifyChatThreadOutcome` can post its completion.
      ...(request.chat ? { chat: request.chat } : {}),
    };
    // Replay before parent/core checks: once accepted, the key keeps resolving
    // to its child even if the parent is later unavailable.
    const replay = await this.findReplay(channel, actorId, effectiveRequest.idempotency_key);
    if (replay) return replay;

    const ids = clerkCoreIds(actorId);
    await this.assertClerkCore(actorId, ids);
    const link = await this.followUps.resolveParentLink(parentCaseId, actorId);
    await this.assertWithinPerUserLimits(actorId, limits);
    const input = this.buildCreateCaseInput(effectiveRequest, channel, text, actorId, ids);
    assertBranchAllowsCaseType(input);
    return this.commit(effectiveRequest, channel, input, actorId, ids.projectId, link);
  }

  private async assertClerkCore(
    actorId: string,
    ids: { projectId: string; repositoryId: string },
  ): Promise<void> {
    // Authorization and provisioning first: no membership means no case, and
    // it is decided before a single limit query — let alone a write — runs.
    const [projectSnap, repositorySnap] = await Promise.all([
      collections.projects().doc(ids.projectId).get(),
      collections.repositories().doc(ids.repositoryId).get(),
    ]);
    const missing: string[] = [];
    if (!projectSnap.exists) missing.push(ids.projectId);
    if (!repositorySnap.exists) missing.push(ids.repositoryId);
    if (missing.length > 0) throw new ClerkCoreNotProvisionedError(actorId, missing);
    const repositoryProjectId = repositorySnap.data()!.project_id;
    if (repositoryProjectId !== ids.projectId) {
      throw new ArbitraError(
        `Clerk placeholder repository '${ids.repositoryId}' belongs to project '${repositoryProjectId}', not '${ids.projectId}'.`,
        'CLERK_CORE_MISCONFIGURED',
        409,
        { repository_id: ids.repositoryId, expected_project_id: ids.projectId },
      );
    }
    assertMembership(projectSnap.data()!, actorId, ids.projectId);
  }

  /**
   * Field defaults are copied from `CaseService.createCase`, minus the two
   * resolution steps that cannot apply here: `validation_track` is set
   * explicitly (so the project-default lookup is moot) and `repository_id` is
   * already an internal `repo_` id (so the slug-resolution query is moot).
   */
  private buildCreateCaseInput(
    request: AssistantIntakeRequest,
    channel: AssistantIntakeChannel,
    text: string,
    actorId: string,
    ids: { projectId: string; repositoryId: string },
  ): CreateCaseInput {
    const { policyVersion, promptVersion } = resolveAssistantVersions();
    const riskLevel = 'low';

    const assistantContext: AssistantContext = {
      channel,
      conversation_visibility: request.chat?.conversation_visibility ?? 'direct',
      requester_user_id: actorId,
      risk_level: riskLevel,
      policy_version: policyVersion,
      prompt_version: promptVersion,
    };
    // Only set what the channel actually supplied. `task_kind` stays absent on
    // purpose — classification is the executor's job.
    if (request.chat?.space_name) assistantContext.space_name = request.chat.space_name;
    if (request.chat?.thread_name) assistantContext.thread_name = request.chat.thread_name;
    if (request.chat?.source_message_name) {
      assistantContext.source_message_name = request.chat.source_message_name;
    }
    if (request.chat?.chat_user_name) assistantContext.chat_user_name = request.chat.chat_user_name;
    // Blueprint provenance (`docs/specs/clerk-config-scheduling-chat.md` Slice
    // B): `blueprint_id` flat for the overlap-'skip' query, `blueprint_context`
    // as the immutable snapshot this occurrence's Case keeps regardless of
    // later edits to the (mutate-in-place) TaskBlueprint row.
    if (request.blueprint) {
      assistantContext.blueprint_id = request.blueprint.blueprint_id;
      assistantContext.blueprint_context = {
        blueprint_id: request.blueprint.blueprint_id,
        blueprint_version: request.blueprint.blueprint_version,
        prompt_text: request.blueprint.prompt_text,
      };
    }

    return {
      title: deriveTitle(text),
      description: text,
      source_type: sourceTypeForChannel(channel),
      source_ref: request.idempotency_key ?? '',
      project_id: ids.projectId,
      repository_id: ids.repositoryId,
      validation_track: 'direct',
      risk_level: riskLevel,
      priority: 'normal',
      case_type: 'assistant_task',
      assistant_context: assistantContext,
    };
  }

  /**
   * All three writes in one transaction, with the receipt check as the first
   * read so a replay returns before anything is staged.
   */
  private async commit(
    request: AssistantIntakeRequest,
    channel: AssistantIntakeChannel,
    input: CreateCaseInput,
    actorId: string,
    projectId: string,
    threadLink?: AssistantThreadLink,
  ): Promise<AssistantIntakeResult> {
    const idempotencyKey = request.idempotency_key;
    const receiptRef = idempotencyKey
      ? collections
          .assistantIntakeReceipts()
          .doc(assistantIntakeReceiptId(channel, actorId, idempotencyKey))
      : null;

    const caseId = generateId('case');
    const eventId = generateId('event');
    const runId = generateId('run');

    return getDb().runTransaction(async (tx) => {
      // ---- reads (Firestore forbids any read after the first write) ----
      if (receiptRef) {
        const receiptSnap = await tx.get(receiptRef);
        if (receiptSnap.exists) {
          return this.replay(tx, receiptSnap.data()!);
        }
      }

      // Re-read the project inside the transaction so a membership revoked
      // between the pre-flight check and the commit cannot be raced past.
      const projectSnap = await tx.get(collections.projects().doc(projectId));
      if (!projectSnap.exists) {
        throw new ClerkCoreNotProvisionedError(actorId, [projectId]);
      }
      assertMembership(projectSnap.data()!, actorId, projectId);

      if (threadLink) {
        const [parentSnap, runSnap, evidenceSnap, artifactSnap] = await Promise.all([
          tx.get(collections.cases().doc(threadLink.parent_case_id)),
          tx.get(collections.runs().doc(threadLink.prior_run_id)),
          tx.get(collections.evidence().doc(threadLink.prior_result_evidence_id)),
          tx.get(collections.artifacts().doc(threadLink.prior_result_artifact_id)),
        ]);
        assertPinnedFollowUpSources(
          threadLink,
          actorId,
          input.project_id,
          input.repository_id,
          {
            parent: parentSnap.data(),
            run: runSnap.data(),
            evidence: evidenceSnap.data(),
            artifact: artifactSnap.data(),
          },
        );
      }

      // ---- writes ----
      const now = new Date().toISOString();
      const newCase = buildCaseDocument(input, actorId, caseId, now, threadLink);
      const event: CaseEvent = {
        event_id: eventId,
        case_id: caseId,
        type: 'assistant_task_received',
        actor_id: actorId,
        payload: {
          channel,
          requester_user_id: actorId,
          project_id: input.project_id,
          repository_id: input.repository_id,
          run_id: runId,
          input_chars: input.description.length,
          policy_version: input.assistant_context?.policy_version,
          prompt_version: input.assistant_context?.prompt_version,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          ...(threadLink ? { assistant_thread: threadLink } : {}),
        },
        created_at: now,
      };
      // Unclaimed by construction: no `lease_expires_at`, no `worker_id`, no
      // `started_at`. `awaiting_claim` records that the missing lease is
      // intended, which keeps the run out of the stale-run sweep's legacy
      // no-lease cohort — see `FirestorePipelineAdapter.createUnclaimedRun`,
      // whose shape this mirrors (it cannot be reused directly: it performs its
      // own non-transactional write).
      const run: Run = {
        run_id: runId,
        case_id: caseId,
        run_type: 'assistant_task_run',
        trigger_source: `assistant-intake:${channel}`,
        status: 'pending',
        input_refs: [],
        output_refs: [],
        created_at: now,
        updated_at: now,
        awaiting_claim: true,
        attempt: 1,
        assistant_policy_state: 'unbound',
      };
      assertAssistantRunPolicyInvariant(run);

      tx.create(collections.cases().doc(caseId), newCase);
      tx.create(collections.caseEvents().doc(eventId), event);
      tx.create(collections.runs().doc(runId), run);
      if (receiptRef && idempotencyKey) {
        const receipt: AssistantIntakeReceipt = {
          receipt_id: receiptRef.id,
          channel,
          requester_user_id: actorId,
          idempotency_key: idempotencyKey,
          case_id: caseId,
          run_id: runId,
          event_id: eventId,
          created_at: now,
          expires_at: new Date(Date.parse(now) + RECEIPT_RETENTION_MS).toISOString(),
        };
        tx.create(receiptRef, receipt);
      }

      return { case: newCase, run, run_id: runId, event_id: eventId, replayed: false };
    });
  }

  /**
   * Fast-path a committed idempotency receipt before quota aggregation.
   *
   * This does not replace the transaction's receipt read in `commit`: two
   * concurrent callers can both observe no receipt here, then only one creates
   * it inside the transaction and the other replays it there.
   */
  private async findReplay(
    channel: AssistantIntakeChannel,
    actorId: string,
    idempotencyKey: string | undefined,
  ): Promise<AssistantIntakeResult | null> {
    if (!idempotencyKey) return null;

    const receiptSnap = await collections
      .assistantIntakeReceipts()
      .doc(assistantIntakeReceiptId(channel, actorId, idempotencyKey))
      .get();
    if (!receiptSnap.exists) return null;

    const receipt = receiptSnap.data()!;
    const caseSnap = await collections.cases().doc(receipt.case_id).get();
    if (!caseSnap.exists) {
      throw new ArbitraError(
        `Assistant intake receipt ${receipt.receipt_id} references case ${receipt.case_id}, which does not exist.`,
        'ASSISTANT_INTAKE_RECEIPT_DANGLING',
        500,
        { receipt_id: receipt.receipt_id, case_id: receipt.case_id },
      );
    }
    return {
      case: caseSnap.data()!,
      run: null,
      run_id: receipt.run_id,
      event_id: receipt.event_id,
      replayed: true,
    };
  }

  /**
   * Return the case the receipt already points at. A missing case document
   * would mean the receipt outlived its case — a data-integrity problem we
   * surface instead of papering over by creating a second case, which is the
   * exact outcome the receipt exists to prevent.
   */
  private async replay(
    tx: FirebaseFirestore.Transaction,
    receipt: AssistantIntakeReceipt,
  ): Promise<AssistantIntakeResult> {
    const caseSnap = await tx.get(collections.cases().doc(receipt.case_id));
    if (!caseSnap.exists) {
      throw new ArbitraError(
        `Assistant intake receipt ${receipt.receipt_id} references case ${receipt.case_id}, which does not exist.`,
        'ASSISTANT_INTAKE_RECEIPT_DANGLING',
        500,
        { receipt_id: receipt.receipt_id, case_id: receipt.case_id },
      );
    }
    return {
      case: caseSnap.data()!,
      run: null,
      run_id: receipt.run_id,
      event_id: receipt.event_id,
      replayed: true,
    };
  }

  /**
   * Both per-user limits, as server-side `count()` aggregations.
   *
   * The active count excludes soft-deleted cases (a deleted case is not
   * active). The daily count deliberately includes them: it is an abuse bound,
   * and counting only live cases would let a caller reset their daily quota by
   * deleting what they just created.
   */
  private async assertWithinPerUserLimits(
    actorId: string,
    limits: AssistantIntakeLimits,
  ): Promise<void> {
    const [activeCount, todayCount] = await Promise.all([
      this.countActiveTasks(actorId),
      this.countTasksCreatedToday(actorId),
    ]);

    if (activeCount >= limits.maxActivePerUser) {
      // "Let one finish" is only actionable if the caller can see WHICH tasks
      // are holding the slots — a stuck task looks identical to a busy one from
      // the outside. Read only on the rejection path: the happy path keeps the
      // cheap `count()` aggregation.
      const blockingCaseIds = await this.listActiveTaskCaseIds(actorId, limits.maxActivePerUser);
      throw new AssistantIntakeLimitError(
        'active_per_user',
        `You already have ${activeCount} active assistant tasks; the limit is ${limits.maxActivePerUser}. `
          + 'Let one finish before starting another.',
        { active: activeCount, max: limits.maxActivePerUser, case_ids: blockingCaseIds },
      );
    }
    if (todayCount >= limits.dailyLimit) {
      throw new AssistantIntakeLimitError(
        'daily',
        `You have started ${todayCount} assistant tasks today; the daily limit is ${limits.dailyLimit}.`,
        { today: todayCount, max: limits.dailyLimit },
      );
    }
  }

  private async countActiveTasks(actorId: string): Promise<number> {
    const snap = await collections
      .activeCases()
      .where('owner_user_id', '==', actorId)
      .where('case_type', '==', 'assistant_task')
      .where('status', 'not-in', [...TERMINAL_CASE_STATUSES])
      .count()
      .get();
    return snap.data().count;
  }

  /**
   * The case ids currently occupying the caller's active-task slots, capped at
   * the limit itself — the point is to name the blockers, not to page through
   * them. Same predicate as `countActiveTasks`, so the ids always explain the
   * count that triggered the rejection.
   */
  private async listActiveTaskCaseIds(actorId: string, limit: number): Promise<string[]> {
    const snap = await collections
      .activeCases()
      .where('owner_user_id', '==', actorId)
      .where('case_type', '==', 'assistant_task')
      .where('status', 'not-in', [...TERMINAL_CASE_STATUSES])
      .limit(limit)
      .get();
    return snap.docs.map((doc) => doc.data().case_id);
  }

  private async countTasksCreatedToday(actorId: string): Promise<number> {
    const snap = await collections
      .cases()
      .where('owner_user_id', '==', actorId)
      .where('case_type', '==', 'assistant_task')
      .where('created_at', '>=', startOfUtcDay(new Date()))
      .count()
      .get();
    return snap.data().count;
  }
}

/**
 * The `Case` document `CaseService.createCase` would have written for this
 * input, with `validation_track` and `repository_id` already resolved by the
 * caller. Kept as a free function so the parity test can compare it against
 * `createCase`'s own output field by field.
 */
export function buildCaseDocument(
  input: CreateCaseInput,
  actorId: string,
  caseId: string,
  now: string,
  assistantThread?: AssistantThreadLink,
): Case {
  return {
    case_id: caseId,
    title: input.title,
    description: input.description,
    source_type: input.source_type,
    source_ref: input.source_ref ?? '',
    project_id: input.project_id,
    repository_id: input.repository_id,
    owner_user_id: actorId,
    assigned_reviewer_id: input.assigned_reviewer_id,
    status: 'open',
    validation_track: input.validation_track ?? 'direct',
    risk_level: input.risk_level,
    priority: input.priority,
    case_type: input.case_type,
    assistant_context: input.assistant_context,
    assistant_thread: assistantThread,
    current_branch: input.current_branch,
    current_pr_ref: input.current_pr_ref,
    // #1079: kept in parity with `CaseService.createCase` — see that
    // function's comment.
    current_head_sha: input.git_context?.commit_sha,
    active_rule_set_refs: input.active_rule_set_refs ?? [],
    knowledge_context_refs: input.knowledge_context_refs ?? [],
    jira_refs: input.jira_refs ?? [],
    decision_ready: false,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    deleted_by: null,
  };
}

function assertMembership(project: Project, actorId: string, projectId: string): void {
  if (isEffectiveMember(project, actorId)) return;
  throw new ForbiddenError(
    `User '${actorId}' is not a member of Clerk project '${projectId}'.`,
    { project_id: projectId, user_id: actorId },
  );
}

function sourceTypeForChannel(channel: AssistantIntakeChannel): SourceType {
  return channel === 'google_chat' ? 'google_chat' : 'manual';
}

/** ISO timestamp of 00:00 UTC on `reference`'s day — the daily window start. */
export function startOfUtcDay(reference: Date): string {
  return `${reference.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** First non-empty line of the request, whitespace-collapsed and elided. */
export function deriveTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? text.trim();
  const collapsed = firstLine.replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_DERIVED_TITLE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_DERIVED_TITLE_CHARS - 1).trimEnd()}…`;
}
