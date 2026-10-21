/**
 * `arbitra-mcp login` — interactive device-flow login from the terminal.
 *
 * Mirrors `gh auth login` UX:
 *   1. POST /api/auth/connect/init  → user_code + verification_uri_complete
 *   2. Print code, prompt user to press Enter
 *   3. Open browser to verification_uri_complete
 *   4. Poll /api/auth/connect/token until success / expiry / denial
 *   5. On success: write token to OS keychain + write .arbitra/.env
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import {
  deriveDeviceId,
  deriveDeviceLabel,
  normalizeClientName,
  resolveBaseUrlForCwd,
  stripUrlCredentials,
  writeArbitraEnv,
} from "./credentials.js";
import {
  initDeviceFlow,
  pollUntilComplete,
  type DeviceInitResponse,
} from "./device-flow.js";
import { writeToken } from "./keychain.js";
import { SERVER_VERSION } from "./version.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

interface LoginOptions {
  clientName: string;
  clientVersion: string;
  baseUrl: string;
  cwd: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests — receives the URL we'd hand to `open`. */
  openUrl?: (url: string) => Promise<void>;
  /** Override for tests. */
  promptEnter?: () => Promise<void>;
  /** Override for tests — receives output lines. */
  stdoutWrite?: (s: string) => void;
}

function parseArgs(args: string[]): { clientName?: string; baseUrl?: string; help: boolean } {
  const out: { clientName?: string; baseUrl?: string; help: boolean } = { help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--client" && args[i + 1]) {
      out.clientName = args[i + 1];
      i += 1;
    } else if (a?.startsWith("--client=")) {
      out.clientName = a.slice("--client=".length);
    } else if (a === "--url" && args[i + 1]) {
      out.baseUrl = args[i + 1];
      i += 1;
    } else if (a?.startsWith("--url=")) {
      out.baseUrl = a.slice("--url=".length);
    }
  }
  return out;
}

function bestEffortGitRemote(cwd: string): { repoUrl?: string; repoName?: string } {
  try {
    const url = stripUrlCredentials(
      execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      })
        .toString()
        .trim()
    );
    if (!url) return {};
    // Best-effort repo name extraction: last path segment minus .git
    const name = basename(url).replace(/\.git$/, "");
    return { repoUrl: url, repoName: name || undefined };
  } catch {
    return {};
  }
}

function promptEnterInteractive(): Promise<void> {
  if (!process.stdin.isTTY) {
    // Non-interactive (piped). Don't block — give the user a brief beat to read
    // the code, then proceed.
    return new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    const handler = () => {
      process.stdin.off("data", handler);
      try {
        if (process.stdin.isTTY) process.stdin.pause();
      } catch {
        /* ignore */
      }
      resolve();
    };
    process.stdin.on("data", handler);
  });
}

