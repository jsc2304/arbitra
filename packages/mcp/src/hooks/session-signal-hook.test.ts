import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_NAME,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HARD_TIMEOUT_MS,
  buildSignalEvent,
  isGovernedWorkspace,
  postSignalBatch,
  resolveGitContext,
  runHook,
  shouldEmitHeartbeat,
  type RunHookDeps,
} from "./session-signal-hook.js";
import { sessionSignalEventSchema } from "./session-signal-schema.js";
import { __resetKeytarForTests, __setKeytarForTests, readToken } from "../keychain.js";

// ---------------------------------------------------------------------------
// buildSignalEvent — payload shape matches the server Zod schema replica.
// ---------------------------------------------------------------------------

test("buildSignalEvent produces a payload that validates against the server schema replica", () => {
  const event = buildSignalEvent({
    eventType: "session_start",
    sessionId: "sess-123",
    repository: "widgets",
    branch: "feat/session-signal-hook",
    now: new Date("2026-08-27T06:00:00.000Z"),
    eventId: "evt-fixed",
  });

  // Reverting any field assignment inside `candidate` in `buildSignalEvent`
  // (e.g. hardcoding `agent_name` to something else, or dropping
  // `client_timestamp`) fails this deepEqual. `sessionSignalEventSchema.parse`
  // below is a second, independent check: a shape that doesn't fit the
  // schema throws here regardless of what buildSignalEvent's own internal
  // `.parse()` call does or doesn't do.
  const parsed = sessionSignalEventSchema.parse(event);
  assert.deepEqual(parsed, {
    event_id: "evt-fixed",
    schema_version: 1,
    event_type: "session_start",
    agent_name: AGENT_NAME,
    repository: "widgets",
    branch: "feat/session-signal-hook",
    session_id: "sess-123",
    client_timestamp: "2026-08-27T06:00:00.000Z",
  });
});

test("buildSignalEvent defaults schema_version to SESSION_SIGNAL_SCHEMA_VERSION and generates a UUID event_id", () => {
  const a = buildSignalEvent({
    eventType: "heartbeat",
    sessionId: "sess-1",
    repository: "repo",
    branch: "main",
  });
  const b = buildSignalEvent({
    eventType: "heartbeat",
    sessionId: "sess-1",
    repository: "repo",
    branch: "main",
  });

  // Reverting `schemaVersion ?? SESSION_SIGNAL_SCHEMA_VERSION` to a hardcoded
  // different number breaks this.
  assert.equal(a.schema_version, 1);
  // Reverting `eventId ?? randomUUID()` to a constant breaks this — two
  // separately built events must not collide.
  assert.notEqual(a.event_id, b.event_id);
});

test("buildSignalEvent never includes tool content or code — only the seven identity/location fields", () => {
  const event = buildSignalEvent({
    eventType: "session_end",
    sessionId: "sess-1",
    repository: "repo",
    branch: "main",
  });
  // Reverting to spread extra fields (e.g. tool_input) onto the candidate
  // breaks this — the field set is the enforcement of "identity and
  // location only", not a runtime filter.
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      "agent_name",
      "branch",
      "client_timestamp",
      "event_id",
      "event_type",
      "repository",
      "schema_version",
      "session_id",
    ].sort()
  );
});

// ---------------------------------------------------------------------------
// resolveGitContext
// ---------------------------------------------------------------------------

test("resolveGitContext derives repository from `git remote get-url origin` and branch from `git branch --show-current`", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const ctx = resolveGitContext("/fake/cwd", (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "remote") return "git@github.com:acme/widgets.git";
    if (args[0] === "branch") return "feat/session-signal-hook";
    throw new Error("unexpected call");
  });

  // scp-like remotes carry no secret and stay untouched (the server parses them).
  assert.equal(ctx.repository, "git@github.com:acme/widgets.git");
  assert.equal(ctx.branch, "feat/session-signal-hook");
  // Reverting the `["remote", "get-url", "origin"]` args (or the branch
  // args) breaks this.
  assert.deepEqual(calls[0].args, ["remote", "get-url", "origin"]);
  assert.deepEqual(calls[1].args, ["branch", "--show-current"]);
});

