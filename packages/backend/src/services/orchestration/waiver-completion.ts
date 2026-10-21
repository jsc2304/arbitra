import { createHash } from 'node:crypto';
import type { CaseEvent, Decision, DecisionSnapshot, Finding } from '@arbitra/shared';
import { collections, getDb } from '../../lib/firestore.js';
import { EventService } from '../event/event-service.js';
import { buildDecisionSnapshot, CompletenessEvaluator } from '../evidence/completeness-evaluator.js';
import { RuleRepository } from '../rule/rule-repository.js';

const SYSTEM_ACTOR = 'system:pipeline';

/** Salt for the closer's decision id derivation. Same shape as `RECEIPT_ID_SALT` in assistant-intake-service.ts. */
const DECISION_ID_SALT = 'arbitra-waiver-completion-decision';

/**
 * Deterministic `waived_on_completion` decision id for a finding (issue #754).
 *
 * The closer's contract is "close each outstanding waiver proposal with
 * exactly one decision", so the id only needs to be a function of the
 * finding it closes — there is only ever one decision *type* this closer
 * writes. Deriving it (instead of `generateId('decision')`'s random nanoid)
 * means two racing invocations of the closer for the same finding — e.g. an
 * explicit `/transition` call landing on `done` at the same moment as an
 * auto-transition, both querying the same outstanding `waiver_proposed`
 * finding before either has written — compute the SAME id and can be made to
 * race on a create-only write instead of each minting its own decision.
 */
export function waiverCompletionDecisionId(findingId: string): string {
  const digest = createHash('sha256')
    .update(`${DECISION_ID_SALT}\0${findingId}\0waived_on_completion`)
    .digest('hex')
    .slice(0, 32);
  return `dec_${digest}`;
}

/**
 * Why the closer is running. Only affects the recorded rationale — the writes
 * are identical, so a backfilled row is still a first-class audit entry.
 */
export type WaiverCompletionContext = 'completion' | 'backfill';

export interface WaiverCompletionResult {
  /** Findings successfully closed (per-finding failures are excluded). */
  closed: number;
  /**
   * Findings that were already closed by a concurrent/prior run of the
   * closer (issue #754) — the deterministic decision id already existed, so
   * this run wrote nothing for them. Not an error; kept separate from
   * `closed` because nothing was actually done here.
   */
  skipped: number;
}

function rationaleFor(context: WaiverCompletionContext): string {
  const base =
    'The case completed while this waiver proposal was still awaiting human confirmation. ' +
    'The proposal is therefore closed administratively — no human confirmed it — so the audit trail ' +
    'does not carry a pending decision that no surface can act on anymore.';
  return context === 'backfill'
    ? `${base} Closed retroactively by the cleanup script for a case that had already completed.`
    : base;
}

/**
 * Best-effort exact snapshot for the closing decisions. Built once per call
 * because every decision in one run shares the same case state. Falls back to a
 * minimal snapshot WITHOUT `snapshot_fidelity` when the case doc or the policy /
 * rule-set reads are unavailable: the UI renders a missing fidelity marker as
 * "snapshot unavailable (legacy)", which is the honest signal — inventing an
 * `exact` snapshot from defaults would misrepresent the record.
 */
async function buildSnapshotForCase(caseId: string): Promise<DecisionSnapshot> {
  const fallback: DecisionSnapshot = {
    active_rule_set_versions: {},
    evidence_policy_version: 0,
    knowledge_asset_refs: [],
  };
  try {
    const caseSnap = await collections.cases().doc(caseId).get();
    const case_ = caseSnap.data();
    if (!case_) return fallback;
    return await buildDecisionSnapshot(case_, new CompletenessEvaluator(), new RuleRepository());
  } catch (err) {
    console.error(
      `[WaiverCompletion] Snapshot build failed for case ${caseId}; recording a legacy-fidelity snapshot:`,
      err,
    );
    return fallback;
  }
}

/**
 * Administratively close every outstanding `waiver_proposed` finding on a case
 * that has reached `done` (issue #751).
 *
 * Background: auto-approve only gates on high/critical findings, and none of the
 * transitions into `done` re-check finding status — so a case could complete with
 * an agent's waiver proposal still pending. After completion no surface offers
 * the confirm/reject action anymore, leaving a human decision in the trail that
 * nobody can ever make. This closes each proposal with a distinct
 * `waived_on_completion` decision (actor `system:pipeline`) and moves the finding
 * to the terminal, non-blocking `waived_on_completion` status, so the trail plainly
 * states the system closed it at completion rather than a reviewer confirming it.
 *
 * The agent's original proposal rationale (`Finding.resolution`) is deliberately
 * left untouched.
 *
 * Contract: NEVER throws and never rejects — callers wire it into the transition
 * path, where a failure must not roll back a completed case. Per-finding work is
 * isolated so one bad document cannot abort the rest; failures are logged and
 * excluded from the returned count.
 *
 * Idempotency (issue #754): `OrchestrationService.transition` does not hold
 * the case-pipeline-lock, so an explicit `/transition` call can race an
 * auto-transition into `done` and run this closer twice concurrently for the
 * same case. Both runs query the outstanding `waiver_proposed` findings
 * before either has written, so a query-then-write of a randomly-generated
 * decision id would mint two `waived_on_completion` decisions for one
 * finding. Per finding, the decision id is instead derived deterministically
 * (`waiverCompletionDecisionId`) and written with a transactional
 * read-then-create-only: the losing run observes the decision already
 * committed (either directly, or via Firestore's automatic transaction retry
 * after a write conflict on the same document) and no-ops instead of
 * duplicating — the same shape as the assistant intake service's idempotency
 * receipt replay.
 */
