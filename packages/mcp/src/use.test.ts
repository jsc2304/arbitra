import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUseInternal } from "./use.js";
import { DEFAULT_BASE_URL } from "./credentials.js";
import { __resetKeytarForTests, __setKeytarForTests, writeToken } from "./keychain.js";

const ORIGINAL_HOME = process.env.HOME;

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arbitra-use-home-"));
  process.env.HOME = home;
  return home;
}

function withTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "arbitra-use-cwd-"));
}

function restoreHome(): void {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
}

const STAGING_URL = "https://staging.arbitra.example.com";
const PROD_URL = "https://arbitra.example.com";

function captureOut(): { write: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return { write: (s) => lines.push(s), text: () => lines.join("") };
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

async function writeEnvFile(cwd: string, content: string): Promise<string> {
  const dir = join(cwd, ".arbitra");
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, ".env");
  await fs.writeFile(path, content);
  return path;
}

test("use status mode reports default source when nothing is configured", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    const out = captureOut();
    const code = await runUseInternal([], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    assert.match(out.text(), new RegExp(DEFAULT_BASE_URL.replace(/[./]/g, "\\$&")));
    assert.match(out.text(), /Source:\s+default/);
    assert.match(out.text(), /Environment:\s+local/);
    assert.match(out.text(), /Connect flow will run on the first tool call/);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use status mode reports .arbitra/.env source and custom label", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    const envPath = await writeEnvFile(cwd, `ARBITRA_URL=${STAGING_URL}\n`);
    const out = captureOut();
    const code = await runUseInternal([], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    assert.match(out.text(), /Source:\s+\.arbitra\/\.env/);
    assert.ok(out.text().includes(envPath), "should print the env file path");
    assert.ok(out.text().includes(STAGING_URL), "should print the pinned URL");
    assert.match(out.text(), /Environment:\s+custom/);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use status mode reports process.env source, custom label, and override warning", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    await writeEnvFile(cwd, `ARBITRA_URL=${STAGING_URL}\n`);
    const out = captureOut();
    const code = await runUseInternal([], {
      cwd,
      env: { ARBITRA_URL: "https://my-fork.example.com" },
      stdoutWrite: out.write,
    });
    assert.equal(code, 0);
    assert.match(out.text(), /Source:\s+process\.env\.ARBITRA_URL/);
    assert.match(out.text(), /Environment:\s+custom/);
    assert.match(out.text(), /WARNING/);
    assert.match(out.text(), /overrides \.arbitra\/\.env/);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use status mode reports token present when a keychain entry matches the host", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    await writeToken(STAGING_URL, "cursor", "arb_dev_token");
    await writeEnvFile(cwd, `ARBITRA_URL=${STAGING_URL}\n`);
    const out = captureOut();
    const code = await runUseInternal([], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    assert.match(out.text(), /Token present/);
    assert.match(out.text(), /cursor/);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use <url> rewrites only the ARBITRA_URL line, preserving all other lines", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    const original = [
      "# my custom comment",
      `ARBITRA_URL=${STAGING_URL}`,
      "ARBITRA_PROJECT_ID=proj_1234",
      "SOME_OTHER_VAR=hello",
      "",
    ].join("\n");
    const envPath = await writeEnvFile(cwd, original);
    const out = captureOut();
    const code = await runUseInternal([PROD_URL], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);

    const after = await fs.readFile(envPath, "utf-8");
    const expected = [
      "# my custom comment",
      `ARBITRA_URL=${PROD_URL}`,
      "ARBITRA_PROJECT_ID=proj_1234",
      "SOME_OTHER_VAR=hello",
      "",
    ].join("\n");
    assert.equal(after, expected);
    assert.match(out.text(), /Switched/);
    assert.match(out.text(), /Restart required/i);
    assert.match(out.text(), /Cursor \/ Claude/);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use <url> drops a trailing slash before writing", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    const out = captureOut();
    const code = await runUseInternal([`${PROD_URL}/`], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    const after = await fs.readFile(join(cwd, ".arbitra", ".env"), "utf-8");
    assert.ok(after.includes(`ARBITRA_URL=${PROD_URL}\n`));
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use <url> finds the env file by walking up from a nested cwd", async () => {
  withTempHome();
  const root = withTempCwd();
  try {
    mockKeytar();
    const envPath = await writeEnvFile(root, `ARBITRA_URL=${PROD_URL}\n`);
    const nested = join(root, "packages", "deep");
    await fs.mkdir(nested, { recursive: true });
    const out = captureOut();
    const code = await runUseInternal([STAGING_URL], { cwd: nested, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    const after = await fs.readFile(envPath, "utf-8");
    assert.match(after, new RegExp(`ARBITRA_URL=${STAGING_URL.replace(/[./]/g, "\\$&")}`));
    // No second .arbitra/.env created next to the nested cwd.
    await assert.rejects(fs.stat(join(nested, ".arbitra", ".env")));
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use <url> creates .arbitra/.env with header when none exists, no project id line", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    const out = captureOut();
    const code = await runUseInternal([STAGING_URL], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    const after = await fs.readFile(join(cwd, ".arbitra", ".env"), "utf-8");
    assert.match(after, /# Arbitra project pin/);
    assert.match(after, /Tokens are stored in your OS keychain/);
    assert.ok(after.includes(`ARBITRA_URL=${STAGING_URL}`));
    assert.ok(!after.includes("ARBITRA_PROJECT_ID"), "must not invent a project id line");
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use rejects a non-URL argument (old dev/prod aliases are gone) and writes nothing", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    const out = captureOut();
    const err = captureOut();
    for (const bad of ["prod", "dev", "ftp://arbitra.example.com"]) {
      const code = await runUseInternal([bad], {
        cwd,
        env: {},
        stdoutWrite: out.write,
        stderrWrite: err.write,
      });
      assert.equal(code, 1, `expected exit 1 for ${bad}`);
    }
    assert.match(err.text(), /Not an http\(s\) URL: prod/);
    assert.match(err.text(), /Usage: arbitra-mcp use \[<url>\]/);
    // Nothing written.
    await assert.rejects(fs.stat(join(cwd, ".arbitra", ".env")));
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use <url> with ARBITRA_URL env var set prints a prominent override warning but still writes", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    await writeEnvFile(cwd, `ARBITRA_URL=${STAGING_URL}\n`);
    const out = captureOut();
    const code = await runUseInternal([PROD_URL], {
      cwd,
      env: { ARBITRA_URL: STAGING_URL },
      stdoutWrite: out.write,
    });
    assert.equal(code, 0);
    assert.match(out.text(), /WARNING/);
    assert.match(out.text(), /switch below will have NO effect/);
    const after = await fs.readFile(join(cwd, ".arbitra", ".env"), "utf-8");
    assert.ok(after.includes(`ARBITRA_URL=${PROD_URL}`));
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("use <url> reports token present for the target host after switching", async () => {
  withTempHome();
  const cwd = withTempCwd();
  try {
    mockKeytar();
    await writeToken(PROD_URL, "claude-code", "arb_prod_token");
    await writeEnvFile(cwd, `ARBITRA_URL=${STAGING_URL}\n`);
    const out = captureOut();
    const code = await runUseInternal([PROD_URL], { cwd, env: {}, stdoutWrite: out.write });
    assert.equal(code, 0);
    assert.match(out.text(), /Token present/);
    assert.match(out.text(), /claude-code/);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});
