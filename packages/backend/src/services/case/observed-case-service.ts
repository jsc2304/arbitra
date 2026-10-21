import crypto from 'node:crypto';
import type { Case, CaseEvent } from '@arbitra/shared';
import { isDefaultBranch } from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';
import { WebhookService } from '../webhook/webhook-service.js';
import { FirestorePipelineAdapter } from '../orchestration/firestore-pipeline-adapter.js';
import { RunCompletionHandler } from '../orchestration/pipeline.js';
import { resolveCaseByBranch } from './branch-resolution.js';

/** System actor stamped on everything this service writes. */
const SYSTEM_ACTOR = 'system:observed-case';

const webhookService = new WebhookService();

/**
 * Deterministic claim doc id for one (repository, branch) pair — the
 * reservation `ensureObservedCaseForSignal` atomically claims before it may
 * create a Case for that pair. Hashing (rather than a raw composite key)
 * keeps the id well-formed and length-bounded regardless of what a branch
 * name contains, mirroring `sessionSignalEventDocId`.
 */
export function observedCaseClaimDocId(repositoryId: string, branch: string): string {
  return crypto.createHash('sha256').update(`${repositoryId}\0${branch}`).digest('hex');
}

export interface ObservedCaseSignalInput {
  /** Repository id (preferred) or a remote URL/name — same contract as `SessionSignalEvent.repository`. */
  repository: string;
  branch: string;
}

/**
 * True when `branch` is one of the signal-hook's own "I couldn't resolve a
 * real branch" fallback values (issue #1013): the exact strings
 * `resolveGitContext` in `packages/mcp/src/hooks/session-signal-hook.ts`
 * emits — `"unknown"` (git present but no branch resolvable at all) or
 * `"detached:<sha>"` (detached HEAD). A signal in either state is real
 * session activity — it still registers in the session view via
 * `ingestSessionSignalBatch` — but it names no unit of work a Case could
 * meaningfully attach to, so `ensureObservedCaseForSignal` must not create
 * one for it. An empty string is included defensively for the same reason
 * the existing `if (!input.branch) return null;` guard already handled it.
 */
export function isUnresolvableSignalBranch(branch: string): boolean {
  return !branch || branch === 'unknown' || branch.startsWith('detached:');
}

/**
 * Repair path for issue #996: the claim transaction that creates an Observed
 * Case commits its `status: 'open'` write, then `ensureObservedCaseForSignal`
 * drives the `open → in_build` auto-transition in a separate, unawaited-by-
 * the-caller step. If that transition call fails or the process dies in
 * between, the case is stuck at `open` forever — invisible to any human
 * queue (Observed Cases have none) — and a later PR merge on that branch
 * reads it as gated/unexplored and records `pr_merged_anomaly` instead of
 * closing it (`webhook-service.ts`).
 *
 * There is no independent sweep for this: repair is lazy, re-driven at the
 * next signal/webhook touch that resolves the case, using the exact same
 * `RunCompletionHandler.onRunCompleted` call the create path already fires.
 * A no-op — returns `case_` unchanged, no Firestore re-read — for anything
 * that isn't an Observed Case stuck at `open`; this never touches a case a
 * human is actively working through the enforced lifecycle.
 */
export async function repairStuckObservedCase(case_: Case): Promise<Case> {
  if (case_.case_type !== 'observed' || case_.status !== 'open') return case_;

  const pipeline = new RunCompletionHandler(new FirestorePipelineAdapter());
  await pipeline.onRunCompleted(case_.case_id).catch((err) => {
    console.error(`[observed-case] repair transition failed for ${case_.case_id}:`, err);
  });

  const refreshed = await collections.cases().doc(case_.case_id).get();
  return refreshed.exists ? (refreshed.data() as Case) : case_;
}

/**
 * Resolve the case bound to a signal's (repository, branch) pair, creating
 * an Observed Case if none exists yet (issue #986 / ADR-0001).
 *
 * Called AFTER Session Signal ingestion has already accepted the event —
 * this never affects the 202/idempotency contract of `ingestSessionSignalBatch`
 * (#983): a repository this cannot resolve, or a Firestore failure here, is
 * logged and swallowed rather than thrown, since the signal itself was
 * already durably recorded.
 *
 * Concurrency: the only way this function ever writes a NEW Case is by first
 * winning a transactional `tx.create` on a deterministic
 * (`observedCaseClaimDocId`) reservation doc. Two callers racing on the same
 * unknown (repository, branch) pair both attempt the claim; exactly one
 * `tx.create` succeeds (Firestore's atomic create-if-absent), the other's
 * transaction is retried by the SDK against the now-existing doc and returns
 * `null` from this function's inner transaction — never a second Case. This
 * is the same "atomic claim, never check-then-insert" discipline as
 * `ingestSessionSignalBatch`'s event-receipt claim.
 */
