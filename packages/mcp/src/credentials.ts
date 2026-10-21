/**
 * Credential discovery chain for arbitra-mcp.
 *
 * Resolves `(baseUrl, token, projectId)` from a layered set of sources in a
 * documented precedence order. Pure functional surface — no `process.exit`,
 * no side effects beyond a one-time stderr warning when the legacy
 * `.arbitra/.env` `ARBITRA_TOKEN=…` line is encountered (PR 5: the line is
 * **ignored** for auth; only the warning is emitted).
 *
 * Token precedence:
 *   1. process.env.ARBITRA_TOKEN  (CI override — never overridden by anything below)
 *   2. OS keychain entry keyed by (baseUrl, clientName)
 *   3. FS fallback file ~/.config/arbitra/<clientName>.json (mode 0600)
 *   4. none → ok:false reason:no_token
 *
 * A legacy `ARBITRA_TOKEN=` line in `$PROJECT/.arbitra/.env` is **no longer
 * honoured**. When present it triggers a one-time stderr warning and is
 * otherwise ignored — auth falls through to keychain / FS-fallback / no_token
 * as if the line were absent.
 *
 * Base URL precedence:
 *   1. process.env.ARBITRA_URL
 *   2. ARBITRA_URL= line in the nearest .arbitra/.env walking up from cwd
 *   3. http://localhost:3000 (no built-in instance)
 *
 * Project ID precedence:
 *   1. process.env.ARBITRA_PROJECT_ID
 *   2. ARBITRA_PROJECT_ID= line in the nearest .arbitra/.env walking up from cwd
 *   3. undefined (callers that need it explicitly demand it via requireProjectId)
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join, dirname } from "node:path";

import { readToken } from "./keychain.js";

/**
 * There is no built-in Arbitra instance. When neither `ARBITRA_URL` nor an
 * `.arbitra/.env` file names one, the MCP server assumes a local instance.
 */
export const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * Removes credentials (`user:token@`) from a URL-form git remote before it
 * leaves the machine. scp-like remotes (`git@host:owner/repo.git`) carry no
 * secret and are returned unchanged.
 */
export function stripUrlCredentials(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

export type TokenSource = "env" | "keychain" | "fs-fallback";

export type ProjectIdSource = "env" | "arbitra-env-file";

export interface ResolvedCredsOk {
  ok: true;
  baseUrl: string;
  token: string;
  tokenSource: TokenSource;
  /** absolute path of the FS-fallback file (only when tokenSource === 'fs-fallback') */
  tokenPath?: string;
  projectId?: string;
  projectIdSource?: ProjectIdSource;
  /** path of the .arbitra/.env file that supplied project_id (when applicable) */
  projectIdPath?: string;
  clientName: string;
  deviceLabel: string;
  deviceId: string;
}

export interface ResolvedCredsFail {
  ok: false;
  reason: "no_token" | "no_project_id";
  baseUrl: string;
  clientName: string;
  deviceLabel: string;
  deviceId: string;
  /** Echoed when reason === 'no_project_id' but a token was found. */
  token?: string;
  tokenSource?: TokenSource;
}

export type ResolvedCreds = ResolvedCredsOk | ResolvedCredsFail;

export interface ResolveOptions {
  /** working directory used to locate $PROJECT/.arbitra/.env */
  cwd: string;
  /** MCP clientInfo.name (or 'arbitra-mcp-cli' for the CLI). Normalized client-side. */
  clientName: string;
  /** Echoed back unmodified. Free-text. */
  clientVersion?: string;
  /** If true, treat missing project_id as a hard failure. Default false. */
  requireProjectId?: boolean;
}

const legacyWarned = new Set<string>();

/**
 * Reset internal one-time-warning dedup state. Tests only.
 */
export function __resetLegacyWarningDedupForTests(): void {
  legacyWarned.clear();
}

/**
 * RFC §D.7 client_name normalization: lowercase, replace non-alphanumeric
 * with `-`, fall back to 'arbitra-mcp-unknown' if missing. Hyphens preserved.
 */
export function normalizeClientName(raw: string | undefined | null): string {
  if (!raw) return "arbitra-mcp-unknown";
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "arbitra-mcp-unknown";
  // Collapse runs of non-alphanumerics to a single hyphen; strip leading /
  // trailing hyphens.
  const normalized = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "arbitra-mcp-unknown";
}

/**
 * Walk up from `cwd` (inclusive) until we hit the filesystem root, looking for
 * `.arbitra/.env`. Returns the absolute path of the first match, or undefined.
 * Supports the "multi-workspace folder" pattern called out in spec §J.4.
 */
export function findArbitraEnvFile(cwd: string): string | undefined {
  let dir = cwd;
  // Cap the walk at 64 levels — defensive against pathological symlink loops.
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(dir, ".arbitra", ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

interface ParsedEnv {
  token?: string;
  url?: string;
  projectId?: string;
}

function parseEnvFile(path: string): ParsedEnv {
  try {
    const raw = readFileSync(path, "utf-8");
    const out: ParsedEnv = {};
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes if any.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === "ARBITRA_TOKEN") out.token = value;
      else if (key === "ARBITRA_URL") out.url = value;
      else if (key === "ARBITRA_PROJECT_ID") out.projectId = value;
    }
    return out;
  } catch {
    return {};
  }
}

function warnLegacyToken(path: string): void {
  if (legacyWarned.has(path)) return;
  legacyWarned.add(path);
  process.stderr.write(
    `[arbitra-mcp] ${path} contains ARBITRA_TOKEN — ignoring. Tokens are now stored in your OS keychain.\n` +
      `              Remove the line to silence this warning. Run \`arbitra-mcp login\` if you need to (re-)authenticate.\n`
  );
}

function firstNonLoopbackMac(): string | undefined {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    const list = ifs[name];
    if (!list) continue;
    for (const i of list) {
      if (i.internal) continue;
      if (!i.mac || i.mac === "00:00:00:00:00:00") continue;
      // Skip pseudo / docker / vmware / bridge interfaces — they change.
      if (/^(docker|br-|veth|tun|tap|vmnet|vboxnet)/i.test(name)) continue;
      return i.mac.toLowerCase();
    }
  }
  return undefined;
}

