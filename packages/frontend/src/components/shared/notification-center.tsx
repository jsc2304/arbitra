'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useNotifications } from '@/providers/notification-provider';
import type { Notification, NotificationType } from '@arbitra/shared';
import { RelativeTime } from './relative-time';
import { Tooltip } from './tooltip';

const typeLabels = {
  case_needs_decision: 'Decision Required',
  manual_validation_pending: 'Manual Validation',
  rule_violation: 'Rule Violation',
  evidence_missing: 'Missing Evidence',
  case_approved: 'Approved',
  case_rejected: 'Rejected',
  changes_requested: 'Changes Requested',
  case_done: 'Case Completed',
  critical_finding: 'Critical Finding',
  gate_pending: 'Gate Confirmation',
  gate_confirmed: 'Gate Confirmed',
  gate_rejected: 'Gate Declined',
  run_failed: 'Run Failed',
  run_retries_exhausted: 'Retries Exhausted',
  run_stalled: 'Run Delayed',
  assistant_task_completed: 'Clerk Task Done',
  assistant_task_failed: 'Clerk Task Failed',
} satisfies Record<NotificationType, string>;

/**
 * Resolves a notification's display label, falling back to the raw type
 * string for anything not in `typeLabels`. Takes plain `string` (not
 * `NotificationType`) because persisted Firestore notifications may carry
 * legacy types no longer in the closed union — the cast below is the
 * boundary between the compile-checked map and that runtime reality.
 * Exported so the mapping is unit-testable directly; the panel itself only
 * renders after the bell is clicked, and this suite is deliberately
 * node-only (no jsdom, no simulated click — see `tooltip.test.tsx`).
 */
export function notificationTypeLabel(type: string): string {
  return (typeLabels as Record<string, string>)[type] ?? type;
}

type IconSpec = { color: string; d: string };

