#!/usr/bin/env node
/**
 * arbitra-mcp doctor — checks whether the local setup is correctly wired.
 *
 * Runs independently of the MCP server; does not require a valid token to
 * start (a missing token is itself a check failure, not a crash).
 *
 * Single source of truth for token + project resolution: `credentials.ts`.
 * The doctor here is a thin wrapper that pretty-prints what the resolver
 * found and runs a couple of network checks against the resolved baseUrl.
 *
 * Usage:
 *   npx -y arbitra-mcp doctor
 *   npx -y arbitra-mcp doctor --json
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCreds, type ResolvedCreds, type TokenSource } from "./credentials.js";
import { listEntries } from "./keychain.js";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

interface KeychainSummary {
  base_url: string;
  client_name: string;
  source: "keychain" | "fs-fallback";
  path?: string;
}

interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
  resolved: {
    base_url: string;
    client_name: string;
    device_label: string;
    device_id: string;
    token: { present: boolean; source: TokenSource | "none"; token_prefix?: string };
    project_id: { present: boolean; source?: string; value?: string };
  };
  keychain_entries: KeychainSummary[];
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function hasMcpArbitraEntry(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  const obj = content as Record<string, unknown>;
  return !!(
    obj.mcpServers &&
    typeof obj.mcpServers === "object" &&
    (obj.mcpServers as Record<string, unknown>).arbitra
  );
}

/**
 * Safe token prefix for display. Never returns the raw token. Mirrors the
 * server-side `token_prefix` shape: first 8 chars + ellipsis + last 3.
 */
function tokenPrefix(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 8)}…${token.slice(-3)}`;
}

async function runChecks(): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  const home = homedir();
  const cwd = process.cwd();

  // Discovery chain — single source of truth.
  const creds: ResolvedCreds = await resolveCreds({
    cwd,
    clientName: "arbitra-mcp-cli",
  });

  const baseUrl = creds.baseUrl;
  const tokenPresent = creds.ok || creds.token !== undefined;
  // `creds.token` and `creds.tokenSource` are present on both the ok branch
  // and the no_project_id failure branch (the token resolved fine, only the
  // project id was missing) — so a flat field read works for both.
  const token = creds.token;
  const tokenSource: TokenSource | "none" = creds.tokenSource ?? "none";

  checks.push({
    name: "Arbitra credentials resolved",
    ok: tokenPresent,
    message: tokenPresent
      ? `Token via ${tokenSource}${token ? ` (${tokenPrefix(token)})` : ""}`
      : "Not found in env / keychain / fs-fallback — run `arbitra-mcp login`",
  });

  const projectIdPresent = creds.ok ? !!creds.projectId : false;
  const projectIdSource = creds.ok ? creds.projectIdSource : undefined;
  const projectIdValue = creds.ok ? creds.projectId : undefined;
  checks.push({
    name: "Default project pin",
    ok: projectIdPresent,
    message: projectIdPresent
      ? `${projectIdValue} via ${projectIdSource}`
      : "No ARBITRA_PROJECT_ID — agents must pass project_id explicitly per call",
  });

  // Server reachability + token validity.
  if (token) {
    let serverReachable = false;
    let tokenValid = false;
    let projectCount = 0;
    let serverMessage = "";
    let tokenMessage = "";
    let projectMessage = "";

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${baseUrl}/api/projects`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      serverReachable = true;
      serverMessage = `${baseUrl} — HTTP ${res.status}`;

      if (res.ok) {
        tokenValid = true;
        tokenMessage = "Bearer token accepted (200)";

        const body = (await res.json()) as unknown;
        const list = Array.isArray(body)
          ? body
          : Array.isArray((body as Record<string, unknown>)?.projects)
            ? ((body as Record<string, unknown>).projects as unknown[])
            : [];
        projectCount = list.length;
        projectMessage =
          projectCount > 0
            ? `${projectCount} project(s) visible`
            : "No projects visible — create one in Arbitra: Settings > New Project";
      } else if (res.status === 401 || res.status === 403) {
        tokenMessage = `Token rejected (${res.status}) — re-run \`arbitra-mcp login\` to refresh`;
        projectMessage = "Skipped (token invalid)";
      } else {
        tokenMessage = `Unexpected status ${res.status}`;
        projectMessage = "Skipped (server error)";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      serverMessage = isTimeout ? `${baseUrl} — timed out after 8 s` : `${baseUrl} — ${msg}`;
      tokenMessage = "Skipped (server unreachable)";
      projectMessage = "Skipped (server unreachable)";
    }

    checks.push({ name: "Arbitra server reachable", ok: serverReachable, message: serverMessage });
    checks.push({ name: "Token valid", ok: tokenValid, message: tokenMessage });
    checks.push({ name: "Project(s) found", ok: projectCount > 0, message: projectMessage });
  } else {
    checks.push({ name: "Arbitra server reachable", ok: false, message: "Skipped (no token)" });
    checks.push({ name: "Token valid", ok: false, message: "Skipped (no token)" });
    checks.push({ name: "Project(s) found", ok: false, message: "Skipped (no token)" });
  }

  // ── 3. Claude Code MCP config ─────────────────────────────────────────────
  const claudePaths = [
    join(home, ".claude", ".mcp.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
  ];

  let claudeOk = false;
  let claudeFoundAt = "";
  for (const p of claudePaths) {
    if (existsSync(p) && hasMcpArbitraEntry(readJsonFile(p))) {
      claudeOk = true;
      claudeFoundAt = p;
      break;
    }
  }

  checks.push({
    name: "Claude Code MCP config",
    ok: claudeOk,
    message: claudeOk
      ? `arbitra MCP entry found — ${claudeFoundAt}`
      : `Not detected in ${claudePaths.join(", ")} — run: claude mcp add arbitra -e ARBITRA_URL=<instance url> -- npx -y arbitra-mcp`,
  });

  // ── 4. Cursor MCP config ──────────────────────────────────────────────────
  const cursorPaths = [join(cwd, ".cursor", "mcp.json"), join(home, ".cursor", "mcp.json")];

  let cursorOk = false;
  let cursorFoundAt = "";
  for (const p of cursorPaths) {
    if (existsSync(p) && hasMcpArbitraEntry(readJsonFile(p))) {
      cursorOk = true;
      cursorFoundAt = p;
      break;
    }
  }

  checks.push({
    name: "Cursor MCP config",
    ok: cursorOk,
    message: cursorOk
      ? `arbitra MCP entry found — ${cursorFoundAt}`
      : `Not detected in ${cursorPaths.join(", ")} — add an arbitra entry to ~/.cursor/mcp.json`,
  });

  // ── 5. Codex MCP config ───────────────────────────────────────────────────
  const codexConfigPath = join(home, ".codex", "config.toml");
  let codexOk = false;
  let codexMessage = "";
  if (existsSync(codexConfigPath)) {
    try {
      const raw = readFileSync(codexConfigPath, "utf-8");
      codexOk = raw.includes("[mcp_servers.arbitra]");
      codexMessage = codexOk
        ? `arbitra MCP entry found — ${codexConfigPath}`
        : `${codexConfigPath} exists but no [mcp_servers.arbitra] block — add one per the Arbitra README`;
    } catch {
      codexMessage = `Could not read ${codexConfigPath}`;
    }
  } else {
    codexMessage = `${codexConfigPath} not found — Codex not configured (OK if you are not using Codex)`;
  }
  checks.push({ name: "Codex MCP config", ok: codexOk, message: codexMessage });

  // Keychain entries summary — never includes token values.
  const entries = await listEntries();
  const keychainSummary: KeychainSummary[] = entries.map((e) => ({
    base_url: e.baseUrl,
    client_name: e.clientName,
    source: e.source,
    ...(e.path ? { path: e.path } : {}),
  }));

  return {
    ok: checks.every((c) => c.ok),
    checks,
    resolved: {
      base_url: baseUrl,
      client_name: creds.clientName,
      device_label: creds.deviceLabel,
      device_id: creds.deviceId,
      token: {
        present: tokenPresent,
        source: tokenSource,
        ...(token ? { token_prefix: tokenPrefix(token) } : {}),
      },
      project_id: {
        present: projectIdPresent,
        ...(projectIdSource ? { source: projectIdSource } : {}),
        ...(projectIdValue ? { value: projectIdValue } : {}),
      },
    },
    keychain_entries: keychainSummary,
  };
}

