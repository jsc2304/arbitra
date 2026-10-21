'use client';

import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import type { WorkspaceEvent } from '@arbitra/shared';
import { SideDrawer } from '../shared/side-drawer';
import { api } from '../../lib/api-client';
import { RelativeTime } from '../shared/relative-time';
import { useCanResolveWorkspaceEvent } from '../../hooks/use-can-resolve-workspace-event';
import { useUserMap } from '../../hooks/use-users';
import { pickBlock } from './workspace-event-blocks';

interface WorkspaceEventDrawerProps {
  /**
   * The workspace-event id to detail. `null` keeps the drawer closed. We
   * accept `string | null` rather than a separate `open` + `eventId` pair so
   * parents only manage a single piece of state (the selected id).
   */
  eventId: string | null;
  onClose: () => void;
}

/**
 * Title shown in the drawer header. Picked per event-type so operators see
 * the intent of the event rather than the raw enum value. Unknown types get
 * a humanized fallback (snake_case → "Snake Case").
 */
function titleFor(event: WorkspaceEvent | undefined, fallbackId: string | null): string {
  if (!event) return 'Event details';
  switch (event.type) {
    case 'webhook_misconfigured':
      return 'Webhook subscription missing pull_request';
    case 'intelligence_run':
      return 'Intelligence run';
    default:
      return humanize(event.type) || `Event ${fallbackId ?? ''}`.trim();
  }
}

function humanize(value: string): string {
  if (!value) return '';
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Drawer that fetches and renders a full `WorkspaceEvent` payload. The body
 * is delegated to a per-type block from the registry (`pickBlock`); unknown
 * types fall back to a JSON dump so operators can still inspect raw evidence.
 *
 * SWR key is `workspace-event:<id>` so repeat opens hit cache. We do NOT
 * revalidate on focus — workspace events are immutable once recorded. A
 * cache miss triggers a single fetch; subsequent opens reuse it.
 */
export function WorkspaceEventDrawer({ eventId, onClose }: WorkspaceEventDrawerProps) {
  const open = eventId !== null;

  // Only fetch when the drawer is open. Passing `null` as the SWR key skips
  // the fetch so we don't hit `/api/workspace-events/null` on initial mount.
  const { data, error, isLoading, mutate } = useSWR<WorkspaceEvent>(
    eventId ? `workspace-event:${eventId}` : null,
    () => api.workspaceEvents.get(eventId as string),
    { revalidateOnFocus: false },
  );

  return (
    <SideDrawer open={open} onClose={onClose} title={titleFor(data, eventId)} width="lg">
      {isLoading && !data ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading event…</div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          Could not load this event: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : data ? (
        <WorkspaceEventBody
          event={data}
          onMutated={mutate}
          onClose={onClose}
        />
      ) : (
        // `eventId` present but neither loading nor erroring and no data ever
        // arrived — happens in tests with a stubbed SWR that returns nothing.
        // Render an empty state instead of leaving the panel visually blank.
        <div className="text-sm text-gray-500 dark:text-gray-400">No event selected.</div>
      )}
    </SideDrawer>
  );
}

function WorkspaceEventBody({
  event,
  onMutated,
  onClose,
}: {
  event: WorkspaceEvent;
  onMutated: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const Block = pickBlock(event.type);
  return (
    <div className="flex flex-col gap-5">
      {event.resolved_at && <ResolvedBanner event={event} />}

      {event.summary && (
        <p className="text-sm text-gray-800 dark:text-gray-200">{event.summary}</p>
      )}

      <div>
        <Block event={event} />
      </div>

      <WorkspaceEventTimeline event={event} />

      {!event.resolved_at && (
        <WorkspaceEventActions
          event={event}
          onMutated={onMutated}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function ResolvedBanner({ event }: { event: WorkspaceEvent }) {
  // Resolve the resolver's display name lazily; fall back to the raw id
  // (e.g. `usr_123`) so the banner never renders a blank "by ".
  const userMap = useUserMap(event.resolved_by ? [event.resolved_by] : []);
  const actor = event.resolved_by ? userMap[event.resolved_by] : undefined;
  const actorLabel = actor?.display_name || actor?.email || event.resolved_by || 'unknown';
  return (
    <div
      role="status"
      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200"
    >
      Resolved <RelativeTime timestamp={event.resolved_at ?? event.timestamp} />{' '}
      by {actorLabel}
    </div>
  );
}

/**
 * Footer action row. "Dismiss for me" is always rendered for authenticated
 * users. "Mark resolved" is gated behind admin OR tech_lead — we only
 * render it once the role check has settled (no one-frame flash).
 */
function WorkspaceEventActions({
  event,
  onMutated,
  onClose,
}: {
  event: WorkspaceEvent;
  onMutated: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const { canResolve, isLoading: roleLoading } = useCanResolveWorkspaceEvent();
  const { mutate: globalMutate } = useSWRConfig();
  const [pending, setPending] = useState<'resolve' | 'dismiss' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** Revalidate every activity-feed SWR key so the removed row disappears. */
  const bumpActivityFeed = () =>
    globalMutate(
      (key: unknown) => Array.isArray(key) && typeof key[0] === 'string' && key[0].startsWith('activity:'),
      undefined,
      { revalidate: true },
    );

  const onResolve = async () => {
    if (pending) return;
    setPending('resolve');
    setErr(null);
    try {
      await api.workspaceEvents.resolve(event.event_id);
      await onMutated();
      await bumpActivityFeed();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to resolve');
    } finally {
      setPending(null);
    }
  };

  const onDismiss = async () => {
    if (pending) return;
    setPending('dismiss');
    setErr(null);
    try {
      await api.workspaceEvents.dismiss(event.event_id);
      await bumpActivityFeed();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to dismiss');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-gray-100 pt-3 dark:border-border-subtle">
      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {err}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          disabled={pending !== null}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60 dark:border-border-subtle dark:bg-surface-1 dark:text-gray-200 dark:hover:bg-surface-2"
        >
          {pending === 'dismiss' ? 'Dismissing…' : 'Dismiss for me'}
        </button>
        {!roleLoading && canResolve && (
          <button
            type="button"
            onClick={onResolve}
            disabled={pending !== null}
            className="rounded-md border border-transparent bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
          >
            {pending === 'resolve' ? 'Resolving…' : 'Mark resolved'}
          </button>
        )}
      </div>
    </div>
  );
}

function WorkspaceEventTimeline({ event }: { event: WorkspaceEvent }) {
  return (
    <div className="border-t border-gray-100 dark:border-border-subtle pt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Timeline
      </div>
      <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        <RelativeTime timestamp={event.timestamp} prefix="Emitted" />
      </div>
    </div>
  );
}
