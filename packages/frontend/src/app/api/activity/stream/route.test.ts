/**
 * @file SSE route guards — most importantly, that a `listActivity` query
 * resolving AFTER the client disconnects does NOT enqueue onto the closed
 * controller. Regression guard for the post-await cancellation race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ActivityEntry } from '@arbitra/shared';

const { listActivity, checkIsAdmin, authenticateFromHeader } = vi.hoisted(() => ({
  listActivity: vi.fn(),
  checkIsAdmin: vi.fn(),
  authenticateFromHeader: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  listActivity,
  checkIsAdmin,
  authenticateFromHeader,
  formatError: (error: unknown) => ({
    status: 500,
    body: {
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'error' },
    },
  }),
}));

import { GET } from './route';

function makeReq(url = 'http://localhost/api/activity/stream'): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  });
}

function makeReqWithoutHeader(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function makeEntry(id: string, ts: string): ActivityEntry {
  return {
    id,
    kind: 'case_event',
    subkind: 'case_created',
    timestamp: ts,
    case_id: 'case_1',
    summary: 'opened',
    href: '/cases/case_1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateFromHeader.mockResolvedValue({ userId: 'user_1' });
  checkIsAdmin.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Read the (already-closed) stream to the end and return the decoded text. */
async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe('GET /api/activity/stream — cancellation guard', () => {
  it('accepts the bearer token as a query param for EventSource clients', async () => {
    listActivity.mockResolvedValue({ entries: [], cursor: null });

    const res = await GET(makeReqWithoutHeader('http://localhost/api/activity/stream?token=query-token'));

    expect(res.status).toBe(200);
    expect(authenticateFromHeader).toHaveBeenCalledWith('Bearer query-token');
    await res.body?.cancel();
  });

  /** Reverts: the `arb_` guard in authenticateExport (api-helpers.ts). */
  it('rejects a long-lived access token passed as a query param', async () => {
    authenticateFromHeader.mockClear();
    const res = await GET(makeReqWithoutHeader('http://localhost/api/activity/stream?token=arb_0123456789abcdef')); // gitleaks:allow (fake token)

    expect(res.status).not.toBe(200);
    expect(authenticateFromHeader).not.toHaveBeenCalled();
  });

  it('does not enqueue onto a closed controller after the client disconnects', async () => {
    // Arrange a slow listActivity that resolves AFTER the request is aborted.
    // The route has already enqueued the `hello` and `retry:` frames during
    // start() — those are expected. Once the request is aborted and the
    // promise resolves, the route MUST NOT call enqueue again.
    let resolveSlow: (value: { entries: ActivityEntry[]; cursor: null | string }) => void = () => {};
    const slow = new Promise<{ entries: ActivityEntry[]; cursor: null | string }>((res) => {
      resolveSlow = res;
    });
    listActivity.mockImplementation(() => slow);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    // Drain the initial frames (`retry:` then `hello`) so we have a known
    // baseline. Each enqueue() lands as a separate chunk in this runtime.
    const decoder = new TextDecoder();
    let seenHello = false;
    for (let i = 0; i < 4 && !seenHello; i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      if (text.includes('event: hello')) seenHello = true;
    }
    expect(seenHello).toBe(true);

    // Cancel the consumer side — equivalent to the browser closing the
    // EventSource. The route's `cancel()` callback flips `cancelled = true`
    // via the abort signal handler and closes the controller.
    await reader.cancel();

    // Now resolve the in-flight listActivity. With the guard in place,
    // the post-await `if (cancelled) return;` short-circuits the loop body
    // before any further enqueue() is attempted. Without the guard, this
    // would throw "TypeError: Invalid state: Controller is already closed".
    resolveSlow({
      entries: [makeEntry('event:evt_1', '2026-05-06T10:00:00.000Z')],
      cursor: null,
    });

    // Give microtasks a chance to flush. If the guard regressed we'd see
    // an unhandled rejection from the route's loop here.
    await new Promise((r) => setTimeout(r, 10));

    // Sanity: no further reads succeed (the stream is closed).
    // Some runtimes throw on read() of a cancelled stream; either is fine,
    // we just need the consumer side to stay closed.
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

describe('GET /api/activity/stream — max-lifetime ceiling vs Cloud Run timeout', () => {
  // Cloud Run hard-kills requests at timeoutSeconds (300s in the reference deployment).
  // The route MUST end the stream with a graceful 'bye' before that, or
  // clients see a transport error and storm-reconnect.
  const CLOUD_RUN_TIMEOUT_MS = 300_000;

  it('emits bye and closes before Cloud Run timeoutSeconds even with zero jitter (worst case)', async () => {
    vi.useFakeTimers();
    // Math.random() = 0 → no jitter subtracted → the LONGEST possible
    // connection lifetime. Even that must stay under the 300s hard kill.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    listActivity.mockResolvedValue({ entries: [], cursor: null });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    // 4min ceiling + one 2s poll tick to cross the threshold + slack.
    const elapsed = 4 * 60 * 1000 + 4_000;
    expect(elapsed).toBeLessThan(CLOUD_RUN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(elapsed);

    // The stream is closed after 'bye', so draining terminates.
    const text = await drain(res.body!);
    expect(text).toContain('event: bye');
    expect(text).toContain('max-lifetime');
  });

  it('subtracts per-connection jitter so simultaneously opened streams expire at different instants', async () => {
    vi.useFakeTimers();
    // Math.random() ≈ 1 → full 30s jitter subtracted → lifetime ≈ 210s.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    listActivity.mockResolvedValue({ entries: [], cursor: null });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    // Well before the un-jittered 240s ceiling: bye already fired → proves
    // the jitter shifted this connection's expiry earlier.
    await vi.advanceTimersByTimeAsync(214_000);

    const text = await drain(res.body!);
    expect(text).toContain('event: bye');
    expect(text).toContain('max-lifetime');
  });

  it('does not emit bye before the jittered ceiling is reached', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    listActivity.mockResolvedValue({ entries: [], cursor: null });

    const res = await GET(makeReq());

    // 60s in: stream must still be open — no bye yet. Collect concurrently
    // so buffered frames don't block the timer advance.
    let collected = '';
    const decoder = new TextDecoder();
    const reader = res.body!.getReader();
    const collector = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        collected += decoder.decode(chunk.value, { stream: true });
      }
    })();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(collected).not.toContain('event: bye');
    expect(collected).toContain('event: hello');

    // Cleanly tear down: cancel the consumer (browser closing the tab).
    await reader.cancel();
    await collector;
  });
});
