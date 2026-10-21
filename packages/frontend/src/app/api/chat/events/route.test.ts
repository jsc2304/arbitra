/**
 * @file route — POST /api/chat/events wiring tests.
 *
 * Token verification itself is covered exhaustively (real signed JWTs,
 * mocked cert-fetch only) in `@/lib/chat-auth.test.ts`. Here `chat-auth` is
 * mocked outright — these tests are about the route's OWN wiring: does a
 * failed check short-circuit to a detail-free 401 before the body is ever
 * parsed, and does each acknowledged event type return the no-op shape
 * Google Chat expects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  verifyChatEventTokenMock,
  mapChatIdentityMock,
  intakeMock,
  intakeFollowUpMock,
  getCaseMock,
  resolveChatThreadCaseMock,
  recordChatThreadTipMock,
  resolveUserChatConversationWindowMock,
  shouldRestartChatConversationMock,
  scheduleAssistantRunDispatchMock,
  resolveCaseShareUrlMock,
  chatReplyPostMock,
} = vi.hoisted(() => ({
  verifyChatEventTokenMock: vi.fn(),
  mapChatIdentityMock: vi.fn(),
  intakeMock: vi.fn(),
  intakeFollowUpMock: vi.fn(),
  getCaseMock: vi.fn(),
  resolveChatThreadCaseMock: vi.fn(),
  recordChatThreadTipMock: vi.fn(),
  // chat DM conversation-window feature: only ever consulted for a `direct`
  // sender (see `route.ts`'s `runChatIntake`) — none of the pre-existing
  // fixtures below set `spaceType`, so `resolveChatSender` resolves
  // `conversationKind: 'space'` for all of them and neither mock is called
  // on those tests at all.
  resolveUserChatConversationWindowMock: vi.fn(),
  shouldRestartChatConversationMock: vi.fn(),
  scheduleAssistantRunDispatchMock: vi.fn(),
  resolveCaseShareUrlMock: vi.fn(),
  chatReplyPostMock: vi.fn(),
}));

vi.mock('@/lib/chat-auth', () => ({ verifyChatEventToken: verifyChatEventTokenMock }));
// The whole point of this mock is that NONE of the pre-existing tests below
// exercise it: every add-on-shape fixture in this file omits `user.type`,
// which `resolveChatSender` fails closed on (`non_human`) before
// `mapChatIdentity` is ever reached — see `chat-sender.test.ts`. Only the
// dedicated "identity mapping" describe block below sets `type: 'HUMAN'`.
// `AssistantIntakeService`/`CaseService` are added for the Slice F intake
// wiring describe block further down — same minimal fake-class pattern as
// `api/assistant/tasks/route.test.ts`, not a typed re-implementation.
// `getChatReplyPoster` used to be mocked separately via a LOCAL
// `./chat-reply` placeholder module; that file is gone (route.ts now
// imports the real poster from `@arbitra/backend`, reconciled with the
// sibling PR that landed it), so the fake poster now lives on this same
// `@arbitra/backend` mock factory instead. These tests are still about
// THIS route's wiring — which outcome posts what, with which target — not
// `GoogleChatReplyPoster`'s own delivery logic, which
// `chat-reply-poster.test.ts` covers.
vi.mock('@arbitra/backend', () => ({
  mapChatIdentity: mapChatIdentityMock,
  resolveChatThreadCase: resolveChatThreadCaseMock,
  recordChatThreadTip: recordChatThreadTipMock,
  resolveUserChatConversationWindow: resolveUserChatConversationWindowMock,
  shouldRestartChatConversation: shouldRestartChatConversationMock,
  getChatReplyPoster: () => ({ post: chatReplyPostMock }),
  AssistantIntakeService: class {
    intake = intakeMock;
    intakeFollowUp = intakeFollowUpMock;
  },
  CaseService: class {
    getCase = getCaseMock;
  },
}));
vi.mock('@/lib/assistant-run-dispatch', () => ({
  scheduleAssistantRunDispatch: scheduleAssistantRunDispatchMock,
}));
vi.mock('@/lib/public-base-url', () => ({ resolveCaseShareUrl: resolveCaseShareUrlMock }));

import { POST } from './route';
import { classifyChatEvent, summarizePayloadShape } from './event-shape';
import { __resetRateLimit, __trackedIpCount, checkChatEventsRateLimit } from './rate-limit';

function makeReq(body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/chat/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The rate limiter is an in-memory, module-level Map — without this,
  // counters from one test would carry into the next. See the dedicated
  // isolation test at the bottom of this file.
  __resetRateLimit();
  // Slice F intake defaults: a poster that "delivers" successfully, no
  // recorded thread yet, and no public base URL to build a share link
  // from. Every test in the dedicated intake describe block below
  // overrides only what it needs on top of these.
  chatReplyPostMock.mockResolvedValue({ ok: true });
  resolveChatThreadCaseMock.mockResolvedValue(undefined);
  // Safe defaults for the two chat DM conversation-window mocks — never
  // actually consulted by any pre-existing (space-keyed) fixture, but set
  // here so a test that forgets to override them fails loudly on an
  // assertion rather than on an unconfigured mock resolving `undefined`.
  resolveUserChatConversationWindowMock.mockResolvedValue('continuous');
  shouldRestartChatConversationMock.mockReturnValue(false);
  resolveCaseShareUrlMock.mockReturnValue(null);
});

describe('POST /api/chat/events — auth wiring', () => {
  /**
   * Reverting `if (!auth.ok) { ...; return NextResponse.json(..., { status:
   * 401 }); }` (e.g. letting an unverified request fall through to
   * `dispatchEvent`) breaks this.
   */
  it('returns 401 when the token is rejected', async () => {
    verifyChatEventTokenMock.mockResolvedValueOnce({ ok: false, reason: 'token_verification_failed' });
    const res = await POST(makeReq({ type: 'MESSAGE' }));
    expect(res.status).toBe(401);
  });

  /**
   * Reverting the 401 branch's response body to include `auth.reason`
   * (instead of the generic `UNAUTHORIZED` message) breaks this — the
   * verification-internal reason must never reach an unauthenticated
   * caller.
   */
  it('does not leak the verification failure reason in the response body', async () => {
    verifyChatEventTokenMock.mockResolvedValueOnce({
      ok: false,
      reason: 'audience_mismatch_should_never_appear',
    });
    const res = await POST(makeReq({ type: 'MESSAGE' }));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('audience_mismatch_should_never_appear');
  });

  /**
   * Reverting the `try { event = (await request.json())...} catch {
   * return NextResponse.json(..., { status: 400 }); }` wrapper (e.g.
   * dispatching on `{}` regardless of what the body actually was) breaks
   * this.
   */
  it('returns 400 for an unparsable body once the token verifies', async () => {
    verifyChatEventTokenMock.mockResolvedValueOnce({ ok: true });
    const req = new NextRequest('http://localhost/api/chat/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  /**
   * Reverting the log call's `aud_unverified: auth.aud, iss_unverified:
   * auth.iss` back to `aud: auth.aud, iss: auth.iss` breaks this — the
   * renamed keys are what make a failure-path log line visibly distinct
   * from the authoritative success-path log, so a forged rejection can
   * never be mistaken for evidence of the real audience.
   */
  it('logs failure-path claims under aud_unverified/iss_unverified, never aud/iss', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    verifyChatEventTokenMock.mockResolvedValueOnce({
      ok: false,
      reason: 'token_verification_failed',
      aud: 'attacker-claimed-audience',
      iss: 'chat@system.gserviceaccount.com',
    });
    await POST(makeReq({ type: 'MESSAGE' }));

    expect(warnSpy).toHaveBeenCalledWith(
      '[chat/events] token verification failed',
      expect.objectContaining({
        aud_unverified: 'attacker-claimed-audience',
        iss_unverified: 'chat@system.gserviceaccount.com',
      }),
    );
    const loggedArg = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(loggedArg).not.toHaveProperty('aud');
    expect(loggedArg).not.toHaveProperty('iss');
    warnSpy.mockRestore();
  });

  /**
   * Reverting the route's `if (auth.reason === 'identity_mismatch')`
   * branch (e.g. collapsing it back into the single `aud_unverified` /
   * `iss_unverified` log) breaks this — on this branch chat-auth.ts has
   * already verified the payload (signature, audience, expiry, issuer),
   * so `auth.aud`/`auth.iss` are trustworthy and must be logged under
   * their real names, alongside the classified `rejectedIdentity` /
   * `emailVerifiedState` chat-auth.ts computed for exactly this purpose.
   */
  it('logs identity_mismatch claims under trusted aud/iss names, plus the classified identity and email_verified state', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    verifyChatEventTokenMock.mockResolvedValueOnce({
      ok: false,
      reason: 'identity_mismatch',
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      rejectedIdentity: 'chat@system.gserviceaccount.com',
      emailVerifiedState: 'true',
    });
    await POST(makeReq({ type: 'MESSAGE' }));

    expect(warnSpy).toHaveBeenCalledWith('[chat/events] token verification failed', {
      reason: 'identity_mismatch',
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      rejected_identity: 'chat@system.gserviceaccount.com',
      email_verified: 'true',
    });
    const loggedArg = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(loggedArg).not.toHaveProperty('aud_unverified');
    expect(loggedArg).not.toHaveProperty('iss_unverified');
    warnSpy.mockRestore();
  });
});

describe('POST /api/chat/events — event dispatch', () => {
  beforeEach(() => {
    verifyChatEventTokenMock.mockResolvedValue({
      ok: true,
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      email: 'chat@system.gserviceaccount.com',
    });
  });

  /** Reverting the `case 'ADDED_TO_SPACE': return NextResponse.json({});` branch (e.g. removing it) breaks this. */
  it('acknowledges ADDED_TO_SPACE with 200', async () => {
    const res = await POST(makeReq({ type: 'ADDED_TO_SPACE' }));
    expect(res.status).toBe(200);
  });

  /** Reverting the `case 'REMOVED_FROM_SPACE': return NextResponse.json({});` branch breaks this. */
  it('acknowledges REMOVED_FROM_SPACE with 200', async () => {
    const res = await POST(makeReq({ type: 'REMOVED_FROM_SPACE' }));
    expect(res.status).toBe(200);
  });

  /** Reverting the `case 'MESSAGE': return NextResponse.json({});` branch breaks this. */
  it('acknowledges MESSAGE with 200', async () => {
    const res = await POST(makeReq({ type: 'MESSAGE', message: { text: 'hi' } }));
    expect(res.status).toBe(200);
  });

  /**
   * Reverting the `default:` branch of `dispatchEvent` to something other
   * than an acknowledged no-op (e.g. a 4xx for anything unrecognized)
   * breaks this — the console sends every trigger type to this one shared
   * endpoint, so a type this route doesn't know yet must still ack cleanly.
   */
  it('acknowledges an unrecognized event type as a no-op instead of erroring', async () => {
    const res = await POST(makeReq({ type: 'SOME_FUTURE_EVENT_TYPE' }));
    expect(res.status).toBe(200);
  });

  /**
   * Reverting `if (!event || typeof event !== 'object') return
   * NextResponse.json({});` breaks this — `JSON.parse('null')` succeeds,
   * so without the guard `switch (event.type)` throws on `null` and the
   * call rejects instead of resolving 200. Neighbouring shapes (`[]`,
   * `"str"`, `5`, `true`) already ack 200 without this guard, since `.type`
   * on any of those is just `undefined`, not a throw.
   */
  it('acknowledges a null JSON body with 200 instead of throwing', async () => {
    const res = await POST(makeReq(null));
    expect(res.status).toBe(200);
  });
});

/**
 * `classifyChatEvent` recognizes the add-on envelope (Google Workspace
 * add-on extending Google Chat — the shape this app is actually
 * registered as) in addition to the classic Chat-API `type` field. See
 * `route.ts`'s module doc and `classifyChatEvent`'s own doc comment for
 * why both shapes exist and why only three of the six documented add-on
 * union keys are mapped.
 */
describe('classifyChatEvent — add-on and classic envelope discriminator', () => {
  /**
   * Reverting `if (payload['addedToSpacePayload'] !== undefined) return
   * 'ADDED_TO_SPACE';` (e.g. deleting the line) breaks this.
   */
  it('classifies the add-on shape via chat.addedToSpacePayload', () => {
    const result = classifyChatEvent({
      chat: { user: { name: 'users/123' }, addedToSpacePayload: { space: { name: 'spaces/AAA' } } },
    });
    expect(result).toBe('ADDED_TO_SPACE');
  });

  /**
   * Reverting `if (payload['removedFromSpacePayload'] !== undefined)
   * return 'REMOVED_FROM_SPACE';` breaks this.
   */
  it('classifies the add-on shape via chat.removedFromSpacePayload', () => {
    const result = classifyChatEvent({
      chat: { user: { name: 'users/123' }, removedFromSpacePayload: { space: { name: 'spaces/AAA' } } },
    });
    expect(result).toBe('REMOVED_FROM_SPACE');
  });

  /**
   * Reverting `if (payload['messagePayload'] !== undefined) return
   * 'MESSAGE';` breaks this.
   */
  it('classifies the add-on shape via chat.messagePayload', () => {
    const result = classifyChatEvent({
      chat: { user: { name: 'users/123' }, messagePayload: { message: { text: 'hi' } } },
    });
    expect(result).toBe('MESSAGE');
  });

  /**
   * Reverting the classic-shape branch's ternary (`return event.type ===
   * 'ADDED_TO_SPACE' || ... ? event.type : undefined;`) to always return
   * `undefined` breaks this — the classic shape must keep working, even
   * though this deployment's registration never actually sends it.
   */
  it('still classifies the classic shape by top-level type', () => {
    expect(classifyChatEvent({ type: 'ADDED_TO_SPACE' })).toBe('ADDED_TO_SPACE');
    expect(classifyChatEvent({ type: 'REMOVED_FROM_SPACE' })).toBe('REMOVED_FROM_SPACE');
    expect(classifyChatEvent({ type: 'MESSAGE' })).toBe('MESSAGE');
  });
});

describe('POST /api/chat/events — add-on envelope wiring through dispatchEvent', () => {
  beforeEach(() => {
    verifyChatEventTokenMock.mockResolvedValue({
      ok: true,
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      email: 'chat@system.gserviceaccount.com',
    });
  });

  /**
   * Guards the WIRING, not just the classifier: reverting `switch
   * (classifyChatEvent(event))` in `dispatchEvent` back to `switch
   * (event.type)` breaks this — `classifyChatEvent` would still correctly
   * classify an add-on `addedToSpacePayload` event in isolation, but
   * `dispatchEvent` would never call it, so the event falls to `default`
   * and the unrecognized-shape diagnostic fires.
   */
  it('routes an add-on ADDED_TO_SPACE event to its branch, not the unrecognized-shape diagnostic', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(
      makeReq({ chat: { user: { name: 'users/123' }, addedToSpacePayload: { space: { name: 'spaces/AAA' } } } }),
    );
    expect(res.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[chat/events] unrecognized event shape, acknowledging as no-op',
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  /** Same wiring guard as above, for the add-on messagePayload shape. */
  it('routes an add-on MESSAGE event to its branch, not the unrecognized-shape diagnostic', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(
      makeReq({ chat: { user: { name: 'users/123' }, messagePayload: { message: { text: 'hi' } } } }),
    );
    expect(res.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[chat/events] unrecognized event shape, acknowledging as no-op',
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  /**
   * Reverting the `default:` branch's `logUnrecognizedEventShape(event);`
   * call (e.g. removing it) breaks this — an event shape this dispatcher
   * doesn't recognize must still produce a diagnostic, just a
   * structure-only one instead of the old `{ type: undefined }`.
   */
  it('logs a structure-only summary for an event shape it does not recognize', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(
      makeReq({
        chat: {
          user: { name: 'users/123' },
          buttonClickedPayload: { message: { text: 'secret button label' }, space: { name: 'spaces/AAA' } },
        },
      }),
    );
    expect(res.status).toBe(200);

    const call = warnSpy.mock.calls.find(
      (c) => c[0] === '[chat/events] unrecognized event shape, acknowledging as no-op',
    );
    expect(call).toBeDefined();
    const loggedArg = call?.[1] as { keyPaths: string[]; truncated: boolean };
    expect(loggedArg.keyPaths).toEqual(
      expect.arrayContaining(['chat', 'chat.user', 'chat.buttonClickedPayload']),
    );
    expect(JSON.stringify(loggedArg)).not.toContain('secret button label');
    expect(JSON.stringify(loggedArg)).not.toContain('spaces/AAA');
    warnSpy.mockRestore();
  });

  /**
   * Asserts WHICH branch an event reached, which the two wiring tests above
   * cannot: they only check that the unrecognized-shape diagnostic stayed
   * silent, so a messagePayload wrongly routed into the ADDED_TO_SPACE
   * branch would pass them. It also covers the reason the log exists at
   * all — every branch is a no-op returning an empty 200, so without this
   * line a deploy that fixes the mapping and one that does not produce
   * byte-identical logs.
   *
   * Reverting `if (kind) logFirstClassifiedKindOnce(kind);` in
   * `dispatchEvent` breaks this.
   */
  it('logs which kind the first classified event resolved to', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST: freshPost } = await import('./route');

    const res = await freshPost(
      makeReq({ chat: { user: { name: 'users/123' }, messagePayload: { message: { text: 'hi' } } } }),
    );
    expect(res.status).toBe(200);

    const calls = warnSpy.mock.calls.filter((c) => c[0] === '[chat/events] first classified event');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ kind: 'MESSAGE' });

    // Once per instance, not once per request.
    await freshPost(
      makeReq({ chat: { user: { name: 'users/123' }, addedToSpacePayload: { space: { name: 'spaces/AAA' } } } }),
    );
    expect(
      warnSpy.mock.calls.filter((c) => c[0] === '[chat/events] first classified event'),
    ).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

/**
 * `summarizePayloadShape` is the privacy-load-bearing piece of this change:
 * a Chat event payload carries real user content (message text, display
 * names, email addresses, space names), and this function is what stands
 * between an unrecognized payload and Cloud Logging. See its doc comment
 * in `route.ts` for the full reasoning.
 */
describe('summarizePayloadShape — structure-only diagnostic', () => {
  /**
   * Reverting the depth-cap check (`if (depth + 1 >= SHAPE_SUMMARY_MAX_DEPTH)
   * { ...; truncated = true; continue; }`) to never trigger breaks this —
   * without it, the walk would keep descending past the cap and report
   * `l1.l2.l3.l4` / `l1.l2.l3.l4.l5`, and `truncated` would stay `false`.
   */
  it('truncates deep nesting at the depth cap', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: 'irrelevant-leaf-value' } } } } };
    const result = summarizePayloadShape(deep);
    expect(result.keyPaths).toEqual(['l1', 'l1.l2', 'l1.l2.l3']);
    expect(result.truncated).toBe(true);
  });

  /**
   * Reverting the key-count check (`if (keyPaths.length >=
   * SHAPE_SUMMARY_MAX_KEYS) { truncated = true; return; }`) to never
   * trigger breaks this — without it, all 45 keys would be reported and
   * `truncated` would stay `false`.
   */
  it('truncates wide objects at the key-count cap', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 45; i++) wide[`k${i}`] = i;
    const result = summarizePayloadShape(wide);
    expect(result.keyPaths.length).toBe(40);
    expect(result.truncated).toBe(true);
  });

  /**
   * Reverting the array branch (`if (Array.isArray(child)) { keyPaths.push(
   * \`${'${childPath}'}[]:${'${child.length}'}\`); continue; }`) — e.g.
   * deleting it so arrays fall into the generic object branch — breaks
   * this: the path would become plain `tags` with no length, and no
   * elements would leak either way, but the length signal this test
   * depends on would be gone.
   */
  it('reports arrays by length, never by content', () => {
    const payload = { tags: ['secret-a', 'secret-b', 'secret-c'], nested: { list: [1, 2] } };
    const result = summarizePayloadShape(payload);
    expect(result.keyPaths).toEqual(expect.arrayContaining(['tags[]:3', 'nested', 'nested.list[]:2']));
    expect(JSON.stringify(result)).not.toContain('secret-a');
    expect(JSON.stringify(result)).not.toContain('secret-b');
    expect(JSON.stringify(result)).not.toContain('secret-c');
  });

  /**
   * LOAD-BEARING PRIVACY TEST. Reverting the leaf-push line (`keyPaths.push
   * (childPath);` at the end of `visit`) to include the value (e.g.
   * `` keyPaths.push(`${childPath}=${String(child)}`); ``) breaks this —
   * the whole point of `summarizePayloadShape` is that a value never
   * reaches the output, at any depth.
   */
  it('never includes payload values — message text, a display name, or an email address', () => {
    const payload = {
      chat: {
        user: { displayName: 'Alex Example', email: 'alex@example.com' },
        messagePayload: { message: { text: 'Please approve invoice #4521 for $12,345.67' } },
        space: { displayName: 'Finance Approvals' },
      },
    };
    const result = summarizePayloadShape(payload);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Alex Example');
    expect(serialized).not.toContain('alex@example.com');
    expect(serialized).not.toContain('Please approve invoice #4521 for $12,345.67');
    expect(serialized).not.toContain('Finance Approvals');
    // Key NAMES are still expected to show up — that is the whole point of
    // a structure-only summary (see the function's doc for why key names,
    // unlike values, are schema and safe to log).
    expect(result.keyPaths).toEqual(
      expect.arrayContaining(['chat.user.displayName', 'chat.user.email', 'chat.space.displayName']),
    );
  });
});

describe('POST /api/chat/events — rate limit (pre-auth, per-IP, in-memory)', () => {
  beforeEach(() => {
    verifyChatEventTokenMock.mockResolvedValue({
      ok: true,
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      email: 'chat@system.gserviceaccount.com',
    });
  });

  /**
   * Reverting the route to run the rate-limit gate AFTER
   * `verifyChatEventToken` (instead of before) breaks this — an over-limit
   * caller would still pay for a full JWT verification (cert fetch +
   * signature check) before being rejected, exactly the cost this gate
   * exists to avoid paying on unauthenticated traffic.
   */
  it('rejects an over-limit request without ever calling verifyChatEventToken', async () => {
    for (let i = 0; i < 600; i++) {
      const res = await POST(makeReq({ type: 'MESSAGE' }));
      expect(res.status).toBe(200);
    }
    verifyChatEventTokenMock.mockClear();

    const res = await POST(makeReq({ type: 'MESSAGE' }));
    expect(res.status).toBe(429);
    expect(verifyChatEventTokenMock).not.toHaveBeenCalled();
  });

  /**
   * Reverting the 429 branch to build the body from anything per-request
   * (e.g. echoing the reason, the bucket id, or changing the status code)
   * breaks this — the body must be the exact constant, no per-request
   * detail, mirroring the 401 path's no-detail style.
   */
  it('returns a constant, detail-free 429 body when over limit', async () => {
    for (let i = 0; i < 600; i++) {
      await POST(makeReq({ type: 'MESSAGE' }));
    }
    const res = await POST(makeReq({ type: 'MESSAGE' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
  });

  /**
   * Reverting `rate-limit.ts`'s `if (recent.length >= RATE_LIMIT_MAX_REQUESTS)
   * return false;` to use `>` instead of `>=` breaks this — with `>`, the
   * 601st call would still be allowed (600 > 600 is false) and only the
   * 602nd would be blocked, one request later than the threshold requires.
   */
  it('blocks at exactly the threshold and allows one request below it', async () => {
    // 599 requests: count stays below the threshold the whole time.
    for (let i = 0; i < 599; i++) {
      const res = await POST(makeReq({ type: 'MESSAGE' }));
      expect(res.status).toBe(200);
    }
    // 600th request: count was 599 (< 600), so this is still allowed —
    // count becomes 600 after this call.
    const res600 = await POST(makeReq({ type: 'MESSAGE' }));
    expect(res600.status).toBe(200);
    // 601st request: count is now 600 (>= 600), so this must be blocked.
    const res601 = await POST(makeReq({ type: 'MESSAGE' }));
    expect(res601.status).toBe(429);
  });

  /**
   * Reverting `rate-limit.ts`'s window-trim (`existing.filter((ts) => ts >
   * cutoff)`) to skip filtering (e.g. keeping every stored timestamp
   * regardless of age) breaks this — timestamps far outside the 60s sliding
   * window would wrongly keep counting toward the limit forever.
   */
  it('drops timestamps outside the window before applying the limit', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 600; i++) {
        checkChatEventsRateLimit('local-dev');
      }
      // Past the 60s window — every stored timestamp above is now stale.
      vi.advanceTimersByTime(61_000);

      const res = await POST(makeReq({ type: 'MESSAGE' }));
      expect(res.status).toBe(200);
      expect(verifyChatEventTokenMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Reverting the route to derive the bucket key from a separately-read
   * header (e.g. the raw, client-controlled leftmost `x-forwarded-for`
   * entry) instead of the shared `resolveCallerIp` breaks this — two
   * requests sharing the same real (rightmost) IP but carrying different
   * spoofed leftmost entries must land in the SAME bucket, the same
   * guarantee `/api/auth/connect/init` relies on, and a request from a
   * genuinely different IP must land in a different bucket.
   */
  it('buckets by the shared resolveCallerIp result, not a second IP-extraction path', async () => {
    for (let i = 0; i < 600; i++) {
      // Both spoofed leftmost entries share the same real (rightmost) IP,
      // so they must count toward the same bucket.
      const headers = { 'x-forwarded-for': i % 2 === 0 ? '1.1.1.1, 9.9.9.9' : '2.2.2.2, 9.9.9.9' };
      const res = await POST(makeReq({ type: 'MESSAGE' }, headers));
      expect(res.status).toBe(200);
    }

    const sameRealIp = await POST(makeReq({ type: 'MESSAGE' }, { 'x-forwarded-for': '3.3.3.3, 9.9.9.9' }));
    expect(sameRealIp.status).toBe(429);

    const differentRealIp = await POST(
      makeReq({ type: 'MESSAGE' }, { 'x-forwarded-for': '4.4.4.4, 8.8.8.8' }),
    );
    expect(differentRealIp.status).toBe(200);
  });
});

describe('POST /api/chat/events — rate limit state isolation', () => {
  /**
   * Reverting the top-level `beforeEach`'s `__resetRateLimit();` call (or
   * removing it) breaks this: the second test below would inherit the full
   * bucket left behind by the first test and wrongly see itself as
   * over-limit. Uses its own key (`isolation-test-ip`) so it cannot be
   * affected by, or interfere with, the `local-dev` bucket the other tests
   * in this file use.
   */
  it('fills a bucket to its limit (setup for the isolation check in the next test)', () => {
    for (let i = 0; i < 600; i++) {
      expect(checkChatEventsRateLimit('isolation-test-ip')).toBe(true);
    }
    expect(checkChatEventsRateLimit('isolation-test-ip')).toBe(false);
  });

  it('starts with a clean counter, not the previous test leftover state', () => {
    expect(checkChatEventsRateLimit('isolation-test-ip')).toBe(true);
  });
});

describe('POST /api/chat/events — tracked-IP bound', () => {
  /**
   * The bucket key is the caller's address on a public endpoint, so a flood
   * from rotating addresses would grow the map without bound if nothing
   * evicted. Removing the `if (requestLog.size > MAX_TRACKED_IPS)` guard in
   * `rate-limit.ts` (or the `requestLog.clear()` at the end of
   * `evictExpired`) leaves the count climbing past the cap and fails this.
   */
  it('stops tracking more source IPs than the cap, even when every bucket is live', () => {
    for (let i = 0; i < 2_500; i++) {
      expect(checkChatEventsRateLimit(`10.0.${Math.floor(i / 256)}.${i % 256}`)).toBe(true);
    }

    // Every bucket above was created within the window, so none can be
    // trimmed away — the cap has to hold on its own.
    expect(__trackedIpCount()).toBeLessThanOrEqual(2_000);
  });

  /**
   * Eviction must drop the buckets that aged out rather than clearing the
   * whole map, or an active caller silently loses the requests it already
   * spent. Here 2 000 stale addresses fill the map, then one live caller
   * pushes it over the cap; eviction fires on that caller's second request.
   * With the delete in place the stale entries go and the live counter
   * survives, so request 601 is rejected. Reverting
   * `if (recent.length === 0) requestLog.delete(trackedIp)` in
   * `evictExpired` leaves the map over the cap, the fallback `clear()`
   * wipes the live counter too, and request 601 is wrongly allowed.
   */
  it('keeps a live caller\'s counter when aged-out buckets are evicted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));
      for (let i = 0; i < 2_000; i++) {
        expect(checkChatEventsRateLimit(`10.1.${Math.floor(i / 256)}.${i % 256}`)).toBe(true);
      }

      // Past the window, so every bucket above is stale from here on.
      vi.advanceTimersByTime(61_000);

      for (let i = 0; i < 600; i++) {
        expect(checkChatEventsRateLimit('10.9.9.9')).toBe(true);
      }

      expect(checkChatEventsRateLimit('10.9.9.9')).toBe(false);
      expect(__trackedIpCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('summarizePayloadShape — key-segment cap', () => {
  /**
   * Key NAMES are emitted verbatim, which is safe only as long as every key
   * is a fixed schema field name. If a future payload ever nests a map keyed
   * by something user-controlled, this cap is what keeps the leak to a
   * fragment instead of a whole address or message. Reverting
   * `capKeySegment(key)` back to a bare `key` in `summarizePayloadShape`
   * breaks this.
   */
  it('truncates an oversized key name instead of emitting it in full', () => {
    const hostileKey = 'a'.repeat(5000);
    const { keyPaths } = summarizePayloadShape({ chat: { [hostileKey]: 1 } });

    const path = keyPaths.find((p) => p.startsWith('chat.a'));
    expect(path).toBeDefined();
    expect(path!.length).toBeLessThan(100);
    expect(path).toContain('…');
    expect(JSON.stringify(keyPaths)).not.toContain(hostileKey);
  });

  /** A key at exactly the cap is untouched — the cap must not truncate normal schema names. */
  it('leaves a key at the cap length unchanged', () => {
    const exactKey = 'b'.repeat(64);
    const { keyPaths } = summarizePayloadShape({ [exactKey]: 1 });
    expect(keyPaths).toContain(exactKey);
  });
});

/**
 * `dispatchEvent`'s wiring into `resolveChatSender` / `mapChatIdentity`
 * (spec Slice E). `chat-sender.test.ts` covers the extraction guards in
 * isolation and `chat-identity-service.test.ts` covers the matching/write
 * logic in isolation; these tests cover the ROUTE gluing them together —
 * which event kinds attempt the mapping, that a failure never escapes as a
 * 5xx, and that nothing sensitive reaches a log line.
 */
describe('POST /api/chat/events — identity mapping wiring (Slice E)', () => {
  beforeEach(() => {
    verifyChatEventTokenMock.mockResolvedValue({
      ok: true,
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      email: 'chat@system.gserviceaccount.com',
    });
  });

  /**
   * Reverting `attemptChatIdentityMapping`'s `if (sender.status ===
   * 'unresolved') { logChatIdentityOutcome(sender.reason); return; }`
   * guard (e.g. calling `mapChatIdentity` unconditionally with whatever
   * `resolveChatSender` returned) breaks this — a payload with no `chat.user`
   * at all must never reach `mapChatIdentity`, and the request must still
   * ack 200.
   */
  it('acknowledges 200 and never calls mapChatIdentity when the identity object is entirely missing', async () => {
    const res = await POST(
      makeReq({ chat: { addedToSpacePayload: { space: { name: 'spaces/AAAA' } } } }),
    );
    expect(res.status).toBe(200);
    expect(mapChatIdentityMock).not.toHaveBeenCalled();
  });

  /**
   * The identity path is derived from Google's docs, not observed on the
   * wire, and this endpoint's classic-vs-add-on split has already differed
   * three times. Reverting the `console.warn('[chat/events] identity
   * shape', summarizePayloadShape(event))` line in the unresolved branch
   * breaks this — without it, a wrong path yields a reason with no clue
   * where the identity actually is, costing a whole deploy cycle to
   * diagnose. The summary must carry structure and no values.
   */
  it('logs the payload structure when the sender cannot be resolved, without any values', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(
      makeReq({
        chat: {
          somewhereElse: { sender: { email: 'alice@corp.example', displayName: 'Alice Example' } },
          messagePayload: { message: { text: 'top secret message' } },
        },
      }),
    );
    expect(res.status).toBe(200);

    const call = warnSpy.mock.calls.find((c) => c[0] === '[chat/events] identity shape');
    expect(call).toBeDefined();
    const logged = call?.[1] as { keyPaths: string[] };
    expect(logged.keyPaths).toEqual(expect.arrayContaining(['chat.somewhereElse']));

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain('alice@corp.example');
    expect(serialized).not.toContain('Alice Example');
    expect(serialized).not.toContain('top secret message');
    warnSpy.mockRestore();
  });

  /**
   * Route-level companion to `chat-sender.test.ts`'s pure `non_human` test:
   * proves the WIRING also never lets a bot/app sender reach
   * `mapChatIdentity`. Reverting `resolveChatSender`'s `type !== 'HUMAN'`
   * guard breaks this the same way it breaks the pure test.
   */
  it('acknowledges 200 and never calls mapChatIdentity for a BOT-typed sender', async () => {
    const res = await POST(
      makeReq({
        chat: {
          user: { name: 'users/app', type: 'BOT' },
          space: { name: 'spaces/AAAA' },
          messagePayload: { message: { text: 'hi' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mapChatIdentityMock).not.toHaveBeenCalled();
  });

  /**
   * Reverting the `case 'ADDED_TO_SPACE':` branch's `await
   * attemptChatIdentityMapping(event);` call (e.g. removing it) breaks
   * this.
   */
  it('calls mapChatIdentity with the resolved sender on ADDED_TO_SPACE', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    const res = await POST(
      makeReq({
        chat: {
          user: { name: 'users/123456789', type: 'HUMAN', email: 'alex@example.com' },
          space: { name: 'spaces/AAAA' },
          addedToSpacePayload: { space: { name: 'spaces/AAAA' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mapChatIdentityMock).toHaveBeenCalledWith({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: 'alex@example.com',
    });
  });

  /**
   * Reverting the `case 'MESSAGE':` branch's `await
   * attemptChatIdentityMapping(event);` call breaks this — proves the
   * SECOND trigger point independently of the first.
   */
  it('calls mapChatIdentity with the resolved sender on MESSAGE', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    const res = await POST(
      makeReq({
        chat: {
          user: { name: 'users/123456789', type: 'HUMAN', email: 'alex@example.com' },
          space: { name: 'spaces/AAAA' },
          messagePayload: { message: { text: 'hi' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mapChatIdentityMock).toHaveBeenCalledWith({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: 'alex@example.com',
    });
  });

  /**
   * The install double-event sequence: an @mention install fires
   * ADDED_TO_SPACE immediately followed by MESSAGE, both carrying the same
   * `chat.user`. Reverting either dispatch branch's
   * `attemptChatIdentityMapping` call would drop this to a single call
   * instead of two, which is what this test's call-count assertion catches
   * that the two single-event tests above cannot (each only proves ITS OWN
   * branch is wired, not that both fire across the real two-event
   * sequence).
   */
  it('attempts the mapping on both events of the install sequence, with the same sender', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped_idempotent', userId: 'usr_alex' });

    const sender = { name: 'users/123456789', type: 'HUMAN', email: 'alex@example.com' };
    const addedRes = await POST(
      makeReq({
        chat: { user: sender, space: { name: 'spaces/AAAA' }, addedToSpacePayload: { space: { name: 'spaces/AAAA' } } },
      }),
    );
    const messageRes = await POST(
      makeReq({
        chat: { user: sender, space: { name: 'spaces/AAAA' }, messagePayload: { message: { text: 'hi' } } },
      }),
    );

    expect(addedRes.status).toBe(200);
    expect(messageRes.status).toBe(200);
    expect(mapChatIdentityMock).toHaveBeenCalledTimes(2);
    expect(mapChatIdentityMock.mock.calls[0]?.[0]).toEqual({
      chatUserId: 'users/123456789',
      spaceName: 'spaces/AAAA',
      email: 'alex@example.com',
    });
    expect(mapChatIdentityMock.mock.calls[1]?.[0]).toEqual(mapChatIdentityMock.mock.calls[0]?.[0]);
  });

  /**
   * Reverting `logChatIdentityOutcome(result.outcome);` on the success path
   * (e.g. logging nothing, or logging before the await resolves) breaks
   * this.
   */
  it('logs the mapping outcome returned by mapChatIdentity', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await POST(
      makeReq({
        chat: {
          user: { name: 'users/123456789', type: 'HUMAN', email: 'alex@example.com' },
          space: { name: 'spaces/AAAA' },
          messagePayload: { message: { text: 'hi' } },
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith('[chat/events] identity mapping outcome', { outcome: 'mapped' });
    warnSpy.mockRestore();
  });

  /**
   * NON-NEGOTIABLE-CONSTRAINT TEST. Reverting the `try { ... } catch {
   * logChatIdentityOutcome('mapping_error'); }` wrapper in
   * `attemptChatIdentityMapping` (e.g. letting the rejection propagate)
   * breaks this — a Firestore hiccup must never turn one Chat delivery
   * into a 5xx, since Chat retries on 5xx and would turn a single event
   * into a retry storm.
   */
  it('still acknowledges 200 when mapChatIdentity rejects', async () => {
    mapChatIdentityMock.mockRejectedValueOnce(new Error('firestore unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(
      makeReq({
        chat: {
          user: { name: 'users/123456789', type: 'HUMAN', email: 'alex@example.com' },
          space: { name: 'spaces/AAAA' },
          messagePayload: { message: { text: 'hi' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith('[chat/events] identity mapping outcome', { outcome: 'mapping_error' });
    warnSpy.mockRestore();
  });

  /**
   * LOAD-BEARING PRIVACY TEST. Reverting `logChatIdentityOutcome`'s
   * `console.warn('[chat/events] identity mapping outcome', { outcome });`
   * call to also pass along sender fields (e.g. `{ outcome, email:
   * sender.email }`, a plausible "helpful debugging" mistake) breaks this
   * — none of the realistic PII this event carries (email, display name,
   * message text) may reach ANY console.warn call this request produces.
   */
  it('never logs the sender email, display name, or message text', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await POST(
      makeReq({
        chat: {
          user: {
            name: 'users/123456789',
            type: 'HUMAN',
            displayName: 'Alex Example',
            email: 'alex.example@example.com',
          },
          space: { name: 'spaces/AAAA', displayName: 'Finance Approvals' },
          messagePayload: { message: { text: 'Please approve invoice #4521 for $12,345.67' } },
        },
      }),
    );

    const allLoggedText = JSON.stringify(warnSpy.mock.calls);
    expect(allLoggedText).not.toContain('Alex Example');
    expect(allLoggedText).not.toContain('alex.example@example.com');
    expect(allLoggedText).not.toContain('Please approve invoice #4521 for $12,345.67');
    expect(allLoggedText).not.toContain('Finance Approvals');
    warnSpy.mockRestore();
  });
});

/**
 * Slice F inbound: a mapped Chat sender's message becomes (or continues) a
 * Clerk `assistant_task` Case via `AssistantIntakeService`, mocked the same
 * way `api/assistant/tasks/route.test.ts` mocks it (a minimal fake class,
 * not a typed re-implementation) — these tests are about THIS route's
 * wiring (which outcome triggers which call, with which arguments, without
 * blocking the response), not `AssistantIntakeService`'s own transaction
 * logic.
 *
 * None of the fixtures in the describe blocks ABOVE this one ever set
 * `messagePayload.message.name` — every one of them therefore resolves
 * `unresolved` (`missing_message_name`) once `attemptChatIntake` reaches
 * `resolveChatMessage`, which is exactly why none of the mocks added for
 * this block (`intakeMock`, `intakeFollowUpMock`, `resolveChatThreadCaseMock`,
 * `chatReplyPostMock`) had to be threaded into any test above this point.
 */
describe('POST /api/chat/events — Clerk intake wiring (Slice F inbound)', () => {
  const SENDER = { name: 'users/123456789', type: 'HUMAN', email: 'alex@example.com' };
  const SPACE_NAME = 'spaces/AAAA';
  const THREAD_NAME = 'spaces/AAAA/threads/T1';
  const MESSAGE_NAME = 'spaces/AAAA/messages/M1';

  interface MessageEventOverrides {
    text?: string;
    /** Pass `null` to omit the field entirely (not merely an empty string). */
    messageName?: string | null;
    /** Pass `null` to omit `thread` entirely. */
    threadName?: string | null;
    /**
     * `chat.space.spaceType` (chat DM conversation window feature).
     * Omitted by default — every pre-existing fixture in this describe
     * block relies on that default resolving `conversationKind: 'space'`
     * (the fail-safe direction; see `chat-sender.test.ts`).
     */
    spaceType?: string;
    /** Override the space name — used by the DM fixtures below. */
    spaceName?: string;
  }

  function makeMessageEvent(overrides: MessageEventOverrides = {}): unknown {
    const messageName = overrides.messageName === undefined ? MESSAGE_NAME : overrides.messageName;
    const threadName = overrides.threadName === undefined ? THREAD_NAME : overrides.threadName;
    return {
      chat: {
        user: SENDER,
        space: {
          name: overrides.spaceName ?? SPACE_NAME,
          ...(overrides.spaceType ? { spaceType: overrides.spaceType } : {}),
        },
        messagePayload: {
          message: {
            text: overrides.text ?? 'Please review PR #42',
            ...(messageName !== null ? { name: messageName } : {}),
            ...(threadName !== null ? { thread: { name: threadName } } : {}),
          },
        },
      },
    };
  }

  /** A 1:1 DM fixture — same sender/message shape, `spaceType: 'DIRECT_MESSAGE'`. */
  function makeDirectMessageEvent(overrides: MessageEventOverrides = {}): unknown {
    return makeMessageEvent({ ...overrides, spaceType: 'DIRECT_MESSAGE' });
  }

  beforeEach(() => {
    verifyChatEventTokenMock.mockResolvedValue({
      ok: true,
      aud: 'https://arbitra.example.com/api/chat/events',
      iss: 'https://accounts.google.com',
      email: 'chat@system.gserviceaccount.com',
    });
  });

  /**
   * Reverting the `channel: 'google_chat'` / `idempotency_key:
   * message.sourceMessageName` / `chat: {...}` construction in
   * `runChatIntake`'s `intakeService.intake(...)` call (e.g. dropping any
   * one of those fields, or passing the thread name as the idempotency key
   * instead of the message name) breaks this.
   */
  it('calls intake with the channel, idempotency key, and chat context for a mapped sender', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    const caseDoc = { case_id: 'case_1', status: 'open' };
    const runDoc = { run_id: 'run_1', case_id: 'case_1' };
    intakeMock.mockResolvedValueOnce({
      case: caseDoc,
      run: runDoc,
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: false,
    });

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(intakeFollowUpMock).not.toHaveBeenCalled();
    expect(intakeMock).toHaveBeenCalledWith(
      {
        text: 'Please review PR #42',
        channel: 'google_chat',
        idempotency_key: MESSAGE_NAME,
        chat: {
          space_name: SPACE_NAME,
          thread_name: THREAD_NAME,
          source_message_name: MESSAGE_NAME,
          chat_user_name: 'users/123456789',
          conversation_visibility: 'space',
        },
      },
      'usr_alex',
    );
  });

  /**
   * Reverting `runChatIntake`'s `scheduleAssistantRunDispatch(result.case,
   * result.run);` call to `await scheduleAssistantRunDispatch(...)` breaks
   * this: `scheduleAssistantRunDispatchMock` here returns a promise that
   * never resolves, so an awaited call would hang and this test would time
   * out instead of completing.
   */
  it('dispatches the run without awaiting it, so the response is not blocked on the assistant', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    const caseDoc = { case_id: 'case_1', status: 'open' };
    const runDoc = { run_id: 'run_1', case_id: 'case_1' };
    intakeMock.mockResolvedValueOnce({
      case: caseDoc,
      run: runDoc,
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: false,
    });
    scheduleAssistantRunDispatchMock.mockReturnValue(new Promise(() => {}));

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    expect(scheduleAssistantRunDispatchMock).toHaveBeenCalledWith(caseDoc, runDoc);
  });

  /**
   * Each of `mapChatIdentity`'s four non-mapped outcomes must decline
   * exactly once and never reach intake. `mapping_conflict` is the one
   * CRITICAL case in this set: it carries a `userId` on the raw result, but
   * — per `chat-identity-service.ts` — that id names a DIFFERENT Arbitra
   * account than the sender. Reverting `attemptChatIntake`'s `if (outcome
   * !== 'mapped' && outcome !== 'mapped_idempotent')` branch (e.g. also
   * treating `mapping_conflict` as mapped because a `userId` is present)
   * breaks this specific case.
   */
  it.each([
    ['no_email', { outcome: 'no_email' }],
    ['no_match', { outcome: 'no_match' }],
    ['ambiguous_match', { outcome: 'ambiguous_match' }],
    ['mapping_conflict', { outcome: 'mapping_conflict', userId: 'usr_a_different_account' }],
  ] as const)('declines exactly once and never calls intake for outcome %s', async (_label, resolved) => {
    mapChatIdentityMock.mockResolvedValueOnce(resolved);

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    expect(intakeMock).not.toHaveBeenCalled();
    expect(intakeFollowUpMock).not.toHaveBeenCalled();
    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    expect(chatReplyPostMock.mock.calls[0]?.[0]).toMatchObject({ spaceName: SPACE_NAME });
  });

  /**
   * Reverting `attemptChatIntake`'s `if (sender.reason !== 'non_human') {
   * await declineUnmatchedChatSender(...); }` guard (e.g. calling it
   * unconditionally for every unresolved reason) breaks this — a
   * structurally malformed sender still gets exactly one decline, same as
   * an identity-mapping miss.
   */
  it('declines exactly once and never calls intake when the sender itself is unresolved', async () => {
    const res = await POST(
      makeReq({
        chat: {
          // No `user` key at all -> `resolveChatSender` returns
          // `missing_user`, distinct from the BOT/`non_human` carve-out
          // covered by the next test.
          space: { name: SPACE_NAME },
          messagePayload: { message: { text: 'hi', name: MESSAGE_NAME } },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(mapChatIdentityMock).not.toHaveBeenCalled();
    expect(intakeMock).not.toHaveBeenCalled();
    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    expect(chatReplyPostMock.mock.calls[0]?.[0]).toMatchObject({ spaceName: SPACE_NAME });
  });

  /**
   * Deliberate carve-out, beyond the base outcome-to-decline mapping above:
   * a BOT-typed sender (this app's own alias is `users/app`) must NOT get a
   * decline, or a future button-click/app-message could bounce a reply off
   * itself indefinitely. Reverting the `sender.reason !== 'non_human'`
   * check (e.g. removing it so every unresolved reason declines) breaks
   * this.
   */
  it('does not decline a BOT-typed sender, to avoid a bot-reply-to-bot loop', async () => {
    const res = await POST(
      makeReq({
        chat: {
          user: { name: 'users/app', type: 'BOT' },
          space: { name: SPACE_NAME },
          messagePayload: { message: { text: 'hi', name: MESSAGE_NAME } },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(chatReplyPostMock).not.toHaveBeenCalled();
    expect(intakeMock).not.toHaveBeenCalled();
  });

  /**
   * Reverting the `if (result.replayed) return;` guard in `runChatIntake`
   * (e.g. letting the pointer write and ack post run unconditionally)
   * breaks this — the second, replayed call would post a second ack and
   * move the thread pointer again.
   */
  it('does not repost the ack or move the thread pointer when intake reports a replay', async () => {
    mapChatIdentityMock.mockResolvedValue({ outcome: 'mapped', userId: 'usr_alex' });
    const caseDoc = { case_id: 'case_1', status: 'open' };
    intakeMock.mockResolvedValueOnce({
      case: caseDoc,
      run: { run_id: 'run_1' },
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: false,
    });
    intakeMock.mockResolvedValueOnce({
      case: caseDoc,
      run: null,
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: true,
    });

    const first = await POST(makeReq(makeMessageEvent()));
    const second = await POST(makeReq(makeMessageEvent()));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(intakeMock).toHaveBeenCalledTimes(2);
    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    expect(recordChatThreadTipMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Reverting the `lookup.status === 'ready' ? await
   * intakeService.intakeFollowUp(...) : await intakeService.intake(...)`
   * branch in `runChatIntake` (e.g. always calling `intake`) breaks this.
   * Also guards the `channel: 'google_chat'` field on the follow-up call
   * (#941 fix): reverting that field (or the corresponding
   * `AssistantIntakeService.intakeFollowUp` logic it exists to drive) makes
   * a Chat-originated follow-up's receipt land in the same
   * parent-scoped-and-`'web'` namespace the browser follow-up route uses,
   * which is exactly what let a redelivery collide with the wrong
   * namespace and create a second case — see
   * `assistant-intake-service.test.ts`'s "#941 regression" describe block
   * for that failure mode proven against the real service.
   *
   * Also guards the reply-target fix: a follow-up
   * case must carry THIS message's own `chat` block, exactly like a root
   * `intake()` call does, or `EventNotifier.notifyChatThreadOutcome` has no
   * `space_name`/`thread_name` to post the completion into. Reverting the
   * `chat: buildChatContextForMessage(sender, message)` field on the
   * `intakeFollowUp` call in `runChatIntake` (dropping it, or passing
   * `undefined`) breaks this.
   */
  it('routes a message in a thread with a completed Clerk case to intakeFollowUp, not intake, carrying this message\'s own chat block', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_root_1', updatedAt: '2026-01-01T00:00:00.000Z' });
    getCaseMock.mockResolvedValueOnce({ case_id: 'case_root_1', status: 'done' });
    intakeFollowUpMock.mockResolvedValueOnce({
      case: { case_id: 'case_2', status: 'open' },
      run: { run_id: 'run_2' },
      run_id: 'run_2',
      event_id: 'evt_2',
      replayed: false,
    });

    const res = await POST(makeReq(makeMessageEvent({ text: 'and one more thing' })));

    expect(res.status).toBe(200);
    expect(intakeMock).not.toHaveBeenCalled();
    expect(intakeFollowUpMock).toHaveBeenCalledWith(
      {
        text: 'and one more thing',
        idempotency_key: MESSAGE_NAME,
        channel: 'google_chat',
        chat: {
          space_name: SPACE_NAME,
          thread_name: THREAD_NAME,
          source_message_name: MESSAGE_NAME,
          chat_user_name: 'users/123456789',
          conversation_visibility: 'space',
        },
      },
      'usr_alex',
      'case_root_1',
    );
  });

  /**
   * Reverting the `ChatThreadCaseLookup`'s `'busy'` state (e.g. collapsing
   * it into `'none'`, which would fall through to a brand new root Case)
   * breaks this — a thread whose recorded tip has not finished yet must
   * neither create a follow-up NOR a second root while the first turn is
   * still running. Covers "redelivery while still in flight" too: POSTing
   * the identical message twice while the case stays busy must never call
   * either intake method on EITHER delivery.
   */
  it('skips the message without creating any case while the thread tip is still in progress, even on redelivery', async () => {
    mapChatIdentityMock.mockResolvedValue({ outcome: 'mapped', userId: 'usr_alex' });
    resolveChatThreadCaseMock.mockResolvedValue({ caseId: 'case_root_1', updatedAt: '2026-01-01T00:00:00.000Z' });
    getCaseMock.mockResolvedValue({ case_id: 'case_root_1', status: 'in_build' });

    const first = await POST(makeReq(makeMessageEvent()));
    const redelivery = await POST(makeReq(makeMessageEvent()));

    expect(first.status).toBe(200);
    expect(redelivery.status).toBe(200);
    expect(intakeMock).not.toHaveBeenCalled();
    expect(intakeFollowUpMock).not.toHaveBeenCalled();
  });

  /**
   * Blocker fix: a message arriving while the thread's case is genuinely
   * busy used to be dropped with no signal at all. Reverting the
   * `getChatReplyPoster().post(...)` call in `runChatIntake`'s `'busy'`
   * branch (e.g. back to a bare `return;`) breaks this.
   */
  it('posts a short "still working" reply exactly once for a message in a genuinely busy thread', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_root_1', updatedAt: '2026-01-01T00:00:00.000Z' });
    getCaseMock.mockResolvedValueOnce({ case_id: 'case_root_1', status: 'in_build' });

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    expect(intakeMock).not.toHaveBeenCalled();
    expect(intakeFollowUpMock).not.toHaveBeenCalled();
    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    const [target, text] = chatReplyPostMock.mock.calls[0] as [{ spaceName: string; threadName?: string }, string];
    expect(target).toMatchObject({ spaceName: SPACE_NAME, threadName: THREAD_NAME });
    expect(text.toLowerCase()).toContain('still working');
    // Must not be confused with the completion ack.
    expect(text).not.toContain('tracking this as an Arbitra case');
  });

  /**
   * Blocker fix: `rejected` is terminal (never becomes `done`), so
   * `resolveExistingChatThreadCase` must not classify it as `'busy'` —
   * that would drop every later message in the thread forever, since a
   * rejected case can never transition to `done`. Chosen semantics: start a
   * fresh root Case, the same as if there were no thread link at all (a
   * rejected case is a dead end `intakeFollowUp`'s `resolveParentLink` can
   * never accept as a parent). Reverting
   * `resolveExistingChatThreadCase`'s `if (TERMINAL_CASE_STATUSES.has(...))
   * return { status: 'none' };` branch (e.g. letting `rejected` fall
   * through to the `'busy'` return) breaks this.
   */
  it('starts a new root case instead of dropping the message when the thread\'s case was rejected', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_rejected_1', updatedAt: '2026-01-01T00:00:00.000Z' });
    getCaseMock.mockResolvedValueOnce({ case_id: 'case_rejected_1', status: 'rejected' });
    intakeMock.mockResolvedValueOnce({
      case: { case_id: 'case_new_root', status: 'open' },
      run: { run_id: 'run_new' },
      run_id: 'run_new',
      event_id: 'evt_new',
      replayed: false,
    });

    const res = await POST(makeReq(makeMessageEvent({ text: 'trying again' })));

    expect(res.status).toBe(200);
    expect(intakeFollowUpMock).not.toHaveBeenCalled();
    expect(intakeMock).toHaveBeenCalledWith(
      {
        text: 'trying again',
        channel: 'google_chat',
        idempotency_key: MESSAGE_NAME,
        chat: {
          space_name: SPACE_NAME,
          thread_name: THREAD_NAME,
          source_message_name: MESSAGE_NAME,
          chat_user_name: 'users/123456789',
          conversation_visibility: 'space',
        },
      },
      'usr_alex',
    );
    // A normal successful intake, so the usual ack still goes out — the
    // rejected case is not itself re-surfaced or explained, just quietly
    // superseded.
    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Route-level companion to the service-level "#941 regression" tests in
   * `assistant-intake-service.test.ts`: once `AssistantIntakeService`
   * correctly reports `replayed: true` for a redelivery routed to
   * `intakeFollowUp` (rather than `intake`), the EXISTING `if
   * (result.replayed) return;` guard in `runChatIntake` must apply there
   * too, not just on the `intake` branch already covered above. Reverting
   * that guard (or narrowing it to only the `intake` branch) breaks this.
   */
  it('does not repost the ack or move the thread pointer when intakeFollowUp reports a replay', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_root_1', updatedAt: '2026-01-01T00:00:00.000Z' });
    getCaseMock.mockResolvedValueOnce({ case_id: 'case_root_1', status: 'done' });
    intakeFollowUpMock.mockResolvedValueOnce({
      case: { case_id: 'case_1', status: 'done' },
      run: null,
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: true,
    });

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    expect(intakeFollowUpMock).toHaveBeenCalledTimes(1);
    expect(chatReplyPostMock).not.toHaveBeenCalled();
    expect(recordChatThreadTipMock).not.toHaveBeenCalled();
    expect(scheduleAssistantRunDispatchMock).not.toHaveBeenCalled();
  });

  /**
   * Reverting `resolveChatMessage`'s `missing_message` guard (e.g. reading
   * `messagePayload.message.text` without checking the object exists
   * first) breaks this — it would throw on `undefined.text` instead of
   * resolving `unresolved`, and `attemptChatIntake` has no catch around
   * that call, so the throw would propagate out of `dispatchEvent` and
   * this request would reject instead of resolving 200.
   */
  it('acknowledges 200 without calling intake when messagePayload has no message, and does not throw', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });

    const res = await POST(
      makeReq({
        chat: {
          user: SENDER,
          space: { name: SPACE_NAME },
          messagePayload: {},
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(intakeMock).not.toHaveBeenCalled();
    expect(intakeFollowUpMock).not.toHaveBeenCalled();
  });

  /**
   * Reverting `resolveChatMessage`'s `missing_message_name` guard (e.g.
   * treating a missing `message.name` as an empty idempotency key rather
   * than unresolved) breaks this — the whole point of requiring it is that
   * intake must never be attempted without a stable de-duplication key.
   */
  it('acknowledges 200 without calling intake when the message has no name to key idempotency on', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });

    const res = await POST(makeReq(makeMessageEvent({ messageName: null })));

    expect(res.status).toBe(200);
    expect(intakeMock).not.toHaveBeenCalled();
  });

  /**
   * Reverting `runChatIntake`'s ack-post call (e.g. skipping it, or posting
   * without the resolved share URL) breaks this — the ack must reach the
   * poster with a link built from the Case just created.
   */
  it('posts an ack with the case share link into the originating thread after a successful intake', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    intakeMock.mockResolvedValueOnce({
      case: { case_id: 'case_1', status: 'open' },
      run: null,
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: false,
    });
    resolveCaseShareUrlMock.mockReturnValueOnce('https://arbitra.example/cases/case_1');

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    const [target, text] = chatReplyPostMock.mock.calls[0] as [{ spaceName: string; threadName?: string }, string];
    expect(target).toMatchObject({ spaceName: SPACE_NAME, threadName: THREAD_NAME });
    expect(text).toContain('https://arbitra.example/cases/case_1');
  });

  /**
   * Reverting `buildChatIntakeAckText`'s `shareUrl`-present branch back to
   * `` `Got it — tracking this as an Arbitra case: ${shareUrl}` `` (a
   * hardcoded English sentence wrapped around the link) fails the
   * no-English-sentence assertion below — Clerk answers in the requester's
   * own language, so the ack must not silently reintroduce hardcoded
   * English.
   */
  it('acks with a neutral marker and the bare link — no hardcoded English sentence', async () => {
    mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
    intakeMock.mockResolvedValueOnce({
      case: { case_id: 'case_1', status: 'open' },
      run: null,
      run_id: 'run_1',
      event_id: 'evt_1',
      replayed: false,
    });
    resolveCaseShareUrlMock.mockReturnValueOnce('https://arbitra.example/cases/case_1');

    const res = await POST(makeReq(makeMessageEvent()));

    expect(res.status).toBe(200);
    const [, text] = chatReplyPostMock.mock.calls[0] as [unknown, string];
    expect(text).toBe('🔗 https://arbitra.example/cases/case_1');
    expect(text).toContain('https://arbitra.example/cases/case_1');
    // No English sentence: strip the url out and there should be no
    // remaining word-like run of letters (the 🔗 marker is not a letter).
    expect(text.replace(/https?:\/\/\S+/g, '')).not.toMatch(/[a-zA-Z]{4,}/);
  });

  /**
   * DM continuity + conversation-window wiring (chat DM conversation window
   * feature; two-stage lookup). The pure
   * per-option restart decision (`shouldRestartChatConversation`) and the
   * per-user habit lookup (`resolveUserChatConversationWindow`) are
   * unit-tested against real timestamps in `chat-conversation-window.test.ts`;
   * these tests are about THIS route's wiring — which continuity key(s) it
   * resolves on, in which order, and what it does with each mocked outcome —
   * same split as the rest of this file.
   *
   * A DM lookup is two-stage (`resolveChatConversationLookup` in route.ts):
   * STAGE 1 checks a `thread_name` link for THIS message's own thread FIRST,
   * with no window; only a genuine miss there falls through to STAGE 2, the
   * `space_name`-keyed lookup with the window applied. Every DM fixture
   * below carries a `thread.name` (`THREAD_NAME`) by default via
   * `makeDirectMessageEvent`, so unless a test explicitly arranges a STAGE 1
   * hit (`resolveChatThreadCaseMock`'s FIRST resolved value), the default
   * `mockResolvedValue(undefined)` from the top-level `beforeEach` makes
   * STAGE 1 miss and the test exercises STAGE 2, exactly like this DM
   * behavior worked before the two-stage split existed.
   */
  describe('DM continuity and the conversation-window setting', () => {
    /**
     * The STAGE 2 fallback path, the other direction from the "still keys on
     * the thread" test above: a DM message resolves `conversationKind:
     * 'direct'` (`spaceType: 'DIRECT_MESSAGE'`) and, once its own thread has
     * no recorded link yet (STAGE 1 miss), falls through to key its lookup
     * on the SPACE name — even though this fixture carries a `thread.name`
     * (a real DM message always does; Chat just never reuses it across
     * messages, which is exactly why a miss is the default case here).
     * Reverting the STAGE 1 miss check in `resolveChatConversationLookup`
     * (e.g. always falling through, or always keying on `message.threadName`
     * regardless of `conversationKind`) breaks this: the second
     * `resolveChatThreadCaseMock` call would not happen, or would not carry
     * `('space_name', SPACE_NAME)`.
     */
    it('falls through to a space-keyed lookup once its own thread has no recorded link (stage 1 miss)', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      await POST(makeReq(makeDirectMessageEvent()));

      expect(resolveChatThreadCaseMock).toHaveBeenNthCalledWith(1, 'thread_name', THREAD_NAME);
      expect(resolveChatThreadCaseMock).toHaveBeenNthCalledWith(2, 'space_name', SPACE_NAME);
    });

    /**
     * THE core Part 1 fix, exercised via STAGE 2 (window says "continue",
     * prior Case is `done`) — a DM's second TOP-LEVEL message (its own
     * thread never recorded, so STAGE 1 misses) continues the same
     * conversation as a follow-up rather than a new root Case. Explicitly
     * pinned to `idle_gap` — the window's new default (Change 3) — since
     * this is exactly the "DM top-level message under idle_gap within 4h
     * continues via space key" scenario the default flip must keep working. Reverting either the STAGE 2 fallback itself or the
     * `lookup.status === 'ready'` branch breaks this.
     *
     * Also guards the reply-target fix for the DM
     * variant specifically: the follow-up's `chat` block must carry
     * `conversation_visibility: 'direct'` and THIS message's own
     * `space_name`/`thread_name`, never inherited from `case_dm_root`.
     * Reverting `buildChatContextForMessage`'s use in the `intakeFollowUp`
     * call (or `chat-sender.ts`'s DM `conversationKind` resolution it reads
     * from) breaks this.
     */
    it('continues a DM as a follow-up via the space key under idle_gap when a top-level message finds no thread link, carrying this message\'s own chat block', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1: this thread has no recorded link
      resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_root', updatedAt: '2026-01-01T00:00:00.000Z' }); // stage 2: space-keyed hit
      getCaseMock.mockResolvedValueOnce({ case_id: 'case_dm_root', status: 'done' });
      resolveUserChatConversationWindowMock.mockResolvedValueOnce('idle_gap');
      shouldRestartChatConversationMock.mockReturnValue(false);
      intakeFollowUpMock.mockResolvedValueOnce({
        case: { case_id: 'case_dm_2', status: 'open' },
        run: { run_id: 'run_2' },
        run_id: 'run_2',
        event_id: 'evt_2',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'one more thing' })));

      expect(res.status).toBe(200);
      expect(intakeMock).not.toHaveBeenCalled();
      expect(intakeFollowUpMock).toHaveBeenCalledWith(
        {
          text: 'one more thing',
          idempotency_key: MESSAGE_NAME,
          channel: 'google_chat',
          chat: {
            space_name: SPACE_NAME,
            thread_name: THREAD_NAME,
            source_message_name: MESSAGE_NAME,
            chat_user_name: 'users/123456789',
            conversation_visibility: 'direct',
          },
        },
        'usr_alex',
        'case_dm_root',
      );
    });

    /**
     * STAGE 2 window restart wins over an in-flight prior Case: once STAGE 1
     * misses (fresh thread) and STAGE 2's `shouldRestartChatConversation`
     * says restart, the lookup must short-circuit to a fresh root even
     * though the prior Case is still busy (`in_build`, not terminal) — no
     * "still working" nudge, no `getCase` re-check outcome consulted at all.
     * Also the "top-level DM message under per_message still starts a root"
     * scenario: `per_message` always restarts (real behavior proven in
     * `chat-conversation-window.test.ts`; here mocked to `true` to isolate
     * the WIRING), so even a prior conversation on the same space must not
     * attach a top-level message to it. Reverting the
     * `windowContext && shouldRestartChatConversation(...)` short-circuit in
     * `resolveChatThreadCaseStatus` (e.g. checking case status first) breaks
     * this — it would nudge "still working" instead of calling `intake`.
     */
    it('starts a fresh root for a top-level DM message under per_message, even though the prior case is still busy', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1: this thread has no recorded link
      resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_root', updatedAt: '2026-01-01T00:00:00.000Z' }); // stage 2: space-keyed hit
      resolveUserChatConversationWindowMock.mockResolvedValueOnce('per_message');
      shouldRestartChatConversationMock.mockReturnValue(true);
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_dm_new_root', status: 'open' },
        run: null,
        run_id: 'run_new',
        event_id: 'evt_new',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'fresh start' })));

      expect(res.status).toBe(200);
      expect(intakeFollowUpMock).not.toHaveBeenCalled();
      expect(intakeMock).toHaveBeenCalled();
      // The window-restart short-circuit must win BEFORE the case's own
      // status is ever read — no queued getCase status (e.g. a still-busy
      // `in_build`) can matter here. Also guards against a would-be leaked,
      // never-consumed `getCaseMock.mockResolvedValueOnce` corrupting a
      // LATER test's queue (`vi.clearAllMocks()` clears call history, not
      // queued `...Once` return values).
      expect(getCaseMock).not.toHaveBeenCalled();
      expect(chatReplyPostMock.mock.calls.every(([, text]) => !String(text).toLowerCase().includes('still working'))).toBe(
        true,
      );
    });

    /**
     * THE fix under test (Change 1): an EXPLICIT reply
     * inside a thread that already has a recorded `thread_name` link (STAGE
     * 1 HIT) continues that conversation as a follow-up — window-independent.
     * Parameterized over both the OLD default (`per_message`, which would
     * restart on EVERY message if it applied here) and the NEW default
     * (`idle_gap`) to prove neither habit can affect this path: both
     * `resolveUserChatConversationWindow` and `shouldRestartChatConversation`
     * must never even be called, and `shouldRestartChatConversationMock` is
     * pinned to `true` (i.e. "would restart if consulted") specifically so a
     * regression that wrongly re-introduces the window check on this path
     * fails loudly with a new root Case instead of silently passing.
     * Reverting the STAGE 1 hit branch in `resolveChatConversationLookup`
     * (e.g. deleting it so a DM always goes straight to STAGE 2) breaks
     * this: `intakeMock` would be called instead of `intakeFollowUpMock`,
     * and both window mocks would be invoked.
     */
    it.each(['per_message', 'idle_gap'] as const)(
      'continues an explicit DM thread reply via intakeFollowUp under the %s window, without ever consulting it',
      async (window) => {
        mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
        resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_thread_root', updatedAt: '2026-01-01T00:00:00.000Z' }); // stage 1 hit
        getCaseMock.mockResolvedValueOnce({ case_id: 'case_dm_thread_root', status: 'done' });
        resolveUserChatConversationWindowMock.mockResolvedValue(window);
        shouldRestartChatConversationMock.mockReturnValue(true);
        intakeFollowUpMock.mockResolvedValueOnce({
          case: { case_id: 'case_dm_thread_2', status: 'open' },
          run: { run_id: 'run_2' },
          run_id: 'run_2',
          event_id: 'evt_2',
          replayed: false,
        });

        const res = await POST(makeReq(makeDirectMessageEvent({ text: 'explicit reply' })));

        expect(res.status).toBe(200);
        expect(resolveChatThreadCaseMock).toHaveBeenCalledTimes(1);
        expect(resolveChatThreadCaseMock).toHaveBeenCalledWith('thread_name', THREAD_NAME);
        expect(intakeMock).not.toHaveBeenCalled();
        expect(intakeFollowUpMock).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'explicit reply' }),
          'usr_alex',
          'case_dm_thread_root',
        );
        expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
        expect(shouldRestartChatConversationMock).not.toHaveBeenCalled();
      },
    );

    /**
     * Busy-path companion to the fix above: a thread-keyed STAGE 1 HIT whose
     * Case is genuinely still in flight (`in_build`) must nudge "still
     * working", exactly like a SPACE thread hit does — never fall through to
     * STAGE 2 or start a new root. Reverting the `resolveChatThreadCaseStatus`
     * reuse on the STAGE 1 hit branch (e.g. hand-rolling a status check that
     * forgets the busy case) breaks this.
     */
    it('posts the busy nudge for an explicit DM thread reply whose case is still in flight, without starting a new case', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_thread_root', updatedAt: '2026-01-01T00:00:00.000Z' }); // stage 1 hit
      getCaseMock.mockResolvedValueOnce({ case_id: 'case_dm_thread_root', status: 'in_build' });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'still there?' })));

      expect(res.status).toBe(200);
      expect(intakeMock).not.toHaveBeenCalled();
      expect(intakeFollowUpMock).not.toHaveBeenCalled();
      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
      expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
      const [target, text] = chatReplyPostMock.mock.calls[0] as [{ spaceName: string; threadName?: string }, string];
      expect(target).toMatchObject({ spaceName: SPACE_NAME, threadName: THREAD_NAME });
      expect(text.toLowerCase()).toContain('still working');
    });

    /**
     * Change 2: a DM must record BOTH continuity keys
     * on every non-replayed turn — the space key (window continuity, as
     * before) AND the thread key for THIS message's own thread (so a FUTURE
     * explicit reply hits STAGE 1 above) — both pointing at the SAME
     * `(rootCaseId, caseId)`. Reverting `runChatIntake`'s dual
     * `recordChatThreadTip` calls back to a single conditional call breaks
     * this — only one of the two `toHaveBeenCalledWith` assertions would
     * hold.
     */
    it('records both a space-keyed and a thread-keyed tip after a fresh DM root, pointing at the same case ids', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      // Both stages miss: a genuinely first-ever DM message.
      resolveChatThreadCaseMock.mockResolvedValue(undefined);
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_dm_fresh', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'hello' })));

      expect(res.status).toBe(200);
      expect(recordChatThreadTipMock).toHaveBeenCalledTimes(2);
      expect(recordChatThreadTipMock).toHaveBeenCalledWith('space_name', SPACE_NAME, 'case_dm_fresh', 'case_dm_fresh');
      expect(recordChatThreadTipMock).toHaveBeenCalledWith('thread_name', THREAD_NAME, 'case_dm_fresh', 'case_dm_fresh');
    });

    /**
     * Same dual-record contract, on the intakeFollowUp branch (a STAGE 1
     * thread hit) — proves Change 2 applies regardless of which stage
     * resolved the lookup, and that `rootCaseId` (not the follow-up's own
     * `case_id`) is what both links get advanced to.
     */
    it('records both continuity keys after a DM follow-up, using the thread root case id', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_thread_root', updatedAt: '2026-01-01T00:00:00.000Z' });
      getCaseMock.mockResolvedValueOnce({ case_id: 'case_dm_thread_root', status: 'done' });
      intakeFollowUpMock.mockResolvedValueOnce({
        case: { case_id: 'case_dm_followup', status: 'open', assistant_thread: { root_case_id: 'case_dm_thread_root' } },
        run: null,
        run_id: 'run_2',
        event_id: 'evt_2',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'and another thing' })));

      expect(res.status).toBe(200);
      expect(recordChatThreadTipMock).toHaveBeenCalledTimes(2);
      expect(recordChatThreadTipMock).toHaveBeenCalledWith(
        'space_name',
        SPACE_NAME,
        'case_dm_thread_root',
        'case_dm_followup',
      );
      expect(recordChatThreadTipMock).toHaveBeenCalledWith(
        'thread_name',
        THREAD_NAME,
        'case_dm_thread_root',
        'case_dm_followup',
      );
    });

    /**
     * The conversation-window habit is looked up ONLY for a DM — a space
     * message must never even call `resolveUserChatConversationWindow`.
     * Reverting the `sender.conversationKind !== 'direct'` guard in
     * `resolveChatConversationLookup` breaks this.
     */
    it('does not look up the conversation-window habit for a space message', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      await POST(makeReq(makeMessageEvent()));

      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
    });

    /**
     * The other direction of the same guard: a DM whose own thread has no
     * recorded link (stage 1 miss, the default for these fixtures) DOES look
     * it up on the stage 2 fallback, keyed on the mapped actor id.
     */
    it('looks up the conversation-window habit for the mapped actor once a DM falls through to stage 2', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      await POST(makeReq(makeDirectMessageEvent()));

      expect(resolveChatThreadCaseMock).toHaveBeenNthCalledWith(1, 'thread_name', THREAD_NAME);
      expect(resolveUserChatConversationWindowMock).toHaveBeenCalledWith('usr_alex');
    });

    /**
     * `conversation_visibility` — previously silently defaulted to
     * `'direct'` for EVERY chat-channel intake regardless of what the
     * payload actually was, since no caller ever populated
     * `request.chat.conversation_visibility` (see
     * `assistant-intake-service.ts`'s `?? 'direct'` fallback). Reverting
     * the `conversation_visibility: sender.conversationKind` line in
     * `runChatIntake`'s `intake(...)` call breaks BOTH halves of this test.
     */
    it('passes the real conversation_visibility through to intake for both a space and a DM message', async () => {
      intakeMock.mockResolvedValue({
        case: { case_id: 'case_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });
      mapChatIdentityMock.mockResolvedValue({ outcome: 'mapped', userId: 'usr_alex' });

      await POST(makeReq(makeMessageEvent({ text: 'space message' })));
      expect(intakeMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ chat: expect.objectContaining({ conversation_visibility: 'space' }) }),
        'usr_alex',
      );

      await POST(makeReq(makeDirectMessageEvent({ text: 'dm message' })));
      expect(intakeMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ chat: expect.objectContaining({ conversation_visibility: 'direct' }) }),
        'usr_alex',
      );
    });

    /**
     * REQUIRED FAIL-SAFE CONTRACT at the route level (mirrors
     * `chat-sender.test.ts`'s unit test): an event whose `spaceType` is
     * absent or unrecognized must still key on the thread, exactly like
     * every other pre-existing fixture in this file — never silently
     * treated as a DM (which would attempt a two-stage lookup instead of the
     * single space-branch one). Reverting `resolveConversationKind`'s
     * fallback (or `resolveChatConversationLookup`'s branch on it) breaks
     * this.
     */
    it('treats an unrecognized spaceType as space-keyed, not as a DM', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      await POST(makeReq(makeMessageEvent({ spaceType: 'SOME_FUTURE_SPACE_TYPE' })));

      expect(resolveChatThreadCaseMock).toHaveBeenCalledTimes(1);
      expect(resolveChatThreadCaseMock).toHaveBeenCalledWith('thread_name', THREAD_NAME);
      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
    });

    /**
     * Part 1's "cannot collide" contract, exercised through the route: a
     * SPACE and a DM whose resource-name strings happen to be identical
     * must key on DIFFERENT continuity keys (`thread_name` vs
     * `space_name`) — `chatThreadLinkId`'s own unit tests
     * (`chat-thread-link-service.test.ts`) prove those two never hash to
     * the same doc id; this proves the route actually passes the right
     * `keyKind` for each. The DM call is the 2nd and 3rd overall
     * `resolveChatThreadCaseMock` calls (stage 1 miss on its OWN thread name,
     * `THREAD_NAME`, then stage 2 on `sameName`) — the SPACE call above it is
     * the 1st.
     */
    it('keys a space message and a DM on different continuity-key kinds even with the same resource-name string', async () => {
      const sameName = 'spaces/SHARED_NAME';
      mapChatIdentityMock.mockResolvedValue({ outcome: 'mapped', userId: 'usr_alex' });
      intakeMock.mockResolvedValue({
        case: { case_id: 'case_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      await POST(makeReq(makeMessageEvent({ threadName: sameName, spaceName: SPACE_NAME })));
      expect(resolveChatThreadCaseMock).toHaveBeenNthCalledWith(1, 'thread_name', sameName);

      await POST(makeReq(makeDirectMessageEvent({ spaceName: sameName })));
      expect(resolveChatThreadCaseMock).toHaveBeenNthCalledWith(2, 'thread_name', THREAD_NAME);
      expect(resolveChatThreadCaseMock).toHaveBeenNthCalledWith(3, 'space_name', sameName);
    });
  });

  /**
   * "neu:"/"new:" new-conversation prefix (issue #969).
   * Applies ONLY to a DM top-level message (a STAGE 1 miss in
   * `resolveChatConversationLookup`): it skips the space-keyed window
   * lookup entirely and routes straight to root `intake()`, with the
   * prefix stripped from the stored text. A STAGE 1 HIT (an explicit
   * thread reply) ignores the prefix — pass-through, unchanged text — same
   * "explicit reply wins" rule #962 already established.
   */
  describe('new-conversation prefix ("neu:"/"new:")', () => {
    /**
     * Core routing behavior: a prefixed top-level DM message never reaches
     * the space-keyed (STAGE 2) lookup at all — `resolveChatThreadCaseMock`
     * is called exactly once (STAGE 1 only) and
     * `resolveUserChatConversationWindowMock` is never called — and the
     * stored task text has the prefix removed. Reverting the
     * `stripNewConversationPrefix` short-circuit in
     * `resolveChatConversationLookup` (e.g. deleting it, or moving it after
     * the STAGE 2 window lookup) breaks this: `resolveChatThreadCaseMock`
     * would be called a second time for `space_name`, and/or
     * `resolveUserChatConversationWindowMock` would be called, and/or the
     * prefix would still be present in `intakeMock`'s `text`.
     */
    it('routes a prefixed top-level DM straight to root intake, skipping the space-keyed window lookup, with the prefix stripped from the stored text', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1: this thread has no recorded link
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_new_1', status: 'open' },
        run: null,
        run_id: 'run_1',
        event_id: 'evt_1',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'neu: zeig mir X' })));

      expect(res.status).toBe(200);
      expect(resolveChatThreadCaseMock).toHaveBeenCalledTimes(1);
      expect(resolveChatThreadCaseMock).toHaveBeenCalledWith('thread_name', THREAD_NAME);
      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
      expect(intakeFollowUpMock).not.toHaveBeenCalled();
      expect(intakeMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'zeig mir X', idempotency_key: MESSAGE_NAME }),
        'usr_alex',
      );
    });

    /**
     * Busy-bypass contract: a prefixed top-level DM never even reaches the
     * space-keyed lookup that would otherwise discover a still-in-flight
     * previous case — no "still working" nudge, straight to a new root
     * case instead. Deliberately does NOT queue a second
     * `resolveChatThreadCaseMock`/`getCaseMock` value representing that
     * busy previous case: this file's shared mocks are `Once`-queued
     * across tests, and `vi.clearAllMocks()` in the top-level `beforeEach`
     * does not drain that queue, so a value queued here but never consumed
     * (because the bypass correctly skips stage 2) would leak into and
     * corrupt the NEXT test's first call instead of catching a regression
     * in this one — `resolveChatThreadCaseMock).toHaveBeenCalledTimes(1)`
     * below already proves stage 2 never ran. Reverting the prefix check's
     * placement (e.g. running it only after
     * `resolveExistingChatThreadCase` decides busy/ready/none, instead of
     * before it) breaks this: `resolveChatThreadCaseMock` would be called a
     * second time, `intakeMock` would never be called, and (since the
     * beforeEach default has `resolveUserChatConversationWindowMock`
     * resolve `'continuous'` and `shouldRestartChatConversationMock`
     * return `false`) the space key's dangling/missing link would resolve
     * `'none'` anyway here — so the sharper regression signal is
     * `resolveChatThreadCaseMock`'s call count, not a busy nudge.
     */
    it('routes a prefixed top-level DM to root intake without ever attempting the space-keyed lookup', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1: this thread has no recorded link
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_new_2', status: 'open' },
        run: null,
        run_id: 'run_2',
        event_id: 'evt_2',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'New: what about Y' })));

      expect(res.status).toBe(200);
      expect(resolveChatThreadCaseMock).toHaveBeenCalledTimes(1); // stage 2 never attempted
      expect(getCaseMock).not.toHaveBeenCalled();
      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
      expect(intakeFollowUpMock).not.toHaveBeenCalled();
      expect(intakeMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'what about Y' }), 'usr_alex');
      expect(
        chatReplyPostMock.mock.calls.every(([, text]) => !String(text).toLowerCase().includes('still working')),
      ).toBe(true);
    });

    /**
     * Regression guard: an UNPREFIXED top-level DM message must keep using
     * the pre-existing window-governed STAGE 2 lookup, unchanged. Reverting
     * this file's prefix feature so it ALSO fires on ordinary text (e.g. a
     * mis-scoped prefix pattern matching anything, or the bypass not being
     * conditioned on a match at all) breaks this: `intakeMock` would be
     * called instead of `intakeFollowUpMock`, or the text would be altered.
     */
    it('leaves an unprefixed top-level DM message on the existing window-governed lookup', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1 miss
      resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_root', updatedAt: '2026-01-01T00:00:00.000Z' }); // stage 2 hit
      getCaseMock.mockResolvedValueOnce({ case_id: 'case_dm_root', status: 'done' });
      resolveUserChatConversationWindowMock.mockResolvedValueOnce('idle_gap');
      shouldRestartChatConversationMock.mockReturnValue(false);
      intakeFollowUpMock.mockResolvedValueOnce({
        case: { case_id: 'case_dm_3', status: 'open' },
        run: null,
        run_id: 'run_3',
        event_id: 'evt_3',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'no prefix here' })));

      expect(res.status).toBe(200);
      expect(resolveUserChatConversationWindowMock).toHaveBeenCalledWith('usr_alex');
      expect(intakeMock).not.toHaveBeenCalled();
      expect(intakeFollowUpMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'no prefix here' }),
        'usr_alex',
        'case_dm_root',
      );
    });

    /**
     * Explicit-reply-wins contract: a STAGE 1 HIT (a reply inside a thread
     * that already has a recorded link) stays a follow-up even when its
     * text carries the "neu:" prefix, and the prefix is left in the stored
     * text — see `resolveChatConversationLookup`'s doc for why (the
     * explicit reply is the user's own continuity signal, #962, and must
     * not be second-guessed by text content). Reverting the STAGE 1 branch
     * to also call `stripNewConversationPrefix` breaks this: the stored
     * text would lose "neu: ", or `intakeMock` would be called instead of
     * `intakeFollowUpMock`.
     */
    it('keeps a prefixed explicit DM thread reply as a follow-up, with the prefix left in the stored text', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce({ caseId: 'case_dm_thread_root', updatedAt: '2026-01-01T00:00:00.000Z' }); // stage 1 hit
      getCaseMock.mockResolvedValueOnce({ case_id: 'case_dm_thread_root', status: 'done' });
      intakeFollowUpMock.mockResolvedValueOnce({
        case: { case_id: 'case_dm_thread_2', status: 'open' },
        run: null,
        run_id: 'run_4',
        event_id: 'evt_4',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'neu: still in this thread' })));

      expect(res.status).toBe(200);
      expect(resolveChatThreadCaseMock).toHaveBeenCalledTimes(1);
      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
      expect(intakeMock).not.toHaveBeenCalled();
      expect(intakeFollowUpMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'neu: still in this thread' }),
        'usr_alex',
        'case_dm_thread_root',
      );
    });

    /**
     * The colon is REQUIRED: "neue Cases zeigen" (German "neue", never
     * followed by a colon) must route exactly like any other top-level DM
     * message, text unchanged. Reverting `NEW_CONVERSATION_PREFIX_PATTERN`
     * to something looser (e.g. `/^\s*neu/i` without the colon) breaks
     * this: the STAGE 2 window lookup would be skipped and the stored text
     * would lose its "neue " lead-in.
     */
    it('does not treat "neue" (no colon) as the prefix — normal routing, text unchanged', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValue(undefined); // both stages miss
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_neue', status: 'open' },
        run: null,
        run_id: 'run_5',
        event_id: 'evt_5',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'neue Cases zeigen' })));

      expect(res.status).toBe(200);
      expect(resolveUserChatConversationWindowMock).toHaveBeenCalledWith('usr_alex'); // stage 2 window lookup DID run
      expect(intakeMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'neue Cases zeigen' }), 'usr_alex');
    });

    /**
     * Case-insensitivity and whitespace tolerance: "NEW:" (uppercase) plus
     * multiple spaces after the colon. Reverting the `i` flag on
     * `NEW_CONVERSATION_PREFIX_PATTERN`, or its trailing `\s*`, breaks this
     * — either the prefix would not match at all (falling through to STAGE
     * 2) or the stored text would keep its leading spaces.
     */
    it('matches "NEW:" case-insensitively and trims the whitespace after the colon', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1 miss
      intakeMock.mockResolvedValueOnce({
        case: { case_id: 'case_new_6', status: 'open' },
        run: null,
        run_id: 'run_6',
        event_id: 'evt_6',
        replayed: false,
      });

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'NEW:   question' })));

      expect(res.status).toBe(200);
      expect(resolveUserChatConversationWindowMock).not.toHaveBeenCalled();
      expect(intakeMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'question' }), 'usr_alex');
    });

    /**
     * Empty remainder ("neu:" alone): not special-cased. The stripped
     * (empty) text is passed straight to `intake()` exactly like any other
     * task text, which already rejects an empty string with a
     * `ValidationError` before any Firestore write
     * (`AssistantIntakeService.intake`) — `runChatIntake`'s existing outer
     * try/catch already tolerates that error shape (see its doc comment:
     * "an empty-text ValidationError that should be unreachable... given
     * `resolveChatMessage`'s own non-empty check"). This proves that SAME
     * path now handles it once the prefix strip makes it reachable, rather
     * than a new dedicated empty-text branch. Reverting `runChatIntake`'s
     * catch-all try/catch to no longer swallow an `intake()` rejection
     * breaks this (the route would throw instead of acking 200).
     */
    it('lets an empty remainder ("neu:" alone) fall through to intake()\'s own empty-text rejection, posting nothing', async () => {
      mapChatIdentityMock.mockResolvedValueOnce({ outcome: 'mapped', userId: 'usr_alex' });
      resolveChatThreadCaseMock.mockResolvedValueOnce(undefined); // stage 1 miss
      intakeMock.mockRejectedValueOnce(
        Object.assign(new Error('Assistant task text must not be empty.'), { code: 'VALIDATION_ERROR' }),
      );

      const res = await POST(makeReq(makeDirectMessageEvent({ text: 'neu:' })));

      expect(res.status).toBe(200);
      expect(intakeMock).toHaveBeenCalledWith(expect.objectContaining({ text: '' }), 'usr_alex');
      expect(chatReplyPostMock).not.toHaveBeenCalled();
    });
  });
});
