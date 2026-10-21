/**
 * `arbitra-mcp token` — resolve a bearer token via the standard credential
 * chain and print it to stdout (and ONLY stdout).
 *
 * Consumers: non-MCP tooling (CLI scripts, CI jobs) that needs to share
 * credentials written by the unified Connect flow, because `ARBITRA_TOKEN` is
 * no longer the canonical storage location.
 *
 * Resolution order matches `resolveCreds` exactly — env → keychain → fs-fallback.
 *
 * Output contract:
 *   - success → token + "\n" on stdout, exit 0.
 *   - failure → one-line human diagnostic on stderr, non-zero exit.
 *
 * Never prints partial tokens, never prints stack traces, never logs the token
 * to stderr.
 */

import { resolveCreds, normalizeClientName } from "./credentials.js";
import { listEntries, normalizeBaseUrl, readToken } from "./keychain.js";

interface TokenArgs {
  clientName?: string;
  baseUrl?: string;
  help: boolean;
}

function parseArgs(args: string[]): TokenArgs {
  const out: TokenArgs = { help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--client-name" && args[i + 1]) {
      out.clientName = args[i + 1];
      i += 1;
    } else if (a?.startsWith("--client-name=")) {
      out.clientName = a.slice("--client-name=".length);
    } else if (a === "--base-url" && args[i + 1]) {
      out.baseUrl = args[i + 1];
      i += 1;
    } else if (a?.startsWith("--base-url=")) {
      out.baseUrl = a.slice("--base-url=".length);
    }
  }
  return out;
}

const HELP_TEXT =
  "Usage: arbitra-mcp token [--base-url URL] [--client-name NAME]\n\n" +
  "Resolve an Arbitra bearer token via the standard discovery chain\n" +
  "(env → OS keychain → fs-fallback) and print it to stdout.\n\n" +
  "Intended for scripts and other non-MCP tooling that needs to share\n" +
  "credentials written by the Connect flow.\n\n" +
  "Options:\n" +
  "  --base-url URL       Override Arbitra base URL (default: env / .arbitra/.env)\n" +
  "  --client-name NAME   Keychain slot to read (default: arbitra-gate)\n" +
  "  -h, --help           Show this help\n\n" +
  "Exit codes:\n" +
  "  0  token printed\n" +
  "  1  no token resolvable — run `arbitra-mcp login`\n";

const NOT_FOUND_MSG =
  "arbitra-mcp token: not found in env / keychain / fs-fallback — run `arbitra-mcp login`\n";

