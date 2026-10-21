import { NextRequest, NextResponse } from 'next/server';
import { verifyChatEventToken } from '@/lib/chat-auth';
import { TERMINAL_CASE_STATUSES, type ChatContinuityKeyKind, type ChatConversationWindow } from '@arbitra/shared';
import {
  AssistantIntakeService,
  CaseService,
  getChatReplyPoster,
  mapChatIdentity,
  recordChatThreadTip,
  resolveChatThreadCase,
  resolveUserChatConversationWindow,
  shouldRestartChatConversation,
  type ChatContinuityLink,
  type ChatIdentityMappingOutcome,
} from '@arbitra/backend';
import { scheduleAssistantRunDispatch } from '@/lib/assistant-run-dispatch';
import { resolveCaseShareUrl } from '@/lib/public-base-url';
import { resolveCallerIp } from '../../auth/connect/_helpers';
import { checkChatEventsRateLimit } from './rate-limit';
import { type ChatEvent, type ChatEventKind, classifyChatEvent, summarizePayloadShape } from './event-shape';
import {
  readCommonEventTimeZone,
  readFallbackSpaceName,
  resolveChatMessage,
  resolveChatSender,
  type ChatMessageResolution,
  type ChatSenderResolution,
  type ResolvedChatMessage,
  type ResolvedChatSender,
} from './chat-sender';

const intakeService = new AssistantIntakeService();
const caseService = new CaseService();

export const dynamic = 'force-dynamic';

/**
 * Constant 429 body — deliberately carries no detail (which limit, which
 * bucket, retry timing), mirroring the 401 path's no-detail rejection style
 * below. A single literal object reused on every rejection rather than
 * built per-request, so there is no per-request value that could leak.
 */
const RATE_LIMIT_EXCEEDED_RESPONSE_BODY = {
  error: { code: 'RATE_LIMITED', message: 'Too many requests' },
} as const;

