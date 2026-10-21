import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetPendingDeviceFlowForTests,
  __awaitBackgroundFlowsForTests,
  markdownLoginPrompt,
  withCredsRetry,
  type MutableCreds,
  type WithCredsContext,
} from "./mcp-creds.js";
import type { ToolResult } from "./types.js";
import type { ResolvedCreds } from "./credentials.js";
import type { DeviceFlowHandle } from "./mcp-creds.js";
import type { DevicePollResult } from "./device-flow.js";

function failCreds(): ResolvedCreds {
  return {
    ok: false,
    reason: "no_token",
    baseUrl: "https://example.com",
    clientName: "cursor",
    deviceLabel: "test-host",
    deviceId: "0123456789abcdef",
  };
}

function okCreds(token: string, tokenSource: "keychain" | "env" | "fs-fallback" = "keychain"): ResolvedCreds {
  return {
    ok: true,
    baseUrl: "https://example.com",
    token,
    tokenSource,
    clientName: "cursor",
    deviceLabel: "test-host",
    deviceId: "0123456789abcdef",
  };
}

/** Build the error result a tool handler produces when the API rejects a token
 * with 401 — mirrors `errorResult(new ArbitraApiError(401, ...))`. */
function apiError401(): ToolResult {
  return {
    content: [{ type: "text" as const, text: "Arbitra API error (401): Invalid or expired access token" }],
    isError: true,
    _apiErrorStatus: 401,
  };
}

test("markdownLoginPrompt formats per spec §D.6 with capitalized client", () => {
  const md = markdownLoginPrompt("cursor", "https://arbitra.example.com", "WDJB-MJHT");
  assert.match(md, /\*\*Connect Cursor to Arbitra\*\*/);
  assert.match(md, /\[Connect Cursor to Arbitra →\]\(https:\/\/arbitra\.example\.com\/connect\?code=WDJB-MJHT\)/);
  assert.match(md, /`WDJB-MJHT`/);
  assert.match(md, /expires in 10 minutes/);
});

test("markdownLoginPrompt falls back to 'your tool' for unknown client_name", () => {
  const md = markdownLoginPrompt("intellij", "https://x.example.com", "ABCD-EFGH");
  assert.match(md, /Connect your tool to Arbitra/);
});

test("markdownLoginPrompt tells the user to retry their original request (not auto-retry)", () => {
  const md = markdownLoginPrompt("cursor", "https://example.com", "WDJB-MJHT");
  assert.match(md, /retry your original request/i);
  assert.doesNotMatch(md, /retry automatically/i);
});

test("handler runs directly when creds are already ok", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_secret"),
    baseUrl: "https://example.com",
    token: "arb_secret",
  };
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
  };
  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async (args) => ({
    content: [{ type: "text" as const, text: `got ${args.x}` }],
  }));
  const result = await wrapped({ x: 42 });
  assert.match((result as ToolResult).content[0]?.text ?? "", /got 42/);
});

test("missing creds returns markdown immediately without blocking on the poll", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: failCreds(),
    baseUrl: "https://example.com",
  };

  // The completion promise resolves only after 500ms — if withCredsRetry
  // awaited it we'd see the test stall well past the 50ms budget.
  let pollResolved = false;
  const completion = new Promise<DevicePollResult>((resolve) => {
    setTimeout(() => {
      pollResolved = true;
      resolve({
        status: "success",
        data: {
          access_token: "arb_after_flow",
          token_type: "Bearer",
          project_id: "proj_xyz",
        },
      });
    }, 500);
  });

  let handlerCalled = false;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_xyz",
        user_code: "WDJB-MJHT",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=WDJB-MJHT",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion,
    }),
    writeToken: async () => ({ source: "keychain" }),
    writeArbitraEnv: async () => "/tmp/fake-path",
    resolveCreds: async () => okCreds("arb_after_flow"),
  };

  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => {
    handlerCalled = true;
    return { content: [{ type: "text" as const, text: "handler ran" }] };
  });

  const start = Date.now();
  const result = (await wrapped({ x: 1 })) as ToolResult;
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 50, `expected return within 50ms, got ${elapsed}ms`);
  assert.equal(pollResolved, false, "poll must not have completed yet");
  assert.equal(handlerCalled, false, "handler must not run on the markdown path");
  assert.match(result.content[0]?.text ?? "", /Connect Cursor to Arbitra/);
  assert.match(result.content[0]?.text ?? "", /WDJB-MJHT/);
  assert.equal(
    (result.structuredContent as Record<string, unknown>).requires_login,
    true
  );

  // Drain the background task so this test doesn't leak into the next.
  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});

