'use client';

import { createContext, useContext, useCallback, useState, useEffect, type ReactNode } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api-client';
import { useAuth } from './auth-provider';
import type { Notification } from '@arbitra/shared';

interface NotificationContextValue {
  notifications: Notification[];
  /** TOTAL unread count across every page (issue #794 P0) — not just the loaded page's. */
  unreadCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  deleteNotification: (notificationId: string) => void;
}

/**
 * Exported (not just `useNotifications`) so `<NotificationCenter>` render
 * tests can supply a raw context value directly — no SWR/fetch mocking or
 * jsdom needed, matching this frontend's node-only,
 * `renderToStaticMarkup`-based test convention.
 */
export const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unreadCount: 0,
  hasMore: false,
  loadingMore: false,
  loadMore: () => {},
  markAsRead: () => {},
  markAllAsRead: () => {},
  deleteNotification: () => {},
});

const POLL_INTERVAL_MS = 30_000;
const PAGE_LIMIT = 30;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const shouldFetch = !loading && !!user;

  const { data, mutate } = useSWR(
    shouldFetch ? 'notifications' : null,
    () => api.notifications.list({ limit: PAGE_LIMIT }),
    {
      refreshInterval: POLL_INTERVAL_MS,
      revalidateOnFocus: true,
      // Silently fail -- notifications are non-critical
      onError: () => {},
    },
  );

  // Extra pages loaded via "Load more", appended after the polled first
  // page. Reset whenever a fresh first page arrives: `data` is a new object
  // on every successful poll/revalidation, so this effect fires exactly
  // then, discarding any already-loaded extra pages. That is a deliberate
  // simplification — merging a re-polled page 1 with pages fetched from an
  // OLDER page 1's cursor risks exactly the overlap/gap this feature exists
  // to avoid, and the drawer is normally open only briefly. The cost is a
  // "Load more" click needed again after a background poll; "Load more"
  // itself never re-fetches page 1, so it never duplicates or skips a row.
  const [morePages, setMorePages] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    setMorePages([]);
    setCursor(data?.next_cursor ?? null);
    if (data) setUnreadCount(data.unread_count);
  }, [data]);

  const notifications = [...(data?.notifications ?? []), ...morePages];
  const hasMore = cursor !== null;

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.notifications.list({ cursor, limit: PAGE_LIMIT });
      setMorePages((prev) => [...prev, ...page.notifications]);
      setCursor(page.next_cursor);
      setUnreadCount(page.unread_count);
    } catch {
      // Silent -- the "Load more" control simply remains clickable to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const markAsRead = useCallback(
    async (notificationId: string) => {
      let wasUnread = false;
      const flip = (n: Notification): Notification => {
        if (n.notification_id === notificationId && !n.read) wasUnread = true;
        return n.notification_id === notificationId ? { ...n, read: true } : n;
      };

      // Optimistic update across BOTH the polled first page and any extra
      // loaded pages -- the item being marked read can be on either.
      mutate(
        (current) => (current ? { ...current, notifications: current.notifications.map(flip) } : current),
        { revalidate: false },
      );
      setMorePages((prev) => prev.map(flip));
      if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        await api.notifications.markAsRead(notificationId);
      } catch {
        // Revert on failure
        mutate();
      }
    },
    [mutate],
  );

  const markAllAsRead = useCallback(async () => {
    if (unreadCount === 0) return;

    // Optimistic update across every loaded row; the bulk endpoint below
    // covers every unread row server-side regardless of what is loaded.
    mutate(
      (current) => (current
        ? { ...current, notifications: current.notifications.map((n) => ({ ...n, read: true })) }
        : current),
      { revalidate: false },
    );
    setMorePages((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);

    try {
      await api.notifications.markAllAsRead();
    } catch {
      mutate();
    }
  }, [mutate, unreadCount]);

  const deleteNotification = useCallback(
    async (notificationId: string) => {
      let wasUnread = false;
      const wasIn = (list: Notification[]) => {
        const found = list.find((n) => n.notification_id === notificationId);
        if (found && !found.read) wasUnread = true;
        return list.filter((n) => n.notification_id !== notificationId);
      };

      mutate(
        (current) => (current ? { ...current, notifications: wasIn(current.notifications) } : current),
        { revalidate: false },
      );
      setMorePages((prev) => wasIn(prev));
      if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        await api.notifications.delete(notificationId);
      } catch {
        // Revert on failure
        mutate();
      }
    },
    [mutate],
  );

  return (
    <NotificationContext.Provider
      value={{ notifications, unreadCount, hasMore, loadingMore, loadMore, markAsRead, markAllAsRead, deleteNotification }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