/**
 * Entry point for the Google Chat app
 * (`docs/specs/clerk-config-scheduling-chat.md` Slice E).
 *
 * The console is configured with a single shared HTTP endpoint URL for all
 * triggers — app commands, `ADDED_TO_SPACE`, `MESSAGE`, and
 * `REMOVED_FROM_SPACE` all land here. `dispatchEvent` below routes by event
 * kind; add a case there when a kind needs real handling instead of
 * restructuring this file.
 *
 * ## Two request shapes, not one
 *
 * A request from this registration passes auth, but its body has no
 * top-level `type` field, so a dispatcher keyed on `type` alone logs
 * `unrecognized event type, acknowledging as no-op { type: undefined }`.
 * This is the SAME classic-vs-add-on
 * split already documented in `chat-auth.ts`'s "Service-account identity"
 * section, now showing up a second time on the body instead of the token:
 * this app is registered as a Google Workspace add-on extending Google
 * Chat, and that registration sends a structurally different event body
 * than the classic Chat-API interaction-events console does. Google's own
 * migration guide (https://developers.google.com/workspace/add-ons/chat/convert)
 * states it plainly for the `type` field specifically: "type | N/A | The
 * event type can be deduced from the trigger." `classifyChatEvent` below is
 * the discriminator for both shapes — see its doc comment for the add-on
 * side, which has no shared field with the classic one at all.
 *
 * Rate limit — evaluated before anything else, including token
 * verification: an in-memory, per-instance, per-source-IP sliding-window
 * check (`checkChatEventsRateLimit` in `./rate-limit`). In-memory, not
 * Firestore: `verifyChatEventToken` below only does a local signature
 * check once the cert cache is warm (see that file's doc comment), so this
 * gate protects an operation that costs nothing over the network — a
 * Firestore-backed limiter would be the only billed I/O on this path.
 * Over-limit -> 429 with a constant, detail-free body. See
 * `./rate-limit`'s doc comment for the threshold and what this control
 * does and does not cover.
 *
 * Auth — every request is a Google-signed JWT, verified before anything
 * else touches the body:
 *
 *   `Authorization: Bearer <token>` — `verifyChatEventToken`
 *   (`@/lib/chat-auth`) checks signature, issuer (Google's own OIDC
 *   issuer, `https://accounts.google.com`;
 *   see that module's doc comment for why this is the correct shape),
 *   audience, expiry, AND that the token's `email` claim identifies the
 *   expected service account specifically (`email_verified` + the
 *   per-project add-on service agent, NOT
 *   `chat@system.gserviceaccount.com` — see `chat-auth.ts`'s "Service-
 *   account identity" section for why the add-on agent is correct for
 *   this app's registration) — the issuer check alone is far too weak on
 *   its own for this token shape. Any failure -> 401 with no detail about
 *   which check failed, before the request body is ever parsed. See
 *   `chat-auth.ts` for the `CHAT_EVENTS_AUDIENCE` and
 *   `CHAT_EVENTS_SERVICE_ACCOUNT_EMAIL` env vars this depends on.
 *
 * ## Identity mapping
 *
 * `ADDED_TO_SPACE` and `MESSAGE` both attempt to bind the verified sender
 * to an Arbitra user — `chat-sender.ts` extracts the identity from the
 * event, `mapChatIdentity` (`@arbitra/backend`) does the exact-match
 * lookup and idempotent write. See `dispatchEvent` below and each of those
 * modules' doc comments for the reasoning; `logChatIdentityOutcome` is the
 * only thing this ever logs about it, and it is a classified outcome
 * string, never an address, name, or message.
 *
 * ## Clerk intake (Slice F, inbound)
 *
 * On `MESSAGE`, once the sender resolves to a mapped Arbitra user AND the
 * event's text extracts cleanly (`chat-sender.ts`'s `resolveChatMessage`),
 * `attemptChatIntake` hands the message to `AssistantIntakeService` — a new
 * root Case on the conversation's first message, `intakeFollowUp` once the
 * conversation's current Case is `done`, and (again) a new root Case once it
 * is `rejected` (a dead end `intakeFollowUp` can never attach to) — via the
 * tip pointer in `@arbitra/backend`'s
 * `resolveChatThreadCase`/`recordChatThreadTip` and the terminal-status
 * check in `resolveExistingChatThreadCase` below. A conversation whose Case
 * is still genuinely in flight gets a short "still working" reply instead of
 * either path. Redelivery of a message already processed — regardless of
 * which of these branches it lands on this time — replays into the
 * original Case via `AssistantIntakeService`'s idempotency receipt; see
 * `runChatIntake`'s doc for why that holds even across a branch change. An
 * unmapped sender never reaches intake at all; it gets one polite decline
 * instead (see `attemptChatIntake`'s doc for the exact outcome-to-action
 * mapping, including the `non_human` carve-out and why `mapping_conflict`'s
 * `userId` must never be used). Outbound replies go through the real
 * `ChatReplyPoster` (`@arbitra/backend`,
 * `packages/backend/src/services/chat/chat-reply-poster.ts`) — the
 * completion hook that posts the FINAL answer back into the thread once the
 * Clerk task finishes lives separately, in
 * `packages/backend/src/services/notification/event-notifier.ts`.
 *
 * ## DM continuity and the conversation-window setting
 *
 * `resolveChatSender`'s `conversationKind` (`chat-sender.ts`, derived from
 * the Space resource's `spaceType`) decides how the tip pointer is keyed. A
 * SPACE (`conversationKind: 'space'`) is single-stage, exactly the
 * pre-existing, proven behavior, byte for byte: keyed on `message.threadName`,
 * no window ever consulted.
 *
 * A DM (`conversationKind: 'direct'`) is TWO-STAGE
 * (`resolveChatConversationLookup` below) — a Chat DM gives every message its
 * OWN thread, so neither key alone is sufficient on its own: a `thread_name`
 * key alone would open a new root Case on every single DM message (nothing
 * to attach to, ever), while a `space_name` key alone would lose an EXPLICIT
 * reply the user sent inside a specific earlier thread (see the fix this
 * paragraph documents, below).
 *
 *   1. STAGE 1 — if this message carries a thread name (it always does),
 *      look up a `thread_name` link FIRST, with NO window consulted. A HIT
 *      (a link already exists for THIS exact thread — i.e. the sender
 *      explicitly replied inside an earlier thread rather than sending a
 *      fresh top-level DM) resolves busy/ready/terminal exactly like a SPACE
 *      lookup and is used as-is: an explicit reply is the user's own intent
 *      signal overriding whatever `chat_conversation_window` habit they
 *      picked, the same way a SPACE thread reply already does today.
 *   2. STAGE 2 — only on a genuine MISS at stage 1 (a top-level DM message
 *      whose fresh thread has never been recorded) does this fall through to
 *      the pre-existing `space_name`-keyed lookup, WITH the window applied:
 *      the sender's own `chat_conversation_window` habit
 *      (`resolveUserChatConversationWindow`, `@arbitra/backend`) decides
 *      whether the space's existing tip still counts as the same
 *      conversation at all (`shouldRestartChatConversation`), evaluated
 *      BEFORE the terminal-status check so a `daily`/`idle_gap` reset always
 *      wins even over a genuinely in-flight previous Case. This stage is
 *      byte-identical to the DM behavior before this two-stage split existed.
 *
 * Change recorded here: before this fix, a DM's
 * lookup was single-stage on `space_name` only, so an explicit reply inside
 * an existing thread was indistinguishable from any other DM message and
 * still went through the window check — under the (also since-changed)
 * `per_message` default, EVERY reply restarted the conversation, silently
 * losing continuity the user had just explicitly asked to keep. Recording
 * the tip under BOTH keys on every DM turn (`recordChatThreadTip`, this
 * file's `runChatIntake`) is what makes stage 1 ever hit: a future explicit
 * reply in THIS thread now has a `thread_name` link to find. See
 * `chat-conversation-window.ts` for the per-option window semantics.
 *
 * A STAGE 2 candidate (a top-level DM message) whose text opens with a
 * "neu:"/"new:" prefix (issue #969) always starts a
 * fresh conversation instead — checked before the window habit is even
 * read, so it overrides every window setting AND any still-in-flight
 * previous case (no "still working" nudge). A STAGE 1 hit (an explicit
 * thread reply) ignores the prefix entirely; see
 * `resolveChatConversationLookup`'s doc for the exact mechanics and
 * `stripNewConversationPrefix` for the pattern.
 *
 * Card v2 / Approve-Request-changes buttons and anything else touching the
 * decision service are still out of scope here — see the spec for what
 * lands on top of this later.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Rate limit BEFORE verifyChatEventToken below. Bucketed by caller IP,
  // resolved the same way `/api/auth/connect/init` does (`resolveCallerIp`
  // — rightmost XFF entry, not client-spoofable) — no second IP-extraction
  // path for this route.
  const callerIp = resolveCallerIp(request);
  if (!checkChatEventsRateLimit(callerIp)) {
    return NextResponse.json(RATE_LIMIT_EXCEEDED_RESPONSE_BODY, { status: 429 });
  }

  const auth = await verifyChatEventToken(request);

  if (!auth.ok) {
    if (auth.reason === 'identity_mismatch') {
      // Unlike the branch below, `verifyIdToken` already SUCCEEDED by the
      // time `chat-auth.ts` returns this reason — signature, audience,
      // expiry, and issuer are all verified. `auth.aud`/`auth.iss` are
      // therefore Google-asserted, not attacker-controlled, and are logged
      // under their real names rather than `*_unverified`. `rejectedIdentity`
      // is already privacy-classified by `classifyRejectedIdentity` in
      // chat-auth.ts (verbatim only for a Google/Workspace service-account
      // domain, hashed otherwise) and `emailVerifiedState` is a boolean
      // claim, never personal — together they settle, on the next real
      // Chat message, whether the pinned service-account identity in
      // chat-auth.ts is right (see that module's doc for why it is
      // currently an inference) or whether `email_verified` is simply
      // absent from this token shape.
      console.warn('[chat/events] token verification failed', {
        reason: auth.reason,
        aud: auth.aud,
        iss: auth.iss,
        rejected_identity: auth.rejectedIdentity,
        email_verified: auth.emailVerifiedState,
      });
    } else {
      // `aud_unverified`/`iss_unverified` are the claims as CLAIMED by an
      // unauthenticated caller (`decodeUnverifiedClaims` in chat-auth.ts,
      // capped at 64 chars there) — never signature-checked at this point,
      // so an attacker fully controls them. A forged rejection line can be
      // made byte-for-byte plausible (e.g. `iss_unverified:
      // 'chat@system.gserviceaccount.com'` with any `aud_unverified` the
      // attacker likes), so this line must NEVER be read as evidence of what
      // the real audience is — that is also why the field names carry
      // `_unverified` rather than matching the trusted `aud`/`iss` used
      // above and below. Never the full token or its signature, and never
      // in the HTTP response. The only authoritative signal for the real
      // audience is this file's `identity_mismatch` branch above, built
      // from a cryptographically verified payload.
      console.warn('[chat/events] token verification failed', {
        reason: auth.reason,
        aud_unverified: auth.aud,
        iss_unverified: auth.iss,
      });
    }
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
      { status: 401 },
    );
  }

  let event: ChatEvent;
  try {
    event = (await request.json()) as ChatEvent;
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } },
      { status: 400 },
    );
  }

  if (!event || typeof event !== 'object') {
    // `JSON.parse('null')` succeeds, so the try/catch above never fires
    // for a literal `null` body — without this guard, `classifyChatEvent`
    // below throws reading `event.type` off `null` (a string/number/
    // boolean/array body does NOT throw there; `.type`/`.chat` on any of
    // those is just `undefined`, which already falls into the `default:`
    // no-op below). Deliberately an ack, not a 400: the documented
    // contract for any shape this route doesn't recognize is a clean
    // no-op (see `dispatchEvent`'s `default:` case), and Chat retries on
    // 5xx — a thrown error here would turn one malformed delivery into a
    // retry storm.
    return NextResponse.json({});
  }

  return dispatchEvent(event, request);
}


/**
 * Routes a verified Chat event by `classifyChatEvent`'s result. Every
 * branch here acknowledges with an empty 200 body — the Chat API contract
 * treats that as "no synchronous reply" — even though `ADDED_TO_SPACE` and
 * `MESSAGE` now do real work (identity mapping) before returning it. An
 * unrecognized shape (a future event kind, an add-on payload key this
 * endpoint doesn't map yet, or a console trigger this endpoint doesn't
 * handle at all) is also acknowledged rather than treated as an error,
 * since this is the one shared endpoint for every configured trigger.
 */