test("background polling writes the token to the keychain on success", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: failCreds(),
    baseUrl: "https://example.com",
  };

  let writtenToken: string | null = null;
  let writtenBaseUrl: string | null = null;
  const completion = new Promise<DevicePollResult>((resolve) => {
    setTimeout(() => {
      resolve({
        status: "success",
        data: {
          access_token: "arb_after_flow",
          token_type: "Bearer",
          project_id: "proj_xyz",
        },
      });
    }, 30);
  });

  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_xyz",
        user_code: "WDJB-MJHT",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=WDJB-MJHT",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion,
    }),
    writeToken: async (baseUrl, _client, token) => {
      writtenBaseUrl = baseUrl;
      writtenToken = token;
      return { source: "keychain" };
    },
    writeArbitraEnv: async () => "/tmp/fake-path",
    resolveCreds: async () => okCreds("arb_after_flow"),
  };

  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => ({
    content: [{ type: "text" as const, text: "handler ran" }],
  }));

  await wrapped({ x: 1 });
  await __awaitBackgroundFlowsForTests();

  assert.equal(writtenToken, "arb_after_flow");
  assert.equal(writtenBaseUrl, "https://example.com");

  __resetPendingDeviceFlowForTests();
});

test("second call after background poll success returns the real handler result", async () => {
  __resetPendingDeviceFlowForTests();

  // resolveCreds returns failCreds the first time, okCreds afterwards. This
  // models the discovery chain seeing a populated keychain on the second
  // tool call (after the background poll wrote the token).
  let flipped = false;
  const mutable: MutableCreds = {
    current: failCreds(),
    baseUrl: "https://example.com",
  };

  const completion = new Promise<DevicePollResult>((resolve) => {
    setTimeout(() => {
      resolve({
        status: "success",
        data: {
          access_token: "arb_after_flow",
          token_type: "Bearer",
          project_id: "proj_xyz",
        },
      });
    }, 30);
  });

  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_xyz",
        user_code: "WDJB-MJHT",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=WDJB-MJHT",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion,
    }),
    writeToken: async () => {
      flipped = true;
      return { source: "keychain" };
    },
    writeArbitraEnv: async () => "/tmp/fake-path",
    resolveCreds: async () => (flipped ? okCreds("arb_after_flow") : failCreds()),
  };

  let handlerCalls = 0;
  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async (args) => {
    handlerCalls += 1;
    return { content: [{ type: "text" as const, text: `handler:${args.x}` }] };
  });

  // First call: creds missing → returns markdown, handler NOT invoked.
  const first = (await wrapped({ x: 1 })) as ToolResult;
  assert.match(first.content[0]?.text ?? "", /Connect Cursor to Arbitra/);
  assert.equal(handlerCalls, 0);

  // Wait for the background poll to settle so applyCreds runs and mutable
  // state flips to ok.
  await __awaitBackgroundFlowsForTests();
  assert.equal(mutable.current.ok, true, "mutable.current.ok should flip after applyCreds");

  // Second call: creds present → handler runs and returns the real result.
  const second = (await wrapped({ x: 2 })) as ToolResult;
  assert.equal(handlerCalls, 1);
  assert.match(second.content[0]?.text ?? "", /handler:2/);

  __resetPendingDeviceFlowForTests();
});

