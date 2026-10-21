import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLogout } from "./logout.js";
import {
  __resetKeytarForTests,
  __setKeytarForTests,
  listEntries,
  writeToken,
} from "./keychain.js";

const ORIGINAL_HOME = process.env.HOME;

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arbitra-logout-test-"));
  process.env.HOME = home;
  return home;
}

function restoreHome(): void {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
}

function silentStdout<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: typeof process.stdout.write }).write = (() => true) as typeof process.stdout.write;
  return fn().finally(() => {
    (process.stdout as { write: typeof process.stdout.write }).write = orig;
  });
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

test("logout --all clears both keychain and FS-fallback entries", async () => {
  const home = withTempHome();
  try {
    const store = mockKeytar();
    await writeToken("https://a.example.com", "cursor", "arb_a");

    // Also drop in a FS-fallback file.
    const dir = join(home, ".config", "arbitra");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(dir, "codex.json"),
      JSON.stringify({
        version: 1,
        token: "arb_b",
        client_name: "codex",
        base_url: "https://b.example.com",
        saved_at: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );

    const code = await silentStdout(() => runLogout(["--all"]));
    assert.equal(code, 0);
    assert.equal(store.size, 0);
    const remaining = await listEntries();
    assert.equal(remaining.length, 0);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("logout --client filters to a single client", async () => {
  withTempHome();
  try {
    const store = mockKeytar();
    await writeToken("https://example.com", "cursor", "arb_cursor");
    await writeToken("https://example.com", "claude-code", "arb_cc");

    const code = await silentStdout(() => runLogout(["--client", "cursor"]));
    assert.equal(code, 0);
    assert.equal(store.size, 1);
    assert.ok(store.has("https://example.com|claude-code"));
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("logout with no matching client prints a message but exits 0", async () => {
  withTempHome();
  try {
    mockKeytar();
    const code = await silentStdout(() => runLogout(["--client", "nonexistent"]));
    assert.equal(code, 0);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});
