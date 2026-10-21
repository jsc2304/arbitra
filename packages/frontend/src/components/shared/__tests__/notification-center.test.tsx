/**
 * @file `<NotificationCenter>` — label/icon mapping (spec Slice C item 4,
 * `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * Pins the friendly labels for `run_failed`/`run_retries_exhausted`/
 * `assistant_task_completed`/`assistant_task_failed`, the removal of the dead
 * `review_completed_with_findings` entry, and the `notificationTypeLabel`/
 * `NotificationIcon` exports, so the mapping is unit-testable without a DOM.
 * The notification panel only renders after the bell is
 * clicked, and this frontend suite is deliberately node-only — no jsdom, no
 * simulated click (see `tooltip.test.tsx`).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Notification } from '@arbitra/shared';

// `<NotificationCenter>` calls `useRouter()` for the "View case" navigation
// (only ever invoked on click, never during the initial render this
// node-only suite exercises) — mocked so rendering the full default export
// doesn't throw for want of an app-router context, same pattern as
// `sidebar.test.tsx`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

import NotificationCenter, { NotificationIcon, notificationTypeLabel } from '../notification-center';
import { NotificationContext } from '@/providers/notification-provider';

describe('notificationTypeLabel', () => {
  it('labels the four run/assistant task events', () => {
    expect(notificationTypeLabel('run_failed')).toBe('Run Failed');
    expect(notificationTypeLabel('run_retries_exhausted')).toBe('Retries Exhausted');
    expect(notificationTypeLabel('assistant_task_completed')).toBe('Clerk Task Done');
    expect(notificationTypeLabel('assistant_task_failed')).toBe('Clerk Task Failed');
  });

  it('still labels the pre-existing event types unchanged', () => {
    expect(notificationTypeLabel('case_needs_decision')).toBe('Decision Required');
    expect(notificationTypeLabel('critical_finding')).toBe('Critical Finding');
  });

  it('labels the three gate event types added for the closed NotificationType union', () => {
    expect(notificationTypeLabel('gate_pending')).toBe('Gate Confirmation');
    expect(notificationTypeLabel('gate_confirmed')).toBe('Gate Confirmed');
    expect(notificationTypeLabel('gate_rejected')).toBe('Gate Declined');
  });

  it('labels run_stalled, the run-timeout watchdog type formerly emitted as warning', () => {
    expect(notificationTypeLabel('run_stalled')).toBe('Run Delayed');
  });

  it('falls back to the raw type string for the removed review_completed_with_findings entry', () => {
    // Reverting the map deletion (re-adding the key) would make this return
    // 'Review Completed' instead of the raw type.
    expect(notificationTypeLabel('review_completed_with_findings')).toBe('review_completed_with_findings');
  });

  it('falls back to the raw type string for any other unknown type', () => {
    expect(notificationTypeLabel('some_future_event')).toBe('some_future_event');
  });
});

describe('<NotificationIcon /> — icon mapping', () => {
  it('renders the four newly-added event types with distinct markup', () => {
    const runFailed = renderToStaticMarkup(<NotificationIcon type="run_failed" />);
    const retriesExhausted = renderToStaticMarkup(<NotificationIcon type="run_retries_exhausted" />);
    const assistantCompleted = renderToStaticMarkup(<NotificationIcon type="assistant_task_completed" />);
    const assistantFailed = renderToStaticMarkup(<NotificationIcon type="assistant_task_failed" />);

    expect(runFailed).toContain('text-red-500');
    expect(retriesExhausted).toContain('text-red-600');
    expect(assistantCompleted).toContain('text-green-500');
    expect(assistantFailed).toContain('text-red-500');

    // Each of the four renders a non-empty <svg>, and all four render
    // distinct markup (run_failed and assistant_task_failed share a text
    // color but differ in path/shape — sparkles vs. exclamation-circle).
    const renders = [runFailed, retriesExhausted, assistantCompleted, assistantFailed];
    for (const html of renders) {
      expect(html).toContain('<svg');
    }
    expect(new Set(renders).size).toBe(4);
  });

  it('renders nothing for the removed review_completed_with_findings type', () => {
    // Reverting the icon-switch deletion would make this render an <svg> again.
    const html = renderToStaticMarkup(<NotificationIcon type="review_completed_with_findings" />);
    expect(html).toBe('');
  });

  it('renders nothing for an unrecognized type (default branch)', () => {
    const html = renderToStaticMarkup(<NotificationIcon type="totally_unknown_type" />);
    expect(html).toBe('');
  });

  it('renders the four gate/run_stalled types added for issue #867 (previously empty)', () => {
    // Each of these rendered '' before the #867 fix (empty typeIcons entries).
    expect(renderToStaticMarkup(<NotificationIcon type="gate_pending" />)).toContain('<svg');
    expect(renderToStaticMarkup(<NotificationIcon type="gate_confirmed" />)).toContain('<svg');
    expect(renderToStaticMarkup(<NotificationIcon type="gate_rejected" />)).toContain('<svg');
    expect(renderToStaticMarkup(<NotificationIcon type="run_stalled" />)).toContain('<svg');
  });

  it('renders nothing for a type name that collides with an inherited Object property', () => {
    // A truthy-lookup guard (`typeIcons[type]` without hasOwn) would resolve
    // 'constructor' through the prototype chain to a function and render an
    // <svg> with d={undefined} instead of returning null here.
    const html = renderToStaticMarkup(<NotificationIcon type="constructor" />);
    expect(html).toBe('');
  });
});

/**
 * Issue #794 P0 — the bell badge must show the caller's TOTAL unread count
 * (`unread_count` from the paginated API response), not
 * `notifications.filter(n => !n.read).length` on whichever page happens to
 * be loaded. Rendered via a raw `NotificationContext.Provider` value (no
 * SWR/fetch mocking, no jsdom) — same node-only, `renderToStaticMarkup`
 * convention as the rest of this suite; the badge itself renders
 * unconditionally on the bell button, not gated behind the (click-to-open,
 * client-state) panel.
 */