let hasLoggedFirstClassifiedKind = false;

/**
 * One-time diagnostic: records which kind the FIRST successfully classified
 * event resolved to. Without it a correct classification is silent — every
 * branch is a no-op returning an empty 200 — so a deploy that fixes the
 * mapping and one that does not would look identical in the log, and
 * telling them apart would cost another human sending another Chat message.
 * `ChatEventKind` is one of three fixed strings and can never carry user
 * content. Remove once real behaviour hangs off these branches.
 */
function logFirstClassifiedKindOnce(kind: ChatEventKind): void {
  if (hasLoggedFirstClassifiedKind) return;
  hasLoggedFirstClassifiedKind = true;
  console.warn('[chat/events] first classified event', { kind });
}

async function dispatchEvent(event: ChatEvent, request: NextRequest): Promise<NextResponse> {
  const kind = classifyChatEvent(event);
  if (kind) logFirstClassifiedKindOnce(kind);
  switch (kind) {
    case 'ADDED_TO_SPACE':
      // On the add-on shape, an install via @mention or slash command fires
      // a SECOND event (a messagePayload one) right after this — that is
      // exactly why `attemptChatIdentityMapping` -> `mapChatIdentity` is
      // idempotent per sender rather than "first event wins" (see that
      // function's doc).
      await attemptChatIdentityMapping(event);
      return NextResponse.json({});
    case 'REMOVED_FROM_SPACE':
      return NextResponse.json({});
    case 'MESSAGE':
      // Some installs never fire ADDED_TO_SPACE (e.g. a direct DM with no
      // explicit add step), so MESSAGE is the second trigger point the
      // spec calls for. `attemptChatIntake` below does its OWN identity
      // mapping attempt (unconditionally, same rationale as this comment
      // used to state: `mapChatIdentity` already collapses to one read and
      // no write once a sender is mapped) and then, only for a mapped
      // sender with cleanly extracted text, hands off to
      // `AssistantIntakeService` (Slice F). Card v2 / decision buttons are
      // still out of scope — see the module doc above. The completion hook
      // that posts the final answer back into the thread lives separately,
      // in `EventNotifier` (not this route).
      await attemptChatIntake(event, request);
      return NextResponse.json({});
    default:
      logUnrecognizedEventShape(event);
      return NextResponse.json({});
  }
}

/** What `attemptChatIdentityMapping` learned about the sender of one event. */
interface ChatIdentityAttempt {
  sender: ChatSenderResolution;
  /** Present only when `sender.status === 'resolved'` (mapChatIdentity was attempted). */
  outcome?: ChatIdentityMappingOutcome | 'mapping_error';
  /**
   * Set whenever `mapChatIdentity` returns a `userId`, regardless of
   * `outcome` — this is NOT gated on `outcome === 'mapped' /
   * 'mapped_idempotent'` here. For `mapping_conflict` specifically, the
   * value names a DIFFERENT Arbitra account than the sender (see
   * `chat-identity-service.ts`'s CRITICAL note); safety comes from every
   * caller checking `outcome` before ever reading `.userId` (see
   * `attemptChatIntake`, which declines and returns before it would reach
   * its own read of this field), not from this field being withheld.
   */
  userId?: string;
}

/**
 * Resolves the verified event's sender (`chat-sender.ts`) and, if it
 * resolves, attempts the exact-match mapping (`mapChatIdentity` in
 * `@arbitra/backend`) — see that function's doc for the matching rule, the
 * idempotency guarantee, and its two deliberate design decisions.
 *
 * Never throws: a Firestore error here must not turn one Chat delivery
 * into a 5xx retry storm, so any failure collapses into the same
 * `mapping_error` outcome as every other "stayed unmapped" case — the
 * caller (`dispatchEvent`) always still returns its empty 200.
 */
