'use client';

import { useEffect, useState } from 'react';
import type { NotificationEvent, Project } from '@arbitra/shared';
import { NOTIFICATION_EVENT_DEFAULTS, NOTIFICATION_EVENT_ORDER } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { RelativeTime } from '../shared/relative-time';

/**
 * Merges a single toggle change into the project's override map without
 * touching any other event's override. Extracted (rather than inlined in
 * the `onChange` handler) so the merge behaviour — the thing a regression
 * would most likely break by replacing the whole map instead of merging —
 * is unit-testable without a DOM (this frontend suite is deliberately
 * node-only, see `tooltip.test.tsx`).
 */
export function nextEventOverrides(
  current: Partial<Record<NotificationEvent, boolean>>,
  event: NotificationEvent,
  checked: boolean,
): Partial<Record<NotificationEvent, boolean>> {
  return { ...current, [event]: checked };
}

/**
 * Whether a given toggle should render disabled: true while ANY event save
 * is in flight, not just the one being saved. A lost-update race (two rapid
 * toggles on different events both PATCH a `notification_events` map merged
 * from the same stale pre-save state; whichever PATCH's response lands last
 * wins, silently dropping the other's change) is only closed by serializing
 * saves this way — per-toggle disabling (`savingEvent === event`) still let
 * a second toggle start mid-save. Exported so the serialization decision is
 * unit-testable without a DOM (see `nextEventOverrides` above).
 */
export function isToggleDisabled(savingEvent: NotificationEvent | null): boolean {
  return savingEvent !== null;
}

/**
 * Sends the webhook-URL PATCH, extracted (like `commitEventToggle` below)
 * so the exact payload is unit-testable without a DOM. Sends an explicit
 * `null` — NEVER `undefined` — when the trimmed input is empty.
 *
 * Regression this guards against (issue #1100): an earlier version sent
 * `notification_webhook_url: trimmedUrl || undefined`. `JSON.stringify`
 * drops keys whose value is `undefined`, so the PATCH body carried no key
 * at all when the field was cleared — the server's `ref.update()` only
 * touches keys present in its argument, so a stale webhook URL was left in
 * Firestore untouched while the UI reported success. `null` survives
 * `JSON.stringify` and is the schema's dedicated "explicitly cleared"
 * signal (`notificationWebhookUrlSchema.nullable()`,
 * `project-validators.ts`) — distinct from the key being absent, which
 * means "leave alone".
 */
export async function commitWebhookSave(projectId: string, trimmedUrl: string): Promise<void> {
  await api.projects.update(projectId, { notification_webhook_url: trimmedUrl || null });
}

/**
 * Computes the merged override map for one toggle, applies it optimistically
 * via `onNext`, and PATCHes it — this is the exact logic `handleToggleEvent`
 * runs, extracted so the PATCH payload it sends is unit-testable without a
 * DOM (this frontend suite is deliberately node-only, no jsdom/`fireEvent`).
 *
 * Reads `current` synchronously and directly — no functional state update.
 * That is only correct BECAUSE `isToggleDisabled` (above) disables EVERY
 * toggle while ANY save is in flight, so at most one call to this function
 * is ever in progress at a time; nothing else can race this read. Do not
 * remove that blanket disable without reinstating some way to always read
 * the latest state here.
 *
 * Regression this guards against: an earlier version assigned `next` inside
 * a `setEventOverrides(prev => (next = ...))` updater callback and read
 * `next` on the very next line — React does not invoke `setState` updater
 * callbacks synchronously, so `next` was still `undefined` when the PATCH
 * below sent it, and toggles never persisted.
 */
export async function commitEventToggle(
  projectId: string,
  current: Partial<Record<NotificationEvent, boolean>>,
  event: NotificationEvent,
  checked: boolean,
  onNext: (next: Partial<Record<NotificationEvent, boolean>>) => void,
): Promise<void> {
  const next = nextEventOverrides(current, event, checked);
  onNext(next);
  await api.projects.update(projectId, { notification_events: next });
}

