/**
 * `arbitra-mcp logout` — clear stored credentials.
 *
 * Without --all: drops entries for the chosen `--client` (default
 * `arbitra-mcp-cli`). With --all: drops every entry under the `arbitra-mcp`
 * service.
 *
 * Does NOT revoke server-side — that's a separate `arbitra-mcp revoke` we
 * don't ship in this initiative. The message points the user at Settings
 * → Connections for server-side revoke.
 */

import { normalizeClientName, resolveBaseUrlForCwd } from "./credentials.js";
import { deleteAll, deleteToken, listEntries } from "./keychain.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

interface LogoutArgs {
  clientName?: string;
  baseUrl?: string;
  all: boolean;
  help: boolean;
}

function parseArgs(args: string[]): LogoutArgs {
  const out: LogoutArgs = { all: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--all") out.all = true;
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

export async function runLogout(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    process.stdout.write(
      "Usage: arbitra-mcp logout [--client <name>] [--all] [--url <baseUrl>]\n\n" +
        "Clear locally stored Arbitra credentials. Without --all, removes\n" +
        "entries for the given --client (default: arbitra-mcp-cli).\n\n" +
        "Note: this does not revoke server-side. To revoke a token on the\n" +
        "server, open Settings → Connections in your Arbitra instance.\n"
    );
    return 0;
  }

  const write = (s: string) => process.stdout.write(s);
  write(`\n${BOLD}arbitra-mcp logout${RESET}\n\n`);

  if (parsed.all) {
    const before = await listEntries();
    if (before.length === 0) {
      write(`${DIM}No stored credentials found.${RESET}\n`);
      return 0;
    }
    write(`Removing ${before.length} entr${before.length === 1 ? "y" : "ies"}…\n`);
    for (const e of before) {
      write(`  ${DIM}- ${e.baseUrl} (${e.clientName}) [${e.source}]${RESET}\n`);
    }
    const { removed } = await deleteAll();
    write(
      `\n${GREEN}${BOLD}Removed ${removed} entr${removed === 1 ? "y" : "ies"} locally.${RESET}\n` +
        `${DIM}To revoke server-side, visit Settings → Connections.${RESET}\n\n`
    );
    return 0;
  }

  const clientName = normalizeClientName(parsed.clientName ?? "arbitra-mcp-cli");
  const baseUrl = (parsed.baseUrl ?? resolveBaseUrlForCwd(process.cwd())).replace(/\/$/, "");

  const entries = (await listEntries()).filter(
    (e) => e.clientName === clientName && (parsed.baseUrl ? e.baseUrl === baseUrl : true)
  );
  if (entries.length === 0) {
    write(`${DIM}No stored credentials for client="${clientName}".${RESET}\n`);
    write(`${DIM}Run with --all to see all entries, or pass --client <name>.${RESET}\n\n`);
    return 0;
  }

  for (const e of entries) {
    const res = await deleteToken(e.baseUrl, e.clientName);
    if (res.removed) {
      write(`${GREEN}removed${RESET}  ${e.baseUrl} (${e.clientName}) [${e.source}]\n`);
    } else {
      write(`${RED}failed${RESET}   ${e.baseUrl} (${e.clientName}) [${e.source}]\n`);
    }
  }
  write(
    `\n${DIM}Token removed locally. To revoke server-side, visit Settings → Connections.${RESET}\n\n`
  );
  return 0;
}