async function attemptChatIdentityMapping(event: ChatEvent): Promise<ChatIdentityAttempt> {
  const sender = resolveChatSender(event);
  if (sender.status === 'unresolved') {
    logChatIdentityOutcome(sender.reason);
    // The identity path (`chat.user`) comes from Google's add-on docs and
    // samples, NOT from anything verified against live payloads.
    // The classic-vs-add-on split has already differed three times here
    // (audience, sender identity, event envelope), so assume a fourth. The
    // reason alone says the identity was not where we looked; this says
    // where it actually is, turning a wrong guess into a one-message fix
    // instead of a deploy cycle. Key paths and array lengths only — never
    // a value; see `summarizePayloadShape`.
    console.warn('[chat/events] identity shape', summarizePayloadShape(event));
    return { sender };
  }
  try {
    const result = await mapChatIdentity({
      chatUserId: sender.chatUserId,
      spaceName: sender.spaceName,
      email: sender.email,
    });
    logChatIdentityOutcome(result.outcome);
    return { sender, outcome: result.outcome, userId: result.userId };
  } catch {
    logChatIdentityOutcome('mapping_error');
    return { sender, outcome: 'mapping_error' };
  }
}

/**
 * Short, jargon-free copy for a sender Clerk cannot act for. Deliberately
 * says nothing about WHICH check failed (no email on the event? no
 * matching account? two matching accounts? a conflicting existing mapping?
 * a structurally unreadable sender?) — collapsing all five into one message
 * is what keeps this from ever confirming or denying that a given address
 * has an Arbitra account (see `attemptChatIntake`'s doc).
 *
 * Deliberately left in English (alongside `CHAT_INTAKE_BUSY_TEXT` below and
 * `buildChatIntakeAckText`'s no-`shareUrl` branch): there is no case yet at
 * this point — Clerk never ran, so there is no answer to draw a language
 * from and no case-language setting to fall back to either. Unlike the
 * ack/completion frames, this text IS the entire message; going bare (a
 * marker with no link, since there is no case to link to) would drop the
 * only information the sender needs to act on. Kept short instead.
 */
const CHAT_INTAKE_DECLINE_TEXT =
  "I can't match your Google account to an Arbitra user, so I can't start a task from this message. "
  + 'Ask an Arbitra admin to connect your Google account, then message me again.';

/**
 * Neutral marker + bare case link — no English sentence and no verb.
 *
 * Clerk answers in the requester's own language (the assistant system
 * prompt instructs it to), so a hardcoded English ack sentence ("Got it —
 * tracking this as an Arbitra case…") would read wrong for a non-English
 * requester. There is no language detection; the language-bearing prose is
 * omitted instead — the link is all the ack needs to carry, and 🔗 reads
 * the same regardless of the requester's language (the same marker idiom
 * `GoogleChatNotifier`'s `formatMessage` already uses for a link line).
 *
 * The no-`shareUrl` branch (no public base URL configured to build a link
 * from) has no link to attach a marker to, so it keeps a short English
 * fallback — an edge case that needs a public base URL misconfigured to
 * ever trigger, not the language-bearing frame this fix targets.
 */
function buildChatIntakeAckText(shareUrl: string | null): string {
  return shareUrl
    ? `🔗 ${shareUrl}`
    : "Got it. I'll reply here once it's done.";
}

/**
 * Short, jargon-free nudge for a message that arrives while the thread's
 * Case is genuinely still in flight (`ChatThreadCaseLookup`'s `'busy'`
 * state). Posted so the message is never silently dropped with no signal to
 * the sender at all.
 *
 * Deliberately left in English — same reasoning as
 * `CHAT_INTAKE_DECLINE_TEXT` above: there is no fresh Clerk-authored text
 * on this path to draw a language from (the in-flight run hasn't produced
 * one yet), and the message itself carries no link to fall back to a bare
 * marker. Kept short instead.
 */
const CHAT_INTAKE_BUSY_TEXT =
  "Still working on your previous message in this thread. I'll reply here once it's done.";

/**
 * Posts `CHAT_INTAKE_DECLINE_TEXT` into the sender's space (and thread,
 * when the inbound message resolved one), swallowing any failure — a
 * failed decline must never turn into a 5xx any more than a failed intake
 * would. `spaceNameOverride` is supplied on the mapChatIdentity-outcome
 * branches, where `resolveChatSender` already succeeded; when the SENDER
 * itself was unresolved there is no validated space to read from that
 * function's result, so this falls back to `readFallbackSpaceName`'s
 * best-effort, independent read of `chat.space.name` — and if even that
 * comes up empty, there is nowhere to reply, so this logs and does nothing
 * rather than throw.
 */
async function declineUnmatchedChatSender(
  event: ChatEvent,
  message: ChatMessageResolution,
  spaceNameOverride?: string,
): Promise<void> {
  const spaceName = spaceNameOverride ?? readFallbackSpaceName(event);
  if (!spaceName) {
    console.warn('[chat/events] cannot post decline: no space name resolvable');
    return;
  }
  const threadName = message.status === 'resolved' ? message.threadName : undefined;
  try {
    const result = await getChatReplyPoster().post({ spaceName, threadName }, CHAT_INTAKE_DECLINE_TEXT);
    if (!result.ok) {
      console.warn('[chat/events] decline reply not delivered', { reason: result.reason });
    }
  } catch {
    console.warn('[chat/events] decline reply post threw');
  }
}