export async function runDoctor(args: string[]): Promise<void> {
  const jsonMode = args.includes("--json");
  const report = await runChecks();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.ok ? 0 : 1);
  }

  // Human-readable output.
  process.stdout.write(`\n${BOLD}arbitra-mcp doctor${RESET}\n\n`);

  for (const check of report.checks) {
    const icon = check.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    process.stdout.write(`  ${icon}  ${check.name}\n`);
    process.stdout.write(`     ${DIM}${check.message}${RESET}\n`);
  }

  process.stdout.write(`\n${BOLD}Identity${RESET}\n`);
  process.stdout.write(`  ${DIM}client_name${RESET}   ${report.resolved.client_name}\n`);
  process.stdout.write(`  ${DIM}device_label${RESET}  ${report.resolved.device_label}\n`);
  process.stdout.write(`  ${DIM}device_id${RESET}     ${report.resolved.device_id}\n`);
  process.stdout.write(`  ${DIM}base_url${RESET}      ${report.resolved.base_url}\n`);

  if (report.keychain_entries.length > 0) {
    process.stdout.write(`\n${BOLD}Stored credentials${RESET}\n`);
    for (const entry of report.keychain_entries) {
      process.stdout.write(
        `  ${DIM}${entry.source.padEnd(12)}${RESET} ${entry.base_url} (${entry.client_name})${entry.path ? ` ${DIM}${entry.path}${RESET}` : ""}\n`
      );
    }
  } else {
    process.stdout.write(`\n${DIM}No stored credentials in keychain or fs-fallback.${RESET}\n`);
  }

  const failed = report.checks.filter((c) => !c.ok);
  process.stdout.write("\n");
  if (report.ok) {
    process.stdout.write(`${GREEN}${BOLD}All checks passed.${RESET}\n\n`);
  } else {
    process.stdout.write(
      `${RED}${BOLD}${failed.length} check(s) failed.${RESET} ` +
        `Re-run with ${BOLD}--json${RESET} for a paste-into-chat summary.\n\n`
    );
  }

  process.exit(report.ok ? 0 : 1);
}