function readOrCreatePersistentMachineId(): string {
  const path = join(homedir(), ".config", "arbitra", "machine-id.txt");
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (raw.length >= 16) return raw;
  } catch {
    /* file missing or unreadable — fall through to create */
  }
  const id = randomBytes(16).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, id, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
  return id;
}

/**
 * Stable per-machine identifier. Hash of (hostname + first non-loopback MAC),
 * or hostname + persistent random id when MAC is unavailable. Non-PII; 16 hex
 * chars (64 bits of effective entropy from the hash).
 */
export function deriveDeviceId(): string {
  const host = hostname();
  const machineEntropy = firstNonLoopbackMac() ?? readOrCreatePersistentMachineId();
  return createHash("sha256").update(`${host}|${machineEntropy}`).digest("hex").slice(0, 16);
}

export function deriveDeviceLabel(): string {
  return hostname() || "Unknown device";
}

/**
 * Base URL precedence: `ARBITRA_URL` env (an empty value counts as unset, so
 * `ARBITRA_URL=${ARBITRA_URL:-}` forwarding in a plugin manifest is harmless)
 * → `ARBITRA_URL` in the nearest `.arbitra/.env` → `DEFAULT_BASE_URL`.
 */
function resolveBaseUrl(envFileUrl: string | undefined): string {
  const raw = process.env.ARBITRA_URL || envFileUrl || DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

/** Base URL for CLI subcommands (`login`, `logout`) that run without `resolveCreds`. */
export function resolveBaseUrlForCwd(cwd: string): string {
  const envFile = findArbitraEnvFile(cwd);
  return resolveBaseUrl(envFile ? parseEnvFile(envFile).url : undefined);
}

/**
 * Core resolver. See module-doc for precedence.
 */
export async function resolveCreds(opts: ResolveOptions): Promise<ResolvedCreds> {
  const clientName = normalizeClientName(opts.clientName);
  const deviceLabel = deriveDeviceLabel();
  const deviceId = deriveDeviceId();

  // Find .arbitra/.env up the tree once — used for both URL and project_id.
  const envFile = findArbitraEnvFile(opts.cwd);
  const parsedEnvFile: ParsedEnv = envFile ? parseEnvFile(envFile) : {};

  const baseUrl = resolveBaseUrl(parsedEnvFile.url);

  // ── Token resolution ────────────────────────────────────────────────────
  let token: string | undefined;
  let tokenSource: TokenSource | undefined;
  let tokenPath: string | undefined;

  // Emit the legacy warning eagerly (independent of whether the keychain has
  // a token) so users see it and clean up the file. Per spec §E.2 the line
  // itself is ignored — auth falls through to keychain / FS-fallback / no_token.
  if (parsedEnvFile.token && envFile) {
    warnLegacyToken(envFile);
  }

  const envToken = process.env.ARBITRA_TOKEN;
  if (envToken && envToken.length > 0) {
    token = envToken;
    tokenSource = "env";
  } else {
    const stored = await readToken(baseUrl, clientName);
    if (stored) {
      token = stored.token;
      tokenSource = stored.source === "keychain" ? "keychain" : "fs-fallback";
      tokenPath = stored.path;
    }
    // No legacy fallback — `.arbitra/.env` ARBITRA_TOKEN line is ignored.
  }

  // ── Project ID resolution ───────────────────────────────────────────────
  let projectId: string | undefined;
  let projectIdSource: ProjectIdSource | undefined;
  let projectIdPath: string | undefined;

  const envProjectId = process.env.ARBITRA_PROJECT_ID;
  if (envProjectId && envProjectId.length > 0) {
    projectId = envProjectId;
    projectIdSource = "env";
  } else if (parsedEnvFile.projectId) {
    projectId = parsedEnvFile.projectId;
    projectIdSource = "arbitra-env-file";
    projectIdPath = envFile;
  }

  if (!token) {
    return {
      ok: false,
      reason: "no_token",
      baseUrl,
      clientName,
      deviceLabel,
      deviceId,
    };
  }

  if (opts.requireProjectId && !projectId) {
    return {
      ok: false,
      reason: "no_project_id",
      baseUrl,
      clientName,
      deviceLabel,
      deviceId,
      token,
      tokenSource,
    };
  }

  return {
    ok: true,
    baseUrl,
    token,
    tokenSource: tokenSource!,
    ...(tokenPath ? { tokenPath } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectIdSource ? { projectIdSource } : {}),
    ...(projectIdPath ? { projectIdPath } : {}),
    clientName,
    deviceLabel,
    deviceId,
  };
}

/**
 * Atomic write of `.arbitra/.env` preserving any lines the unified flow does
 * not own. Specifically: rewrites ARBITRA_URL and ARBITRA_PROJECT_ID, leaves
 * everything else alone, and adds the canonical header comment block if the
 * file is being created from scratch.
 *
 * When `projectId` is omitted (the `use` subcommand's URL-only switch), any
 * existing ARBITRA_PROJECT_ID line is preserved untouched and none is added.
 *
 * If `dropLegacyToken` is true, an existing `ARBITRA_TOKEN=` line is removed
 * (the unified flow stores tokens in the keychain).
 */
export async function writeArbitraEnv(
  cwd: string,
  values: { baseUrl: string; projectId?: string },
  opts: { dropLegacyToken?: boolean } = {}
): Promise<string> {
  const dir = join(cwd, ".arbitra");
  const path = join(dir, ".env");
  await fs.mkdir(dir, { recursive: true });

  const HEADER = [
    "# Arbitra project pin — personal per developer per repo, do NOT commit.",
    "# Generated by the Arbitra Connect flow. Re-run `arbitra-mcp login` to refresh.",
    "#",
    "# Tokens are stored in your OS keychain (macOS Keychain / Windows Credential",
    "# Manager / libsecret) — never put a token in this file.",
    "",
  ].join("\n");

  let existing: string | undefined;
  try {
    existing = await fs.readFile(path, "utf-8");
  } catch {
    /* fresh file */
  }

  const lines: string[] = [];
  const seenKeys = new Set<string>();
  if (existing) {
    for (const rawLine of existing.split("\n")) {
      const line = rawLine;
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) {
        lines.push(line);
        continue;
      }
      const eq = stripped.indexOf("=");
      if (eq <= 0) {
        lines.push(line);
        continue;
      }
      const key = stripped.slice(0, eq).trim();
      if (key === "ARBITRA_URL") {
        lines.push(`ARBITRA_URL=${values.baseUrl}`);
        seenKeys.add("ARBITRA_URL");
      } else if (key === "ARBITRA_PROJECT_ID" && values.projectId !== undefined) {
        lines.push(`ARBITRA_PROJECT_ID=${values.projectId}`);
        seenKeys.add("ARBITRA_PROJECT_ID");
      } else if (key === "ARBITRA_TOKEN" && opts.dropLegacyToken) {
        // omit
      } else {
        lines.push(line);
      }
    }
  } else {
    lines.push(...HEADER.split("\n"));
  }

  if (!seenKeys.has("ARBITRA_URL")) lines.push(`ARBITRA_URL=${values.baseUrl}`);
  if (values.projectId !== undefined && !seenKeys.has("ARBITRA_PROJECT_ID")) {
    lines.push(`ARBITRA_PROJECT_ID=${values.projectId}`);
  }

  // Ensure trailing newline, no leading blank line cluster.
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";

  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, out, { mode: 0o600 });
  await fs.rename(tmp, path);
  return path;
}