async function defaultOpenUrl(url: string): Promise<void> {
  try {
    const mod = (await import("open")) as unknown as
      | { default: (url: string) => Promise<unknown> }
      | ((url: string) => Promise<unknown>);
    const openFn = typeof mod === "function" ? mod : mod.default;
    await openFn(url);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

function renderProgress(write: (s: string) => void, remaining: number): void {
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  // Carriage return + clear-to-EOL keeps the spinner on one line.
  write(`\r  ${DIM}Waiting for approval… ${mins}m ${secs.toString().padStart(2, "0")}s${RESET}\x1b[K`);
}

export async function runLogin(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    process.stdout.write(
      "Usage: arbitra-mcp login [--client <name>] [--url <baseUrl>]\n\n" +
        "Authenticate with Arbitra via the device-code flow. Saves the token\n" +
        "to your OS keychain and writes .arbitra/.env with the chosen project.\n"
    );
    return 0;
  }

  const cwd = process.cwd();
  const baseUrl = (parsed.baseUrl ?? resolveBaseUrlForCwd(cwd)).replace(/\/$/, "");
  const clientName = normalizeClientName(parsed.clientName ?? "arbitra-mcp-cli");

  return runLoginInternal({
    clientName,
    clientVersion: SERVER_VERSION,
    baseUrl,
    cwd,
  });
}

export async function runLoginInternal(opts: LoginOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const openUrl = opts.openUrl ?? defaultOpenUrl;
  const promptEnter = opts.promptEnter ?? promptEnterInteractive;
  const write = opts.stdoutWrite ?? ((s: string) => process.stdout.write(s));
  const writeErr = (s: string) => process.stderr.write(s);

  const { repoUrl, repoName } = bestEffortGitRemote(opts.cwd);
  const deviceLabel = deriveDeviceLabel();
  const deviceId = deriveDeviceId();

  let init: DeviceInitResponse;
  try {
    init = await initDeviceFlow(
      opts.baseUrl,
      {
        client_name: opts.clientName,
        client_version: opts.clientVersion,
        device_label: deviceLabel,
        device_id: deviceId,
        ...(repoUrl ? { repo_url: repoUrl } : {}),
        ...(repoName ? { repo_name: repoName } : {}),
      },
      fetchImpl
    );
  } catch (err) {
    writeErr(
      `${RED}Failed to start login flow:${RESET} ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  write(`\n${BOLD}arbitra-mcp login${RESET}\n\n`);
  write(`  ${BOLD}!${RESET} First, copy your one-time code:\n\n`);
  write(`      ${BOLD}${init.user_code}${RESET}\n\n`);
  write(
    `  ${BOLD}!${RESET} Press Enter to open ${init.verification_uri_complete} in your browser…\n`
  );

  await promptEnter();

  try {
    await openUrl(init.verification_uri_complete);
  } catch (err) {
    write(
      `\n  ${DIM}Could not auto-open browser (${err instanceof Error ? err.message : String(err)}).${RESET}\n` +
        `  ${DIM}Open this URL manually:${RESET}\n      ${init.verification_uri_complete}\n`
    );
  }

  write("\n");

  const result = await pollUntilComplete({
    baseUrl: opts.baseUrl,
    deviceCode: init.device_code,
    expiresIn: init.expires_in,
    interval: init.interval,
    onTick: (_, remaining) => renderProgress(write, remaining),
    fetchImpl,
  });

  write("\r\x1b[K");

  if (result.status === "expired") {
    writeErr(
      `${RED}The connection request expired before approval.${RESET} ` +
        `Re-run \`arbitra-mcp login\` to start over.\n`
    );
    return 1;
  }
  if (result.status === "denied") {
    writeErr(`${RED}Connection cancelled.${RESET}\n`);
    return 1;
  }
  if (result.status === "invalid") {
    writeErr(`${RED}Connection lost.${RESET} Please run \`arbitra-mcp login\` again.\n`);
    return 1;
  }
  if (result.status === "network_error") {
    writeErr(`${RED}Network error:${RESET} ${result.message}\n`);
    return 1;
  }
  if (result.status !== "success") {
    // Defensive — pollUntilComplete should never return pending/slow_down at
    // its terminal step, but the union includes them.
    writeErr(`${RED}Unexpected polling state: ${result.status}${RESET}\n`);
    return 1;
  }

  // Success path.
  const { access_token, project_id, project_name, server_url } = result.data;
  const effectiveBaseUrl = (server_url ?? opts.baseUrl).replace(/\/$/, "");

  let writeResult: Awaited<ReturnType<typeof writeToken>>;
  try {
    writeResult = await writeToken(effectiveBaseUrl, opts.clientName, access_token);
  } catch (err) {
    writeErr(
      `${RED}Token issued but failed to persist:${RESET} ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  let envPath: string | undefined;
  if (project_id) {
    try {
      envPath = await writeArbitraEnv(opts.cwd, {
        baseUrl: effectiveBaseUrl,
        projectId: project_id,
      });
    } catch (err) {
      writeErr(
        `${DIM}Token saved but .arbitra/.env write failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`
      );
    }
  }

  const storeLabel =
    writeResult.source === "keychain"
      ? "OS keychain"
      : `fallback file (${writeResult.path ?? "~/.config/arbitra/"})`;
  const projectSuffix = project_name ?? project_id ?? "Arbitra";

  write(
    `${GREEN}${BOLD}Connected${RESET} to ${BOLD}${projectSuffix}${RESET} on ${deviceLabel} (${opts.clientName}).\n` +
      `Token saved to ${storeLabel}.\n`
  );
  if (envPath) write(`${DIM}Project pin written to ${envPath}${RESET}\n`);
  write("\n");
  return 0;
}
