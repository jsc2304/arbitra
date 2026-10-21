import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLoginInternal } from "./login.js";
import { __resetKeytarForTests, __setKeytarForTests } from "./keychain.js";

const ORIGINAL_HOME = process.env.HOME;

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arbitra-login-home-"));
  process.env.HOME = home;
  return home;
}

function withTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "arbitra-login-cwd-"));
}

function restoreHome(): void {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
}

function captureOut(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s) => lines.push(s), lines };
}

interface FetchSequence {
  init: { user_code: string; device_code: string; verification_uri_complete: string };
  tokenResponses: Array<{ status: number; body: Record<string, unknown> }>;
}

function mockFetch(seq: FetchSequence): typeof fetch {
  let tokenIdx = 0;
  return (async (url: string | URL | Request) => {
    const target = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
    if (target.endsWith("/api/auth/connect/init")) {
      return new Response(
        JSON.stringify({
          device_code: seq.init.device_code,
          user_code: seq.init.user_code,
          verification_uri: "https://example.com/connect",
          verification_uri_complete: seq.init.verification_uri_complete,
          expires_in: 600,
          interval: 0, // tests don't want to wait
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.endsWith("/api/auth/connect/token")) {
      const r = seq.tokenResponses[Math.min(tokenIdx, seq.tokenResponses.length - 1)];
      tokenIdx += 1;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected URL in test: ${target}`);
  }) as unknown as typeof fetch;
}

test("happy path writes token to keychain and project_id to .arbitra/.env", async () => {
  withTempHome();
  const cwd = withTempCwd();
  const store = new Map<string, string>();
  __setKeytarForTests({
    getPassword: async (_s, a) => store.get(a) ?? null,
    setPassword: async (_s, a, p) => {
      store.set(a, p);
    },
    deletePassword: async (_s, a) => store.delete(a),
    findCredentials: async () =>
      Array.from(store.entries()).map(([account, password]) => ({ account, password })),
  });

  const out = captureOut();
  try {
    const code = await runLoginInternal({
      clientName: "cursor",
      clientVersion: "1.0.0",
      baseUrl: "https://api.example.com",
      cwd,
      fetchImpl: mockFetch({
        init: {
          user_code: "WDJB-MJHT",
          device_code: "dev_xyz",
          verification_uri_complete: "https://example.com/connect?code=WDJB-MJHT",
        },
        tokenResponses: [
          {
            status: 200,
            body: {
              access_token: "arb_secret_token",
              token_type: "Bearer",
              project_id: "proj_abc",
              project_name: "demo-project",
              server_url: "https://api.example.com",
            },
          },
        ],
      }),
      openUrl: async () => {
        /* noop */
      },
      promptEnter: async () => {
        /* noop */
      },
      stdoutWrite: out.write,
    });
    assert.equal(code, 0);
    assert.equal(store.get("https://api.example.com|cursor"), "arb_secret_token");
    const envBody = await fs.readFile(join(cwd, ".arbitra", ".env"), "utf-8");
    assert.match(envBody, /^ARBITRA_PROJECT_ID=proj_abc$/m);
    assert.match(envBody, /^ARBITRA_URL=https:\/\/api\.example\.com$/m);
    // Token should never appear in stdout.
    assert.ok(!out.lines.join("").includes("arb_secret_token"));
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("expired_token returns exit 1", async () => {
  withTempHome();
  const cwd = withTempCwd();
  __setKeytarForTests(null);
  const out = captureOut();
  try {
    const code = await runLoginInternal({
      clientName: "cursor",
      clientVersion: "1.0.0",
      baseUrl: "https://api.example.com",
      cwd,
      fetchImpl: mockFetch({
        init: {
          user_code: "ABCD-EFGH",
          device_code: "dev_xyz",
          verification_uri_complete: "https://example.com/connect?code=ABCD-EFGH",
        },
        tokenResponses: [{ status: 400, body: { error: "expired_token" } }],
      }),
      openUrl: async () => {},
      promptEnter: async () => {},
      stdoutWrite: out.write,
    });
    assert.equal(code, 1);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("access_denied returns exit 1", async () => {
  withTempHome();
  const cwd = withTempCwd();
  __setKeytarForTests(null);
  const out = captureOut();
  try {
    const code = await runLoginInternal({
      clientName: "cursor",
      clientVersion: "1.0.0",
      baseUrl: "https://api.example.com",
      cwd,
      fetchImpl: mockFetch({
        init: {
          user_code: "DENY-CODE",
          device_code: "dev_xyz",
          verification_uri_complete: "https://example.com/connect?code=DENY-CODE",
        },
        tokenResponses: [{ status: 400, body: { error: "access_denied" } }],
      }),
      openUrl: async () => {},
      promptEnter: async () => {},
      stdoutWrite: out.write,
    });
    assert.equal(code, 1);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("slow_down bumps interval and eventually succeeds", async () => {
  withTempHome();
  const cwd = withTempCwd();
  const store = new Map<string, string>();
  __setKeytarForTests({
    getPassword: async (_s, a) => store.get(a) ?? null,
    setPassword: async (_s, a, p) => {
      store.set(a, p);
    },
    deletePassword: async (_s, a) => store.delete(a),
    findCredentials: async () =>
      Array.from(store.entries()).map(([account, password]) => ({ account, password })),
  });
  const out = captureOut();
  try {
    const code = await runLoginInternal({
      clientName: "cursor",
      clientVersion: "1.0.0",
      baseUrl: "https://api.example.com",
      cwd,
      fetchImpl: mockFetch({
        init: {
          user_code: "SLOW-DOWN",
          device_code: "dev_xyz",
          verification_uri_complete: "https://example.com/connect?code=SLOW-DOWN",
        },
        tokenResponses: [
          { status: 400, body: { error: "slow_down" } },
          { status: 400, body: { error: "authorization_pending" } },
          {
            status: 200,
            body: {
              access_token: "arb_after_slowdown",
              token_type: "Bearer",
              project_id: "proj_abc",
            },
          },
        ],
      }),
      openUrl: async () => {},
      promptEnter: async () => {},
      stdoutWrite: out.write,
    });
    assert.equal(code, 0);
    assert.equal(store.get("https://api.example.com|cursor"), "arb_after_slowdown");
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});
