/**
 * NotificationDispatcher — Sends push notifications (Google Chat webhooks)
 * for key case lifecycle events.
 *
 * Looks up the project's `notification_webhook_url` and sends formatted
 * messages.
 */

import type { Case, CaseStatus, NotificationEvent, Project, User } from '@arbitra/shared';
import { NOTIFICATION_EVENT_DEFAULTS } from '@arbitra/shared';
import { GoogleChatNotifier, type ChatMessage, type SendResult } from './google-chat-notifier.js';
import { collections } from '../../lib/firestore.js';

/**
 * `NotificationEvent` and `NOTIFICATION_EVENT_DEFAULTS` moved to
 * `@arbitra/shared` (slice C2, `docs/specs/clerk-config-scheduling-chat.md`)
 * so the frontend Integrations tab can import the catalog directly without
 * pulling this package (and firebase-admin/Firestore with it) into a
 * client bundle. Re-exported here for source compatibility with existing
 * importers of this module.
 */
export type { NotificationEvent };
export { NOTIFICATION_EVENT_DEFAULTS };

/**
 * Long-form, human-readable labels for case statuses. Mirrors the frontend's
 * `CASE_STATUS_LABELS` (`packages/frontend/src/lib/case-status-labels.ts`).
 * Kept local because the frontend map is a React-package export and the
 * backend must not depend on the frontend workspace.
 */
const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Open',
  exploration: 'Exploration',
  ready_for_build: 'Ready for Build',
  in_build: 'Building',
  in_validation: 'Validating',
  in_review: 'In Review',
  needs_human_decision: 'Needs Decision',
  verification_pending: 'Verification Pending',
  approved: 'Approved',
  pending_merge: 'Pending Merge',
  done: 'Done',
  rejected: 'Rejected',
};

