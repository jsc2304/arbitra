import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE_URL,
  __resetLegacyWarningDedupForTests,
  deriveDeviceId,
  findArbitraEnvFile,
  normalizeClientName,
  resolveBaseUrlForCwd,
  resolveCreds,
  stripUrlCredentials,
  writeArbitraEnv,
} from "./credentials.js";
import { __resetKeytarForTests, __setKeytarForTests } from "./keychain.js";

const ORIGINAL = {
  HOME: process.env.HOME,
  ARBITRA_TOKEN: process.env.ARBITRA_TOKEN,
  ARBITRA_URL: process.env.ARBITRA_URL,
  ARBITRA_PROJECT_ID: process.env.ARBITRA_PROJECT_ID,
};

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arbitra-creds-test-"));
  process.env.HOME = home;
  return home;
}

function withTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "arbitra-creds-cwd-"));
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

test("normalizeClientName lowercases and replaces non-alphanumerics", () => {
  assert.equal(normalizeClientName("Cursor"), "cursor");
  assert.equal(normalizeClientName("Claude Code"), "claude-code");
  assert.equal(normalizeClientName("VS Code 1.0"), "vs-code-1-0");
  assert.equal(normalizeClientName(undefined), "arbitra-mcp-unknown");
  assert.equal(normalizeClientName(""), "arbitra-mcp-unknown");
  assert.equal(normalizeClientName("   "), "arbitra-mcp-unknown");
  assert.equal(normalizeClientName("___"), "arbitra-mcp-unknown");
});

test("deriveDeviceId is stable across calls", () => {
  withTempHome();
  try {
    const a = deriveDeviceId();
    const b = deriveDeviceId();
    assert.equal(a, b);
    assert.equal(a.length, 16);
    assert.match(a, /^[0-9a-f]{16}$/);
  } finally {
    restoreEnv();
  }
});