test("resolveGitContext strips credentials from a URL-form remote before it is sent", () => {
  const remotes: Array<[string, string]> = [
    ["https://alex:ghp_secret123@github.com/acme/widgets.git", "https://github.com/acme/widgets.git"],
    ["https://ghp_secret123@github.com/acme/widgets.git", "https://github.com/acme/widgets.git"],
    ["https://alex:p@ss@git.example.com/acme/widgets.git", "https://git.example.com/acme/widgets.git"],
    ["ssh://git@github.com/acme/widgets.git", "ssh://github.com/acme/widgets.git"],
    ["https://github.com/acme/widgets.git", "https://github.com/acme/widgets.git"],
    ["https://github.com/acme/widgets@2.git", "https://github.com/acme/widgets@2.git"],
  ];
  for (const [remote, expected] of remotes) {
    const ctx = resolveGitContext("/fake/cwd", (_cmd, args) => {
      if (args[0] === "remote") return remote;
      if (args[0] === "branch") return "main";
      throw new Error("unexpected call");
    });
    // Reverting the `stripUrlCredentials` call in `resolveGitContext` breaks this.
    assert.equal(ctx.repository, expected);
    assert.ok(!ctx.repository.includes("secret123"));
  }
});

test("resolveGitContext falls back to the repo directory name when there is no origin remote", () => {
  const ctx = resolveGitContext("/fake/cwd/my-repo", (cmd, args) => {
    if (args[0] === "remote") throw new Error("no origin");
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return "/fake/cwd/my-repo";
    if (args[0] === "branch") return "main";
    throw new Error("unexpected call");
  });
  // Reverting the `basename(topLevel)` fallback breaks this.
  assert.equal(ctx.repository, "my-repo");
});

test("resolveGitContext falls back to a detached-HEAD marker when `branch --show-current` is empty", () => {
  const ctx = resolveGitContext("/fake/cwd", (cmd, args) => {
    if (args[0] === "remote") return "origin-url";
    if (args[0] === "branch") return ""; // detached HEAD returns empty string
    if (args[0] === "rev-parse" && args.includes("--short")) return "abc1234";
    throw new Error("unexpected call");
  });
  // Reverting the `detached:${sha}` fallback breaks this.
  assert.equal(ctx.branch, "detached:abc1234");
});

test("resolveGitContext never throws even when every git call fails", () => {
  const ctx = resolveGitContext("/not/a/repo", () => {
    throw new Error("git not found");
  });
  assert.equal(ctx.repository, "repo");
  assert.equal(ctx.branch, "unknown");
});

// ---------------------------------------------------------------------------
// shouldEmitHeartbeat — throttling
// ---------------------------------------------------------------------------

function inMemoryThrottleDeps() {
  const store = new Map<string, number>();
  return {
    deps: {
      read: (path: string) => store.get(path),
      write: (path: string, value: number) => store.set(path, value),
    },
    store,
  };
}

test("shouldEmitHeartbeat allows the first heartbeat for a session", () => {
  const { deps } = inMemoryThrottleDeps();
  const allowed = shouldEmitHeartbeat({ sessionId: "sess-1", now: 1000, deps });
  assert.equal(allowed, true);
});

test("shouldEmitHeartbeat blocks a second heartbeat inside the interval", () => {
  const { deps } = inMemoryThrottleDeps();
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 1000, intervalMs: 1000, deps }), true);
  // Reverting or removing the `params.now - last < intervalMs` throttle
  // check entirely breaks this — a heartbeat 500ms later must be blocked.
  // This does NOT pin the exact `<` vs `<=` boundary — see the dedicated
  // boundary test below for that.
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 1500, intervalMs: 1000, deps }), false);
});

test("shouldEmitHeartbeat boundary: exactly intervalMs elapsed is allowed, not blocked", () => {
  const { deps } = inMemoryThrottleDeps();
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 1000, intervalMs: 1000, deps }), true);
  // now - last === intervalMs exactly (2000 - 1000 === 1000). The strict `<`
  // comparison means this is NOT blocked. Reverting `<` to `<=` breaks this
  // specific assertion (it would flip to `false`).
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 2000, intervalMs: 1000, deps }), true);
});

test("shouldEmitHeartbeat allows a heartbeat again once the interval has elapsed", () => {
  const { deps } = inMemoryThrottleDeps();
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 1000, intervalMs: 1000, deps }), true);
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 2001, intervalMs: 1000, deps }), true);
});

test("shouldEmitHeartbeat throttles per session id independently", () => {
  const { deps } = inMemoryThrottleDeps();
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-a", now: 1000, intervalMs: 1000, deps }), true);
  // Reverting session-scoped state-file paths to a shared path breaks this
  // — a different session must not be throttled by session-a's heartbeat.
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-b", now: 1000, intervalMs: 1000, deps }), true);
});

