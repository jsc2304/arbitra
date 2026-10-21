/**
 * EventNotifier — Translates case events into user notifications.
 *
 * Called inline after events are emitted to create real notifications.
 * Originally wired for the 5 mandatory triggers — case_needs_decision,
 * manual_validation_pending, rule_violation, evidence_missing,
 * case_approved/case_rejected — and extended (spec
 * `docs/specs/clerk-config-scheduling-chat.md`, slice C item 1) to cover the
 * rest of the event catalog: case_completed, critical_finding, run_failed,
 * run_retries_exhausted, and the Clerk outcomes assistant_task_completed /
 * assistant_task_failed. Slice D of the same spec adds a SECOND channel for
 * the Clerk outcomes only: a requester-scoped Google Chat ping, independent
 * of (and never routed through) the project-wide `NotificationDispatcher`
 * used everywhere else in this class — see `notifyRequesterChat`'s doc
 * comment. Slice F adds a THIRD, distinct Chat action for the Clerk outcomes:
 * `notifyChatThreadOutcome` posts the case's own terminal outcome back into
 * the Google Chat thread the task originated from (when it came from Chat at
 * all) — separate from the requester's personal webhook ping, and separate
 * from `chat-reply.ts`'s ack/decline/busy replies on the INBOUND route,
 * which never touch this class.
 *
 * Called from TWO places: `EventService.emit` (immediately, for events on
 * the plain non-transactional path) and `EventService.notifyCommitted`
 * (post-commit, for events staged via `emitInTransaction` — see that
 * method's doc comment for why the two paths exist).
 */

import type { Case, DecisionType, EventType, Finding, User } from '@arbitra/shared';
import { isBlockingFindingStatus, caseShareUrl } from '@arbitra/shared';
import { NotificationService } from './notification-service.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import { GoogleChatNotifier, type SendResult } from './google-chat-notifier.js';
import { getChatReplyPoster, markdownToChatText, truncateForChat } from '../chat/chat-reply-poster.js';
import { AssistantAnswerLookup } from '../assistant/assistant-answer-lookup.js';
import { collections } from '../../lib/firestore.js';
import { publishCaseCommitStatus } from '../webhook/commit-status-service.js';

/**
 * Outcome markers for Chat replies. Dropping the English frame text removed
 * the only cue distinguishing an
 * acknowledgement from a finished answer from a failed run — all three
 * collapsed into an identical bare link, so a reader had to open the case to
 * learn which had happened. These markers restore that signal without
 * reintroducing prose in a language the requester may not speak: the ack in
 * `chat/events/route.ts` keeps 🔗, a delivered answer leads with ✅, and a
 * run that produced no answer leads with ⚠️.
 */
const CHAT_MARKER_ANSWERED = '✅';
const CHAT_MARKER_FAILED = '⚠️';

export class EventNotifier {
  constructor(
    private readonly notificationService = new NotificationService(),
    private readonly dispatcher = new NotificationDispatcher(),
    private readonly chatNotifier = new GoogleChatNotifier(),
    private readonly answerLookup = new AssistantAnswerLookup(),
  ) {}

  /**
   * Process a case event and create notifications for relevant users.
   * This is called inline (fire-and-forget) after event emission.
   */
  async onCaseEvent(
    caseId: string,
    eventType: EventType,
    payload: Record<string, unknown>,
    actorId: string,
  ): Promise<void> {
    try {
      const case_ = await this.getCase(caseId);
      if (!case_) return;

      switch (eventType) {
        case 'human_decision_requested':
          await this.notifyHumanDecisionNeeded(case_, actorId);
          break;

        case 'manual_validation_confirmed':
          // When case transitions to verification_pending
          if (payload.to_status === 'verification_pending') {
            await this.notifyManualValidationPending(case_, actorId);
          }
          break;

        case 'case_approved':
          await this.notifyCaseOutcome(case_, 'case_approved', actorId);
          break;

        case 'case_rejected':
          await this.notifyCaseOutcome(case_, 'case_rejected', actorId);
          break;

        case 'case_completed':
          await this.notifyCaseCompleted(case_);
          break;

        case 'assistant_task_completed':
          await this.notifyAssistantOutcome(case_, 'assistant_task_completed', payload);
          break;

        case 'assistant_task_failed':
          await this.notifyAssistantOutcome(case_, 'assistant_task_failed', payload);
          break;

        case 'run_failed':
          await this.notifyRunFailed(case_, payload);
          break;

        case 'run_retries_exhausted':
          await this.notifyRunRetriesExhausted(case_, payload);
          break;

        case 'gate_pending':
          await this.notifyGatePending(case_, payload);
          break;

        case 'gate_confirmed':
          await this.notifyGateConfirmed(case_, actorId, payload);
          break;

        case 'gate_rejected':
          await this.notifyGateRejected(case_, actorId, payload);
          break;

        case 'decision_created': {
          // Typed against DecisionType so a removed/renamed decision type
          // becomes a compile error here rather than a silent runtime no-op.
          const decisionType = payload.type as DecisionType | undefined;
          if (decisionType === 'request_changes') {
            await this.notifyChangesRequested(case_, actorId, payload);
          }
          break;
        }

        default:
          // Check for transition events that lead to notification-worthy states
          if (payload.to_status === 'needs_human_decision') {
            await this.notifyHumanDecisionNeeded(case_, actorId);
          } else if (payload.to_status === 'verification_pending') {
            await this.notifyManualValidationPending(case_, actorId);
          }
          break;
      }

      // Check for critical rule violations from rule_results_attached events
      if (eventType === 'rule_results_attached') {
        await this.checkCriticalRuleViolations(case_, payload);
      }

      // Check for evidence_missing from evidence events
      if (eventType === 'evidence_missing_detected') {
        await this.notifyEvidenceMissing(case_, payload);
      }

      // Merge-time enforcement (issue #988): publish/refresh the
      // `arbitra/case` GitHub commit status. This is the SINGLE choke point
      // for both trigger points the spec calls for, since every write path
      // that changes a case's status or links/enriches a PR already funnels
      // through `EventService.emit`/`notifyCommitted` into this method:
      //   (a) PR linked/enriched — `pr_opened` (branch-name/PR-text link) and
      //       `pr_updated` (branch-scan link, incl. `synchronize` re-links
      //       with a new head sha) both carry `commit_sha` in their payload.
      //   (b) a status/lifecycle change that alters the verdict — EVERY
      //       transition event carries `from_status`/`to_status`
      //       (`applyTransitionInTransaction` and the pipeline's
      //       `executeTransition` both stamp it), so gating on
      //       `payload.to_status !== undefined` covers approve/reject/
      //       human-decision/auto-close-on-merge uniformly without a
      //       per-status case list to keep in sync.
      // `publishCaseCommitStatus` itself is the Observed-Case guard for the
      // VERDICT, not for whether a GitHub call happens at all: since issue
      // #1024 it always publishes — an Enforced Case gets the computed
      // verdict, an Observed Case or Assistant Task gets an unconditional
      // `success` ("observed — not enforced" / "not enforced"), so a
      // required `arbitra/case` check never blocks a PR that was never
      // meant to be gated. Fail-soft by contract either way, so no
      // try/catch is needed here beyond this method's own.
      //
      // Publishing here is READ-ONLY (issue #1045/#1046). The
      // approval pin the verdict is gated on is written transactionally by
      // `applyTransitionInTransaction`, not here: this hook is reached
      // through `onCaseEvent(...).catch()` on both call paths and is never
      // awaited, so a pin written here would be lost whenever a
      // notification is dropped — leaving a legitimately approved PR
      // permanently failing, with no transition out of `approved` able to
      // restore it. It would also race the second, independent publish that
      // the auto `approved -> pending_merge` edge fires.
      if (eventType === 'pr_opened' || eventType === 'pr_updated' || payload['to_status'] !== undefined) {
        const headSha = typeof payload['commit_sha'] === 'string' ? payload['commit_sha'] : undefined;
        await publishCaseCommitStatus(case_, {}, { headSha });
      }
    } catch (err) {
      console.warn(`[EventNotifier] Failed to process ${eventType} for case ${caseId}:`, err);
    }
  }

