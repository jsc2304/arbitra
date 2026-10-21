import type { NotificationEvent } from '../types/notification.js';

/**
 * Catalog entry for one Google Chat notification event.
 *
 * `chat` is the catalog-driven DEFAULT for whether the event pushes to the
 * project's Google Chat webhook (on top of its always-on in-app
 * notification); a project's `notification_events` override
 * (`Project['notification_events']`, `types/project.ts`) takes precedence
 * when present — see `resolveEventChatEnabled` in
 * `packages/backend/src/services/notification/notification-dispatcher.ts`.
 *
 * `label` is the single human-readable name for the event, shared by the
 * backend (comments/docs) and the frontend Integrations tab toggle list —
 * one source so UI copy can never drift from the event catalog.
 */
export interface NotificationEventCatalogEntry {
  chat: boolean;
  label: string;
}

/**
 * Decision-type events (something needs a human to act) default on;
 * informational events (approved/done — today's deliberate in-app-only
 * choice) default off; findings/violations/run-failure events default on
 * because their templates exist specifically to fire.
 *
 * `Record<NotificationEvent, ...>` is deliberate: adding a `NotificationEvent`
 * variant without adding its catalog entry here is a compile error.
 */
export const NOTIFICATION_EVENT_DEFAULTS: Record<NotificationEvent, NotificationEventCatalogEntry> = {
  case_needs_decision: { chat: true, label: 'Decision required' },
  critical_finding: { chat: true, label: 'Critical finding' },
  case_approved: { chat: false, label: 'Case approved' },
  case_done: { chat: false, label: 'Case completed' },
  changes_requested: { chat: true, label: 'Changes requested' },
  manual_validation_pending: { chat: false, label: 'Manual validation pending' },
  rule_violation: { chat: true, label: 'Rule violation' },
  evidence_missing: { chat: true, label: 'Evidence missing' },
  gate_pending: { chat: true, label: 'Gate confirmation required' },
  gate_rejected: { chat: true, label: 'Gate declined' },
  profile_changed: { chat: false, label: 'Lifecycle profile updated' },
  run_failed: { chat: true, label: 'Pipeline task failed' },
  run_retries_exhausted: { chat: true, label: 'Pipeline task failed after retries' },
};

/**
 * Stable render order for the Integrations tab toggle list. Derived from
 * `NOTIFICATION_EVENT_DEFAULTS` (not hand-duplicated) so a new catalog entry
 * appears in the list automatically.
 */
export const NOTIFICATION_EVENT_ORDER: readonly NotificationEvent[] = Object.keys(
  NOTIFICATION_EVENT_DEFAULTS,
) as NotificationEvent[];