/**
 * Slice F inbound entry point, called once per `MESSAGE` event
 * (`docs/specs/clerk-config-scheduling-chat.md`). Never throws — every
 * branch below is wrapped so a Firestore hiccup, a rejected
 * `AssistantIntakeService` call, or a failed outbound reply degrades to a
 * logged warning, never a 5xx (`dispatchEvent` always still acks 200).
 *
 * Outcome-to-action mapping, most specific first:
 *   - `sender.status === 'unresolved'` with reason `non_human`: silently
 *     ignored, NOT declined. Every other unresolved reason still gets the
 *     polite decline below. This carve-out exists because this app's own
 *     bot alias (`users/app`) is exactly the kind of sender `non_human`
 *     fails closed on — declining to it would risk a bot-reply-to-bot loop.
 *     Every other unresolved reason (missing envelope/user/space, a
 *     deleted/anonymized profile) still gets the SAME decline as an
 *     identity-mapping miss, per this slice's explicit test contract; see
 *     the PR description for why that uniform treatment (rather than also
 *     narrowing those) was kept as specified rather than second-guessed.
 *   - `mapChatIdentity` outcome `no_email` / `no_match` / `ambiguous_match`
 *     / `mapping_conflict`: one polite decline, and intake is never
 *     attempted. `mapping_conflict`'s `userId` names a DIFFERENT account
 *     than the sender (see `chat-identity-service.ts`) and is never read.
 *   - outcome missing or `mapping_error`: an infrastructure hiccup, not an
 *     identity verdict — telling the sender "you're not matched" would be
 *     actively wrong, so this logs (already done by
 *     `attemptChatIdentityMapping`) and does nothing user-facing.
 *   - `mapped` / `mapped_idempotent` but the message text did not extract
 *     (`resolveChatMessage` unresolved): logged, no decline (the SENDER is
 *     fine; the payload shape is the unknown here) and no intake.
 *   - `mapped` / `mapped_idempotent` with resolved text: handed to
 *     `runChatIntake`.
 */
async function attemptChatIntake(event: ChatEvent, request: NextRequest): Promise<void> {
  const message = resolveChatMessage(event);
  const identity = await attemptChatIdentityMapping(event);
  const { sender, outcome } = identity;

  if (sender.status === 'unresolved') {
    if (sender.reason !== 'non_human') {
      await declineUnmatchedChatSender(event, message);
    }
    return;
  }

  if (!outcome || outcome === 'mapping_error') {
    return;
  }

  if (outcome !== 'mapped' && outcome !== 'mapped_idempotent') {
    await declineUnmatchedChatSender(event, message, sender.spaceName);
    return;
  }

  const userId = identity.userId;
  if (!userId) {
    // Defensive: `mapChatIdentity`'s contract always sets `userId` alongside
    // 'mapped' / 'mapped_idempotent'. A violated contract should not crash
    // the webhook either — see this function's "never throws" doc above.
    return;
  }

  if (message.status === 'unresolved') {
    console.warn('[chat/events] message shape', summarizePayloadShape(event));
    return;
  }

  await runChatIntake(event, request, userId, sender, message);
}

/**
 * Resolution of "does this Chat conversation already have a Clerk case",
 * for the root-vs-follow-up decision in `runChatIntake`.
 *
 * `'busy'` is a deliberate third state, not folded into `'none'`: the
 * conversation has a Case that is genuinely still in flight (any
 * non-terminal `CaseStatus`), but `AssistantFollowUpService.resolveParentLink`
 * (called inside `intakeFollowUp`) only accepts a parent whose `status` is
 * `'done'` — attaching to a still-running task is invalid there, and
 * treating this message as a brand NEW root instead would silently split
 * one conversation into two Cases. `runChatIntake` never drops a `'busy'`
 * message silently: it replies with a short "still working" nudge instead
 * (see that function).
 *
 * `TERMINAL_CASE_STATUSES` (`done`, `rejected`) are both excluded from
 * `'busy'`, but resolve differently: `'done'` is `'ready'` (the case can
 * receive a follow-up), while `'rejected'` — a dead end
 * `resolveParentLink` can never accept as a parent — resolves to `'none'`,
 * the same as no link at all, so the next message starts a fresh root Case
 * rather than being dropped forever.
 */
type ChatThreadCaseLookup =
  | { status: 'none' }
  | { status: 'busy'; caseId: string }
  | { status: 'ready'; caseId: string };

/**
 * One conversation's continuity key — WHICH coordinate a tip pointer is
 * keyed on. A SPACE lookup only ever uses one: `thread_name` (unchanged). A
 * DM now uses BOTH kinds at once — a `space_name` key (the window-governed
 * fallback) and, when this message carries a thread, a `thread_name` key
 * (the explicit-reply fast path and, after every DM turn, a tip recorded
 * under it for a future reply to find) — see `resolveChatConversationLookup`
 * and this file's module doc for the two-stage DM algorithm. Kept as one
 * small object rather than two loose strings so a lookup or a
 * `recordChatThreadTip` call site can never accidentally pass the wrong kind
 * alongside the right key or vice versa.
 */
interface ChatContinuityKey {
  keyKind: ChatContinuityKeyKind;
  key: string;
}

/**
 * Resolves the SPACE continuity key for a mapped sender's message: keyed on
 * `message.threadName`, exactly the pre-existing behavior — `undefined` when
 * the event carried no thread, same as before, which `runChatIntake` treats
 * as "no lookup possible", not an error.
 *
 * A DM's continuity keys are resolved separately, by
 * `resolveChatConversationLookup` below — a DM needs a `space_name` key AND
 * (when present) a `thread_name` key at the same time for its two-stage
 * lookup and its dual tip recording, which this single-key function has no
 * way to express.
 */
function resolveSpaceContinuityKey(message: ResolvedChatMessage): ChatContinuityKey | undefined {
  return message.threadName ? { keyKind: 'thread_name', key: message.threadName } : undefined;
}

/**
 * Shared busy/ready/terminal-status resolution for an ALREADY-FETCHED tip
 * link — factored out of `resolveExistingChatThreadCase` below so the DM
 * explicit-thread-reply path (`resolveChatConversationLookup`) can reuse the
 * exact same handling (`done` -> `ready`, `rejected` -> `none`, a dangling
 * pointer -> `none`) after fetching its OWN `thread_name` link directly,
 * without ever passing a `windowContext` — an explicit reply's continuity
 * does not depend on the sender's `chat_conversation_window` habit at all
 * (see this file's module doc).
 *
 * The window check, when a caller does supply one, runs BEFORE the
 * terminal-status check, and — when it says to restart — short-circuits
 * straight to `'none'` without ever reading the pointed-to Case's status at
 * all: a `daily`/`idle_gap` reset is a hard boundary the user explicitly
 * opted into, and must win even over a genuinely in-flight previous Case
 * (the alternative — still nudging "still working" across a boundary the
 * user asked to reset on — is exactly the surprising behavior this feature
 * exists to avoid). `'continuous'` and `'per_message'` are themselves
 * unconditional (never / always restart), so for those two
 * `shouldRestartChatConversation` never even inspects the timestamps.
 */
