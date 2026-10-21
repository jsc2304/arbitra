/**
 * OS keychain integration with FS fallback.
 *
 * Wraps `keytar` (macOS Keychain / Windows Credential Manager / libsecret on Linux)
 * and falls back transparently to a mode-0600 JSON file under
 * `~/.config/arbitra/<clientName>.json` when the native module fails to load or
 * any operation throws (Linux without libsecret is the typical case).
 *
 * Keying: service = "arbitra-mcp", account = `${baseUrl}|${clientName}`.
 * Two reasons: (a) dev / prod Arbitra instances stay disjoint per developer;
 * (b) Cursor / Claude Code / Codex on the same machine, same instance get
 * their own slot — visible at a glance via `security find-internet-password`.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const KEYCHAIN_SERVICE = "arbitra-mcp";

export interface KeychainEntry {
  readonly token: string;
  readonly source: "keychain" | "fs-fallback";
  readonly path?: string;
}

export interface KeychainEntryRef {
  baseUrl: string;
  clientName: string;
  source: "keychain" | "fs-fallback";
  path?: string;
}

interface KeytarLike {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
  findCredentials: (service: string) => Promise<Array<{ account: string; password: string }>>;
}

interface FsFile {
  readonly version: 1;
  readonly token: string;
  readonly client_name: string;
  readonly base_url: string;
  readonly saved_at: string;
}

let keytarModule: KeytarLike | null | undefined;

/**
 * Lazy-load `keytar`. Cached after first attempt — if the native module fails
 * to load (no prebuilt binary, no libsecret) we record the failure and never
 * retry within this process.
 */
async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarModule !== undefined) return keytarModule;
  try {
    const mod = (await import("keytar")) as unknown as { default?: KeytarLike } & KeytarLike;
    // keytar publishes CJS, so the default-interop dance may expose its
    // functions either on `mod` or on `mod.default` depending on bundler.
    keytarModule = (mod.default ?? mod) as KeytarLike;
    // Smoke-test one read so a broken native module surfaces here rather than
    // mid-flow. findCredentials with no entries should succeed and return [].
    await keytarModule.findCredentials(KEYCHAIN_SERVICE);
    return keytarModule;
  } catch {
    keytarModule = null;
    return null;
  }
}

/**
 * Reset keytar module cache. Tests only — never call from production code.
 */
export function __resetKeytarForTests(): void {
  keytarModule = undefined;
}

/**
 * Inject a mock keytar implementation. Tests only.
 */
export function __setKeytarForTests(impl: KeytarLike | null): void {
  keytarModule = impl;
}

function accountKey(baseUrl: string, clientName: string): string {
  return `${baseUrl}|${clientName}`;
}

function parseAccountKey(account: string): { baseUrl: string; clientName: string } | null {
  const idx = account.lastIndexOf("|");
  if (idx <= 0 || idx === account.length - 1) return null;
  return {
    baseUrl: account.slice(0, idx),
    clientName: account.slice(idx + 1),
  };
}

function fsFallbackPath(clientName: string): string {
  return join(homedir(), ".config", "arbitra", `${clientName}.json`);
}

/**
 * Normalize a baseUrl for equality comparison: strip trailing slash. Matches
 * the `accountKey` discriminator used for the keychain so the FS-fallback
 * file inherits the same `(baseUrl, clientName)` keying without us renaming
 * the file (which would orphan files written by older versions).
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

async function readFsFallback(
  baseUrl: string,
  clientName: string
): Promise<KeychainEntry | null> {
  const path = fsFallbackPath(clientName);
  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FsFile>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) {
      return null;
    }
    // Discriminate by base_url so a token for staging.arbitra.example.com
    // never gets handed to a process pointed at arbitra.example.com (and vice
    // versa). Don't delete the existing file — a future call against the
    // matching baseUrl should still succeed.
    if (typeof parsed.base_url === "string") {
      if (normalizeBaseUrl(parsed.base_url) !== normalizeBaseUrl(baseUrl)) {
        return null;
      }
    }
    return { token: parsed.token, source: "fs-fallback", path };
  } catch {
    return null;
  }
}

async function writeFsFallback(
  baseUrl: string,
  clientName: string,
  token: string
): Promise<string> {
  const path = fsFallbackPath(clientName);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Tighten the dir mode in case it already existed with looser perms.
  try {
    await fs.chmod(dirname(path), 0o700);
  } catch {
    /* best-effort */
  }
  const payload: FsFile = {
    version: 1,
    token,
    client_name: clientName,
    base_url: baseUrl,
    saved_at: new Date().toISOString(),
  };
  // Write via tmp + rename so a crash never leaves a half-written file.
  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600);
  return path;
}