  private async notifyHumanDecisionNeeded(case_: Case, _actorId: string): Promise<void> {
    const targets = await this.getReviewersAndLeads(case_.project_id);
    // Also notify case owner
    if (case_.owner_user_id && !targets.includes(case_.owner_user_id)) {
      targets.push(case_.owner_user_id);
    }

    for (const userId of targets) {
      await this.notificationService.notify({
        user_id: userId,
        type: 'case_needs_decision',
        title: `Decision required: ${case_.title}`,
        body: `Open the Courtroom to review findings and make a decision — approve, reject, or request changes.`,
        case_id: case_.case_id,
      });
    }
  }

  private async notifyManualValidationPending(case_: Case, _actorId: string): Promise<void> {
    // Issue #1073 P0 staleness: this fires on EVERY transition into
    // `verification_pending`, including the `needs_human_decision ->
    // verification_pending` exit (status-transitions.ts) — one of the four
    // ways a `case_needs_decision` notification (fanned out by
    // `notifyHumanDecisionNeeded` above) goes stale. Harmless no-op via the
    // other entry paths (e.g. `in_review -> verification_pending`) since the
    // query only matches unread rows that actually exist for this case.
    await this.notificationService.reconcileCaseNeedsDecision(case_.case_id);

    const targets = await this.getReviewersAndLeads(case_.project_id);

    for (const userId of targets) {
      await this.notificationService.notify({
        user_id: userId,
        type: 'manual_validation_pending',
        title: `Manual validation needed: ${case_.title}`,
        body: `Manual sign-off is required. Head to the Courtroom to confirm validation. Track: ${case_.validation_track ?? 'unset'}, Risk: ${case_.risk_level ?? 'unset'}.`,
        case_id: case_.case_id,
      });
    }
  }

  private async notifyCaseOutcome(
    case_: Case,
    type: 'case_approved' | 'case_rejected',
    _actorId: string,
  ): Promise<void> {
    // Issue #1073 P0 staleness: `case_approved`/`case_rejected` are two of
    // the four exits out of `needs_human_decision` that leave every
    // non-acting reviewer's `case_needs_decision` notification unread
    // forever. Reconcile BEFORE the owner-only early return below — same
    // early-return trap `notifyGateConfirmed`/`notifyGateRejected` already
    // had to work around for the `gate_pending` precedent (see their doc
    // comments): a case with no `owner_user_id` must still clear the OTHER
    // reviewers' stale copies.
    await this.notificationService.reconcileCaseNeedsDecision(case_.case_id);

    // Notify case owner
    if (!case_.owner_user_id) return;

    if (type === 'case_approved') {
      await this.notificationService.notify({
        user_id: case_.owner_user_id,
        type,
        title: `Case approved: ${case_.title}`,
        body: `Great news — your case has been approved and is ready to merge.`,
        case_id: case_.case_id,
      });

      // Google Chat dispatch — muted by default (informational event, see
      // `NOTIFICATION_EVENT_DEFAULTS`), but always called so a per-project
      // override (slice C2) can turn it on without a code change here.
      this.dispatcher.dispatch({
        event: 'case_approved',
        case_,
      }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for case_approved:', err));
    } else {
      await this.notificationService.notify({
        user_id: case_.owner_user_id,
        type,
        title: `Case rejected: ${case_.title}`,
        body: `Your case was rejected. Open it to review the rationale and decide on next steps.`,
        case_id: case_.case_id,
      });
      // No PROJECT Chat event exists for `case_rejected` in the catalog —
      // `rejected` is a terminal, non-merge outcome distinct from the
      // approve/merge path `case_approved`/`case_done` cover, and the spec's
      // Chat program never proposed one for `this.dispatcher`. A Clerk
      // (`assistant_task`) case reaching `rejected` is different: that is
      // the terminal-failure edge out of the Clerk lifecycle
      // (`status-transitions.ts`'s `assistant_terminal_failure_documented`
      // precondition), and if it originated in Google Chat the requester is
      // sitting in that thread waiting for an answer that will now never
      // come — see `notifyChatThreadOutcome`'s doc for why this gets the
      // SAME originating-thread reply `assistant_task_completed` does below,
      // just with the failure text.
      if (case_.case_type === 'assistant_task') {
        await this.notifyChatThreadOutcome(case_, 'rejected');
      }
    }
  }

  /**
   * `case_completed` fires whenever a case reaches `done` — engineering
   * cases and Clerk (`assistant_task`) cases alike, since both list
   * `case_completed` in their transition's event set
   * (`status-transitions.ts`). Clerk cases ALSO emit `assistant_task_completed`
   * on the very same transition, which `notifyAssistantOutcome` turns into a
   * requester-scoped notification — a second, generic "case completed" one
   * here would just duplicate it for the same user.
   */
  private async notifyCaseCompleted(case_: Case): Promise<void> {
    if (case_.case_type === 'assistant_task') return;
    if (!case_.owner_user_id) return;

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'case_done',
      title: `Case completed: ${case_.title}`,
      body: `Your case has reached done.`,
      case_id: case_.case_id,
    });