export async function closeOutstandingWaiverProposalsOnCompletion(
  caseId: string,
  context: WaiverCompletionContext,
): Promise<WaiverCompletionResult> {
  let pending: Finding[];
  try {
    const snap = await collections
      .findings()
      .where('case_id', '==', caseId)
      .where('status', '==', 'waiver_proposed')
      .get();
    pending = snap.docs.map((d) => d.data());
  } catch (err) {
    console.error(
      `[WaiverCompletion] Failed to query outstanding waiver proposals for case ${caseId}:`,
      err,
    );
    return { closed: 0, skipped: 0 };
  }

  if (pending.length === 0) return { closed: 0, skipped: 0 };

  const snapshot = await buildSnapshotForCase(caseId);
  const rationale = rationaleFor(context);
  const eventService = new EventService();
  let closed = 0;
  let skipped = 0;

  for (const finding of pending) {
    try {
      const now = new Date().toISOString();
      const decisionId = waiverCompletionDecisionId(finding.finding_id);
      const decision: Decision = {
        decision_id: decisionId,
        case_id: caseId,
        finding_id: finding.finding_id,
        type: 'waived_on_completion',
        actor_id: SYSTEM_ACTOR,
        rationale,
        snapshot,
        created_at: now,
      };

      // Decision-create + finding-update + decision_created event MUST land
      // together: a persisted `waived_on_completion` Decision whose finding
      // never actually left `waiver_proposed` (or vice versa) would let a
      // retry (the cleanup script re-run, or a racing concurrent closer run)
      // create a SECOND decision for the same finding, breaking its
      // idempotency contract. One Firestore transaction per finding gives an
      // all-or-nothing write (see OrchestrationService.transition for the
      // same core-vs-best-effort split), and the leading `txn.get` +
      // `txn.create` make it create-only: a run that finds the decision
      // already there skips both writes.
      //
      // The `decision_created` event is staged in the SAME transaction via
      // `emitInTransaction` (issue #913) rather than emitted afterwards: a
      // crash between the transaction committing and a standalone event
      // write would otherwise durably close the finding while silently
      // dropping the timeline entry/notification for it, with no retry or
      // reconciliation. Staging it here means the event is as durable as the
      // decision the instant the transaction commits — see
      // `EventService.emitInTransaction`'s doc comment and
      // `OrchestrationService.transition`, which already uses this pattern
      // for the same crash window on ordinary transitions.
      const decisionRef = collections.decisions().doc(decisionId);
      const findingRef = collections.findings().doc(finding.finding_id);
      const committedEvent: CaseEvent | undefined = await getDb().runTransaction(async (txn) => {
        const existing = await txn.get(decisionRef);
        if (existing.exists) return undefined;
        txn.create(decisionRef, decision);
        txn.update(findingRef, {
          status: 'waived_on_completion',
          updated_at: now,
        });
        return eventService.emitInTransaction(
          txn,
          caseId,
          'decision_created',
          {
            decision_id: decision.decision_id,
            type: decision.type,
            finding_id: finding.finding_id,
          },
          SYSTEM_ACTOR,
        );
      });

      if (!committedEvent) {
        // Already closed by a concurrent or prior run (issue #754) — not an
        // error, so no console.error and no duplicate `decision_created`
        // event: the event for this finding already fired on whichever run
        // actually created the decision.
        console.log(
          `[WaiverCompletion] Finding ${finding.finding_id} on case ${caseId} already closed by a concurrent/prior run (decision ${decisionId}); skipping.`,
        );
        skipped += 1;
        continue;
      }

      // Notify AFTER the transaction commits — `emitInTransaction` cannot
      // notify inline because the transaction can still abort after it
      // stages the write. Non-fatal by contract (`notifyCommitted` never
      // throws): the finding is already closed at this point, so a
      // notification failure must not un-count it. See
      // `EventService.notifyCommitted`.
      eventService.notifyCommitted([committedEvent]);

      closed += 1;
    } catch (err) {
      console.error(
        `[WaiverCompletion] Failed to close waiver proposal ${finding.finding_id} on case ${caseId}:`,
        err,
      );
    }
  }

  return { closed, skipped };
}