test("shouldEmitHeartbeat defaults the throttle interval to DEFAULT_HEARTBEAT_INTERVAL_MS (2 minutes)", () => {
  assert.equal(DEFAULT_HEARTBEAT_INTERVAL_MS, 2 * 60 * 1000);
  const { deps } = inMemoryThrottleDeps();
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 0, deps }), true);
  // Reverting the default `intervalMs` breaks this — 90s later is still
  // inside a 2-minute window.
  assert.equal(shouldEmitHeartbeat({ sessionId: "sess-1", now: 90_000, deps }), false);
});

// ---------------------------------------------------------------------------
// postSignalBatch — timeout and failure swallowing
// ---------------------------------------------------------------------------

test("postSignalBatch swallows a network error and returns false instead of throwing", async () => {
  const result = await postSignalBatch({
    baseUrl: "https://example.invalid",
    token: "tok",
    events: [],
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  // Reverting the try/catch around the fetch call breaks this — the promise
  // would reject instead of resolving to `false`.
  assert.equal(result, false);
});

test("postSignalBatch returns false for a non-2xx response", async () => {
  const result = await postSignalBatch({
    baseUrl: "https://example.invalid",
    token: "tok",
    events: [],
    fetchImpl: async () => new Response(null, { status: 500 }),
  });
  assert.equal(result, false);
});

test("postSignalBatch aborts a hanging request at the timeout instead of waiting forever", async () => {
  let sawAbort = false;
  const start = Date.now();
  const result = await postSignalBatch({
    baseUrl: "https://example.invalid",
    token: "tok",
    events: [],
    timeoutMs: 50,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
      }),
  });
  const elapsed = Date.now() - start;
  // Reverting the `setTimeout(() => controller.abort(), timeoutMs)` call
  // breaks this — the request would hang past `timeoutMs` and this
  // assertion would time out the test instead of completing near 50ms.
  assert.equal(sawAbort, true);
  assert.equal(result, false);
  assert.ok(elapsed < 1000, `expected the abort well under 1s, took ${elapsed}ms`);
});

test("HARD_TIMEOUT_MS is at most 1500ms per the fire-and-forget contract", () => {
  assert.ok(HARD_TIMEOUT_MS <= 1500);
});

// ---------------------------------------------------------------------------
// runHook — end-to-end orchestration with injected dependencies
// ---------------------------------------------------------------------------

function baseDeps(overrides: Partial<RunHookDeps> = {}): Partial<RunHookDeps> {
  return {
    resolveCreds: async () => ({
      ok: true,
      baseUrl: "https://arbitra.example.com",
      token: "test-token",
      tokenSource: "env",
      clientName: AGENT_NAME,
      deviceLabel: "test-device",
      deviceId: "device-1",
    }),
    resolveGitContext: () => ({ repository: "widgets", branch: "feat/x" }),
    shouldEmitHeartbeat: () => true,
    isGovernedWorkspace: () => true,
    postSignalBatch: async () => true,
    now: () => new Date("2026-08-27T06:00:00.000Z"),
    ...overrides,
  };
}

test("runHook is a no-op in a workspace without .arbitra — no creds resolved, nothing posted", async () => {
  let credsCalled = false;
  let posted = false;
  await runHook(
    "session_start",
    { session_id: "sess-1", cwd: "/some/client/repo" },
    baseDeps({
      isGovernedWorkspace: () => false,
      resolveCreds: async () => {
        credsCalled = true;
        return {
          ok: true,
          baseUrl: "https://arbitra.example.com",
          token: "t",
          tokenSource: "env",
          clientName: AGENT_NAME,
          deviceLabel: "d",
          deviceId: "1",
        };
      },
      postSignalBatch: async () => { posted = true; return true; },
    })
  );
  // Reverting the `if (!d.isGovernedWorkspace(cwd)) return;` guard breaks this —
  // a session in a non-governed repo must leak nothing, not even a creds lookup.
  assert.equal(credsCalled, false);
  assert.equal(posted, false);
});