    // Muted by default (informational), see `NOTIFICATION_EVENT_DEFAULTS`.
    this.dispatcher.dispatch({
      event: 'case_done',
      case_,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for case_done:', err));
  }

  /**
   * Clerk (assistant task) outcomes, notified to the REQUESTER — not the
   * case owner pool used elsewhere in this class, and not the reviewer pool
   * (a Clerk task has no reviewers). `requester_user_id` is the field the
   * spec names as authoritative; `owner_user_id` is the same actor in
   * practice (`AssistantIntakeService` stamps both from the same actor id
   * at creation) but is used only as a fallback for older/odd data.
   *
   * Deliberately NO project-wide Google Chat dispatch here (`this.dispatcher`
   * is never called from this method): the project a Clerk case lives in is
   * the requester's own private Clerk project, and routing a private task's
   * outcome through the project-wide Chat webhook would leak requester-only
   * content into a space other project members can read. Instead, slice D
   * (`docs/specs/clerk-config-scheduling-chat.md`) adds
   * `notifyRequesterChat` below: a SEPARATE, requester-scoped channel keyed
   * on the requester's OWN `User.notification_chat_webhook`, called after
   * the in-app notification and guarded so a slow/failing Chat send can
   * never throw out of, or roll back, the in-app path — see that method's
   * call site below for why this is an ordinary awaited call rather than a
   * second detached promise.
   */
  private async notifyAssistantOutcome(
    case_: Case,
    type: 'assistant_task_completed' | 'assistant_task_failed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const requesterUserId = case_.assistant_context?.requester_user_id ?? case_.owner_user_id;
    if (!requesterUserId) return;

    if (type === 'assistant_task_completed') {
      await this.notificationService.notify({
        user_id: requesterUserId,
        type,
        title: `Clerk task done: ${case_.title}`,
        body: `Your Clerk task has an answer ready. Open the case to read it.`,
        case_id: case_.case_id,
      });
    } else {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown reason';
      await this.notificationService.notify({
        user_id: requesterUserId,
        type,
        title: `Clerk task failed: ${case_.title}`,
        body: `Your Clerk task could not be completed (${reason}). Open the case for details.`,
        case_id: case_.case_id,
      });
    }

    // Slice D — a webhook send failure (bad URL, Chat outage, a user who
    // revoked the space) must never surface as, or roll back, the in-app
    // notification above (already sent by this point). Awaited rather than
    // a detached `.catch(...)` promise: EVERY caller of `onCaseEvent`
    // (`EventService.emit`/`.notifyCommitted`) already invokes it
    // fire-and-forget itself, so awaiting here adds no caller-visible
    // latency while keeping this whole path synchronous end-to-end — one
    // fire-and-forget boundary in the call chain is enough. The try/catch
    // is pure defense-in-depth: `notifyRequesterChat` already swallows its
    // own Firestore errors and `GoogleChatNotifier.send` never throws.
    try {
      await this.notifyRequesterChat(case_, requesterUserId, type, payload);
    } catch (err) {
      console.warn(
        `[EventNotifier] Chat webhook dispatch failed for ${type} on case ${case_.case_id}:`,
        err,
      );
    }

    // Slice F — the completion hook, separate from the requester's personal
    // webhook ping above: posts the case's own outcome back into the
    // ORIGINATING Google Chat thread (space + thread stamped on
    // `assistant_context` at intake), when the task came from Chat at all.
    // `notifyChatThreadOutcome` never throws (same discipline as
    // `notifyRequesterChat` above), so no try/catch is needed at this call
    // site — see that method's own doc.
    if (type === 'assistant_task_completed') {
      await this.notifyChatThreadOutcome(case_, 'completed');
    }
  }

  /**
   * Slice D (`docs/specs/clerk-config-scheduling-chat.md`) — pings the
   * REQUESTER's own private Google Chat space, not any project space. No-op
   * (today's exact behavior) when the requester has no
   * `notification_chat_webhook` configured, or their user doc can't be
   * loaded — this is a config gap, not a delivery failure, so it does not
   * touch `notification_chat_delivery` (mirrors
   * `NotificationDispatcher.dispatch`'s unset-webhook no-op).
   *
   * Message shape reuses `GoogleChatNotifier`'s existing title/link/body
   * builder (`formatMessage`) rather than a bespoke format: `title` is the
   * task's case title (bold line), `link` is the case deep link (via the
   * shared `caseShareUrl` helper — the same one the case detail route's
   * `share_url` field uses), and `body` is the one-line outcome
   * ("completed" / "completed with limitation: …" / "failed: …").
   */
  private async notifyRequesterChat(
    case_: Case,
    requesterUserId: string,
    type: 'assistant_task_completed' | 'assistant_task_failed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    let webhookUrl: string | null | undefined;
    try {
      const userDoc = await collections.users().doc(requesterUserId).get();
      if (!userDoc.exists) return;
      webhookUrl = (userDoc.data() as User).notification_chat_webhook;
    } catch (err) {
      console.warn(`[EventNotifier] Failed to load user ${requesterUserId} for Chat dispatch:`, err);
      return;
    }
    if (!webhookUrl) return;

    const baseUrl = process.env['ARBITRA_URL'];
    const link = baseUrl
      ? caseShareUrl({ baseUrl, caseId: case_.case_id, status: case_.status })
      : undefined;

    const result = await this.chatNotifier.send(webhookUrl, {
      title: case_.title,
      body: this.assistantOutcomeLine(type, payload),
      link,
    });

    await this.recordChatDeliveryOutcome(requesterUserId, result);
  }

  /**
   * The one-line outcome for a requester's Chat ping. `reads_withheld` on
   * `assistant_task_completed`'s payload is stamped by the `done` transition
   * itself (`applyTransitionInTransaction`'s `extraEventPayload` applies to
   * every event the transition emits, `assistant_task_completed` included —
   * see `assistant-task-executor.ts`), so no executor change was needed to
   * read it here. `assistant_task_failed` carries its failure class in
   * `payload.reason` (e.g. `'bound:max_steps'`, `'completion_failed'`) —
   * the same field `notifyAssistantOutcome`'s in-app body already reads.
   */
  private assistantOutcomeLine(
    type: 'assistant_task_completed' | 'assistant_task_failed',
    payload: Record<string, unknown>,
  ): string {
    if (type === 'assistant_task_failed') {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown reason';
      return `failed: ${reason}`;
    }
    if (payload.reads_withheld === true) {
      return 'completed with limitation: read budget spent';
    }
    return 'completed';
  }

  /**
   * Persists one send outcome to `users/{id}.notification_chat_delivery` —
   * same shape and write discipline as
   * `NotificationDispatcher.recordDeliveryOutcome` (spec Slice C item 4):
   * dot-path updates so each write only ever touches its own leaf, success
   * does NOT clear a prior `last_error`, and this method swallows its own
   * Firestore errors so a recording failure can never surface as (or be
   * confused with) the send itself failing.
   */
  private async recordChatDeliveryOutcome(userId: string, result: SendResult): Promise<void> {
    const now = new Date().toISOString();
    try {
      if (result.ok) {
        await collections.users().doc(userId).update({
          'notification_chat_delivery.last_success_at': now,
        });
      } else {
        await collections.users().doc(userId).update({
          'notification_chat_delivery.last_error': {
            at: now,
            code: result.status !== undefined ? String(result.status) : 'network_error',
            message: result.error ?? 'Unknown error',
          },
        });
      }
    } catch (err) {
      console.warn(`[EventNotifier] Failed to record chat delivery outcome for user ${userId}:`, err);
    }
  }

  /**
   * Slice F completion hook (`docs/specs/clerk-config-scheduling-chat.md`):
   * posts the case's terminal outcome — `'completed'` from
   * `notifyAssistantOutcome`, `'rejected'` from `notifyCaseOutcome`'s
   * assistant_task branch — back into the Google Chat space/thread the task
   * originated from. No-op for a case that either did not come from Chat at
   * all (`assistant_context.channel !== 'google_chat'`) or has no
   * `space_name` to reply into (defensive: intake always stamps one for the
   * `google_chat` channel, but a channel string is user-influenced input at
   * the type level, not a closed enum — see `AssistantContext.channel`'s own
   * doc).
   *
   * ## Content: a short lead + the case link, NOT the full answer
   *
   * Deliberately consistent with the Slice D trade-off that
   * already withholds the full answer from the REQUESTER's personal webhook
   * ping (`notifyRequesterChat` above posts only a one-line outcome, never
   * the answer text): a Google Chat space can have readers other than the
   * requester, so the full Clerk answer — which may quote the requester's
   * own question and any data Clerk read on their behalf — never gets
   * printed into a space other people can see. What DOES get posted is a
   * short, bounded lead (`deriveChatCompletionLead`, capped at
   * `CHAT_COMPLETION_LEAD_MAX_CHARS`) plus the case's own deep link
   * (`caseShareUrl`), where the full answer already lives behind Arbitra's
   * own access control. `truncateForChat` still runs over the assembled
   * text regardless, as the hard byte ceiling Chat's API enforces — not
   * because a lead this short is expected to ever need it.
   *
   * ## Never an empty message
   *
   * `AssistantAnswerLookup.getAnswerForCase` returns `null` for "no answer
   * yet", a missing/unlinked artifact, or a parse failure — none of those
   * are the caller's problem to diagnose, so all three fall back to the same
   * neutral marker-plus-link text (see "No English framing" below) rather
   * than posting nothing (or an empty string).
   *
   * ## No English framing
   *
   * Clerk answers in the requester's own language (the assistant system
   * prompt instructs it to), so hardcoded English sentences wrapped around
   * the lead — an ack-style "Full answer:" label, a "your task is done"
   * fallback — read wrong for any non-English requester. No language
   * detection; remove the language-bearing prose instead. The
   * lead itself (Clerk-authored, already in the requester's language) gets
   * no added framing at all — just a blank line, then the bare case link.
   * The two branches with no Clerk-authored text to draw language from (no
   * lead found; `outcome === 'rejected'`) fall back to the same neutral
   * `🔗 <link>` marker the ack in `chat/events/route.ts` uses, rather than
   * an English sentence.
   *
   * ## Never blocks or throws
   *
   * Same discipline as `notifyRequesterChat`: every failure mode (poster
   * throws, poster returns `{ok: false}`, the answer lookup itself throws)
   * degrades to a logged warning. Callers (`notifyAssistantOutcome`,
   * `notifyCaseOutcome`) call this unwrapped precisely because it already
   * never throws.
   *
   * ## Double-post guard
   *
   * `assistant_context.chat_reply_posted_at` is checked before attempting a
   * post and stamped (via a best-effort, non-transactional
   * `collections.cases().doc(...).update(...)`, same write discipline as
   * `recordChatDeliveryOutcome` above) immediately after — on EVERY attempt,
   * not only a successful one, since a failed Chat POST is not retried
   * either. This is intentionally not transactional: `onCaseEvent`'s own
   * callers already invoke it fire-and-forget, and two truly concurrent
   * deliveries for the same case racing this read-then-write is the same
   * accepted routing slack `chat-thread-link-service.ts` documents for its
   * own tip pointer, not a correctness bar this best-effort notification
   * path needs to clear.
   */
  private async notifyChatThreadOutcome(
    case_: Case,
    outcome: 'completed' | 'rejected',
  ): Promise<void> {
    const ctx = case_.assistant_context;
    if (!ctx || ctx.channel !== 'google_chat') return;
    if (!ctx.space_name) return;
    if (ctx.chat_reply_posted_at) return;

    const baseUrl = process.env['ARBITRA_URL'];
    const shareUrl = baseUrl
      ? caseShareUrl({ baseUrl, caseId: case_.case_id, status: case_.status })
      : undefined;
    // Always some reference to the case, even without a public base URL to
    // build a real link from — see `truncateForChat`'s deepLink parameter
    // below, which needs a value regardless.
    const caseRef = shareUrl ?? `the case (${case_.case_id}) in Arbitra`;

    // No language detection: a
    // Clerk answer is written in the requester's own language, so English
    // scaffolding wrapped around it is wrong more often than it's right.
    // Every branch below either carries no language-bearing prose at all
    // (a neutral marker plus the bare case reference) or is exactly the
    // Clerk-authored lead with no added framing — never a hardcoded English
    // sentence.
    let text: string;
    if (outcome === 'rejected') {
      // No Clerk-authored text exists for a rejected outcome. Marker only —
      // but a DISTINCT one: dropping the English prose also
      // dropped the only signal separating "tracking", "answered" and
      // "failed", which left all three reading as an identical bare link.
      // The marker carries that distinction instead of a sentence, so the
      // reply stays language-neutral and still legible at a glance.
      text = `${CHAT_MARKER_FAILED} ${caseRef}`;
    } else {
      const answer = await this.answerLookup.getAnswerForCase(case_.case_id).catch((err) => {
        console.warn(
          `[EventNotifier] Answer lookup failed for case ${case_.case_id}, posting fallback:`,
          err,
        );
        return null;
      });
      const lead = answer ? deriveChatCompletionLead(answer) : null;
      // The lead is already in the requester's language — it needs no
      // English label. Bare link on its own line, no "Full answer:".
      // Without a lead (no answer text found), fall back to the same
      // neutral marker+link the rejected branch above uses.
      text = lead
        ? `${CHAT_MARKER_ANSWERED} ${lead}\n\n${caseRef}`
        : `${CHAT_MARKER_FAILED} ${caseRef}`;
    }

    // Markdown -> Chat syntax BEFORE truncation: the byte budget enforced
    // by `truncateForChat` must reflect what is actually sent, and cutting
    // a still-Markdown `**word**` at the byte ceiling could otherwise leave
    // a dangling, unclosed marker in the delivered text.
    const finalText = truncateForChat(markdownToChatText(text), shareUrl ?? '');

    try {
      const result = await getChatReplyPoster().post(
        { spaceName: ctx.space_name, threadName: ctx.thread_name },
        finalText,
      );
      if (!result.ok) {
        console.warn(
          `[EventNotifier] Chat thread reply not delivered for case ${case_.case_id}:`,
          result.reason,
        );
      }
    } catch (err) {
      console.warn(`[EventNotifier] Chat thread reply post threw for case ${case_.case_id}:`, err);
    } finally {
      await this.markChatReplyPosted(case_.case_id);
    }
  }

  /**
   * Stamps `assistant_context.chat_reply_posted_at`, unconditionally of
   * whether the post that just preceded it succeeded — see
   * `notifyChatThreadOutcome`'s doc for why. Swallows its own Firestore
   * errors, same as `recordChatDeliveryOutcome`, so a recording failure can
   * never surface as (or be confused with) the post itself failing — worst
   * case a future re-notification posts once more, no worse than today's
   * complete absence of a guard.
   */
  private async markChatReplyPosted(caseId: string): Promise<void> {
    try {
      await collections.cases().doc(caseId).update({
        'assistant_context.chat_reply_posted_at': new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[EventNotifier] Failed to record chat_reply_posted_at for case ${caseId}:`, err);
    }
  }

  private async notifyRunFailed(case_: Case, payload: Record<string, unknown>): Promise<void> {
    if (!case_.owner_user_id) return;

    const runLabel = (typeof payload.run_type === 'string' ? payload.run_type : 'task').replace(/_/g, ' ');
    const attempt = typeof payload.attempt === 'number' ? payload.attempt : 1;
    const error = typeof payload.error === 'string' ? payload.error : undefined;

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'run_failed',
      title: `${runLabel} failed: ${case_.title}`,
      body: `Attempt ${attempt} of ${runLabel} failed.${error ? ` ${error}` : ''}`,
      case_id: case_.case_id,
    });

    this.dispatcher.dispatch({
      event: 'run_failed',
      case_,
      rationale: error,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for run_failed:', err));
  }

  /**
   * The roadmap-promised case-owner notification for an exhausted retry
   * ladder. Previously done ad hoc, in-app only, directly inside
   * `Pipeline.emitRetriesExhausted` — that call is now removed in favour of
   * this one path, so the event catalog (and its Chat dispatch, which the
   * ad hoc call never had) is the single source of truth for this event.
   */
  private async notifyRunRetriesExhausted(case_: Case, payload: Record<string, unknown>): Promise<void> {
    if (!case_.owner_user_id) return;

    const runLabel = (typeof payload.run_type === 'string' ? payload.run_type : 'task').replace(/_/g, ' ');
    const attempts = typeof payload.attempts === 'number' ? payload.attempts : 1;

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'run_retries_exhausted',
      title: `Pipeline task failed after retries: ${case_.title}`,
      body: `${runLabel} for '${case_.title}' failed after ${attempts} attempt(s) and will not be retried automatically. Manual attention required.`,
      case_id: case_.case_id,
    });

    this.dispatcher.dispatch({
      event: 'run_retries_exhausted',
      case_,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for run_retries_exhausted:', err));
  }

  private async notifyChangesRequested(
    case_: Case,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Issue #1073 P0 staleness: `request_changes` is the third exit out of
    // `needs_human_decision` that must clear stale `case_needs_decision`
    // rows. Reconcile BEFORE the early return, same trap as
    // `notifyCaseOutcome` above (and `notifyGateConfirmed`/`notifyGateRejected`
    // before it) — a reviewer requesting changes on their OWN case (or a case
    // with no owner) must still clear every OTHER reviewer's stale copy.
    await this.notificationService.reconcileCaseNeedsDecision(case_.case_id);

    if (!case_.owner_user_id || case_.owner_user_id === actorId) return;

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'changes_requested',
      title: `Changes requested: ${case_.title}`,
      body: `A reviewer sent your case back for rework.${payload.rationale ? ` Reason: ${payload.rationale}` : ' Open the case to see what needs to change.'}`,
      case_id: case_.case_id,
    });

    // Dispatch Google Chat push notification
    // Fetch the decision to get the rationale
    let rationale: string | undefined;
    if (payload.decision_id) {
      try {
        const decisionDoc = await collections.decisions().doc(payload.decision_id as string).get();
        if (decisionDoc.exists) {
          rationale = decisionDoc.data()!.rationale;
        }
      } catch {
        // Best-effort — send notification without rationale
      }
    }

    this.dispatcher.dispatch({
      event: 'changes_requested',
      case_,
      rationale,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed:', err));
  }

  /**
   * `rule_results_attached`'s own payload carries only counts of rules
   * evaluated/conflicts (`rule-service.ts`'s `evaluateRulesForCase`), never a
   * fail count or finding severity — so both checks below re-query the
   * case's current state rather than trust the payload. Two independent
   * notifications can fire from the one event: `rule_violation` for any
   * failed `RuleResult`s, and `critical_finding` for any still-blocking
   * high/critical `Finding` (rules and findings are separate collections;
   * `RuleResult.finding_ref` — the join between them — is never populated
   * anywhere in this codebase today, so they must be checked independently).
   */
  private async checkCriticalRuleViolations(
    case_: Case,
    _payload: Record<string, unknown>,
  ): Promise<void> {
    await this.notifyRuleViolations(case_);
    await this.notifyCriticalFindings(case_);
  }

  private async notifyRuleViolations(case_: Case): Promise<void> {
    let failCount: number;
    try {
      const snap = await collections.ruleResults().where('case_id', '==', case_.case_id).get();
      failCount = snap.docs.filter((doc) => doc.data().result_status === 'fail').length;
    } catch (err) {
      console.warn(`[EventNotifier] Failed to load rule results for case ${case_.case_id}:`, err);
      return;
    }
    if (failCount === 0) return;

    const targets = await this.getReviewersAndLeads(case_.project_id);
    if (case_.owner_user_id && !targets.includes(case_.owner_user_id)) {
      targets.push(case_.owner_user_id);
    }

    for (const userId of targets) {
      await this.notificationService.notify({
        user_id: userId,
        type: 'rule_violation',
        title: `Rule violations detected: ${case_.title}`,
        body: `${failCount} rule${failCount !== 1 ? 's' : ''} failed — review the violations before this case can progress.`,
        case_id: case_.case_id,
      });
    }

    this.dispatcher.dispatch({
      event: 'rule_violation',
      case_,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for rule_violation:', err));
  }

  /**
   * Blocking + high/critical severity mirrors the precondition gates
   * (`has_high_critical_findings` et al. in `preconditions.ts`) — same
   * `isBlockingFindingStatus` helper, same severity pair, so "notified" and
   * "still blocking progress" never disagree.
   */
  private async notifyCriticalFindings(case_: Case): Promise<void> {
    let findings: Finding[];
    try {
      const snap = await collections.findings().where('case_id', '==', case_.case_id).get();
      findings = snap.docs.map((doc) => doc.data());
    } catch (err) {
      console.warn(`[EventNotifier] Failed to load findings for case ${case_.case_id}:`, err);
      return;
    }

    const blocking = findings.filter(
      (f) => isBlockingFindingStatus(f.status) && (f.severity === 'high' || f.severity === 'critical'),
    );
    if (blocking.length === 0) return;

    // Most severe first, so the single finding named in the notification is
    // the one that matters most when both severities are present.
    const worst = blocking.find((f) => f.severity === 'critical') ?? blocking[0]!;

    const targets = await this.getReviewersAndLeads(case_.project_id);
    if (case_.owner_user_id && !targets.includes(case_.owner_user_id)) {
      targets.push(case_.owner_user_id);
    }

    const countNote = blocking.length > 1 ? ` (${blocking.length} total)` : '';
    for (const userId of targets) {
      await this.notificationService.notify({
        user_id: userId,
        type: 'critical_finding',
        title: `Critical finding: ${case_.title}`,
        body: `${worst.severity} finding: ${worst.title}${countNote}. Review before this case can progress.`,
        case_id: case_.case_id,
      });
    }

    this.dispatcher.dispatch({
      event: 'critical_finding',
      case_,
      findingTitle: worst.title,
      findingSeverity: worst.severity,
      findingCount: blocking.length,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for critical_finding:', err));
  }

  private async notifyEvidenceMissing(
    case_: Case,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!case_.owner_user_id) return;

    const missingTypes = (payload.missing_types as string[]) ?? [];

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'evidence_missing',
      title: `Evidence missing: ${case_.title}`,
      body: `This case is blocked by missing evidence${missingTypes.length > 0 ? `: ${missingTypes.join(', ')}` : ''}. Submit the required evidence to unblock the review.`,
      case_id: case_.case_id,
    });

    this.dispatcher.dispatch({
      event: 'evidence_missing',
      case_,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for evidence_missing:', err));
  }

  private async notifyGatePending(case_: Case, payload: Record<string, unknown>): Promise<void> {
    const targets = await this.getReviewersAndLeads(case_.project_id);
    const targetStatus = (payload.to_status as string) ?? 'next phase';

    for (const userId of targets) {
      await this.notificationService.notify({
        user_id: userId,
        type: 'gate_pending',
        title: `Confirmation required: ${case_.title}`,
        body: `Case is ready to proceed to ${targetStatus} and awaits your confirmation.`,
        case_id: case_.case_id,
      });
    }

    // Also dispatch Google Chat push notification
    this.dispatcher.dispatch({
      event: 'gate_pending',
      case_,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for gate_pending:', err));
  }

  private async notifyGateConfirmed(
    case_: Case,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Issue #794 P0 staleness: every reviewer/tech-lead who got the
    // `gate_pending` notification (not just the owner notified below) has a
    // copy that now instructs them to confirm/reject a gate someone already
    // decided. Reconcile BEFORE the early return so it runs even when the
    // actor is the owner themselves (other reviewers' copies still need it).
    //
    // CONSTRAINT: `gate_confirmed`/`gate_rejected` are emitted for TWO
    // architecturally independent gate kinds that share these event types —
    // (1) the case-level LIFECYCLE `pending_gate` set by
    // `pipeline.ts`'s `emitGatePending`/cleared by `executeGateConfirmation`
    // (payload: `gate_id`/`from_status`/`to_status`, no `gate_kind`), and
    // (2) a RULE-level `human_confirmation` RuleResult gate resolved by
    // `DecisionService.resolveHumanConfirmationGate` (payload tagged
    // `gate_kind: 'human_confirmation_rule'` + `rule_id`). Only kind (1) ever
    // emits `gate_pending` (only `pipeline.ts` does — see
    // `NotificationRepository.markStaleGatePending`'s query), so reconciling
    // on kind (2) would mark a still-live lifecycle `gate_pending`
    // notification read for every other reviewer while the actual lifecycle
    // gate remains undecided. Skip reconciliation for the rule-level kind.
    if (payload.gate_kind !== 'human_confirmation_rule') {
      await this.notificationService.reconcileGateDecision(case_.case_id);
    }

    // Notify case owner that gate was confirmed
    if (!case_.owner_user_id || case_.owner_user_id === actorId) return;

    const targetStatus = (payload.to_status as string) ?? 'next phase';

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'gate_confirmed',
      title: `Gate confirmed: ${case_.title}`,
      body: `Your case has been confirmed to proceed to ${targetStatus}.`,
      case_id: case_.case_id,
    });
  }

  private async notifyGateRejected(
    case_: Case,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Issue #794 P0 staleness + the lifecycle-vs-rule-level gate_kind
    // constraint — see the identical comment in `notifyGateConfirmed` above.
    if (payload.gate_kind !== 'human_confirmation_rule') {
      await this.notificationService.reconcileGateDecision(case_.case_id);
    }

    // Notify case owner that gate was declined
    if (!case_.owner_user_id || case_.owner_user_id === actorId) return;

    await this.notificationService.notify({
      user_id: case_.owner_user_id,
      type: 'gate_rejected',
      title: `Gate declined: ${case_.title}`,
      body: `Gate declined for your case. The case remains in ${case_.status}.`,
      case_id: case_.case_id,
    });

    // Dispatch Google Chat push notification
    this.dispatcher.dispatch({
      event: 'gate_rejected',
      case_,
    }).catch((err) => console.warn('[EventNotifier] Google Chat dispatch failed for gate_rejected:', err));
  }

  /**
   * Get reviewer pool and tech leads for a project.
   * Falls back to all users with reviewer/tech_lead roles if project has no pool configured.
   */
  private async getReviewersAndLeads(projectId?: string): Promise<string[]> {
    const targets: Set<string> = new Set();

    if (projectId) {
      try {
        const projectDoc = await collections.projects().doc(projectId).get();
        if (projectDoc.exists) {
          const project = projectDoc.data()!;
          for (const uid of project.reviewer_pool ?? []) targets.add(uid);
          for (const uid of project.tech_leads ?? []) targets.add(uid);
        }
      } catch (err) {
        console.warn(`[EventNotifier] Failed to load project ${projectId}:`, err);
      }
    }

    // If no project-level targets, find users with reviewer or tech_lead roles
    if (targets.size === 0) {
      try {
        const usersSnap = await collections.users().get();
        for (const doc of usersSnap.docs) {
          const user = doc.data();
          if (user.roles.some((r: string) => r === 'reviewer' || r === 'tech_lead' || r === 'admin')) {
            targets.add(user.user_id);
          }
        }
      } catch (err) {
        console.warn('[EventNotifier] Failed to load users for notification targets:', err);
      }
    }

    return Array.from(targets);
  }

  private async getCase(caseId: string): Promise<Case | null> {
    try {
      const doc = await collections.cases().doc(caseId).get();
      return doc.exists ? doc.data()! : null;
    } catch (err) {
      console.warn(`[EventNotifier] Failed to load case ${caseId}:`, err);
      return null;
    }
  }
}

/**
 * Bound on `deriveChatCompletionLead`'s output — "a couple of hundred
 * characters", per the Slice F completion hook
 * (`notifyChatThreadOutcome`'s doc). Character-based, not byte-based:
 * `truncateForChat`'s byte ceiling downstream is the real Chat API limit
 * this composes with; this constant is a much tighter cosmetic bound so a
 * short-space-reply lead never balloons into a second answer.
 */
const CHAT_COMPLETION_LEAD_MAX_CHARS = 220;

/**
 * Room reserved, inside `CHAT_COMPLETION_LEAD_MAX_CHARS`, for the "+N more"
 * partial-list marker `deriveChatCompletionLead` appends below (see that
 * function's "Signalling a partial list" doc). Sized for `\n… (+NNN)` —
 * three digits covers any list Clerk would plausibly return inline; a
 * roster past a few hundred names would never fit this lead's budget
 * regardless of how the marker itself is sized. Reserved BEFORE packing
 * items rather than appended after and re-checked, so the packing loop
 * below stays a single pass.
 */
const CHAT_COMPLETION_LEAD_MARKER_RESERVE = 12;

/** Matches one Markdown list-item line: a `-`/`*`/`+` bullet or a `1.`/`1)` ordinal. */
const CHAT_LEAD_LIST_ITEM_PATTERN = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * True when every non-blank line of `block` reads as a Markdown list item.
 * Deliberately ALL-lines, not ANY-line: a block mixing prose with one line
 * that happens to start with "-" (a hyphenated word, a sub-clause dash) is
 * prose, not a list — folding it into the lead as if each line were an
 * enumerable item would garble it rather than clarify it.
 */
function isChatLeadListBlock(block: string): boolean {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 && lines.every((l) => CHAT_LEAD_LIST_ITEM_PATTERN.test(l));
}

/** Splits a block already confirmed via `isChatLeadListBlock` into its item lines. */
function splitChatLeadListItems(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Word-boundary clamp to `CHAT_COMPLETION_LEAD_MAX_CHARS`, shared by every
 * `deriveChatCompletionLead` return path that has no list items to fold in.
 */
function clampChatLead(text: string): string {
  if (text.length <= CHAT_COMPLETION_LEAD_MAX_CHARS) return text;
  const cut = text.slice(0, CHAT_COMPLETION_LEAD_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  // Prefer a word boundary, but not one so early it would gut the lead —
  // mirrors `truncateForChat`'s own "boundary window" reasoning.
  const boundary = lastSpace > 40 ? lastSpace : cut.length;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}

/**
 * Derives a brief lead from a Clerk answer for `notifyChatThreadOutcome`.
 *
 * Base case: the first non-empty paragraph (split on a blank line),
 * whitespace-collapsed, cut to `CHAT_COMPLETION_LEAD_MAX_CHARS` at the
 * nearest word boundary (`clampChatLead`). Never throws — a
 * malformed/empty answer collapses to `''`, which `notifyChatThreadOutcome`
 * treats the same as "no answer" (falls back to the generic
 * marker-plus-link text) rather than posting a lead that is just
 * whitespace or an ellipsis.
 *
 * ## List folding (issue #949)
 *
 * A "who/which/list me" answer is typically one intro paragraph plus a
 * Markdown list — e.g. "The North team has 10 members:" followed
 * by ten bullet lines. Taking only the intro paragraph (the pre-fix
 * behaviour) keeps the COUNT but drops every NAME, and leaves the intro's
 * trailing colon dangling straight into the blank line and case link —
 * reading as a cut-off sentence, not a deliberate summary.
 *
 * So: whenever the lead paragraph ends in a colon, OR the very next block
 * is itself a Markdown list (`isChatLeadListBlock`) — either condition is
 * independently sufficient, per the issue's "when X, or Y" — list items are
 * folded into the lead, one at a time, until the next item would push the
 * combined text past budget. `CHAT_COMPLETION_LEAD_MARKER_RESERVE` chars
 * are held back from the start of that packing so there is always room left
 * for the partial-list marker below, without a second truncation pass.
 *
 * ## Signalling a partial list
 *
 * A list cut short by the budget must not read as the complete list — the
 * same defect this fix removes, just moved one level down (10 people
 * becomes 4 people with no hint the other 6 exist). Chosen signal: an
 * ellipsis line plus a parenthesised remaining-count, `… (+6)` — numerals
 * and punctuation only, so it stays language-neutral like the rest of this
 * function's output (no lead-language detection; see
 * `notifyChatThreadOutcome`'s own doc on that). A bare ellipsis alone would
 * say "more exists" but not how much is being withheld; the count costs
 * nothing extra to compute here (the item array is already fully split),
 * and the case link one line down covers anyone who wants the rest.
 *
 * ## No dangling colon without a list to back it up
 *
 * If the lead ends in a colon but the next block ISN'T a list (more prose,
 * or nothing at all — end of answer), there is nothing to fold in. Rather
 * than post the exact "text:" + blank line + link shape the bug report
 * flagged, the trailing colon is dropped instead: a colon promising a
 * continuation that never arrives reads as broken, a colon-less sentence
 * does not.
 */
function deriveChatCompletionLead(answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) return '';

  const blocks = trimmed
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const leadBlock = blocks[0] ?? trimmed;
  const leadNormalized = leadBlock.replace(/\s+/g, ' ').trim();
  const leadEndsWithColon = leadBlock.endsWith(':');

  const nextBlock = blocks[1];
  const listItems =
    nextBlock && isChatLeadListBlock(nextBlock) ? splitChatLeadListItems(nextBlock) : [];

  if (listItems.length === 0) {
    // No list to fold in either way — the original single-paragraph
    // behaviour, minus a colon that would otherwise dangle with nothing
    // behind it (see "No dangling colon" above).
    const lead = leadEndsWithColon ? leadNormalized.replace(/:$/, '') : leadNormalized;
    return clampChatLead(lead);
  }

  const fullyFolded = [leadNormalized, ...listItems].join('\n');
  if (fullyFolded.length <= CHAT_COMPLETION_LEAD_MAX_CHARS) {
    // Every item fits — no partial-list marker needed, nothing was withheld.
    return fullyFolded;
  }

  let used = leadNormalized.length;
  const included: string[] = [];
  for (const item of listItems) {
    const withItem = used + 1 + item.length; // +1 accounts for the joining "\n"
    if (withItem > CHAT_COMPLETION_LEAD_MAX_CHARS - CHAT_COMPLETION_LEAD_MARKER_RESERVE) break;
    included.push(item);
    used = withItem;
  }

  if (included.length === 0) {
    // Not even one item fit alongside the lead paragraph itself (e.g. a
    // single very long item) — fall back to the plain paragraph rather than
    // an empty or garbled list.
    return clampChatLead(leadNormalized);
  }

  const remaining = listItems.length - included.length;
  return [leadNormalized, ...included, `… (+${remaining})`].join('\n');
}