async function resolveChatThreadCaseStatus(
  link: ChatContinuityLink,
  windowContext?: { window: ChatConversationWindow; timeZoneId?: string },
): Promise<ChatThreadCaseLookup> {
  if (
    windowContext
    && shouldRestartChatConversation(windowContext.window, link.updatedAt, new Date().toISOString(), windowContext.timeZoneId)
  ) {
    return { status: 'none' };
  }

  const caseId = link.caseId;
  try {
    const existing = await caseService.getCase(caseId);
    if (existing.status === 'done') return { status: 'ready', caseId };
    if (TERMINAL_CASE_STATUSES.has(existing.status)) {
      // Terminal but not `done` (currently only `rejected`): a dead end the
      // requester cannot continue via `intakeFollowUp`, which requires a
      // `done` parent. Treated exactly like no link at all so the next
      // message starts a fresh root Case instead of being dropped — see
      // `ChatThreadCaseLookup`'s doc comment above.
      return { status: 'none' };
    }
    return { status: 'busy', caseId };
  } catch {
    // Dangling pointer (the Case was deleted, or a transient read error) —
    // treated exactly like "no link yet": the next message starts a new
    // root. See `chat-thread-link-service.ts`'s doc for why a stale or
    // missing pointer is accepted routing slack, not a correctness bug.
    return { status: 'none' };
  }
}

/**
 * Reads ONE continuity key's tip pointer and turns it into a
 * root-vs-follow-up lookup — fetch-then-resolve, thin wrapper around
 * `resolveChatThreadCaseStatus` above. `windowContext` is supplied ONLY for
 * a DM's space-keyed (stage 2) lookup; a SPACE lookup never passes one, so
 * its behavior is exactly the pre-existing thread-keyed algorithm,
 * unchanged.
 */
async function resolveExistingChatThreadCase(
  continuityKey: ChatContinuityKey,
  windowContext?: { window: ChatConversationWindow; timeZoneId?: string },
): Promise<ChatThreadCaseLookup> {
  const link = await resolveChatThreadCase(continuityKey.keyKind, continuityKey.key);
  if (!link) return { status: 'none' };
  return resolveChatThreadCaseStatus(link, windowContext);
}

/**
 * Matches a "start a new conversation" prefix at the very start of a Chat
 * DM message — `neu:` or `new:`, case-insensitive, tolerating leading
 * whitespace before the word and after the colon (issue #969). The colon is REQUIRED and sits directly after the
 * bare word with no gap: `(?:neu|new):` cannot match "neue Cases zeigen"
 * (German "neue" is never followed by a colon), so an ordinary sentence
 * that happens to start with that syllable is never mistaken for the
 * command. No `m` flag — `^` anchors to the absolute start of the whole
 * string, not per line, matching "the very start of the message text".
 *
 * Known trade-off: a message whose CONTENT legitimately starts with the
 * same shape — say, a forwarded subject line "New: pricing update" — is
 * indistinguishable from the command, gets stripped, and starts a new
 * conversation. Accepted deliberately: the collision is rare, harmless
 * (the question is still answered, just without prior context), and the
 * alternative — a stricter marker nobody remembers — defeats the point.
 */
const NEW_CONVERSATION_PREFIX_PATTERN = /^\s*(?:neu|new):\s*/i;

/**
 * Returns the message text with a matched `NEW_CONVERSATION_PREFIX_PATTERN`
 * removed, or `undefined` when the text does not start with the prefix at
 * all. The remainder can be an empty string (e.g. the message was just
 * "neu:") — callers must check for `undefined` specifically, not falsiness,
 * to tell "no prefix" apart from "prefix with nothing after it".
 */
function stripNewConversationPrefix(text: string): string | undefined {
  const match = NEW_CONVERSATION_PREFIX_PATTERN.exec(text);
  return match ? text.slice(match[0].length) : undefined;
}

/**
 * Result of `resolveChatConversationLookup` below: the root-vs-follow-up
 * verdict plus every continuity key `runChatIntake` needs afterward to
 * record the tip (Change 2). `spaceKey` is set only
 * for a DM (always — a resolved sender's `spaceName` is never empty);
 * `threadKey` is set whenever the message itself carries a thread name,
 * for EITHER conversation kind (a SPACE's one-and-only key, or a DM's
 * second, dual-recorded key). `taskText` is the text `runChatIntake` should
 * actually store — `message.text` unchanged in every case EXCEPT a DM
 * top-level message whose text opened with the "neu:"/"new:" prefix
 * (issue #969), where it is that text with the prefix stripped.
 */
interface ChatConversationLookup {
  lookup: ChatThreadCaseLookup;
  spaceKey?: ChatContinuityKey;
  threadKey?: ChatContinuityKey;
  taskText: string;
}

