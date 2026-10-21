export type UserRole = 'developer' | 'reviewer' | 'tech_lead' | 'admin';

/**
 * Closed set of DM continuity habits a user can pick for their 1:1 Google
 * Chat conversation with Clerk (feature: chat DM conversation window).
 * Deliberately closed rather than a free-form duration — see
 * `chat-conversation-window.ts` (`packages/backend/src/services/chat/`) for
 * the pure decision function each value drives:
 *
 *  - `continuous` — never auto-restarts; the whole DM is one endless
 *    conversation (the same effective behavior a Chat SPACE thread already
 *    has today — this just applies it to a DM keyed on the space itself).
 *  - `daily` — a new conversation starts at the first message of each
 *    calendar day; everything within one day continues the same one.
 *  - `idle_gap` — a new conversation starts after a fixed period with no
 *    message (`CHAT_IDLE_GAP_MS`, 4 hours) — see
 *    `DEFAULT_CHAT_CONVERSATION_WINDOW` below for why this is the default.
 *  - `per_message` — every message stands alone, never attached to an
 *    earlier one. This was the DE FACTO behavior for every DM before this
 *    feature shipped (a flat Chat DM has no threads, so every message
 *    already started a fresh case) and remains a selectable option, but is
 *    no longer the default — see `DEFAULT_CHAT_CONVERSATION_WINDOW` below.
 *
 * Applies ONLY to a DM's SPACE-keyed continuity (the fallback lookup a
 * top-level DM message uses when its own thread has never been recorded
 * before); it never governs an explicit reply inside an existing thread,
 * which continues regardless of this setting (`resolveChatConversationLookup`,
 * `packages/frontend/src/app/api/chat/events/route.ts`) — see that module's
 * doc for the two-stage DM lookup. A Chat SPACE conversation always stays
 * keyed on its explicit thread, unaffected by this setting either way.
 */
export const CHAT_CONVERSATION_WINDOWS = ['continuous', 'daily', 'idle_gap', 'per_message'] as const;

export type ChatConversationWindow = (typeof CHAT_CONVERSATION_WINDOWS)[number];

/**
 * Default for a user who never opens the setting. Deliberately NOT
 * `continuous` — that is exactly the "giant runaway thread" shape the
 * setting exists to let people opt OUT of, not the safe default to opt IN
 * to silently. Deliberately NOT `per_message` either (the original default): `per_message` restarts even a reply sent moments
 * later, which reads as broken rather than intentional for the common case
 * of a short back-and-forth DM. `idle_gap`'s fixed 4-hour boundary
 * (`CHAT_IDLE_GAP_MS`, `chat-conversation-window.ts`) already comfortably
 * spans one working session while still resetting overnight, so it is the
 * least surprising default without requiring a user to visit the setting —
 * `per_message` remains available for anyone who explicitly wants every
 * message treated standalone.
 */
export const DEFAULT_CHAT_CONVERSATION_WINDOW: ChatConversationWindow = 'idle_gap';