test("two concurrent withCredsRetry calls share one in-flight device flow (spec §I.1)", async () => {
  __resetPendingDeviceFlowForTests();

  const mutable: MutableCreds = {
    current: failCreds(),
    baseUrl: "https://example.com",
  };

  let initCalls = 0;
  let pollCalls = 0;

  const originalFetch = global.fetch;
  // Intercept the device-flow HTTP calls (`/api/auth/connect/init` and
  // `/api/auth/connect/token`) at the global-fetch boundary. The real
  // `ensureDeviceFlow` in mcp-creds.ts dedups via its module-level
  // `pendingDeviceFlow` — that path is what we are actually validating.
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/auth/connect/init")) {
      initCalls += 1;
      return new Response(
        JSON.stringify({
          device_code: "dev_xyz",
          user_code: "WDJB-MJHT",
          verification_uri: "https://example.com/connect",
          verification_uri_complete: "https://example.com/connect?code=WDJB-MJHT",
          expires_in: 600,
          interval: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/api/auth/connect/token")) {
      pollCalls += 1;
      // Brief simulated server processing before terminal success.
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({
          access_token: "arb_after_flow",
          token_type: "Bearer",
          project_id: "proj_xyz",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch in concurrency test: ${url}`);
  }) as typeof global.fetch;

  let writeCount = 0;
  let flipped = false;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    writeToken: async () => {
      writeCount += 1;
      flipped = true;
      return { source: "keychain" };
    },
    writeArbitraEnv: async () => "/tmp/fake-path",
    resolveCreds: async () => (flipped ? okCreds("arb_after_flow") : failCreds()),
  };

  let handlerA = 0;
  let handlerB = 0;
  const wrappedA = withCredsRetry<{ id: string }, ToolResult>(ctx, async (args) => {
    handlerA += 1;
    return { content: [{ type: "text" as const, text: `A:${args.id}` }] };
  });
  const wrappedB = withCredsRetry<{ id: string }, ToolResult>(ctx, async (args) => {
    handlerB += 1;
    return { content: [{ type: "text" as const, text: `B:${args.id}` }] };
  });

  try {
    const [resA, resB] = await Promise.all([
      wrappedA({ id: "alpha" }),
      wrappedB({ id: "beta" }),
    ]);

    // Exactly one device-flow init for both concurrent callers (spec §I.1).
    assert.equal(initCalls, 1, `expected 1 init call, got ${initCalls}`);

    // New markdown-first semantics: neither concurrent caller waits for the
    // poll, so both get markdown with the same user_code.
    assert.equal(handlerA, 0, "handler A must NOT run on the markdown path");
    assert.equal(handlerB, 0, "handler B must NOT run on the markdown path");
    assert.match((resA as ToolResult).content[0]?.text ?? "", /WDJB-MJHT/);
    assert.match((resB as ToolResult).content[0]?.text ?? "", /WDJB-MJHT/);

    // Drain the detached background poll so the keychain write happens.
    await __awaitBackgroundFlowsForTests();
    assert.equal(writeCount, 1, `expected exactly 1 writeToken call, got ${writeCount}`);
    assert.ok(pollCalls >= 1, `expected pollCalls >= 1, got ${pollCalls}`);

    // Third call after the flow settled: handler runs normally.
    const wrappedC = withCredsRetry<{ id: string }, ToolResult>(ctx, async (args) => {
      return { content: [{ type: "text" as const, text: `C:${args.id}` }] };
    });
    const resC = (await wrappedC({ id: "gamma" })) as ToolResult;
    assert.match(resC.content[0]?.text ?? "", /C:gamma/);
  } finally {
    global.fetch = originalFetch;
    __resetPendingDeviceFlowForTests();
  }
});

test("missing creds + flow-expiry surfaces markdown and clears the slot for a retry", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: failCreds(),
    baseUrl: "https://example.com",
  };

  let settled: DevicePollResult | null = null;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_xyz",
        user_code: "EXPI-RED1",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=EXPI-RED1",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
    }),
    onBackgroundFlowSettled: (r) => {
      settled = r;
    },
  };

  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => ({
    content: [{ type: "text" as const, text: "should not be called" }],
  }));
  const result = (await wrapped({ x: 1 })) as ToolResult;
  assert.match(result.content[0]?.text ?? "", /Connect Cursor to Arbitra/);
  assert.match(result.content[0]?.text ?? "", /EXPI-RED1/);
  assert.ok(result.structuredContent);
  assert.equal((result.structuredContent as Record<string, unknown>).requires_login, true);

  // Drain the detached settle handler.
  await __awaitBackgroundFlowsForTests();
  assert.ok(settled, "background settled hook must fire");
  assert.equal((settled as DevicePollResult).status, "expired");

  // Slot cleared → a second call would start a fresh flow rather than serving
  // the stale handle. We verify by injecting a different starter and asserting
  // it actually fires (which it only would if the slot is null).
  let secondInitFired = false;
  const ctx2: WithCredsContext = {
    ...ctx,
    startDeviceFlow: async () => {
      secondInitFired = true;
      return {
        init: {
          device_code: "dev_xyz2",
          user_code: "FRES-HCD2",
          verification_uri: "https://example.com/connect",
          verification_uri_complete: "https://example.com/connect?code=FRES-HCD2",
          expires_in: 600,
          interval: 0,
        },
        baseUrl: "https://example.com",
        startedAt: Date.now(),
        completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
      };
    },
    onBackgroundFlowSettled: undefined,
  };
  const wrapped2 = withCredsRetry<{ x: number }, ToolResult>(ctx2, async () => ({
    content: [{ type: "text" as const, text: "ignored" }],
  }));
  const result2 = (await wrapped2({ x: 1 })) as ToolResult;
  assert.equal(secondInitFired, true, "second call must start a fresh flow");
  assert.match(result2.content[0]?.text ?? "", /FRES-HCD2/);

  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});

test("background poll crash does not poison the in-flight slot", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: failCreds(),
    baseUrl: "https://example.com",
  };

  // Use a rejecting completion promise to simulate a poll-loop crash.
  let settled: DevicePollResult | null = null;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_xyz",
        user_code: "CRSH-FLOW",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=CRSH-FLOW",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion: Promise.reject(new Error("simulated poll crash")),
    }),
    onBackgroundFlowSettled: (r) => {
      settled = r;
    },
  };

  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => ({
    content: [{ type: "text" as const, text: "ignored" }],
  }));
  await wrapped({ x: 1 });
  await __awaitBackgroundFlowsForTests();

  // The error handler converted the crash into a network_error result for
  // the settled hook — proving the catch path ran (and therefore the slot
  // was cleared in the finally block).
  assert.ok(settled, "background settled hook must fire even on crash");
  assert.equal((settled as DevicePollResult).status, "network_error");

  // Next call starts a fresh flow.
  let secondInitFired = false;
  const ctx2: WithCredsContext = {
    ...ctx,
    startDeviceFlow: async () => {
      secondInitFired = true;
      return {
        init: {
          device_code: "dev_xyz2",
          user_code: "AFTR-CRSH",
          verification_uri: "https://example.com/connect",
          verification_uri_complete: "https://example.com/connect?code=AFTR-CRSH",
          expires_in: 600,
          interval: 0,
        },
        baseUrl: "https://example.com",
        startedAt: Date.now(),
        completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
      };
    },
    onBackgroundFlowSettled: undefined,
  };
  const wrapped2 = withCredsRetry<{ x: number }, ToolResult>(ctx2, async () => ({
    content: [{ type: "text" as const, text: "ignored" }],
  }));
  await wrapped2({ x: 1 });
  assert.equal(secondInitFired, true, "slot must be cleared after crash");

  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});

test("env-token 401 stays a hard fail — no device flow, bare error returned", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_env_secret", "env"),
    baseUrl: "https://example.com",
    token: "arb_env_secret",
  };

  let deviceFlowStarted = false;
  let deleteCalled = false;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    startDeviceFlow: async () => {
      deviceFlowStarted = true;
      throw new Error("device flow must NOT start for an env token");
    },
    deleteToken: async () => {
      deleteCalled = true;
      return { removed: true };
    },
  };

  // Handler simulates the API rejecting the env token with 401.
  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => apiError401());
  const result = (await wrapped({ x: 1 })) as ToolResult;

  assert.equal(deviceFlowStarted, false, "env-token 401 must not start a device flow");
  assert.equal(deleteCalled, false, "env-token must not be cleared");
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /401/);
  assert.match(result.content[0]?.text ?? "", /Invalid or expired access token/);
  // No Connect prompt — CI must not see an interactive re-auth.
  assert.doesNotMatch(result.content[0]?.text ?? "", /Reconnect/i);
  assert.equal(mutable.current.ok, true, "env creds stay ok (no reset)");
  // Even on the env hard-fail path the internal tag is stripped from the wire.
  assert.equal(
    (result as ToolResult)._apiErrorStatus,
    undefined,
    "_apiErrorStatus must not leak onto the wire"
  );

  __resetPendingDeviceFlowForTests();
});

test("keychain-token 401 clears the token and surfaces the Connect re-auth link", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_stale", "keychain"),
    baseUrl: "https://example.com",
    token: "arb_stale",
  };

  let deletedBaseUrl: string | null = null;
  let deletedClient: string | null = null;
  let handlerCalls = 0;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async (baseUrl, clientName) => {
      deletedBaseUrl = baseUrl;
      deletedClient = clientName;
      return { removed: true };
    },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_reauth",
        user_code: "REAU-TH01",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=REAU-TH01",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
    }),
  };

  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => {
    handlerCalls += 1;
    return apiError401();
  });
  const result = (await wrapped({ x: 1 })) as ToolResult;

  // One handler invocation only — no retry loop.
  assert.equal(handlerCalls, 1, "handler must run exactly once (no auto-retry loop)");
  // Stale token cleared from the keychain.
  assert.equal(deletedBaseUrl, "https://example.com");
  assert.equal(deletedClient, "cursor");
  // Mutable creds reset to missing-token so subsequent calls take the flow.
  assert.equal(mutable.current.ok, false);
  assert.equal(mutable.token, undefined);
  // Re-auth prompt surfaces the Connect link + user code.
  assert.match(result.content[0]?.text ?? "", /Reconnect Cursor to Arbitra/);
  assert.match(result.content[0]?.text ?? "", /REAU-TH01/);
  assert.match(result.content[0]?.text ?? "", /connect\?code=REAU-TH01/);
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.requires_login, true);
  assert.equal(sc.reason, "token_expired");
  assert.equal(sc.verification_uri_complete, "https://example.com/connect?code=REAU-TH01");

  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});

test("fs-fallback-token 401 takes the same clear + Connect re-auth branch as keychain", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_stale_fs", "fs-fallback"),
    baseUrl: "https://example.com",
    token: "arb_stale_fs",
  };

  let deletedBaseUrl: string | null = null;
  let deletedClient: string | null = null;
  let handlerCalls = 0;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async (baseUrl, clientName) => {
      deletedBaseUrl = baseUrl;
      deletedClient = clientName;
      return { removed: true };
    },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_reauth",
        user_code: "REAU-TH01",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=REAU-TH01",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
    }),
  };

  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => {
    handlerCalls += 1;
    return apiError401();
  });
  const result = (await wrapped({ x: 1 })) as ToolResult;

  // Same branch as keychain: one handler call, token cleared, creds reset,
  // Connect re-auth prompt surfaced. Proves the `!== "env"` guard covers
  // fs-fallback, not just keychain.
  assert.equal(handlerCalls, 1, "handler must run exactly once (no auto-retry loop)");
  assert.equal(deletedBaseUrl, "https://example.com");
  assert.equal(deletedClient, "cursor");
  assert.equal(mutable.current.ok, false);
  assert.equal(mutable.token, undefined);
  assert.match(result.content[0]?.text ?? "", /Reconnect Cursor to Arbitra/);
  assert.match(result.content[0]?.text ?? "", /REAU-TH01/);
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.requires_login, true);
  assert.equal(sc.reason, "token_expired");

  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});

test("happy-path tool result is returned untouched (no 401 marker)", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_good", "keychain"),
    baseUrl: "https://example.com",
    token: "arb_good",
  };
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async () => {
      throw new Error("deleteToken must not be called on the happy path");
    },
  };
  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async (args) => ({
    content: [{ type: "text" as const, text: `ok:${args.x}` }],
  }));
  const result = (await wrapped({ x: 7 })) as ToolResult;
  assert.match(result.content[0]?.text ?? "", /ok:7/);
  assert.equal(mutable.current.ok, true);

  __resetPendingDeviceFlowForTests();
});

test("non-401 API error does NOT trigger re-auth (e.g. 403 / 500)", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_good", "keychain"),
    baseUrl: "https://example.com",
    token: "arb_good",
  };
  let deleteCalled = false;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async () => {
      deleteCalled = true;
      return { removed: true };
    },
    startDeviceFlow: async () => {
      throw new Error("device flow must NOT start for a non-401 error");
    },
  };
  const wrapped = withCredsRetry<{ x: number }, ToolResult>(ctx, async () => ({
    content: [{ type: "text" as const, text: "Arbitra API error (403): forbidden" }],
    isError: true,
    _apiErrorStatus: 403,
  }));
  const result = (await wrapped({ x: 1 })) as ToolResult;
  assert.equal(deleteCalled, false);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /403/);
  assert.equal(mutable.current.ok, true);
  // Internal tag stripped before returning to the client — never on the wire.
  assert.equal(
    (result as ToolResult)._apiErrorStatus,
    undefined,
    "_apiErrorStatus must not leak onto the wire"
  );

  __resetPendingDeviceFlowForTests();
});
