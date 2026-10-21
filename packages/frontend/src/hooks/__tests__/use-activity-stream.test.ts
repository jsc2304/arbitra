/**
 * @file use-activity-stream — URL contract + reconnect policy + connection
 * controller.
 *
 * The React hook itself uses `EventSource`, which we don't polyfill in the
 * node-only test environment. So we test the framework-free pieces the hook
 * composes (same idiom as `computeFeedStatus`):
 *   - `buildStreamUrl` — pure URL construction, the wire contract the
 *     backend route depends on.
 *   - `computeReconnectDelay` — the backoff policy that replaces a fixed
 *     3s reconnect (which synchronizes clients into a reconnect storm).
 *   - `createActivityStreamConnection` — the connection state machine,
 *     driven with a fake EventSource + fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  buildStreamUrl,
  computeReconnectDelay,
  createActivityStreamConnection,
  type EventSourceLike,
  type VisibilitySource,
} from '../use-activity-stream';

describe('buildStreamUrl', () => {
  it('omits all query params when filters/since are empty', () => {
    expect(buildStreamUrl({ filters: {}, since: null })).toBe('/api/activity/stream');
  });

  it('includes since when provided', () => {
    expect(
      buildStreamUrl({ filters: {}, since: '2026-05-06T10:00:00.000Z' }),
    ).toBe('/api/activity/stream?since=2026-05-06T10%3A00%3A00.000Z');
  });

  it('includes token when provided because EventSource cannot send Authorization headers', () => {
    expect(
      buildStreamUrl({ filters: {}, since: null, token: 'firebase-token' }),
    ).toBe('/api/activity/stream?token=firebase-token');
  });

  it('includes client_name + project_id + agents_only — matches /api/activity contract', () => {
    const url = buildStreamUrl({
      filters: { clientName: 'cursor', projectId: 'proj_a', agentsOnly: true },
      since: null,
    });
    expect(url).toContain('client_name=cursor');
    expect(url).toContain('project_id=proj_a');
    expect(url).toContain('agents_only=true');
  });

  it('skips agentsOnly when false (avoids accidentally pinning the server-side filter)', () => {
    const url = buildStreamUrl({
      filters: { agentsOnly: false },
      since: null,
    });
    expect(url).not.toContain('agents_only');
  });
});

// ---------------------------------------------------------------------------
// computeReconnectDelay — exponential backoff + full jitter. Replaces a
// fixed 3s delay that synchronizes every client into a reconnect storm
// (Cloud Run 429 "Rate exceeded.").
// ---------------------------------------------------------------------------
describe('computeReconnectDelay', () => {
  it('error backoff grows exponentially: 1s, 2s, 4s, 8s ... (random=1 → full delay)', () => {
    const at = (attempt: number) =>
      computeReconnectDelay({ reason: 'error', attempt, random: 0.999999 });
    expect(at(0)).toBeCloseTo(1_000, -1);
    expect(at(1)).toBeCloseTo(2_000, -1);
    expect(at(2)).toBeCloseTo(4_000, -1);
    expect(at(3)).toBeCloseTo(8_000, -1);
  });

  it('caps the error backoff at 30s', () => {
    const delay = computeReconnectDelay({
      reason: 'error',
      attempt: 20,
      random: 0.999999,
    });
    expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
    expect(delay).toBeGreaterThan(RECONNECT_MAX_DELAY_MS / 2);
  });

  it('applies full jitter: delay lands in [delay/2, delay)', () => {
    // attempt 2 → un-jittered delay = 4000.
    const floor = computeReconnectDelay({ reason: 'error', attempt: 2, random: 0 });
    const ceil = computeReconnectDelay({ reason: 'error', attempt: 2, random: 0.999999 });
    expect(floor).toBe(2_000);
    expect(ceil).toBeLessThan(4_000.01);
    expect(ceil).toBeGreaterThan(3_999);
  });

  it("graceful 'bye' rotations reconnect fast but jittered: 500–1500ms", () => {
    expect(computeReconnectDelay({ reason: 'bye', attempt: 0, random: 0 })).toBe(500);
    expect(
      computeReconnectDelay({ reason: 'bye', attempt: 0, random: 0.999999 }),
    ).toBeCloseTo(1_500, 0);
    // Attempt count is irrelevant for graceful rotations.
    expect(computeReconnectDelay({ reason: 'bye', attempt: 9, random: 0 })).toBe(500);
  });

  it('first error attempt uses the documented base delay', () => {
    expect(
      computeReconnectDelay({ reason: 'error', attempt: 0, random: 0 }),
    ).toBe(RECONNECT_BASE_DELAY_MS / 2);
  });
});

// ---------------------------------------------------------------------------
// createActivityStreamConnection — drive the state machine with a fake
// EventSource. Verifies: backoff growth across consecutive errors, attempt
// reset on 'hello', fast 'bye' reconnect, and the getToken() failure guard.
// ---------------------------------------------------------------------------

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Set<Listener>>();
  closedByClient = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closedByClient = true;
  }

  emit(type: string, data = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>);
    }
  }
}

/** Flush the microtask queue so the controller's async connect() settles. */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createActivityStreamConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function open({
    getToken = async () => 'tok',
    random = () => 0.999999, // deterministic: always the top of the jitter band
    onConnectionChange = undefined as
      | ((state: 'open' | 'closed' | 'error') => void)
      | undefined,
  } = {}) {
    const events: unknown[] = [];
    const connection = createActivityStreamConnection({
      getUrl: (token) => `/api/activity/stream?token=${token ?? 'none'}`,
      getToken,
      onEvent: (entry) => events.push(entry),
      onConnectionChange,
      createEventSource: (url) => new FakeEventSource(url),
      random,
    });
    return { connection, events };
  }

  it('escalates the reconnect delay across consecutive errors (1s → 2s → 4s)', async () => {
    const { connection } = open();
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);

    // 1st error: with random≈1 the delay is the full base (≈1000ms).
    FakeEventSource.instances[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(990);
    expect(FakeEventSource.instances).toHaveLength(1); // not yet
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances).toHaveLength(2);

    // 2nd consecutive error: ≈2000ms.
    FakeEventSource.instances[1]!.emit('error');
    await vi.advanceTimersByTimeAsync(1_980);
    expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(40);
    expect(FakeEventSource.instances).toHaveLength(3);

    // 3rd consecutive error: ≈4000ms.
    FakeEventSource.instances[2]!.emit('error');
    await vi.advanceTimersByTimeAsync(3_960);
    expect(FakeEventSource.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(80);
    expect(FakeEventSource.instances).toHaveLength(4);

    connection.close();
  });

  it("resets the backoff when 'hello' arrives (successful open)", async () => {
    const { connection } = open();
    await flushMicrotasks();

    // Escalate twice: attempt counter now at 2 (next error delay would be 4s).
    FakeEventSource.instances[0]!.emit('error');
    await vi.advanceTimersByTimeAsync(1_010);
    FakeEventSource.instances[1]!.emit('error');
    await vi.advanceTimersByTimeAsync(2_020);
    expect(FakeEventSource.instances).toHaveLength(3);

    // Successful open resets the counter...
    FakeEventSource.instances[2]!.emit('hello');
    // ...so the next error backs off from the base again (≈1000ms, not 4s).
    FakeEventSource.instances[2]!.emit('error');
    await vi.advanceTimersByTimeAsync(1_010);
    expect(FakeEventSource.instances).toHaveLength(4);

    connection.close();
  });

  it("reconnects fast (but jittered) after a graceful server 'bye'", async () => {
    const states: string[] = [];
    const { connection } = open({
      onConnectionChange: (state) => states.push(state),
    });
    await flushMicrotasks();

    FakeEventSource.instances[0]!.emit('hello');
    FakeEventSource.instances[0]!.emit('bye');
    // A graceful rotation is reported as 'closed', never 'error'.
    expect(states).toEqual(['open', 'closed']);

    // random≈1 → bye delay ≈1500ms. Old source closed, new one after delay.
    expect(FakeEventSource.instances[0]!.closedByClient).toBe(true);
    await vi.advanceTimersByTimeAsync(1_490);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeEventSource.instances).toHaveLength(2);

    connection.close();
  });

  it('schedules a backoff reconnect when getToken() throws instead of dying silently', async () => {
    let calls = 0;
    const states: string[] = [];
    const { connection } = open({
      getToken: async () => {
        calls += 1;
        if (calls === 1) throw new Error('auth backend down');
        return 'tok';
      },
      onConnectionChange: (state) => states.push(state),
    });
    await flushMicrotasks();

    // First connect failed before any EventSource was created — but a retry
    // is scheduled (previously the rejection killed the stream silently).
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(states).toEqual(['error']);

    await vi.advanceTimersByTimeAsync(1_010);
    expect(calls).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(1);

    connection.close();
  });

  it('forwards pushed activity entries and stops everything on close()', async () => {
    const { connection, events } = open();
    await flushMicrotasks();

    FakeEventSource.instances[0]!.emit(
      'activity',
      JSON.stringify({ id: 'evt_1', summary: 'opened' }),
    );
    expect(events).toEqual([{ id: 'evt_1', summary: 'opened' }]);

    // Malformed payloads are dropped silently.
    FakeEventSource.instances[0]!.emit('activity', 'not-json');
    expect(events).toHaveLength(1);

    connection.close();
    expect(FakeEventSource.instances[0]!.closedByClient).toBe(true);

    // No zombie reconnects after close — even if an error raced the close.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createActivityStreamConnection — hidden-tab pause. A fake VisibilitySource
// drives the same 'visibilitychange'-shaped contract `documentVisibilitySource`
// wraps, without touching jsdom (the suite is node-only).
// ---------------------------------------------------------------------------

class FakeVisibility implements VisibilitySource {
  hidden: boolean;
  private listeners = new Set<() => void>();

  constructor(hidden = false) {
    this.hidden = hidden;
  }

  isHidden(): boolean {
    return this.hidden;
  }

  /** Number of still-subscribed listeners — lets a test observe the
   *  unsubscribe itself, not just its downstream effect. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Flip visibility and notify subscribers, like a real 'visibilitychange'. */
  emit(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

function openWithVisibility({
  visibility,
  getUrl,
  onConnectionChange,
  getToken = async () => 'tok',
  random = () => 0.999999,
}: {
  visibility: VisibilitySource;
  getUrl: (token: string | null) => string;
  onConnectionChange?: (state: 'open' | 'closed' | 'error') => void;
  getToken?: () => Promise<string | null>;
  random?: () => number;
}) {
  const connection = createActivityStreamConnection({
    getUrl,
    getToken,
    onEvent: () => {},
    onConnectionChange,
    createEventSource: (url) => new FakeEventSource(url),
    random,
    visibility,
  });
  return { connection };
}

describe('createActivityStreamConnection — hidden-tab pause', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Fails if the hidden-branch body at use-activity-stream.ts:309-317 (the
  // `visibility.isHidden()` arm of the subscribe callback) is reverted to a
  // no-op — the open EventSource would stay open and no 'closed' event fire.
  it('hidden tab: closes the open EventSource, reports closed, leaves no pending timer', async () => {
    const visibility = new FakeVisibility(false);
    const states: string[] = [];
    const { connection } = openWithVisibility({
      visibility,
      getUrl: () => '/api/activity/stream?since=A',
      onConnectionChange: (state) => states.push(state),
    });
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);
    const opened = FakeEventSource.instances[0]!;

    visibility.emit(true);

    expect(opened.closedByClient).toBe(true);
    expect(states).toEqual(['closed']);
    expect(vi.getTimerCount()).toBe(0);

    connection.close();
  });

  // Fails if the visible-branch reconnect at use-activity-stream.ts:318-327
  // (`paused = false; attempt = 0; void connect();`) is removed — the
  // connection would stay paused forever after the tab is shown again.
  it('visible after hidden: reconnects exactly once, re-invoking getUrl with the freshest since', async () => {
    let since = 'A';
    const visibility = new FakeVisibility(false);
    const { connection } = openWithVisibility({
      visibility,
      getUrl: (token) => `/api/activity/stream?since=${since}&token=${token ?? 'none'}`,
    });
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toContain('since=A');

    visibility.emit(true); // hide
    // Caller's `since` ref moves on while paused (e.g. a poll or another
    // tick updated it) — the reconnect must read the fresh value, not the
    // one captured at first connect.
    since = 'B';
    visibility.emit(false); // visible again
    await flushMicrotasks();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('since=B');
    expect(FakeEventSource.instances[1]!.url).not.toBe(FakeEventSource.instances[0]!.url);

    connection.close();
  });

  // Fails if the construction-time check at use-activity-stream.ts:329-333
  // (`if (visibility.isHidden()) { paused = true; } else { void connect(); }`)
  // is replaced with an unconditional `void connect()` — a tab that starts
  // hidden would open a connection immediately.
  it('constructed while hidden: opens no EventSource until the tab becomes visible', async () => {
    const visibility = new FakeVisibility(true);
    const { connection } = openWithVisibility({
      visibility,
      getUrl: () => '/api/activity/stream',
    });
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(0);

    visibility.emit(false);
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);

    connection.close();
  });

  // Fails if the `clearTimeout(reconnectTimer)` inside the hidden branch at
  // use-activity-stream.ts:312-315 is dropped — the stale error-reconnect
  // timer would still fire later and open an unwanted EventSource while
  // paused (scheduleReconnect's own `paused` guard at line 298 is a second,
  // independent backstop this test does not exercise).
  it("error then hidden: cancels the pending reconnect timer, no reconnect while paused", async () => {
    const visibility = new FakeVisibility(false);
    const { connection } = openWithVisibility({
      visibility,
      getUrl: () => '/api/activity/stream',
    });
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0]!.emit('error');
    expect(vi.getTimerCount()).toBe(1); // reconnect timer scheduled

    visibility.emit(true);
    expect(vi.getTimerCount()).toBe(0); // cancelled, not just paused-and-pending

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS + 1_000);
    expect(FakeEventSource.instances).toHaveLength(1); // no reconnect fired

    connection.close();
  });

  // Fails if `close()` stops calling `unsubscribeVisibility?.();`
  // (use-activity-stream.ts:341) — the listener count would stay 1 instead
  // of dropping to 0. That line is the one this test guards directly; the
  // "no EventSource after a later visible emit" checks below are a
  // secondary check only — `connect()`'s own `closed` guard already
  // prevents the reopen even without the unsubscribe, so they alone
  // wouldn't fail if that line were removed.
  it('close() unsubscribes from visibility: a later visible event opens nothing', async () => {
    const visibility = new FakeVisibility(true);
    const { connection } = openWithVisibility({
      visibility,
      getUrl: () => '/api/activity/stream',
    });
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(visibility.listenerCount).toBe(1);

    connection.close();
    expect(visibility.listenerCount).toBe(0);

    visibility.emit(false);
    await flushMicrotasks();

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  // Fails if the `visibility` parameter default path (the plain `else { void
  // connect(); }` at use-activity-stream.ts:334-336) is removed or gated
  // behind `visibility` being required — existing callers (and the tests
  // above this describe block) that never pass `visibility` would stop
  // connecting at all.
  it('without a visibility option: connects immediately, unaffected by the pause machinery', async () => {
    const connection = createActivityStreamConnection({
      getUrl: () => '/api/activity/stream',
      getToken: async () => 'tok',
      onEvent: () => {},
      createEventSource: (url) => new FakeEventSource(url),
      random: () => 0.999999,
      // `visibility` deliberately omitted.
    });
    await flushMicrotasks();
    expect(FakeEventSource.instances).toHaveLength(1);
    connection.close();
  });
});
