import type { NextRequest } from 'next/server';
import { checkIsAdmin, listActivity } from '@arbitra/backend';
import { authenticateExport, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';
// SSE responses are inherently long-lived; opt out of any edge-cache.
export const fetchCache = 'force-no-store';

/**
 * Streaming mechanism: SSE (Server-Sent Events).
 *
 * Why SSE over WebSocket:
 *  - Built-in browser EventSource — no extra client deps.
 *  - One-way server→client fits the activity feed (no client→server pushes).
 *  - Works through standard HTTP/HTTPS — no Upgrade negotiation, no proxy
 *    headaches on Cloud Run.
 *  - Auto-reconnect is handled by the browser (with the `Last-Event-ID`
 *    header and `retry:` tuning).
 *
 * Architecture (deliberately minimal, no new infra):
 *  - There is no Firestore `onSnapshot` listener anywhere in the codebase
 *    (verified via `grep -r "onSnapshot|EventSource|WebSocket"`), and no
 *    event bus we can subscribe to. Rather than introduce one, this route
 *    runs a server-side polling loop that re-uses the existing
 *    `listActivity()` query path (the same one `/api/activity` calls).
 *  - Every POLL_INTERVAL_MS the loop fetches activity newer than the last
 *    emitted timestamp and pushes any new entries down the SSE stream.
 *  - The frontend `useActivityStream()` hook treats arrivals as deltas and
 *    merges them into the existing feed cache.
 *
 * Trade-offs:
 *  - Latency is bounded by POLL_INTERVAL_MS (default 2s) — same as the SWR
 *    poll it's meant to stand in for.
 *  - When/if a real Firestore listener lands later, this route can swap its
 *    poll loop for a snapshot subscription without changing the wire format.
 *  - Cost: the client's SWR poll and this route's server-side tick must not
 *    both run for the same tab, and a tick must not re-read the whole table.
 *    `since` is applied inside the Firestore queries, so an idle tick reads
 *    only the (empty) query results — 6 reads, one per source, Firestore's
 *    charge for a query that matches nothing — and cases/findings/projects
 *    are resolved only for the rows a tick actually returns. The client
 *    (`useActivityFeed` / `useActivityStream`) suspends its poll while this
 *    stream is open and closes the stream outright while the tab is hidden,
 *    so a backgrounded tab holds no connection and costs nothing.
 *
 *    Cost formula: reads/hour/tab =
 *    (3600 / (POLL_INTERVAL_MS / 1000)) × reads-per-tick. Idle, that's
 *    1800 ticks/hour × 6 reads ≈ 10,800 reads/h per open tab (an active tick
 *    costs more: the new docs found plus the cases/projects they reference).
 *    Polling every 2 s costs one read per matching document per tab, so keep
 *    the interval coarse; 2s latency is the UX property the feed is built
 *    around.
 *
 * Fallback: if the connection fails (unsupported browser, mid-flight 502,
 * proxy buffering), the client falls back to its SWR poll — see
 * `shouldPollFallback` in `use-activity-feed.ts`.
 */

// See the "Trade-offs" cost paragraph above for the reads/hour this drives.
const POLL_INTERVAL_MS = 2_000;
// Ping the client every 25s so intermediaries don't kill an idle connection.
// Cloud Run's default idle timeout is 60s; 25s leaves ample margin.
const KEEPALIVE_INTERVAL_MS = 25_000;
// Hard ceiling on a single connection's lifetime. The client hook reconnects
// with a fresh token; this protects against memory leaks on very long sessions.
//
// CONSTRAINT: this MUST stay safely below Cloud Run's request timeout
// (timeoutSeconds=300 in the reference deployment). If Cloud Run's timeout fires first it
// hard-kills the connection mid-stream — clients then see a transport error
// instead of the graceful 'bye' event and storm-reconnect in lockstep.
const MAX_CONNECTION_MS = 4 * 60 * 1000; // 4 minutes — well under the 300s kill
// Per-connection jitter SUBTRACTED from the max lifetime (0–30s). Streams
// opened at the same instant (e.g. many tabs after a deploy or a shared
// network blip) would otherwise all expire — and reconnect — at exactly the
// same moment, recreating the thundering herd the ceiling exists to prevent.
const MAX_CONNECTION_JITTER_MS = 30 * 1000;

export async function GET(request: NextRequest): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authenticateExport>>;
  let admin: boolean;
  const searchParams = request.nextUrl.searchParams;
  try {
    auth = await authenticateExport(request, searchParams.get('token'));
    admin = await checkIsAdmin(auth.userId);
  } catch (error) {
    return handleError(error);
  }

  const clientName = searchParams.get('client_name') ?? undefined;
  const projectId = searchParams.get('project_id') ?? undefined;
  const agentsOnly = searchParams.get('agents_only') === 'true';
  // The client passes its newest known timestamp so we don't replay rows
  // it already rendered. Falls back to "now" if absent.
  const initialSince = searchParams.get('since') ?? new Date().toISOString();

  const encoder = new TextEncoder();
  const userId = auth.userId;
  let cleanupStream: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cancelled = false;
      let latest = initialSince;
      const startedAt = Date.now();
      // Jittered per-connection ceiling — see MAX_CONNECTION_JITTER_MS above.
      const maxConnectionMs =
        MAX_CONNECTION_MS - Math.random() * MAX_CONNECTION_JITTER_MS;

      const send = (event: string, data: unknown) => {
        if (cancelled) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          cancelled = true;
        }
      };

      // Keep the standard SSE retry hint for native EventSource clients.
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      send('hello', { since: latest });

      const keepalive = setInterval(() => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          cancelled = true;
        }
      }, KEEPALIVE_INTERVAL_MS);

      const tick = async () => {
        if (cancelled) return;
        if (Date.now() - startedAt > maxConnectionMs) {
          // Structured lifecycle log so we can see how often the max-lifetime
          // ceiling fires in production (issue #567 item 12). Symmetric with
          // the other lifecycle signals on this route.
          console.info(
            '[activity/stream] bye',
            JSON.stringify({
              reason: 'max-lifetime',
              userId,
              connectionMs: Date.now() - startedAt,
            }),
          );
          send('bye', { reason: 'max-lifetime' });
          cleanup();
          return;
        }
        try {
          const result = await listActivity(userId, admin, {
            limit: 50,
            since: latest,
            ...(clientName ? { clientName } : {}),
            ...(projectId ? { projectId } : {}),
            ...(agentsOnly ? { agentsOnly } : {}),
          });
          // The query awaited above can resolve after the client disconnected
          // (or after the max-lifetime cleanup ran). Re-check `cancelled`
          // before touching the controller — `enqueue()` on a closed stream
          // throws and the entries would be lost anyway.
          if (cancelled) return;
          if (result.entries.length > 0) {
            // listActivity returns entries sorted desc; emit oldest-first so
            // the client can apply them in arrival order. Update `latest`
            // from the newest (the first) entry post-emit.
            const ordered = [...result.entries].reverse();
            for (const entry of ordered) send('activity', entry);
            const newest = result.entries[0]?.timestamp;
            if (newest) latest = newest;
          }
        } catch {
          // Soft-fail one tick; loop continues. If the loop becomes a hot
          // failure, clients reconnect with `retry:` after disconnect.
        }
      };

      // Self-rescheduling loop instead of setInterval — guarantees at most
      // ONE in-flight `listActivity` query per connection, even if a tick
      // ever takes longer than POLL_INTERVAL_MS. setInterval would stack
      // overlapping ticks and amplify load on slow queries.
      const loop = async () => {
        while (!cancelled) {
          await tick();
          if (cancelled) return;
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      };

      const cleanup = () => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // Ignore double-close.
        }
      };
      cleanupStream = cleanup;

      request.signal.addEventListener('abort', cleanup);

      // Kick off the poll loop; intentionally fire-and-forget — the loop
      // exits cleanly when `cancelled` flips.
      void loop();
    },
    cancel() {
      // Browser closed the EventSource. In tests and some runtimes this
      // arrives as ReadableStream.cancel() without also aborting the request
      // signal, so wire it to the same cleanup path.
      cleanupStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
