/**
 * `arbitra-mcp use [<url>]` — switch which Arbitra instance the MCP talks to.
 *
 * Without an argument it reports the currently resolved base URL (status mode):
 * which source supplied it (process.env.ARBITRA_URL / .arbitra/.env / default),
 * the derived environment label, and whether a keychain token exists for that
 * host.
 *
 * With a URL it rewrites the ARBITRA_URL line of the nearest `.arbitra/.env`
 * (same upward walk credentials.ts uses), preserving every other line, then
 * reports keychain-token status for the target host.
 *
 * The running MCP server caches its base URL at startup — the MCP host
 * (Cursor / Claude) must fully restart the server for a switch to take effect.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_BASE_URL, findArbitraEnvFile, writeArbitraEnv } from "./credentials.js";
import { listEntries, normalizeBaseUrl } from "./keychain.js";
import { classifyEnvironment } from "./resources/defaults-resource.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

export type UrlSource = "process.env.ARBITRA_URL" | ".arbitra/.env" | "default";

interface UseOptions {
  cwd: string;
  /** Override for tests — defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Override for tests — receives output lines. */
  stdoutWrite?: (s: string) => void;
  /** Override for tests — receives error output lines. */
  stderrWrite?: (s: string) => void;
}

const USAGE =
  "Usage: arbitra-mcp use [<url>]\n\n" +
  "Without an argument: show the currently resolved Arbitra host and its source.\n" +
  "With a URL: rewrite ARBITRA_URL in the nearest .arbitra/.env.\n\n" +
  "Example:\n" +
  "  arbitra-mcp use https://arbitra.example.com\n";

/** A switch target must be an absolute http(s) URL. */
function parseTargetUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return normalizeBaseUrl(raw);
  } catch {
    return undefined;
  }
}

/** Read only the ARBITRA_URL line from an env file (no full parse needed). */
async function readEnvFileUrl(path: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      if (line.slice(0, eq).trim() !== "ARBITRA_URL") continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    /* unreadable — treat as absent */
  }
  return undefined;
}

/** Does any keychain / FS-fallback entry exist for this host (any client)? */
async function tokenClientsForHost(baseUrl: string): Promise<string[]> {
  const target = normalizeBaseUrl(baseUrl);
  try {
    const entries = await listEntries();
    return entries
      .filter((e) => normalizeBaseUrl(e.baseUrl) === target)
      .map((e) => e.clientName);
  } catch {
    return [];
  }
}

function printTokenStatus(write: (s: string) => void, clients: string[]): void {
  if (clients.length > 0) {
    const unique = Array.from(new Set(clients)).sort();
    write(`  ${GREEN}Token present${RESET} ${DIM}(${unique.join(", ")})${RESET}\n`);
  } else {
    write(
      `  ${DIM}No keychain token for this host yet — the Connect flow will run on the first tool call.${RESET}\n`
    );
  }
}

function printEnvOverrideWarning(
  write: (s: string) => void,
  envUrl: string,
  switching: boolean
): void {
  write(
    `\n${YELLOW}${BOLD}WARNING:${RESET} ${YELLOW}process.env.ARBITRA_URL is set (${envUrl}) and overrides .arbitra/.env.${RESET}\n` +
      (switching
        ? `${YELLOW}The switch below will have NO effect until the environment variable is removed.${RESET}\n`
        : `${YELLOW}Changes to .arbitra/.env will have no effect until the environment variable is removed.${RESET}\n`)
  );
}

export async function runUse(args: string[]): Promise<number> {
  return runUseInternal(args, { cwd: process.cwd() });
}

export async function runUseInternal(args: string[], opts: UseOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const write = opts.stdoutWrite ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.stderrWrite ?? ((s: string) => process.stderr.write(s));

  if (args.includes("--help") || args.includes("-h")) {
    write(USAGE);
    return 0;
  }

  const target = args.find((a) => !a.startsWith("-"));
  const envUrl = env.ARBITRA_URL;
  const envFile = findArbitraEnvFile(opts.cwd);
  const fileUrl = envFile ? await readEnvFileUrl(envFile) : undefined;

  // ── Status mode ───────────────────────────────────────────────────────────
  if (target === undefined) {
    let resolved: string;
    let source: UrlSource;
    if (envUrl && envUrl.length > 0) {
      resolved = envUrl;
      source = "process.env.ARBITRA_URL";
    } else if (fileUrl) {
      resolved = fileUrl;
      source = ".arbitra/.env";
    } else {
      resolved = DEFAULT_BASE_URL;
      source = "default";
    }
    resolved = normalizeBaseUrl(resolved);

    const label = classifyEnvironment(resolved);
    const sourceDetail =
      source === ".arbitra/.env" && envFile ? `${source} (${envFile})` : source;

    write(`\n${BOLD}arbitra-mcp use${RESET}\n\n`);
    write(`  Base URL:     ${BOLD}${resolved}${RESET}\n`);
    write(`  Source:       ${sourceDetail}\n`);
    write(`  Environment:  ${label}\n`);
    printTokenStatus(write, await tokenClientsForHost(resolved));

    if (envUrl && envUrl.length > 0) {
      printEnvOverrideWarning(write, envUrl, false);
    }
    write("\n");
    return 0;
  }

  // ── Switch mode ───────────────────────────────────────────────────────────
  const targetUrl = parseTargetUrl(target);
  if (!targetUrl) {
    writeErr(`${RED}Not an http(s) URL: ${target}${RESET}\n\n${USAGE}`);
    return 1;
  }

  if (envUrl && envUrl.length > 0) {
    printEnvOverrideWarning(write, envUrl, true);
  }

  // Rewrite the env file where the walker found it; create one at cwd if none
  // exists (writeArbitraEnv adds the canonical header comment for fresh files).
  const envRoot = envFile ? dirname(dirname(envFile)) : opts.cwd;
  const path = await writeArbitraEnv(envRoot, { baseUrl: targetUrl });

  write(
    `\n${GREEN}${BOLD}Switched${RESET} to ${BOLD}${targetUrl}${RESET}.\n` +
      `${DIM}ARBITRA_URL updated in ${path}${RESET}\n`
  );
  printTokenStatus(write, await tokenClientsForHost(targetUrl));
  write(
    `\n  ${BOLD}!${RESET} Restart required: the MCP server caches its host at startup.\n` +
      `    Fully restart the MCP server in your MCP host (Cursor / Claude) for the change to take effect.\n\n`
  );
  return 0;
}
