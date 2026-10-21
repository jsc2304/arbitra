/**
 * In-app notification types — the closed set emitted via
 * `notificationService.notify(...)` calls in
 * `packages/backend/src/services/notification/event-notifier.ts` and the
 * run-timeout watchdog in
 * `packages/backend/src/services/orchestration/pipeline.ts`.
 */
export type NotificationType =
  | 'case_needs_decision'
  | 'manual_validation_pending'
  | 'rule_violation'
  | 'evidence_missing'
  | 'case_approved'
  | 'case_rejected'
  | 'changes_requested'
  | 'case_done'
  | 'critical_finding'
  | 'gate_pending'
  | 'gate_confirmed'
  | 'gate_rejected'
  | 'run_failed'
  | 'run_retries_exhausted'
  | 'run_stalled'
  | 'assistant_task_completed'
  | 'assistant_task_failed';

/**
 * Google Chat notification catalog event names — the closed set the
 * backend dispatcher switches on and the Integrations tab renders toggles
 * for (spec `docs/specs/clerk-config-scheduling-chat.md`, Slice C).
 *
 * Canonical home is `@arbitra/shared` (not `@arbitra/backend`) so a
 * client-bundled component (the Integrations tab) can import the catalog
 * (`NOTIFICATION_EVENT_DEFAULTS`, `constants/notification-events.ts`)
 * without pulling `@arbitra/backend` — and with it firebase-admin/Firestore
 * — into the browser bundle. Mirrors the existing frontend/backend split
 * used for `CASE_STATUS_LABELS`
 * (`packages/backend/src/services/notification/notification-dispatcher.ts`).
 * `notification-dispatcher.ts` imports and re-exports this type for source
 * compatibility with existing call sites.
 */
export type NotificationEvent =
  | 'case_needs_decision'
  | 'critical_finding'
  | 'case_approved'
  | 'case_done'
  | 'changes_requested'
  | 'manual_validation_pending'
  | 'rule_violation'
  | 'evidence_missing'
  | 'gate_pending'
  | 'gate_rejected'
  | 'profile_changed'
  | 'run_failed'
  | 'run_retries_exhausted';

export interface Notification {
  notification_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  case_id?: string;
  read: boolean;
  created_at: string;
}

export interface CreateNotificationInput {
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  case_id?: string;
}

/**
 * One page of `GET /api/notifications` (issue #794 P0 — the drawer's
 * duplication/overload complaint: 48 notifications with no pagination).
 *
 * `unread_count` is the caller's TOTAL unread count across every page, not
 * just this page's — the notification bell badge must show that total even
 * while only the first `limit` rows are loaded, so it's carried on every
 * page response rather than left for the client to derive from
 * `notifications.filter(n => !n.read)`.
 *
 * `next_cursor` is `null` once the page returned fewer than `limit` rows
 * (end of the list) or the caller passed no more history to walk; pass it
 * back as the `cursor` query param to fetch the next page. A request with
 * no `cursor`/`limit` at all (an old client predating this contract) still
 * gets a valid first page — both params are optional query params, not a
 * required request body — so nothing existing breaks.
 */
export interface NotificationPage {
  notifications: Notification[];
  next_cursor: string | null;
  unread_count: number;
}
