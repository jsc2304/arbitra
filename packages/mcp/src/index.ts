#!/usr/bin/env node
/**
 * Arbitra MCP Server — REST API bridge for AI coding agents.
 *
 * Without a subcommand this starts the MCP server on stdio.
 *
 * Subcommands:
 *   doctor         — check local setup (token, server reachability, IDE config)
 *   doctor --json  — same, machine-readable output for paste-into-chat
 *   login          — interactive device-code authentication (writes OS keychain)
 *   logout         — clear stored credentials
 *   token          — print the resolved bearer token (for scripts and CI)
 *   use [<url>]    — show or switch the Arbitra host (rewrites .arbitra/.env)
 *   hook <event>   — Claude Code session-signal hook (session_start | heartbeat | session_end)
 *
 * Every branch loads its modules lazily: the `hook` subcommand runs on every
 * Claude Code tool call and must not pay for importing the MCP SDK.
 */

const [, , subcommand, ...subArgs] = process.argv;

/** Runs a subcommand that resolves to an exit code. */
function exitWithCode(label: string, run: () => Promise<number>): void {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`arbitra-mcp ${label} error:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
}

if (subcommand === "hook") {
  // Hard contract: never blocks, never fails the agent — always exits 0.
  import("./hooks/session-signal-hook.js")
    .then((mod) => mod.runHookCli(subArgs))
    .catch(() => {
      /* swallow — fire-and-forget */
    })
    .finally(() => process.exit(0));
} else if (subcommand === "doctor") {
  import("./doctor.js")
    .then((mod) => mod.runDoctor(subArgs))
    .catch((err) => {
      console.error("arbitra-mcp doctor error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (subcommand === "login") {
  exitWithCode("login", async () => (await import("./login.js")).runLogin(subArgs));
} else if (subcommand === "logout") {
  exitWithCode("logout", async () => (await import("./logout.js")).runLogout(subArgs));
} else if (subcommand === "use") {
  exitWithCode("use", async () => (await import("./use.js")).runUse(subArgs));
} else if (subcommand === "token") {
  import("./token.js")
    .then((mod) => mod.runToken(subArgs))
    .then(
      (code) => process.exit(code),
      () => {
        // runToken catches and converts errors to exit code 1; this is a
        // belt-and-braces guard. Deliberately silent — never print partial
        // tokens or stack traces from this subcommand.
        process.stderr.write(
          "arbitra-mcp token: credential resolution failed — run `arbitra-mcp login`\n"
        );
        process.exit(1);
      }
    );
} else {
  process.on("uncaughtException", (err) => {
    console.error("Arbitra MCP error:", err.message);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Arbitra MCP error:", reason);
    process.exit(1);
  });

  import("./server.js")
    .then((mod) => mod.runServer())
    .catch((err) => {
      console.error("Arbitra MCP fatal:", err.message);
      process.exit(1);
    });
}