// Every entry renders identical SVG wrapper markup (24x24 viewBox, 2px
// stroke, currentColor) — only the Tailwind color class and the single
// <path d> differ, so the switch below collapses to a lookup table. Three
// of the four gate_* / run_stalled entries intentionally reuse a `d` string
// byte-for-byte from an existing type (see the comments); the notification
// label disambiguates them for the user, matching existing precedent
// (case_approved and case_done already share a path).
const typeIcons = {
  case_needs_decision: {
    // Orange/amber clock icon
    color: 'text-amber-500',
    d: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  manual_validation_pending: {
    // Blue clipboard icon
    color: 'text-blue-500',
    d: 'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z',
  },
  rule_violation: {
    // Red triangle warning icon
    color: 'text-red-500',
    d: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  },
  evidence_missing: {
    // Yellow/orange file-x icon
    color: 'text-orange-400',
    d: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Zm3 13.5 3-3m0 0-3-3m3 3h-6',
  },
  case_approved: {
    // Green checkmark circle
    color: 'text-green-500',
    d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  case_rejected: {
    // Red x circle
    color: 'text-red-500',
    d: 'm9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  changes_requested: {
    // Yellow arrow-left/undo icon
    color: 'text-yellow-500',
    d: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3',
  },
  case_done: {
    // Green check circle — case completed (same path as case_approved)
    color: 'text-green-500',
    d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  critical_finding: {
    // Red exclamation triangle — critical alert (same path as rule_violation)
    color: 'text-red-600',
    d: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  },
  gate_pending: {
    // Clock icon, reused from case_needs_decision — a gate awaiting
    // confirmation is the same "pending" shape as a decision awaiting one.
    color: 'text-amber-500',
    d: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  gate_confirmed: {
    // Check-circle, reused from case_approved
    color: 'text-green-500',
    d: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  gate_rejected: {
    // X-circle, reused from case_rejected
    color: 'text-red-500',
    d: 'm9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  run_failed: {
    // Red exclamation circle — run failed
    color: 'text-red-500',
    d: 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z',
  },
  run_retries_exhausted: {
    // Red retry arrows — failed after all retries, needs manual attention
    color: 'text-red-600',
    d: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  },
  run_stalled: {
    // Exclamation-circle, reused from run_failed, but amber — stalled means
    // delayed, not failed.
    color: 'text-amber-500',
    d: 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z',
  },
  assistant_task_completed: {
    // Green sparkles — Clerk assistant task finished
    color: 'text-green-500',
    d: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z',
  },
  assistant_task_failed: {
    // Red sparkles — Clerk assistant task failed (same path as
    // assistant_task_completed, red instead of green)
    color: 'text-red-500',
    d: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z',
  },
} satisfies Record<NotificationType, IconSpec>;

/**
 * Takes plain `string` (not `NotificationType`) for the same legacy-Firestore
 * reason as `notificationTypeLabel` above. Guards with `Object.hasOwn`
 * rather than a truthy lookup: an object-literal index access resolves
 * inherited keys like `'constructor'` or `'toString'` through the prototype
 * chain to a truthy function value, which would fall through to rendering
 * an `<svg>` with `d={undefined}` for exactly the legacy-data inputs this
 * loose signature exists to guard against.
 */
export function NotificationIcon({ type }: { type: string }) {
  if (!Object.hasOwn(typeIcons, type)) return null;
  const { color, d } = typeIcons[type as keyof typeof typeIcons];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
      className={`h-4 w-4 ${color} shrink-0 mt-0.5`}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

function NotificationItem({
  notification,
  onRead,
  onDelete,
  onNavigate,
}: {
  notification: Notification;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
  onNavigate: (caseId: string) => void;
}) {
  return (
    <div
      className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-border-subtle hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors ${
        notification.read ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        {!notification.read ? (
          <span className="mt-1.5 h-2 w-2 rounded-full bg-accent shrink-0" />
        ) : (
          <span className="h-2 w-2 shrink-0" />
        )}
        <NotificationIcon type={notification.type} />
        <button
          type="button"
          className="flex-1 min-w-0 text-left"
          onClick={() => {
            if (!notification.read) {
              onRead(notification.notification_id);
            }
            if (notification.case_id) {
              onNavigate(notification.case_id);
            }
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-accent-700 dark:text-accent-300 uppercase tracking-wide">
              {notificationTypeLabel(notification.type)}
            </span>
            <RelativeTime
              timestamp={notification.created_at}
              className="text-xs text-gray-400 dark:text-gray-500 shrink-0"
            />
          </div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words mt-0.5" title={notification.title}>
            {notification.title}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 break-words" title={notification.body}>{notification.body}</p>
          {notification.case_id && (
            <span className="text-xs text-accent-700 dark:text-accent-300 hover:underline mt-1 inline-block">
              View case →
            </span>
          )}
        </button>
        <Tooltip label="Dismiss notification">
        <button
          type="button"
          className="mt-1 p-1 rounded text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-surface-base dark:hover:bg-border-subtle transition-colors shrink-0"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(notification.notification_id);
          }}
        >
          {/* Trash icon (Heroicons outline) */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
            />
          </svg>
        </button>
        </Tooltip>
      </div>
    </div>
  );
}

export default function NotificationCenter() {
  const { notifications, unreadCount, hasMore, loadingMore, loadMore, markAsRead, markAllAsRead, deleteNotification } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  function handleNavigate(caseId: string) {
    setOpen(false);
    router.push(`/cases/${caseId}`);
  }

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const bellLabel = `Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`;
  return (
    <div className="relative" ref={panelRef}>
      <Tooltip label={bellLabel}>
      <button
        type="button"
        className="relative p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-md hover:bg-surface-base dark:hover:bg-border-subtle transition-colors"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={bellLabel}
      >
        {/* Bell icon (Heroicons outline) */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-border-subtle">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                className="text-xs text-accent-700 dark:text-accent-300 hover:text-accent-800 dark:hover:text-accent-200 font-medium"
                onClick={() => markAllAsRead()}
              >
                Mark all as read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-10 flex flex-col items-center justify-center gap-2 text-center">
                {/* Bell icon (gray, ~24px) */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="h-6 w-6 text-gray-300 dark:text-gray-600"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
                  />
                </svg>
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">You&apos;re all caught up</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">No new notifications</p>
              </div>
            ) : (
              <>
                {notifications.map((n) => (
                  <NotificationItem
                    key={n.notification_id}
                    notification={n}
                    onRead={markAsRead}
                    onDelete={deleteNotification}
                    onNavigate={handleNavigate}
                  />
                ))}
                {hasMore && (
                  <button
                    type="button"
                    className="w-full px-4 py-2.5 text-xs font-medium text-accent-700 dark:text-accent-300 hover:bg-surface-base dark:hover:bg-border-subtle/50 transition-colors disabled:opacity-50"
                    onClick={() => loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
