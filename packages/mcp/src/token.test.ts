import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runToken } from "./token.js";
import { DEFAULT_BASE_URL } from "./credentials.js";
import {
  __resetKeytarForTests,
  __setKeytarForTests,
  writeToken,
} from "./keychain.js";

const ORIGINAL = {
  HOME: process.env.HOME,
  ARBITRA_TOKEN: process.env.ARBITRA_TOKEN,
  ARBITRA_URL: process.env.ARBITRA_URL,
  ARBITRA_PROJECT_ID: process.env.ARBITRA_PROJECT_ID,
};

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arbitra-token-test-"));
  process.env.HOME = home;
  return home;
}

function withTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "arbitra-token-cwd-"));
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearArbitraEnv(): void {
  delete process.env.ARBITRA_TOKEN;
  delete process.env.ARBITRA_URL;
  delete process.env.ARBITRA_PROJECT_ID;
}

function mockKeytar() {
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
  return store;
}

function mockEmptyKeychain() {
  __setKeytarForTests({
    getPassword: async () => null,
    setPassword: async () => {
      /* noop */
    },
    deletePassword: async () => true,
    findCredentials: async () => [],
  });
}

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function capture(
  argv: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CaptureResult> {
  let stdout = "";
  let stderr = "";
  const code = await runToken(argv, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    stdoutWrite: (s) => {
      stdout += s;
    },
    stderrWrite: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

test("token short-circuits when ARBITRA_TOKEN env is set", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    process.env.ARBITRA_TOKEN = "arb_env_short_circuit";
    // Even with no keychain available the env wins.
    __setKeytarForTests(null);
    const res = await capture([], { cwd, env: process.env });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "arb_env_short_circuit\n");
    assert.equal(res.stderr, "");
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("token resolves from keychain when env is empty", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockKeytar();
    // Default --client-name is arbitra-gate; default base URL is the package default.
    await writeToken(DEFAULT_BASE_URL, "arbitra-gate", "arb_from_keychain");

    const res = await capture([], { cwd, env: process.env });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "arb_from_keychain\n");
    assert.equal(res.stderr, "");
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("token honours --client-name override", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockKeytar();
    await writeToken(DEFAULT_BASE_URL, "cursor", "arb_cursor_token");

    const res = await capture(["--client-name", "cursor"], { cwd, env: process.env });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "arb_cursor_token\n");
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("token resolves from fs-fallback when keychain unavailable", async () => {
  const home = withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    // Force keytar to fail-load so writeFsFallback is the only path.
    __setKeytarForTests(null);

    const dir = join(home, ".config", "arbitra");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(dir, "arbitra-gate.json"),
      JSON.stringify({
        version: 1,
        token: "arb_fs_fallback_token",
        client_name: "arbitra-gate",
        base_url: DEFAULT_BASE_URL,
        saved_at: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );

    const res = await capture([], { cwd, env: process.env });
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "arb_fs_fallback_token\n");
    assert.equal(res.stderr, "");
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("token returns non-zero and prints stderr diagnostic when nothing is resolvable", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockEmptyKeychain();

    const res = await capture([], { cwd, env: process.env });
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /arbitra-mcp token: not found/);
    assert.match(res.stderr, /arbitra-mcp login/);
    // Crucial: never echo a (partial) token to stderr.
    assert.doesNotMatch(res.stderr, /arb_/);
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("token --help prints usage and exits 0", async () => {
  const res = await capture(["--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Usage: arbitra-mcp token/);
  assert.equal(res.stderr, "");
});

test("cross-client-name keychain fallback — cursor-only login, default args succeed", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockKeytar();
    // Only a `cursor` entry exists — the default --client-name is `arbitra-gate`,
    // which has nothing in the keychain. The fallback should pick up cursor's token.
    await writeToken("https://test.example", "cursor", "arb_fake_cursor");

    const res = await capture(["--base-url", "https://test.example"], {
      cwd,
      env: process.env,
    });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /arb_fake_cursor/);
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("multiple matches preference order — arbitra-gate > arbitra-mcp-cli > alphabetical", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockKeytar();
    // Three entries for the same baseUrl. None match the default `arbitra-gate`
    // slot, so the fallback must pick `arbitra-mcp-cli` per preference order.
    await writeToken("https://test.example", "cursor", "arb_cursor_tok");
    await writeToken("https://test.example", "arbitra-mcp-cli", "arb_cli_tok");
    await writeToken("https://test.example", "codex", "arb_codex_tok");

    const res1 = await capture(["--base-url", "https://test.example"], {
      cwd,
      env: process.env,
    });
    assert.equal(res1.code, 0);
    assert.match(res1.stdout, /arb_cli_tok/);

    // Now add an `arbitra-gate` entry — but the default --client-name is
    // `arbitra-gate`, which means resolveCreds picks it up directly (no
    // fallback needed). Either way, that's the token that must surface.
    await writeToken("https://test.example", "arbitra-gate", "arb_gate_tok");
    const res2 = await capture(["--base-url", "https://test.example"], {
      cwd,
      env: process.env,
    });
    assert.equal(res2.code, 0);
    assert.match(res2.stdout, /arb_gate_tok/);
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("fallback stderr hint identifies clientName, not the token", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockKeytar();
    const token = "arb_secret_cursor_token_value";
    await writeToken("https://test.example", "cursor", token);

    const res = await capture(["--base-url", "https://test.example"], {
      cwd,
      env: process.env,
    });
    assert.equal(res.code, 0);
    assert.match(res.stderr, /clientName=cursor/);
    // Crucial: stderr must NEVER echo the token value itself.
    assert.ok(!res.stderr.includes(token), "stderr leaked token value");
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});