export interface RunTokenOptions {
  /** Override for tests — defaults to process.cwd(). */
  cwd?: string;
  /** Override for tests — defaults to process.stdout.write. */
  stdoutWrite?: (s: string) => void;
  /** Override for tests — defaults to process.stderr.write. */
  stderrWrite?: (s: string) => void;
  /** Override for tests — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function runToken(
  argv: string[],
  options: RunTokenOptions = {}
): Promise<number> {
  const parsed = parseArgs(argv);
  const stdoutWrite =
    options.stdoutWrite ??
    ((s: string) => {
      process.stdout.write(s);
    });
  const stderrWrite =
    options.stderrWrite ??
    ((s: string) => {
      process.stderr.write(s);
    });
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (parsed.help) {
    stdoutWrite(HELP_TEXT);
    return 0;
  }

  // Short-circuit on ARBITRA_TOKEN env var. resolveCreds would also pick this
  // up at step 1, but doing it explicitly keeps the contract obvious and
  // avoids any keychain / file IO when CI supplies a token.
  const envToken = env.ARBITRA_TOKEN;
  if (envToken && envToken.length > 0) {
    stdoutWrite(`${envToken}\n`);
    return 0;
  }

  const clientName = normalizeClientName(parsed.clientName ?? "arbitra-gate");

  // resolveCreds picks up baseUrl from process.env.ARBITRA_URL / .arbitra/.env.
  // Forward --base-url by temporarily overlaying ARBITRA_URL on process.env
  // (and the test-supplied env, if different) for the lookup so the keychain
  // entry is keyed correctly.
  const restoreUrl = parsed.baseUrl ? overlayEnvUrl(env, parsed.baseUrl) : null;

  try {
    const creds = await resolveCreds({ cwd, clientName });
    if (creds.ok) {
      stdoutWrite(`${creds.token}\n`);
      return 0;
    }
    // Cross-client-name fallback: the gate / consumer asked for the
    // arbitra-gate slot (or any explicit clientName) but nothing has written
    // it. If exactly one other slot matches the resolved baseUrl, hand that
    // token over so a user who only authenticated via an IDE (cursor /
    // claude-code / codex) isn't blocked. Multi-match preference order:
    // arbitra-gate, arbitra-mcp-cli, then alphabetical.
    const fallback = await tryCrossClientFallback(creds.baseUrl, clientName);
    if (fallback) {
      stderrWrite(
        `arbitra-mcp token: using keychain entry from clientName=${fallback.clientName}\n`
      );
      stdoutWrite(`${fallback.token}\n`);
      return 0;
    }
    stderrWrite(NOT_FOUND_MSG);
    return 1;
  } catch {
    // Never leak stack traces — keep the failure mode crisp for the shell gate.
    stderrWrite(
      "arbitra-mcp token: credential resolution failed — run `arbitra-mcp login`\n"
    );
    return 1;
  } finally {
    if (restoreUrl) restoreUrl();
  }
}

/**
 * Multi-match preference: requested clientName wins (already tried via
 * resolveCreds, so it won't appear here), then arbitra-gate, then
 * arbitra-mcp-cli, then alphabetical of remaining. Returns the picked
 * entry's token + clientName, or null if no entry matches the baseUrl.
 *
 * Never logs the token. Never throws — keychain / fs errors collapse to null
 * so the caller falls through to NOT_FOUND_MSG.
 */
async function tryCrossClientFallback(
  baseUrl: string,
  excludeClientName: string
): Promise<{ token: string; clientName: string } | null> {
  let entries;
  try {
    entries = await listEntries();
  } catch {
    return null;
  }
  const target = normalizeBaseUrl(baseUrl);
  const matches = entries.filter(
    (e) =>
      normalizeBaseUrl(e.baseUrl) === target && e.clientName !== excludeClientName
  );
  if (matches.length === 0) return null;

  // De-dup clientNames (keychain + fs-fallback may both list the same slot)
  // while preserving the preference order below.
  const names = Array.from(new Set(matches.map((m) => m.clientName)));
  const PREFERRED = ["arbitra-gate", "arbitra-mcp-cli"];
  names.sort((a, b) => {
    const ai = PREFERRED.indexOf(a);
    const bi = PREFERRED.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      const av = ai === -1 ? PREFERRED.length : ai;
      const bv = bi === -1 ? PREFERRED.length : bi;
      if (av !== bv) return av - bv;
    }
    return a.localeCompare(b);
  });

  for (const name of names) {
    try {
      const entry = await readToken(baseUrl, name);
      if (entry && entry.token) {
        return { token: entry.token, clientName: name };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function overlayEnvUrl(env: NodeJS.ProcessEnv, url: string): () => void {
  // resolveCreds reads process.env directly, so we always overlay there. If
  // the caller passed a distinct `env` object (tests), keep both in sync so
  // observable side effects mirror what production would see.
  const originalProc = process.env.ARBITRA_URL;
  const originalEnv = env.ARBITRA_URL;
  process.env.ARBITRA_URL = url;
  if (env !== process.env) env.ARBITRA_URL = url;
  return () => {
    if (originalProc === undefined) delete process.env.ARBITRA_URL;
    else process.env.ARBITRA_URL = originalProc;
    if (env !== process.env) {
      if (originalEnv === undefined) delete env.ARBITRA_URL;
      else env.ARBITRA_URL = originalEnv;
    }
  };
}
