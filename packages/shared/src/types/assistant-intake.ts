/**
 * Entry points an assistant task can be requested through.
 *
 * `web` is the authenticated in-app route (`POST /api/assistant/tasks`).
 * `google_chat` is the Chat entry point, which is NOT built yet — when it
 * lands it calls the same `AssistantIntakeService`, differing only in the
 * channel it declares and in the idempotency key it supplies (the Chat message
 * name). There is deliberately no second intake path.
 * `blueprint` is a Task Blueprint occurrence (`docs/specs/clerk-config-scheduling-chat.md`
 * Slice B, #793): the run-now route and, once slice B2 lands, the cron tick
 * service both call this same `intake()` with `channel: 'blueprint'` and an
 * idempotency key derived from `(blueprint_id, blueprint_version, occurrence_iso)`.
 */
export const ASSISTANT_INTAKE_CHANNELS = ['web', 'google_chat', 'blueprint'] as const;

export type AssistantIntakeChannel = (typeof ASSISTANT_INTAKE_CHANNELS)[number];

/** Google-Chat coordinates, supplied only by the Chat entry point. */
export interface AssistantIntakeChatContext {
  space_name?: string;
  thread_name?: string;
  source_message_name?: string;
  chat_user_name?: string;
  conversation_visibility?: 'direct' | 'space';
}

/**
 * Blueprint provenance, supplied only by the `blueprint` entry point
 * (run-now today; the B2 tick service later). Carried on the request rather
 * than written as a second Firestore call after intake so the snapshot lands
 * atomically with case creation — see `buildCreateCaseInput` in
 * `assistant-intake-service.ts`.
 */
export interface AssistantIntakeBlueprintContext {
  blueprint_id: string;
  blueprint_version: number;
  prompt_text: string;
}

/** Request accepted by `AssistantIntakeService.intake`. */
export interface AssistantIntakeRequest {
  /** The task as the requester wrote it. Length-capped server-side. */
  text: string;
  /** Defaults to `web`. */
  channel?: AssistantIntakeChannel;
  /**
   * Caller-supplied de-duplication key, scoped to (channel, requester). Two
   * requests carrying the same key resolve to the same case — the second one
   * creates nothing. The Chat entry point passes the message name here; the
   * blueprint entry point passes `blueprint:{blueprint_id}:{version}:{occurrence_iso}`.
   */
  idempotency_key?: string;
  chat?: AssistantIntakeChatContext;
  blueprint?: AssistantIntakeBlueprintContext;
}

/** Browser request for a new immutable turn after a completed Clerk task. */
export interface AssistantFollowUpRequest {
  text: string;
  /** Required so a retry cannot create another child Case. */
  idempotency_key: string;
  /**
   * Defaults to `web`. Only a server-side caller can set this — the
   * `strict()` web-route schema (`webAssistantFollowUpSchema`) has no such
   * field, so an untrusted body can never supply one. The Chat entry point
   * passes `google_chat` so its key is not re-scoped to the parent Case —
   * see `AssistantIntakeService.intakeFollowUp`'s doc for why a channel
   * whose key is already globally unique must skip that scoping.
   */
  channel?: AssistantIntakeChannel;
  /**
   * Google-Chat coordinates for THIS follow-up message's own reply target.
   * Only a server-side caller can set this — same as `channel`, the browser
   * schema has no such field. The Chat entry point
   * (`packages/frontend/src/app/api/chat/events/route.ts`) passes the
   * CURRENT message's own space/thread here, never the parent case's: a DM
   * follow-up sits in its own thread, and even inside a space the completion
   * has to post where THIS message landed. `AssistantIntakeService.intakeFollowUp`
   * persists it onto the child case's `assistant_context` exactly like
   * `intake()` does, so `EventNotifier`'s completion hook
   * (`notifyChatThreadOutcome`) has a reply target for follow-up cases too.
   */
  chat?: AssistantIntakeChatContext;
}

/** One chronological row returned by the dedicated Clerk thread endpoint. */
export interface AssistantThreadTurn {
  case_id: string;
  title: string;
  request: string;
  status: import('./case.js').CaseStatus;
  created_at: string;
  updated_at: string;
  depth: number;
  parent_case_id?: string;
  answer_preview?: string;
}

export interface AssistantThreadResponse {
  root_case_id: string;
  turns: AssistantThreadTurn[];
}

/**
 * Idempotency receipt for one accepted intake. The doc id is derived from
 * (channel, requester, key) — see `assistantIntakeReceiptId` — so the receipt
 * is looked up by computing its id, never by querying, which is what lets the
 * check happen inside the intake transaction.
 */
export interface AssistantIntakeReceipt {
  receipt_id: string;
  channel: AssistantIntakeChannel;
  requester_user_id: string;
  /** The raw key the id was derived from, kept for debugging and audit. */
  idempotency_key: string;
  /** The case the first request created. A replay returns this case. */
  case_id: string;
  /** The run the first request created, so a replay can report it without a read. */
  run_id: string;
  event_id: string;
  created_at: string;
  /**
   * `created_at` + retention window. A Firestore TTL policy on this field has
   * to be configured manually (same as `device_codes`) — until then the field
   * is documentation of intended retention, not an active cleanup.
   */
  expires_at: string;
}