function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: 'notif_1',
    user_id: 'usr_1',
    type: 'gate_pending',
    title: 'T',
    body: 'B',
    read: false,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Extracts the bell badge's own rendered content — never the aria-label/tooltip text, which also embeds the raw count and would make a loose `toContain` check pass for the wrong reason. */
function badgeContent(html: string): string | null {
  const match = html.match(/bg-red-500[^>]*>([^<]+)<\/span>/);
  return match ? match[1]! : null;
}

describe('<NotificationCenter /> — unread badge (issue #794 P0)', () => {
  it('shows the TOTAL unread count from context, not the loaded page\'s unread count', () => {
    // Only 1 of the 2 loaded notifications is unread, but the context's
    // total (as the real provider derives it from the API's `unread_count`)
    // is 47 — the badge must render 47, proving it reads `unreadCount`
    // rather than deriving it from the loaded `notifications` array.
    const html = renderToStaticMarkup(
      <NotificationContext.Provider
        value={{
          notifications: [
            makeNotification({ notification_id: 'n1', read: false }),
            makeNotification({ notification_id: 'n2', read: true }),
          ],
          unreadCount: 47,
          hasMore: true,
          loadingMore: false,
          loadMore: () => {},
          markAsRead: () => {},
          markAllAsRead: () => {},
          deleteNotification: () => {},
        }}
      >
        <NotificationCenter />
      </NotificationContext.Provider>,
    );

    expect(badgeContent(html)).toBe('47');
  });

  it('caps the displayed badge at "99+" for a very large total (unchanged behavior)', () => {
    const html = renderToStaticMarkup(
      <NotificationContext.Provider
        value={{
          notifications: [],
          unreadCount: 148,
          hasMore: false,
          loadingMore: false,
          loadMore: () => {},
          markAsRead: () => {},
          markAllAsRead: () => {},
          deleteNotification: () => {},
        }}
      >
        <NotificationCenter />
      </NotificationContext.Provider>,
    );

    expect(badgeContent(html)).toBe('99+');
  });

  it('renders no badge when the total unread count is zero, even with loaded read notifications', () => {
    const html = renderToStaticMarkup(
      <NotificationContext.Provider
        value={{
          notifications: [makeNotification({ read: true })],
          unreadCount: 0,
          hasMore: false,
          loadingMore: false,
          loadMore: () => {},
          markAsRead: () => {},
          markAllAsRead: () => {},
          deleteNotification: () => {},
        }}
      >
        <NotificationCenter />
      </NotificationContext.Provider>,
    );

    expect(badgeContent(html)).toBeNull();
  });
});
