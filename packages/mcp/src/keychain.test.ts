import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetKeytarForTests,
  __setKeytarForTests,
  deleteAll,
  deleteToken,
  listEntries,
  readToken,
  writeToken,
} from "./keychain.js";

const ORIGINAL_HOME = process.env.HOME;

function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arbitra-keychain-test-"));
  process.env.HOME = home;
  return home;
}

function restoreHome(): void {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
}

function mockKeytar() {
  const store = new Map<string, string>();
  const impl = {
    getPassword: async (_s: string, account: string) => store.get(account) ?? null,
    setPassword: async (_s: string, account: string, password: string) => {
      store.set(account, password);
    },
    deletePassword: async (_s: string, account: string) => store.delete(account),
    findCredentials: async () =>
      Array.from(store.entries()).map(([account, password]) => ({ account, password })),
  };
  __setKeytarForTests(impl);
  return { impl, store };
}

test("writeToken + readToken round-trip via mocked keychain", async () => {
  withTempHome();
  try {
    mockKeytar();
    const result = await writeToken("https://example.com", "cursor", "arb_secret_xyz");
    assert.equal(result.source, "keychain");

    const read = await readToken("https://example.com", "cursor");
    assert.ok(read);
    assert.equal(read?.token, "arb_secret_xyz");
    assert.equal(read?.source, "keychain");
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("keychain import failure falls back to FS file", async () => {
  withTempHome();
  try {
    __setKeytarForTests(null);
    const result = await writeToken("https://example.com", "cursor", "arb_secret_xyz");
    assert.equal(result.source, "fs-fallback");
    assert.ok(result.path);

    const read = await readToken("https://example.com", "cursor");
    assert.ok(read);
    assert.equal(read?.token, "arb_secret_xyz");
    assert.equal(read?.source, "fs-fallback");
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("FS fallback file is mode 0600", async () => {
  const home = withTempHome();
  try {
    __setKeytarForTests(null);
    const result = await writeToken("https://example.com", "cursor", "arb_xyz");
    assert.equal(result.source, "fs-fallback");
    const mode = statSync(result.path!).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got 0o${mode.toString(8)}`);
    // And the parent dir should be 0700.
    const dirMode = statSync(join(home, ".config", "arbitra")).mode & 0o777;
    assert.equal(dirMode, 0o700, `expected dir mode 0700, got 0o${dirMode.toString(8)}`);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("deleteToken removes entry and read returns null", async () => {
  withTempHome();
  try {
    mockKeytar();
    await writeToken("https://example.com", "cursor", "arb_xyz");
    const { removed } = await deleteToken("https://example.com", "cursor");
    assert.equal(removed, true);
    const read = await readToken("https://example.com", "cursor");
    assert.equal(read, null);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("listEntries enumerates both keychain and FS fallback", async () => {
  const home = withTempHome();
  try {
    mockKeytar();
    await writeToken("https://prod.example.com", "cursor", "arb_a");

    // Write a stray FS-fallback file by hand to verify listEntries picks it up.
    const dir = join(home, ".config", "arbitra");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(dir, "codex.json"),
      JSON.stringify({
        version: 1,
        token: "arb_b",
        client_name: "codex",
        base_url: "https://dev.example.com",
        saved_at: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );

    const entries = await listEntries();
    const keys = entries.map((e) => `${e.source}:${e.clientName}@${e.baseUrl}`).sort();
    assert.deepEqual(keys, [
      "fs-fallback:codex@https://dev.example.com",
      "keychain:cursor@https://prod.example.com",
    ]);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("FS fallback discriminates by base_url (cross-instance isolation)", async () => {
  withTempHome();
  try {
    // No keytar — force the FS-fallback path.
    __setKeytarForTests(null);
    const devUrl = "https://staging.arbitra.example.com";
    const prodUrl = "https://arbitra.example.com";

    // Write a dev token for (devUrl, 'cursor').
    const wrote = await writeToken(devUrl, "cursor", "arb_dev_secret");
    assert.equal(wrote.source, "fs-fallback");

    // Reading with the prod URL must return null — the dev token must
    // never bleed across instances.
    const prodRead = await readToken(prodUrl, "cursor");
    assert.equal(prodRead, null);

    // Same baseUrl still round-trips.
    const devRead = await readToken(devUrl, "cursor");
    assert.ok(devRead);
    assert.equal(devRead?.token, "arb_dev_secret");
    assert.equal(devRead?.source, "fs-fallback");

    // Trailing slash on either side is normalised away.
    const devReadTrailing = await readToken(`${devUrl}/`, "cursor");
    assert.ok(devReadTrailing);
    assert.equal(devReadTrailing?.token, "arb_dev_secret");
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});

test("deleteAll empties both keychain and FS fallback", async () => {
  const home = withTempHome();
  try {
    mockKeytar();
    await writeToken("https://a.example.com", "cursor", "arb_a");
    // Add an FS file too.
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

    const { removed } = await deleteAll();
    assert.equal(removed, 2);
    const after = await listEntries();
    assert.equal(after.length, 0);
  } finally {
    __resetKeytarForTests();
    restoreHome();
  }
});