export function WebhookSection({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const [webhookUrl, setWebhookUrl] = useState(project.notification_webhook_url ?? '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [eventOverrides, setEventOverrides] = useState<Partial<Record<NotificationEvent, boolean>>>(
    project.notification_events ?? {},
  );
  const [savingEvent, setSavingEvent] = useState<NotificationEvent | null>(null);
  const { addToast } = useToast();

  const currentUrl = project.notification_webhook_url ?? '';
  const isDirty = webhookUrl !== currentUrl;

  // Sync state when project changes
  useEffect(() => {
    setWebhookUrl(project.notification_webhook_url ?? '');
    setTestResult(null);
  }, [project.notification_webhook_url]);

  useEffect(() => {
    setEventOverrides(project.notification_events ?? {});
  }, [project.notification_events]);

  async function handleSave() {
    setSaving(true);
    try {
      await commitWebhookSave(project.project_id, webhookUrl.trim());
      addToast('success', 'Webhook URL saved');
      onUpdate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to save webhook URL');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      await api.projects.testWebhook(project.project_id);
      setTestResult('success');
      addToast('success', 'Test message sent successfully');
    } catch {
      setTestResult('error');
      addToast('error', 'Failed to send test message. Check the webhook URL.');
    } finally {
      setTesting(false);
      // A Test click is itself a recorded send attempt (backend writes
      // `notification_delivery` either way) — refetch so the delivery status
      // below reflects the attempt that just happened, not stale data.
      onUpdate();
    }
  }

  async function handleToggleEvent(event: NotificationEvent, checked: boolean) {
    // `eventOverrides` is read directly (synchronously) inside
    // commitEventToggle — see that function's doc comment for why this is
    // safe: `isToggleDisabled(savingEvent)` below disables every toggle
    // while this is in flight, so no second call can ever race the read.
    setSavingEvent(event);
    try {
      await commitEventToggle(project.project_id, eventOverrides, event, checked, setEventOverrides);
      onUpdate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to update notification setting');
    } finally {
      setSavingEvent(null);
    }
  }

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-5">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Google Chat Notifications
      </h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Paste the webhook URL from your Google Chat space to receive notifications about case events.
      </p>

      <div className="flex gap-2">
        <input
          type="url"
          value={webhookUrl}
          onChange={(e) => { setWebhookUrl(e.target.value); setTestResult(null); }}
          placeholder="https://chat.googleapis.com/v1/spaces/..."
          className="flex-1 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-gray-400 dark:placeholder:text-gray-500"
        />
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing || !currentUrl}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {testing ? 'Sending...' : 'Test'}
        </button>
      </div>

      {testResult === 'success' && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">Test message sent successfully.</p>
      )}
      {testResult === 'error' && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">Failed to send test message. Check the webhook URL.</p>
      )}

      {/*
        Delivery observability (spec Slice C item 4): renders whichever of
        `last_success_at`/`last_error` are present on
        `project.notification_delivery` — the two are independent (a success
        does not clear a prior error), so both can show at once. Renders
        nothing at all when the field is absent (a project that has never
        sent, e.g. right after webhook setup).
      */}
      {project.notification_delivery?.last_success_at && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="delivery-last-success">
          <RelativeTime
            timestamp={project.notification_delivery.last_success_at}
            prefix="Last delivered"
          />
        </p>
      )}
      {project.notification_delivery?.last_error && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="delivery-last-error">
          Last error ({project.notification_delivery.last_error.code}):{' '}
          {project.notification_delivery.last_error.message}{' '}
          (<RelativeTime timestamp={project.notification_delivery.last_error.at} />)
        </p>
      )}

      {/*
        Catalog-driven toggle list (spec Slice C item 2): rendered from
        `NOTIFICATION_EVENT_DEFAULTS`/`NOTIFICATION_EVENT_ORDER`
        (`@arbitra/shared`, same catalog the backend dispatcher switches on)
        rather than a hardcoded event list, so this UI can never drift from
        the event catalog again. Replaces the former hardcoded five-event
        sentence.
      */}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-border-subtle">
        <h5 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Event notifications
        </h5>
        <ul className="space-y-1.5">
          {NOTIFICATION_EVENT_ORDER.map((event) => {
            const entry = NOTIFICATION_EVENT_DEFAULTS[event];
            const checked = eventOverrides[event] ?? entry.chat;
            return (
              <li key={event} className="flex items-center justify-between gap-3">
                <label
                  htmlFor={`notification-event-${event}`}
                  className="text-sm text-gray-700 dark:text-gray-300"
                >
                  {entry.label}
                </label>
                <input
                  id={`notification-event-${event}`}
                  type="checkbox"
                  checked={checked}
                  disabled={isToggleDisabled(savingEvent)}
                  onChange={(e) => handleToggleEvent(event, e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 dark:border-border-default text-accent-700 focus:ring-1 focus:ring-accent"
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