function humanizeStatus(status: string): string {
  if (status in CASE_STATUS_LABELS) {
    return CASE_STATUS_LABELS[status as CaseStatus];
  }
  // Fallback: snake_case -> Title Case.
  return status
    .split('_')
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export interface DispatchInput {
  event: NotificationEvent;
  case_: Case;
  /** Extra context depending on event type */
  findingTitle?: string;
  findingSeverity?: string;
  findingCount?: number;
  rationale?: string;
  baseUrl?: string;
}

/**
 * Effective chat-gating for one event on one project (slice C2): a
 * project's `notification_events` override wins when the key is present
 * (`true` or `false`, explicitly set by the Integrations tab), otherwise
 * the catalog default (`NOTIFICATION_EVENT_DEFAULTS[event].chat`) applies.
 * `undefined` in the override map means "no explicit choice", not "off" —
 * only an explicit `false` mutes a default-on event, and only an explicit
 * `true` unmutes a default-off one.
 *
 * Exported and unit-tested directly (override on / override off / absent)
 * so the precedence rule has one place to be correct, independent of
 * `dispatch()`'s Firestore plumbing.
 */
export function resolveEventChatEnabled(
  event: NotificationEvent,
  overrides?: Partial<Record<NotificationEvent, boolean>>,
): boolean {
  const override = overrides?.[event];
  if (override !== undefined) return override;
  return NOTIFICATION_EVENT_DEFAULTS[event].chat;
}

/** Replace {{placeholder}} tokens in a template string with values from vars. Unmatched placeholders are left as-is. */
function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

interface ProjectNotificationConfig {
  webhookUrl?: string;
  templates?: Partial<Record<string, string>>;
  projectName?: string;
  notificationEvents?: Partial<Record<NotificationEvent, boolean>>;
}

interface ResolvedUser {
  name: string;
  email: string;
}

const UNKNOWN_USER: ResolvedUser = { name: 'Unknown', email: '' };

export class NotificationDispatcher {
  private readonly chatNotifier = new GoogleChatNotifier();

  /**
   * Dispatch a push notification for a case event.
   * Looks up the project's webhook URL and sends the message.
   * Silently returns if no webhook is configured.
   */
  async dispatch(input: DispatchInput): Promise<void> {
    const { event, case_ } = input;

    // Project fetch FIRST: call sites always call `dispatch()` for every
    // wired event and let this gate decide, so no call site needs to know
    // about per-project overrides. Was previously gated on the catalog
    // default alone (cheaper, no Firestore read for a muted event) — that
    // short-circuit no longer holds once a project can override the
    // default, because the override itself lives on the project doc we'd
    // otherwise be skipping the fetch of.
    const config = await this.getProjectNotificationConfig(case_.project_id);
    // Project-not-found/lookup-failed no-op (spec Slice C item 3): stays
    // non-throwing, keeps its console.warn (inside
    // getProjectNotificationConfig below), and deliberately does NOT touch
    // `notification_delivery` — there's no webhook to have failed sending to.
    if (!config) return;
    if (!resolveEventChatEnabled(event, config.notificationEvents)) return;
    // Unset-webhook no-op (spec Slice C item 3): a project with no configured
    // webhook is a config gap, not a delivery failure — do not record a
    // `last_error` for it.
    if (!config.webhookUrl) return;

    const baseUrl = input.baseUrl ?? process.env['ARBITRA_URL'] ?? '';
    const caseLink = baseUrl ? `${baseUrl}/cases/${case_.case_id}` : undefined;

    // Resolve owner and reviewer names
    const owner = await this.resolveUser(case_.owner_user_id);
    const reviewer = case_.assigned_reviewer_id
      ? await this.resolveUser(case_.assigned_reviewer_id)
      : undefined;

    const projectName = config.projectName ?? case_.project_id;
    const statusLabel = humanizeStatus(case_.status);

    const message = this.buildMessage(event, case_, input, caseLink, owner, reviewer);
    message.projectName = projectName;
    message.status = statusLabel;

    // If project has a custom template for this event, use it instead of the
    // hardcoded body — and preserve the legacy message shape so users who
    // adopted custom templates aren't hit with unexpected meta/emoji lines.
    const template = config.templates?.[event];
    if (template) {
      const vars: Record<string, string> = {
        'case.title': case_.title,
        'case.case_id': case_.case_id,
        'case.risk_level': case_.risk_level ?? 'unset',
        'case.status': case_.status,
        'case.status_label': statusLabel,
        'project.name': projectName,
        'finding.title': input.findingTitle ?? '',
        'finding.severity': input.findingSeverity ?? '',
        'finding.count': String(input.findingCount ?? 0),
        'link': caseLink ?? '',
        'rationale': input.rationale ? ` Rationale: ${input.rationale}` : '',
        'owner.name': owner.name,
        'owner.email': owner.email,
        'reviewer.name': reviewer?.name ?? '',
        'reviewer.email': reviewer?.email ?? '',
      };
      message.body = resolveTemplate(template, vars);
      // Custom-template users opted into their own shape; don't inject meta.
      delete message.projectName;
      delete message.status;
    }

    const result = await this.chatNotifier.send(config.webhookUrl, message);
    // Fire-and-forget: recordDeliveryOutcome swallows its own errors (see its
    // doc comment) so a Firestore write failure can never surface as a
    // dispatch()-level exception — the notification already went out (or
    // definitively didn't); recording that fact is best-effort observability,
    // not part of the delivery itself.
    await this.recordDeliveryOutcome(case_.project_id, result);
  }

  /**
   * Persists one send outcome to `projects/{id}.notification_delivery`
   * (spec Slice C item 4). Success writes only `last_success_at` — it does
   * NOT clear an existing `last_error`, so the Integrations tab can show
   * "last delivered X ago" next to a still-visible last error from an
   * earlier failed attempt. Uses dot-path field updates (not a full-object
   * overwrite) specifically so each write only ever touches its own leaf.
   *
   * A missing webhook or a project-lookup failure never reaches this method
   * (both return before `chatNotifier.send` is called) — those are config
   * gaps, not delivery failures, and per spec are NOT recorded here.
   */
  private async recordDeliveryOutcome(projectId: string, result: SendResult): Promise<void> {
    const now = new Date().toISOString();
    try {
      if (result.ok) {
        await collections.projects().doc(projectId).update({
          'notification_delivery.last_success_at': now,
        });
      } else {
        await collections.projects().doc(projectId).update({
          'notification_delivery.last_error': {
            at: now,
            code: result.status !== undefined ? String(result.status) : 'network_error',
            message: result.error ?? 'Unknown error',
          },
        });
      }
    } catch (err) {
      console.warn(
        `[NotificationDispatcher] Failed to record delivery outcome for project ${projectId}:`,
        err,
      );
    }
  }

  private buildMessage(
    event: NotificationEvent,
    case_: Case,
    input: DispatchInput,
    link?: string,
    owner?: ResolvedUser,
    _reviewer?: ResolvedUser,
  ): ChatMessage {
    const ownerName = owner?.name ?? 'Unknown';

    switch (event) {
      case 'case_needs_decision':
        return {
          title: 'Decision Required',
          body: `Case '${case_.title}' (owner: ${ownerName}) needs a decision in the Courtroom. Risk level: ${case_.risk_level ?? 'unset'}. (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'critical_finding':
        return {
          title: 'Critical Finding Detected',
          body: `${input.findingSeverity ?? 'Critical'} finding in ${ownerName}'s case '${case_.title}': ${input.findingTitle ?? 'unknown'}`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'case_approved':
        return {
          title: 'Case Approved',
          body: `${ownerName}'s case '${case_.title}' has been approved and is ready for merge. (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'case_done':
        return {
          title: 'Case Completed',
          body: `${ownerName}'s case '${case_.title}' is done.`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'changes_requested':
        return {
          title: 'Changes Requested',
          body: `${ownerName}'s case '${case_.title}' was sent back for rework.${input.rationale ? ` Reason: ${input.rationale}` : ''} (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'gate_pending': {
        const targetLabel = case_.pending_gate?.target_status ?? 'next phase';
        return {
          title: 'Gate Confirmation Required',
          body: `Case '${case_.title}' (owner: ${ownerName}) is ready to proceed to ${targetLabel} and awaits your confirmation. (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };
      }

      case 'gate_rejected':
        return {
          title: 'Gate Declined',
          body: `Gate declined for case '${case_.title}' (owner: ${ownerName}). The case remains in ${case_.status}. (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'profile_changed':
        return {
          title: 'Lifecycle Profile Updated',
          body: `The lifecycle profile for the project has been updated. New and existing cases will be processed according to the updated profile.`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'run_failed':
        return {
          title: 'Pipeline Task Failed',
          body: `A pipeline task failed on ${ownerName}'s case '${case_.title}'.${input.rationale ? ` ${input.rationale}` : ''} (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      case 'run_retries_exhausted':
        return {
          title: 'Pipeline Task Failed After Retries',
          body: `A pipeline task on ${ownerName}'s case '${case_.title}' failed after all retries and will not be retried automatically. Manual attention required. (${case_.case_id})`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };

      default:
        return {
          title: 'Arbitra Notification',
          body: `Event on ${ownerName}'s case '${case_.title}'.`,
          caseId: case_.case_id,
          caseTitle: case_.title,
          link,
        };
    }
  }

  private async resolveUser(userId?: string): Promise<ResolvedUser> {
    if (!userId) return UNKNOWN_USER;
    try {
      const doc = await collections.users().doc(userId).get();
      if (!doc.exists) return UNKNOWN_USER;
      const user = doc.data() as User;
      return { name: user.display_name || user.email, email: user.email };
    } catch {
      return UNKNOWN_USER;
    }
  }

  private async getProjectNotificationConfig(
    projectId?: string,
  ): Promise<ProjectNotificationConfig | undefined> {
    if (!projectId) return undefined;

    try {
      const doc = await collections.projects().doc(projectId).get();
      if (!doc.exists) return undefined;
      const project = doc.data() as Project;
      return {
        webhookUrl: project.notification_webhook_url,
        templates: project.notification_templates,
        projectName: project.name,
        notificationEvents: project.notification_events,
      };
    } catch (err) {
      console.warn(`[NotificationDispatcher] Failed to load project ${projectId}:`, err);
      return undefined;
    }
  }
}