test("base URL: ARBITRA_URL env → .arbitra/.env → http://localhost:3000 (no built-in instance)", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockEmptyKeychain();
    assert.equal(DEFAULT_BASE_URL, "http://localhost:3000");

    // Nothing configured → local default.
    const none = await resolveCreds({ cwd, clientName: "cursor" });
    assert.equal(none.baseUrl, "http://localhost:3000");
    assert.equal(resolveBaseUrlForCwd(cwd), "http://localhost:3000");

    // .arbitra/.env supplies the URL; a trailing slash is dropped.
    mkdirSync(join(cwd, ".arbitra"), { recursive: true });
    writeFileSync(join(cwd, ".arbitra", ".env"), "ARBITRA_URL=https://from-file.example.com/\n");
    assert.equal((await resolveCreds({ cwd, clientName: "cursor" })).baseUrl, "https://from-file.example.com");
    assert.equal(resolveBaseUrlForCwd(cwd), "https://from-file.example.com");

    // An empty env var (what `ARBITRA_URL=${ARBITRA_URL:-}` forwarding produces) counts as unset.
    process.env.ARBITRA_URL = "";
    assert.equal((await resolveCreds({ cwd, clientName: "cursor" })).baseUrl, "https://from-file.example.com");

    // A non-empty env var wins over the file.
    process.env.ARBITRA_URL = "https://from-env.example.com";
    assert.equal((await resolveCreds({ cwd, clientName: "cursor" })).baseUrl, "https://from-env.example.com");
    assert.equal(resolveBaseUrlForCwd(cwd), "https://from-env.example.com");
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("stripUrlCredentials removes userinfo from URL-form remotes only", () => {
  assert.equal(
    stripUrlCredentials("https://alex:token@github.com/acme/repo.git"),
    "https://github.com/acme/repo.git"
  );
  assert.equal(stripUrlCredentials("https://token@github.com/acme/repo"), "https://github.com/acme/repo");
  assert.equal(stripUrlCredentials("ssh://git@github.com/acme/repo.git"), "ssh://github.com/acme/repo.git");
  // No userinfo, scp-like, local paths and `@` in the path stay untouched.
  assert.equal(stripUrlCredentials("https://github.com/acme/repo.git"), "https://github.com/acme/repo.git");
  assert.equal(stripUrlCredentials("git@github.com:acme/repo.git"), "git@github.com:acme/repo.git");
  assert.equal(stripUrlCredentials("/home/alex/repo@2"), "/home/alex/repo@2");
  assert.equal(stripUrlCredentials("https://github.com/acme/repo@2.git"), "https://github.com/acme/repo@2.git");
});

test("ARBITRA_TOKEN env wins over keychain; legacy .env line is ignored", async () => {
  withTempHome();
  const cwd = withTempCwd();
  __resetLegacyWarningDedupForTests();
  try {
    clearArbitraEnv();
    // Set up legacy .arbitra/.env with ARBITRA_TOKEN line.
    mkdirSync(join(cwd, ".arbitra"), { recursive: true });
    writeFileSync(
      join(cwd, ".arbitra", ".env"),
      "ARBITRA_URL=https://from-env-file.example.com\nARBITRA_TOKEN=legacy_token_value\nARBITRA_PROJECT_ID=proj_xyz\n"
    );
    __setKeytarForTests({
      getPassword: async () => "keychain_token_value",
      setPassword: async () => {
        /* noop */
      },
      deletePassword: async () => true,
      findCredentials: async () => [],
    });

    // Set env var → wins
    process.env.ARBITRA_TOKEN = "env_token_value";
    const r1 = await resolveCreds({ cwd, clientName: "cursor" });
    assert.ok(r1.ok);
    if (r1.ok) {
      assert.equal(r1.token, "env_token_value");
      assert.equal(r1.tokenSource, "env");
    }

    // Drop env var → keychain wins
    delete process.env.ARBITRA_TOKEN;
    const r2 = await resolveCreds({ cwd, clientName: "cursor" });
    assert.ok(r2.ok);
    if (r2.ok) {
      assert.equal(r2.token, "keychain_token_value");
      assert.equal(r2.tokenSource, "keychain");
    }

    // Drop keychain → legacy .env line is ignored (PR 5 dropped support).
    // Result: ok:false reason:no_token, despite ARBITRA_TOKEN= sitting in
    // .arbitra/.env. The warning fires on stderr but the value is not used.
    __setKeytarForTests({
      getPassword: async () => null,
      setPassword: async () => {
        /* noop */
      },
      deletePassword: async () => true,
      findCredentials: async () => [],
    });
    __resetLegacyWarningDedupForTests();
    let warnings = 0;
    let stdoutWrites = 0;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    (process.stderr as { write: typeof process.stderr.write }).write = ((s: string | Uint8Array) => {
      if (typeof s === "string" && s.includes("ARBITRA_TOKEN")) warnings += 1;
      return true;
    }) as typeof process.stderr.write;
    (process.stdout as { write: typeof process.stdout.write }).write = ((s: string | Uint8Array) => {
      if (typeof s === "string" && s.includes("ARBITRA_TOKEN")) stdoutWrites += 1;
      return true;
    }) as typeof process.stdout.write;
    try {
      const r3 = await resolveCreds({ cwd, clientName: "cursor" });
      assert.equal(r3.ok, false, "legacy ARBITRA_TOKEN line must not provide a token");
      if (!r3.ok) {
        assert.equal(r3.reason, "no_token");
      }
      assert.equal(warnings, 1, "warning should be emitted to stderr");
      assert.equal(stdoutWrites, 0, "warning must not leak to stdout (would pollute MCP JSON-RPC)");
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = origStderrWrite;
      (process.stdout as { write: typeof process.stdout.write }).write = origStdoutWrite;
    }
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("project_id resolves from env then .arbitra/.env", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockEmptyKeychain();
    process.env.ARBITRA_TOKEN = "arb_xyz";

    // 1. .env only
    mkdirSync(join(cwd, ".arbitra"), { recursive: true });
    writeFileSync(join(cwd, ".arbitra", ".env"), "ARBITRA_PROJECT_ID=proj_from_file\n");
    const r1 = await resolveCreds({ cwd, clientName: "cursor" });
    assert.ok(r1.ok);
    if (r1.ok) {
      assert.equal(r1.projectId, "proj_from_file");
      assert.equal(r1.projectIdSource, "arbitra-env-file");
    }

    // 2. env var overrides
    process.env.ARBITRA_PROJECT_ID = "proj_from_env";
    const r2 = await resolveCreds({ cwd, clientName: "cursor" });
    assert.ok(r2.ok);
    if (r2.ok) {
      assert.equal(r2.projectId, "proj_from_env");
      assert.equal(r2.projectIdSource, "env");
    }
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("findArbitraEnvFile walks up to find nearest .arbitra/.env", () => {
  withTempHome();
  const root = withTempCwd();
  try {
    mkdirSync(join(root, ".arbitra"), { recursive: true });
    writeFileSync(join(root, ".arbitra", ".env"), "ARBITRA_PROJECT_ID=proj_x\n");
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    const found = findArbitraEnvFile(nested);
    assert.equal(found, join(root, ".arbitra", ".env"));
  } finally {
    restoreEnv();
  }
});

test("missing token returns ok:false reason:no_token", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockEmptyKeychain();
    const r = await resolveCreds({ cwd, clientName: "cursor" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "no_token");
      assert.equal(r.clientName, "cursor");
    }
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("requireProjectId triggers no_project_id failure when token exists but project missing", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    clearArbitraEnv();
    mockEmptyKeychain();
    process.env.ARBITRA_TOKEN = "arb_xyz";
    const r = await resolveCreds({ cwd, clientName: "cursor", requireProjectId: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "no_project_id");
      assert.equal(r.token, "arb_xyz");
    }
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("legacy ARBITRA_TOKEN warning is emitted only once per file path, to stderr", async () => {
  withTempHome();
  const cwd = withTempCwd();
  __resetLegacyWarningDedupForTests();
  try {
    clearArbitraEnv();
    mockEmptyKeychain();
    mkdirSync(join(cwd, ".arbitra"), { recursive: true });
    writeFileSync(join(cwd, ".arbitra", ".env"), "ARBITRA_TOKEN=legacy_xyz\n");

    let stderrWrites = 0;
    let stdoutWrites = 0;
    let lastStderrPayload = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    (process.stderr as { write: typeof process.stderr.write }).write = ((s: string | Uint8Array) => {
      if (typeof s === "string" && s.includes("ARBITRA_TOKEN")) {
        stderrWrites += 1;
        lastStderrPayload = s;
      }
      return true;
    }) as typeof process.stderr.write;
    (process.stdout as { write: typeof process.stdout.write }).write = ((s: string | Uint8Array) => {
      if (typeof s === "string" && s.includes("ARBITRA_TOKEN")) stdoutWrites += 1;
      return true;
    }) as typeof process.stdout.write;
    try {
      await resolveCreds({ cwd, clientName: "cursor" });
      await resolveCreds({ cwd, clientName: "cursor" });
      await resolveCreds({ cwd, clientName: "cursor" });
      assert.equal(stderrWrites, 1, "warning should only be emitted once per process");
      assert.equal(stdoutWrites, 0, "warning must not leak to stdout (would pollute MCP JSON-RPC stdio)");
      assert.match(
        lastStderrPayload,
        /contains ARBITRA_TOKEN — ignoring\. Tokens are now stored in your OS keychain\./,
        "warning text must match spec §E.2 verbatim"
      );
      assert.match(
        lastStderrPayload,
        /Run `arbitra-mcp login` if you need to \(re-\)authenticate\./,
        "warning must reference `arbitra-mcp login` for re-auth"
      );
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = origStderrWrite;
      (process.stdout as { write: typeof process.stdout.write }).write = origStdoutWrite;
    }
  } finally {
    __resetKeytarForTests();
    restoreEnv();
  }
});

test("writeArbitraEnv preserves unrelated lines and updates pinned keys", async () => {
  const cwd = withTempCwd();
  try {
    mkdirSync(join(cwd, ".arbitra"), { recursive: true });
    writeFileSync(
      join(cwd, ".arbitra", ".env"),
      "# user comment\nMY_OTHER_VAR=42\nARBITRA_URL=https://old.example.com\n"
    );
    const path = await writeArbitraEnv(cwd, {
      baseUrl: "https://new.example.com",
      projectId: "proj_abc",
    });
    const raw = await fs.readFile(path, "utf-8");
    assert.match(raw, /MY_OTHER_VAR=42/);
    assert.match(raw, /^ARBITRA_URL=https:\/\/new\.example\.com$/m);
    assert.match(raw, /^ARBITRA_PROJECT_ID=proj_abc$/m);
    assert.match(raw, /# user comment/);
  } finally {
    restoreEnv();
  }
});

test("writeArbitraEnv with dropLegacyToken strips ARBITRA_TOKEN line", async () => {
  const cwd = withTempCwd();
  try {
    mkdirSync(join(cwd, ".arbitra"), { recursive: true });
    writeFileSync(
      join(cwd, ".arbitra", ".env"),
      "ARBITRA_TOKEN=legacy_xyz\nARBITRA_URL=https://old.example.com\n"
    );
    const path = await writeArbitraEnv(
      cwd,
      { baseUrl: "https://new.example.com", projectId: "proj_abc" },
      { dropLegacyToken: true }
    );
    const raw = await fs.readFile(path, "utf-8");
    assert.doesNotMatch(raw, /ARBITRA_TOKEN/);
  } finally {
    restoreEnv();
  }
});