test("isGovernedWorkspace: true only when the workspace root carries .arbitra", async () => {
  const { mkdtempSync, mkdirSync: mkdir, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const governed = mkdtempSync(join(tmpdir(), "gov-"));
  const bare = mkdtempSync(join(tmpdir(), "bare-"));
  try {
    mkdir(join(governed, ".arbitra"));
    const noGit = () => {
      throw new Error("not a git repo");
    };
    // Reverting the existsSync(join(root, ".arbitra")) check breaks both assertions.
    assert.equal(isGovernedWorkspace(governed, noGit), true);
    assert.equal(isGovernedWorkspace(bare, noGit), false);
    // Git toplevel wins over cwd: cwd is a subdir, .arbitra sits at the toplevel.
    const sub = join(governed, "packages", "x");
    mkdir(sub, { recursive: true });
    assert.equal(isGovernedWorkspace(sub, () => governed), true);
    // Non-git nested workspace: .arbitra sits ABOVE cwd with no git toplevel —
    // the walk-up (mirroring findArbitraEnvFile) must still find it. Reverting
    // the ancestor loop to a single existsSync check breaks this assertion.
    assert.equal(isGovernedWorkspace(sub, noGit), true);
  } finally {
    rmSync(governed, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("runHook is a no-op when the hook input carries no session_id", async () => {
  let posted = false;
  await runHook(
    "session_start",
    {},
    baseDeps({ postSignalBatch: async () => { posted = true; return true; } })
  );
  // Reverting the `if (!sessionId) return;` guard breaks this.
  assert.equal(posted, false);
});

test("runHook posts one event with the session id, event type, and derived git context on the happy path", async () => {
  let captured: Parameters<RunHookDeps["postSignalBatch"]>[0] | undefined;
  await runHook(
    "session_start",
    { session_id: "sess-42", cwd: "/repo" },
    baseDeps({
      postSignalBatch: async (params) => {
        captured = params;
        return true;
      },
    })
  );

  assert.ok(captured);
  assert.equal(captured!.baseUrl, "https://arbitra.example.com");
  assert.equal(captured!.token, "test-token");
  assert.equal(captured!.events.length, 1);
  const event = captured!.events[0];
  assert.equal(event.event_type, "session_start");
  assert.equal(event.session_id, "sess-42");
  assert.equal(event.repository, "widgets");
  assert.equal(event.branch, "feat/x");
  assert.equal(event.agent_name, AGENT_NAME);
  sessionSignalEventSchema.parse(event);
});

test("runHook skips posting when credentials cannot be resolved (never starts an interactive flow)", async () => {
  let posted = false;
  await runHook(
    "session_start",
    { session_id: "sess-1", cwd: "/repo" },
    baseDeps({
      resolveCreds: async () => ({
        ok: false,
        reason: "no_token",
        baseUrl: "https://arbitra.example.com",
        clientName: AGENT_NAME,
        deviceLabel: "test-device",
        deviceId: "device-1",
      }),
      postSignalBatch: async () => { posted = true; return true; },
    })
  );
  // Reverting the `if (!creds.ok) return;` guard breaks this.
  assert.equal(posted, false);
});

test("runHook skips posting a throttled heartbeat and never resolves credentials for it", async () => {
  let credsCalled = false;
  let posted = false;
  await runHook(
    "heartbeat",
    { session_id: "sess-1", cwd: "/repo" },
    baseDeps({
      shouldEmitHeartbeat: () => false,
      resolveCreds: async () => {
        credsCalled = true;
        return {
          ok: true,
          baseUrl: "https://arbitra.example.com",
          token: "t",
          tokenSource: "env",
          clientName: AGENT_NAME,
          deviceLabel: "d",
          deviceId: "1",
        };
      },
      postSignalBatch: async () => { posted = true; return true; },
    })
  );
  // Reverting the `if (!emit) return;` throttle short-circuit breaks this —
  // a throttled heartbeat must not even resolve credentials, let alone post.
  assert.equal(credsCalled, false);
  assert.equal(posted, false);
});

test("runHook never throws even if a dependency throws", async () => {
  await assert.doesNotReject(() =>
    runHook(
      "session_start",
      { session_id: "sess-1", cwd: "/repo" },
      baseDeps({
        resolveCreds: async () => {
          throw new Error("boom");
        },
      })
    )
  );
});

// ---------------------------------------------------------------------------
// CLI entrypoint — exit code is always 0, regardless of failure mode.
// ---------------------------------------------------------------------------

// The hook runs through the real CLI entry point: `arbitra-mcp hook <event>`.
const CLI_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

// Two independent guards against ever reaching a real backend from these
// tests — belt and braces, because either one alone has a hole:
//
//   - An isolated $HOME plus a stripped ARBITRA_TOKEN does NOT stop
//     `readToken` (src/keychain.ts) from resolving a credential: keytar talks
//     to the OS-level keychain (macOS Keychain / Credential Manager /
//     libsecret), which $HOME does not scope. On any machine with a stored
//     `claude-code` credential, the CLI process would resolve a *real* token
//     regardless of $HOME. `ARBITRA_DISABLE_KEYCHAIN=1` is the actual guard —
//     `readToken` checks it first and returns null unconditionally (see
//     `isKeychainDisabledForTests` in src/keychain.ts) before it ever calls
//     keytar or reads the FS-fallback file. Proven by the dedicated
//     regression test below, which shows a stubbed keytar credential *is*
//     resolved without the env var and is *not* resolved with it.
//   - `ARBITRA_URL` is pointed at an unroutable loopback port so that even a
//     credential that slipped through by some future code path could not
//     reach the real Arbitra host — the connection fails closed, not open.
const UNROUTABLE_ARBITRA_URL = "http://127.0.0.1:1";

function runCli(args: string[], stdin: string, extraEnv: Record<string, string | undefined> = {}) {
  const isolatedHome = mkdtempSync(join(tmpdir(), "arbitra-hook-cli-test-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.ARBITRA_TOKEN;
  delete env.ARBITRA_PROJECT_ID;
  env.HOME = isolatedHome;
  env.ARBITRA_DISABLE_KEYCHAIN = "1";
  env.ARBITRA_URL = UNROUTABLE_ARBITRA_URL;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  return spawnSync(process.execPath, [CLI_ENTRY, "hook", ...args], {
    input: stdin,
    encoding: "utf-8",
    env,
    timeout: 5000,
    cwd: isolatedHome,
  });
}

test("ARBITRA_DISABLE_KEYCHAIN=1 makes readToken() return null even when keytar has a real credential", async () => {
  const originalFlag = process.env.ARBITRA_DISABLE_KEYCHAIN;
  try {
    delete process.env.ARBITRA_DISABLE_KEYCHAIN;
    __setKeytarForTests({
      getPassword: async () => "sentinel-would-be-a-real-prod-token",
      setPassword: async () => {},
      deletePassword: async () => true,
      findCredentials: async () => [],
    });

    // Without the guard: this is exactly the vulnerable path the review
    // caught — a stored credential resolves normally.
    const withoutGuard = await readToken("https://arbitra.example.com", "claude-code");
    assert.equal(withoutGuard?.token, "sentinel-would-be-a-real-prod-token");
    assert.equal(withoutGuard?.source, "keychain");

    // With the guard set: the exact same stubbed keytar is still wired up,
    // but readToken must not consult it at all.
    process.env.ARBITRA_DISABLE_KEYCHAIN = "1";
    const withGuard = await readToken("https://arbitra.example.com", "claude-code");
    // Reverting the `if (isKeychainDisabledForTests()) return null;` guard in
    // src/keychain.ts readToken breaks this — it would resolve the same
    // sentinel token as above instead of null.
    assert.equal(withGuard, null);
  } finally {
    __resetKeytarForTests();
    if (originalFlag === undefined) delete process.env.ARBITRA_DISABLE_KEYCHAIN;
    else process.env.ARBITRA_DISABLE_KEYCHAIN = originalFlag;
  }
});

test("CLI: exits 0 for an unrecognized event-type argument", () => {
  const result = runCli(["not-a-real-event"], "{}");
  assert.equal(result.status, 0);
});

test("CLI: exits 0 when stdin is not valid JSON", () => {
  const result = runCli(["session_start"], "not json{{{");
  assert.equal(result.status, 0);
});

test("CLI: exits 0 on the happy-path shape with no resolvable credentials (fire-and-forget contract)", () => {
  const result = runCli(
    ["session_start"],
    JSON.stringify({ session_id: "arbitra-mcp-test-cli-happy-path", cwd: "/tmp" })
  );
  assert.equal(result.status, 0);
  // A hook must stay silent: Claude Code reads stdout of some hook events.
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("CLI: exits 0 with empty stdin", () => {
  const result = runCli(["heartbeat"], "");
  assert.equal(result.status, 0);
});

test("CLI: with the keychain guard, a full session_start invocation completes near-instantly — no network attempt is made", () => {
  // `ARBITRA_DISABLE_KEYCHAIN=1` (baked into runCli) makes credential
  // resolution fail immediately (no env token, no keychain, no FS-fallback
  // — isolated $HOME has neither), so `runHook` returns before ever
  // constructing a fetch call. If that guard regressed and the process
  // instead attempted a real network call against the unroutable
  // `ARBITRA_URL`, `postSignalBatch`'s own 1500ms AbortController timeout
  // would still bound it, but the observed wall time would jump from
  // "effectively 0" to "near 1500ms". This asserts the fast path, which
  // only reverting the credential-resolution short-circuit (or the
  // ARBITRA_DISABLE_KEYCHAIN guard itself) would break.
  const start = Date.now();
  const result = runCli(
    ["session_start"],
    JSON.stringify({ session_id: "arbitra-mcp-test-cli-timing", cwd: "/tmp" })
  );
  const elapsed = Date.now() - start;
  assert.equal(result.status, 0);
  assert.ok(elapsed < 1000, `expected a near-instant exit with no network attempt, took ${elapsed}ms`);
});