/**
 * Resolves ONE message's root-vs-follow-up lookup, branching on
 * `sender.conversationKind` — see this file's module doc for the full
 * two-stage DM algorithm this implements.
 *
 * SPACE: byte-identical to the pre-existing algorithm — a single
 * `thread_name`-keyed lookup, no window ever consulted.
 *
 * DM: two-stage.
 *   STAGE 1 — when this message carries a thread name (it always does; a
 *   Chat DM gives every message its own thread), look up a `thread_name`
 *   link FIRST, with no window context. A HIT (a link already exists for
 *   THIS exact thread, written by a PRIOR turn's dual tip-record — see
 *   `runChatIntake`) resolves busy/ready/terminal via
 *   `resolveChatThreadCaseStatus` and is returned immediately: STAGE 2 never
 *   runs, and `resolveUserChatConversationWindow` is never even called, so
 *   an explicit reply's continuity truly cannot be affected by the sender's
 *   window habit. `taskText` is `message.text` UNCHANGED here even when it
 *   carries the "neu:"/"new:" prefix — an explicit reply inside an already
 *   linked thread is the user's own continuity signal (#962) and wins
 *   regardless of the message's wording; only a genuinely top-level message
 *   (STAGE 2 below) can start a fresh conversation via the prefix.
 *   STAGE 2 — only on a genuine MISS at stage 1 (no `thread_name` link was
 *   ever recorded for this thread — a top-level DM message) does this fall
 *   through to the pre-existing `space_name`-keyed lookup, window context
 *   included. Byte-identical to this DM's pre-existing (single-stage)
 *   behavior — UNLESS the message text opens with the "neu:"/"new:" prefix
 *   (issue #969): that case is checked FIRST, before the window habit is
 *   even read, and short-circuits straight to `{ status: 'none' }` — a
 *   deliberate fresh root — without ever calling
 *   `resolveUserChatConversationWindow` or `resolveExistingChatThreadCase`.
 *   That is what makes the prefix win over BOTH a `continuous`/`daily`
 *   window habit AND a still-in-flight previous case (which would otherwise
 *   produce a "still working" nudge instead of a new conversation) — either
 *   would defeat the whole point of an explicit "start fresh" request.
 *   `spaceKey`/`threadKey` are still returned so `runChatIntake` records
 *   both tip pointers exactly as it would for any other DM root case; only
 *   the WINDOW LOOKUP is skipped, not the dual tip-recording it feeds once
 *   the new root case exists.
 */
async function resolveChatConversationLookup(
  sender: ResolvedChatSender,
  message: ResolvedChatMessage,
  actorId: string,
  event: ChatEvent,
): Promise<ChatConversationLookup> {
  if (sender.conversationKind !== 'direct') {
    const threadKey = resolveSpaceContinuityKey(message);
    const lookup = threadKey ? await resolveExistingChatThreadCase(threadKey) : ({ status: 'none' } as const);
    return { lookup, threadKey, taskText: message.text };
  }

  const spaceKey: ChatContinuityKey = { keyKind: 'space_name', key: sender.spaceName };
  const threadKey: ChatContinuityKey | undefined = message.threadName
    ? { keyKind: 'thread_name', key: message.threadName }
    : undefined;

  if (threadKey) {
    const threadLink = await resolveChatThreadCase(threadKey.keyKind, threadKey.key);
    if (threadLink) {
      return { lookup: await resolveChatThreadCaseStatus(threadLink), spaceKey, threadKey, taskText: message.text };
    }
  }

  const newConversationText = stripNewConversationPrefix(message.text);
  if (newConversationText !== undefined) {
    return { lookup: { status: 'none' }, spaceKey, threadKey, taskText: newConversationText };
  }

  const windowContext = {
    window: await resolveUserChatConversationWindow(actorId),
    timeZoneId: readCommonEventTimeZone(event),
  };
  return {
    lookup: await resolveExistingChatThreadCase(spaceKey, windowContext),
    spaceKey,
    threadKey,
    taskText: message.text,
  };
}

/**
 * THIS message's own Chat coordinates, as an `AssistantIntakeChatContext`
 * block — identical shape for `intake()` and `intakeFollowUp()`, and
 * deliberately built from `sender`/`message` (the CURRENT delivery), never
 * from anything on a parent case. A DM's every message has its own thread,
 * and even inside a space a follow-up sits in the same thread as the
 * message that produced it — either way, this delivery's own values are
 * always the correct reply target, so a follow-up case must never inherit
 * its parent's `space_name`/`thread_name` instead of stamping its own (see
 * `AssistantIntakeService.intakeFollowUp`'s and
 * `EventNotifier.notifyChatThreadOutcome`'s docs for why a missing chat
 * block on a follow-up case means its completion reply silently never
 * posts).
 */
function buildChatContextForMessage(
  sender: ResolvedChatSender,
  message: ResolvedChatMessage,
): {
  space_name: string;
  thread_name?: string;
  source_message_name: string;
  chat_user_name: string;
  conversation_visibility: 'direct' | 'space';
} {
  return {
    space_name: sender.spaceName,
    ...(message.threadName ? { thread_name: message.threadName } : {}),
    source_message_name: message.sourceMessageName,
    chat_user_name: sender.chatUserId,
    conversation_visibility: sender.conversationKind,
  };
}

/**
 * Runs the intake decision for a sender already confirmed mapped, with
 * cleanly extracted message text. Never throws: wrapped end to end so a
 * Firestore hiccup, a rejected `AssistantIntakeService` call, or a failed
 * reply post all degrade to a logged warning.
 *
 * Idempotency: `message.sourceMessageName` (the Chat message's own
 * resource name, `chat.messagePayload.message.name`) is passed as
 * `idempotency_key` — this is what collapses Chat's at-least-once delivery
 * retries onto exactly one Case, per `AssistantIntakeService`'s own
 * contract for the `google_chat` channel. It is NOT the same value as a
 * continuity key (`resolveChatConversationLookup`): the message name
 * identifies THIS delivery, a continuity key identifies the CONVERSATION,
 * and only the continuity key(s) are used for the root-vs-follow-up routing
 * decision below.
 *
 * The root-vs-follow-up decision itself is read from the conversation's
 * MUTABLE pointer (`resolveExistingChatThreadCase`) on every single
 * delivery, so a redelivery of the exact same message can land on a
 * different branch than its first delivery did (e.g. the case reached
 * `done` in between). That is exactly why the `intakeFollowUp` call below
 * passes `channel: 'google_chat'` — so its receipt lands in the same
 * namespace `intake()` would use for this message, and a redelivery
 * replays into the ORIGINAL case no matter which branch it is routed
 * through this time. See `AssistantIntakeService.intakeFollowUp`'s doc for
 * the full reasoning. Both branches also pass `chat:
 * buildChatContextForMessage(sender, message)` — THIS delivery's own reply
 * target, not the parent's — so a `google_chat` follow-up case gets a
 * `space_name`/`thread_name` in its `assistant_context` exactly like a root
 * case does, and its completion can actually post back into the thread.
 *
 * The tip pointer(s) (`recordChatThreadTip`) are written only when
 * `result.replayed` is `false` — see that function's own doc for why
 * writing it again on a replay would risk rolling the pointer backward.
 * The same `!result.replayed` guard gates the ack reply, so a duplicate
 * delivery of an already-processed message produces no second message in
 * the Chat thread.
 *
 * For a DM specifically, BOTH continuity keys are recorded on every
 * non-replayed turn — `spaceKey` (window continuity, as before this fix)
 * AND `threadKey` for THIS message's own thread (Change 2) — both pointing at the same `(rootCaseId, caseId)`, so a FUTURE
 * explicit reply inside this exact thread has a `thread_name` link to hit
 * at `resolveChatConversationLookup`'s stage 1. The completion reply posts
 * into the question's own thread (`message.threadName`, below), so the
 * thread the user later replies in IS this same `threadKey` — no extra
 * mapping is needed to make that reply resolvable. A SPACE keeps recording
 * exactly one `thread_name` link, unchanged.
 */