export interface User {
  user_id: string;
  email: string;
  display_name: string;
  roles: UserRole[];
  /**
   * Avatar URL synced from the identity provider (e.g. Google `picture` claim).
   * Written fire-and-forget by the auth middleware on every sign-in. May be
   * stale or resolve to a placeholder silhouette for some Workspace tenants —
   * use `custom_avatar_url` first when resolving the effective avatar.
   */
  avatar_url?: string;
  /**
   * User-supplied avatar URL that overrides `avatar_url`. Set via
   * `PATCH /api/users/me`. Must be `https://` and ≤ 500 chars; an empty string
   * clears the override and falls back to `avatar_url`.
   */
  custom_avatar_url?: string;
  /**
   * Requester-scoped Google Chat webhook for Clerk task outcomes (spec Slice D,
   * `docs/specs/clerk-config-scheduling-chat.md`). The user pastes the
   * incoming-webhook URL of a PRIVATE Google Chat space they own; Clerk
   * pings that space directly with their own task's outcome — never the
   * project-wide webhook (`Project.notification_webhook_url`), which would
   * leak a requester-only Clerk answer into a shared space. `null` (or an
   * empty string on the wire) clears it. Absent/unset means today's
   * behavior: no Chat ping, in-app notification only (see
   * `EventNotifier.notifyAssistantOutcome`). Written via
   * `PATCH /api/users/me`, validated the same way as
   * `Project.notification_webhook_url` (`notificationWebhookUrlSchema`,
   * `https://chat.googleapis.com/…` or empty/null).
   */
  notification_chat_webhook?: string | null;
  /**
   * Delivery observability for `notification_chat_webhook` (spec Slice D),
   * same shape and write discipline as `Project.notification_delivery`
   * (Slice C item 4): server-owned, written by
   * `EventNotifier.notifyAssistantOutcome` and the
   * `POST /api/users/me/test-chat-webhook` route after each real send
   * attempt — never by a client PATCH. `last_success_at` and `last_error`
   * are independent (a success does not clear a prior error).
   */
  notification_chat_delivery?: {
    last_success_at?: string;
    last_error?: {
      /** ISO timestamp of the failed attempt. */
      at: string;
      /** HTTP status as a string (e.g. "429", "500") or "network_error" when the fetch itself threw. */
      code: string;
      /** Response body text or the thrown error's message. */
      message: string;
    };
  };
  /**
   * Google Chat identity binding (spec Slice E,
   * `docs/specs/clerk-config-scheduling-chat.md`). Written once by
   * `mapChatIdentity` (`packages/backend/src/services/chat/chat-identity-service.ts`)
   * on the first `ADDED_TO_SPACE` or `MESSAGE` event whose verified sender
   * email exactly matches this user's `email` (case-insensitive; never a
   * fuzzy/partial match — see that service's doc for why).
   *
   * `chat_user_id` is the opaque Chat/People/Directory resource id
   * (`users/123456789`, also the Google OIDC `sub`) — it is NOT an Arbitra
   * user id and NOT an email address. `space_name` is the space the
   * mapping event happened in, kept as the FIRST value ever written: a
   * later message from the same sender in a different space does not move
   * it (see the service's doc for why). The mapping is never overwritten
   * with a different `chat_user_id` once set — a reused/reassigned address
   * would otherwise silently re-point future decision attribution at a
   * different person.
   */
  chat_identity?: {
    space_name: string;
    chat_user_id: string;
    mapped_at: string;
  };
  /**
   * DM conversation-window habit (see `ChatConversationWindow` above).
   * Absent means the user never chose one — every reader must treat that as
   * `DEFAULT_CHAT_CONVERSATION_WINDOW`, never as `undefined` behavior of its
   * own (`resolveUserChatConversationWindow` in
   * `packages/backend/src/services/chat/chat-conversation-window.ts` is the
   * one place that applies this fallback). Written via `PATCH /api/users/me`,
   * same route as `notification_chat_webhook`. Personal, not project policy —
   * unlike `notification_chat_webhook` this has no project-level equivalent
   * to fall back to.
   */
  chat_conversation_window?: ChatConversationWindow;
  created_at: string;
  updated_at: string;
}

export interface PersonalAccessToken {
  token_id: string;
  user_id: string;
  name: string;
  /** The hashed token value (SHA-256). The raw token is only shown once at creation. */
  token_hash: string;
  /** Prefix for identification, e.g. "arb_...abc" */
  token_prefix: string;
  created_at: string;
  last_used_at?: string;
  expires_at?: string;

  // ── Per-tool / per-device metadata (additive, optional) ────────────
  // Populated by the device-flow / unified-connect path. Existing tokens
  // pre-dating this feature have all fields undefined; the tokens panel
  // renders them as "legacy".

  /** Normalized MCP client name, e.g. 'cursor', 'claude-code', 'codex', 'arbitra-mcp-cli', 'arbitra-mcp-unknown'. */
  client_name?: string;
  /** Free-text client version captured at mint time, e.g. '0.42.3'. */
  client_version?: string;
  /** Stable per-machine hash (sha256(hostname+mac), 16 hex chars). Same across tools on one machine. */
  device_id?: string;
  /** Human-friendly device label, e.g. 'Jans-MacBook'. Editable on the /connect page. */
  device_label?: string;
  /** How the token was minted. 'manual' = legacy `/api/tokens` POST; 'unified_connect' = device flow; 'ci_service' = future CI scope. */
  created_via?: 'manual' | 'unified_connect' | 'ci_service';
}