async function deleteFsFallback(clientName: string): Promise<boolean> {
  const path = fsFallbackPath(clientName);
  try {
    await fs.unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test/CI escape hatch: `ARBITRA_DISABLE_KEYCHAIN=1` makes `readToken` act as
 * if neither the OS keychain nor the FS-fallback file has anything stored,
 * regardless of what's actually on the machine — it never touches keytar or
 * the filesystem. Added for the session-signal-hook CLI-process tests
 * (`src/hooks/session-signal-hook.test.ts`), which spawn the real built CLI
 * and, without this, would resolve a real developer's stored credential on
 * any machine that has one and could make a real network call. Documented in
 * `docs/session-signal-hook.md`. Never set this for normal `arbitra-mcp`
 * usage — it silently makes every tool call behave as if logged out.
 */
export function isKeychainDisabledForTests(): boolean {
  return process.env.ARBITRA_DISABLE_KEYCHAIN === "1";
}

export async function readToken(
  baseUrl: string,
  clientName: string
): Promise<KeychainEntry | null> {
  if (isKeychainDisabledForTests()) return null;
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const token = await keytar.getPassword(KEYCHAIN_SERVICE, accountKey(baseUrl, clientName));
      if (token) return { token, source: "keychain" };
    } catch {
      // fall through to FS fallback
    }
  }
  return readFsFallback(baseUrl, clientName);
}

export async function writeToken(
  baseUrl: string,
  clientName: string,
  token: string
): Promise<{ source: "keychain" | "fs-fallback"; path?: string }> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, accountKey(baseUrl, clientName), token);
      return { source: "keychain" };
    } catch {
      // fall through to FS fallback
    }
  }
  const path = await writeFsFallback(baseUrl, clientName, token);
  return { source: "fs-fallback", path };
}

export async function deleteToken(
  baseUrl: string,
  clientName: string
): Promise<{ removed: boolean }> {
  let removed = false;
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      removed = (await keytar.deletePassword(KEYCHAIN_SERVICE, accountKey(baseUrl, clientName))) || removed;
    } catch {
      /* best-effort */
    }
  }
  const fsRemoved = await deleteFsFallback(clientName);
  return { removed: removed || fsRemoved };
}

/**
 * Enumerate every keychain entry under the Arbitra service plus any FS-fallback
 * files for `doctor` output and the `logout` interactive picker. Token values
 * are deliberately *not* returned — only locator metadata.
 */
export async function listEntries(): Promise<KeychainEntryRef[]> {
  const refs: KeychainEntryRef[] = [];
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const creds = await keytar.findCredentials(KEYCHAIN_SERVICE);
      for (const { account } of creds) {
        const parsed = parseAccountKey(account);
        if (parsed) {
          refs.push({ ...parsed, source: "keychain" });
        }
      }
    } catch {
      /* fall through to FS listing */
    }
  }
  // Always list FS fallback files too — a user may have entries in both stores
  // if they migrated machines or hit an intermittent keytar failure.
  try {
    const dir = join(homedir(), ".config", "arbitra");
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const path = join(dir, f);
      try {
        const raw = await fs.readFile(path, "utf-8");
        const parsed = JSON.parse(raw) as Partial<FsFile>;
        if (typeof parsed.base_url === "string" && typeof parsed.client_name === "string") {
          refs.push({
            baseUrl: parsed.base_url,
            clientName: parsed.client_name,
            source: "fs-fallback",
            path,
          });
        }
      } catch {
        /* skip unreadable / non-JSON */
      }
    }
  } catch {
    /* dir doesn't exist — fine */
  }
  return refs;
}

/**
 * One-shot helper for `logout --all`: drop every entry under the Arbitra
 * service from both the keychain and the FS fallback directory.
 */
export async function deleteAll(): Promise<{ removed: number }> {
  let removed = 0;
  const entries = await listEntries();
  for (const e of entries) {
    const res = await deleteToken(e.baseUrl, e.clientName);
    if (res.removed) removed += 1;
  }
  return { removed };
}