async function runChatIntake(
  event: ChatEvent,
  request: NextRequest,
  actorId: string,
  sender: ResolvedChatSender,
  message: ResolvedChatMessage,
): Promise<void> {
  try {
    const { lookup, spaceKey, threadKey, taskText } = await resolveChatConversationLookup(sender, message, actorId, event);

    if (lookup.status === 'busy') {
      // Genuinely in flight (never `rejected` — see `resolveExistingChatThreadCase`
      // above, which routes that terminal status to `'none'` instead). Never
      // silently swallowed: reply once so the sender knows the message
      // landed, rather than getting no signal at all.
      console.warn('[chat/events] thread has a Clerk task in flight; replying instead of starting a new case');
      try {
        const postResult = await getChatReplyPoster().post(
          { spaceName: sender.spaceName, threadName: message.threadName },
          CHAT_INTAKE_BUSY_TEXT,
        );
        if (!postResult.ok) {
          console.warn('[chat/events] busy reply not delivered', { reason: postResult.reason });
        }
      } catch {
        console.warn('[chat/events] busy reply post threw');
      }
      return;
    }

    // `text: taskText` — `message.text` UNCHANGED except for a DM top-level
    // message that opened with the "neu:"/"new:" prefix (issue #969), where
    // `resolveChatConversationLookup` already stripped it; see that
    // function's doc. `idempotency_key` stays `message.sourceMessageName`
    // (THIS delivery's own Chat message resource name) regardless — the
    // receipt key must never change with the stored text, and a redelivery
    // of the identical raw message (prefix and all) must still replay into
    // the same case.
    const result = lookup.status === 'ready'
      ? await intakeService.intakeFollowUp(
          {
            text: taskText,
            idempotency_key: message.sourceMessageName,
            channel: 'google_chat',
            chat: buildChatContextForMessage(sender, message),
          },
          actorId,
          lookup.caseId,
        )
      : await intakeService.intake(
          {
            text: taskText,
            channel: 'google_chat',
            idempotency_key: message.sourceMessageName,
            chat: buildChatContextForMessage(sender, message),
          },
          actorId,
        );

    // Fire-and-forget, same idiom as `/api/assistant/tasks`'s POST handler
    // — never awaited, so a slow or dead executor can never delay this
    // webhook's response.
    if (result.run) {
      scheduleAssistantRunDispatch(result.case, result.run);
    }

    if (result.replayed) return;

    if (spaceKey || threadKey) {
      const rootCaseId = result.case.assistant_thread?.root_case_id ?? result.case.case_id;
      // `spaceKey` is set only for a DM (see `ChatConversationLookup`'s
      // doc), so this writes ONE link for a SPACE (its sole `threadKey`)
      // and BOTH links for a DM — the dual-key record this fix adds.
      if (spaceKey) {
        await recordChatThreadTip(spaceKey.keyKind, spaceKey.key, rootCaseId, result.case.case_id);
      }
      if (threadKey) {
        await recordChatThreadTip(threadKey.keyKind, threadKey.key, rootCaseId, result.case.case_id);
      }
    }

    const shareUrl = resolveCaseShareUrl(request, result.case.case_id, result.case.status);
    try {
      const postResult = await getChatReplyPoster().post(
        { spaceName: sender.spaceName, threadName: message.threadName },
        buildChatIntakeAckText(shareUrl),
      );
      if (!postResult.ok) {
        console.warn('[chat/events] ack reply not delivered', { reason: postResult.reason });
      }
    } catch {
      console.warn('[chat/events] ack reply post threw');
    }
  } catch {
    // Classification-only: never log the caught error's message here.
    // `AssistantIntakeService` errors (e.g. an unprovisioned Clerk core,
    // or an empty-text ValidationError — genuinely reachable via a bare
    // "neu:"/"new:" message, whose stripped remainder is empty even though
    // `resolveChatMessage` guarantees the RAW text was not) carry no Chat
    // payload content today, but a defensive log line in this file must hold to
    // the same "never a value" discipline as `logUnrecognizedEventShape`
    // regardless.
    console.warn('[chat/events] chat intake failed');
  }
}

/**
 * Logs the classified identity-mapping outcome only — never
 * `chat.user.name`, an email, a display name, or a space name. See
 * `chat-sender.ts`'s `ChatSenderUnresolvedReason` and
 * `chat-identity-service.ts`'s `ChatIdentityMappingOutcome` for what each
 * string means; `mapping_error` is added here for the try/catch above.
 */
function logChatIdentityOutcome(outcome: string): void {
  console.warn('[chat/events] identity mapping outcome', { outcome });
}

/**
 * Logs a privacy-safe, STRUCTURE-ONLY diagnostic for an event this
 * dispatcher doesn't recognize. Replaces the previous `{ type: event.type
 * }` diagnostic, which degenerated to `{ type: undefined }` for every real
 * add-on event (see this file's module doc) and gave no way to tell which
 * of the six add-on payload keys — or some entirely new shape — actually
 * arrived. See `summarizePayloadShape`'s doc for why only key paths and
 * array lengths are ever logged, never a value.
 */
function logUnrecognizedEventShape(event: ChatEvent): void {
  const { keyPaths, truncated } = summarizePayloadShape(event);
  console.warn('[chat/events] unrecognized event shape, acknowledging as no-op', {
    keyPaths,
    truncated,
  });
}