export async function ensureObservedCaseForSignal(
  input: ObservedCaseSignalInput,
): Promise<Case | null> {
  if (isUnresolvableSignalBranch(input.branch)) return null;

  const repo = await webhookService.resolveRepositoryForSignal(input.repository).catch((err) => {
    console.warn(`[observed-case] Repository lookup failed for '${input.repository}':`, err);
    return null;
  });
  if (!repo) {
    // Unresolvable repository: the signal itself was already processed and
    // the session registry already reflects it (issue #983's contract) —
    // there is simply no case to attach. Not an error.
    return null;
  }

  const { case: existing } = await resolveCaseByBranch({
    repositoryId: repo.repository_id,
    branch: input.branch,
  });
  if (existing) {
    if (existing.case_type === 'observed' && isDefaultBranch(repo, input.branch)) {
      // Issue #1009: an Observed Case already bound to the default branch —
      // almost certainly one of the pre-fix eternal cases (PRs merge INTO
      // this branch, never FROM it, so it can never auto-close). Never
      // attach another signal to it; let it stop growing rather than keep
      // every future default-branch session piling onto the same stuck
      // case. Cleanup of already-existing instances is a documented,
      // separate maintenance pass (scripts/cleanup-default-branch-observed-cases.ts)
      // rather than something a live signal-processing call should do.
      return null;
    }
    // Issue #996: re-drive the open → in_build transition if a prior
    // creation's post-commit step never landed. No-op for anything that
    // isn't stuck.
    return repairStuckObservedCase(existing);
  }

  if (isDefaultBranch(repo, input.branch)) {
    // Issue #1009: sessions on the default branch still register in Mission
    // Control via `ingestSessionSignalBatch` (already called before this
    // function runs) — they just never grow an eternal Observed Case.
    return null;
  }

  const claimRef = collections
    .observedCaseClaims()
    .doc(observedCaseClaimDocId(repo.repository_id, input.branch));
  const caseId = generateId('case');
  const eventId = generateId('event');
  const now = new Date().toISOString();

  const created = await getDb().runTransaction(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) return null;

    const newCase: Case = {
      case_id: caseId,
      title: `Observed: ${input.branch}`,
      description:
        `Auto-created by Arbitra from agent activity on ${repo.name} @ ${input.branch}. `
        + 'No case existed for this branch yet — this one records the work without blocking it.',
      source_type: 'git',
      source_ref: input.branch,
      project_id: repo.project_id,
      repository_id: repo.repository_id,
      owner_user_id: SYSTEM_ACTOR,
      status: 'open',
      validation_track: 'direct',
      risk_level: 'low',
      priority: 'normal',
      case_type: 'observed',
      current_branch: input.branch,
      active_rule_set_refs: [],
      knowledge_context_refs: [],
      jira_refs: [],
      decision_ready: false,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      deleted_by: null,
    };
    const caseCreatedEvent: CaseEvent = {
      event_id: eventId,
      case_id: caseId,
      type: 'case_created',
      actor_id: SYSTEM_ACTOR,
      payload: {
        title: newCase.title,
        project_id: repo.project_id,
        repository_id: repo.repository_id,
        case_type: 'observed',
        branch: input.branch,
      },
      created_at: now,
    };

    tx.create(claimRef, {
      repository_id: repo.repository_id,
      branch: input.branch,
      case_id: caseId,
      created_at: now,
    });
    tx.create(collections.cases().doc(caseId), newCase);
    tx.create(collections.caseEvents().doc(eventId), caseCreatedEvent);

    return newCase;
  });

  if (!created) {
    // Lost the race (or a stale claim survived a crashed prior attempt):
    // the winner's case is authoritative. Re-resolve rather than trust the
    // in-flight `caseId` this call generated but never wrote.
    const { case: resolved } = await resolveCaseByBranch({
      repositoryId: repo.repository_id,
      branch: input.branch,
    });
    if (!resolved) return null;
    // Issue #996: the winner's own post-commit transition is exactly the
    // one that can have died — route the loser's re-resolve through the
    // same repair check the `existing`-case fast path above uses, rather
    // than handing back a case still stuck at `open` and wasting this
    // touch's repair opportunity.
    return repairStuckObservedCase(resolved);
  }

  // Drive the case's own `open → in_build` auto-transition immediately —
  // mirrors every other pipeline trigger site (webhook, run completion):
  // fire-and-forget, logged, never lets a pipeline hiccup fail signal
  // processing.
  const pipeline = new RunCompletionHandler(new FirestorePipelineAdapter());
  await pipeline.onRunCompleted(created.case_id).catch((err) => {
    console.error(
      `[observed-case] onRunCompleted failed after creating ${created.case_id}:`,
      err,
    );
  });

  return created;
}
