#!/usr/bin/env node
/**
 * Minimal signal-emitter hook. Invoked by Claude Code as a `command` hook on
 * SessionStart, PostToolUse (as a throttled heartbeat), and SessionEnd via
 * `arbitra-mcp hook <event>` (see `index.ts`). Emits a Session Signal event to
 * `POST {ARBITRA_URL}/api/signals` so the developer's own real sessions show
 * up in Arbitra's session registry.
 *
 * Hard contract, in order of importance:
 *   1. Never blocks or fails the agent's real work. Every failure mode
 *      (no token, network error, timeout, non-2xx, bad JSON on stdin) is
 *      swallowed. The process always exits 0.
 *   2. Never starts an interactive flow. `resolveCreds` alone (not
 *      `withCredsRetry`) is used deliberately — a hook has no chat turn to
 *      surface a device-flow login link into, so "no token yet" just means
 *      "skip this emission", not "prompt the user".
 *   3. Payload carries identity and location only — agent name, repository,
 *      branch, session id, event id/type/schema version, optional client
 *      timestamp. No tool output, no diffs, no code, no file paths beyond
 *      repository identity. The repository URL is sent without credentials.
 *      See `session-signal-schema.ts`.
 *
 * Claude Code hook stdin JSON (read fields only — see
 * https://code.claude.com/docs/en/hooks for the full shape each event
 * carries): `session_id` (keys the Session Signal `session_id` and the
 * heartbeat throttle) and `cwd` (the working directory git context —
 * repository/branch — is derived from). `hook_event_name` is accepted but
 * unused: which Session Signal `event_type` to emit is passed explicitly as
 * the subcommand argument by the hook command line, so this module doesn't
 * need to map hook names itself.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { resolveCreds, stripUrlCredentials } from "../credentials.js";
import {
  SESSION_SIGNAL_SCHEMA_VERSION,
  sessionSignalEventSchema,
  type SessionSignalEvent,
  type SessionSignalEventType,
} from "./session-signal-schema.js";

/** Self-signed agent identity — this hook only ever runs under Claude Code. */
export const AGENT_NAME = "claude-code";

/** N=2 minutes default heartbeat throttle (issue #985). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

/** Hard fire-and-forget deadline for the network call. */
export const HARD_TIMEOUT_MS = 1500;

/** Backstop deadline for the whole process, in case something outside the fetch call hangs. */
const WATCHDOG_TIMEOUT_MS = HARD_TIMEOUT_MS + 500;

const HEARTBEAT_STATE_DIR = join(homedir(), ".config", "arbitra", "session-signal-heartbeat");

/** The subset of Claude Code's hook stdin JSON this emitter reads. */
export interface HookStdinInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

export interface GitContext {
  repository: string;
  branch: string;
}

type ExecFn = (cmd: string, args: string[], cwd: string) => string;

function defaultExec(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    timeout: 300,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString("utf-8")
    .trim();
}

/**
 * Derives repository identity and branch from `cwd` via git. Never throws —
 * any git failure (not a repo, no origin remote, detached HEAD) falls back
 * to a best-effort value so the hook always has something to emit. Credentials
 * embedded in the remote URL (`https://user:token@host/...`) are stripped.
 */
export function resolveGitContext(cwd: string, exec: ExecFn = defaultExec): GitContext {
  let repository: string | undefined;
  try {
    const remote = exec("git", ["remote", "get-url", "origin"], cwd);
    repository = remote ? stripUrlCredentials(remote) : undefined;
  } catch {
    // no origin remote configured — fall through to the directory name
  }
  if (!repository) {
    try {
      const topLevel = exec("git", ["rev-parse", "--show-toplevel"], cwd);
      repository = topLevel ? basename(topLevel) : basename(cwd);
    } catch {
      repository = basename(cwd);
    }
  }

  let branch: string | undefined;
  try {
    branch = exec("git", ["branch", "--show-current"], cwd) || undefined;
  } catch {
    // not a git repo (or git unavailable) — fall through
  }
  if (!branch) {
    try {
      const sha = exec("git", ["rev-parse", "--short", "HEAD"], cwd);
      branch = sha ? `detached:${sha}` : "unknown";
    } catch {
      branch = "unknown";
    }
  }

  return { repository, branch };
}

/**
 * A workspace is Arbitra-governed iff its root carries a `.arbitra/`
 * directory — the same marker every governed repo already checks in. The
 * root is the git toplevel when `cwd` is inside a git repo, else `cwd`
 * itself (covers non-git container workspaces that pin an `.arbitra/`).
 *
 * This is the privacy gate for the emitter: sessions in repos that never
 * opted into Arbitra must not report their existence — not the remote URL,
 * not the branch name, not even a credentials lookup.
 */
export function isGovernedWorkspace(cwd: string, exec: ExecFn = defaultExec): boolean {
  let start = cwd;
  try {
    const topLevel = exec("git", ["rev-parse", "--show-toplevel"], cwd);
    if (topLevel) start = topLevel;
  } catch {
    // not a git repo — walk up from cwd itself
  }
  // Walk up to the filesystem root, mirroring findArbitraEnvFile's
  // multi-workspace-folder pattern, so a nested non-git workspace under a
  // governed root is still recognized.
  try {
    let dir = start;
    for (;;) {
      if (existsSync(join(dir, ".arbitra"))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    return false;
  }
}

export interface BuildSignalEventParams {
  eventType: SessionSignalEventType;
  sessionId: string;
  repository: string;
  branch: string;
  now?: Date;
  eventId?: string;
  agentName?: string;
  schemaVersion?: number;
}

/**
 * Builds one Session Signal event and validates it against the local schema
 * replica before returning — a malformed event never reaches the network.
 */
export function buildSignalEvent(params: BuildSignalEventParams): SessionSignalEvent {
  const candidate: SessionSignalEvent = {
    event_id: params.eventId ?? randomUUID(),
    schema_version: params.schemaVersion ?? SESSION_SIGNAL_SCHEMA_VERSION,
    event_type: params.eventType,
    agent_name: params.agentName ?? AGENT_NAME,
    repository: params.repository,
    branch: params.branch,
    session_id: params.sessionId,
    client_timestamp: (params.now ?? new Date()).toISOString(),
  };
  return sessionSignalEventSchema.parse(candidate);
}

function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unknown-session";
}

function defaultReadLastEmitted(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function defaultWriteLastEmitted(path: string, value: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(value), { mode: 0o600 });
  } catch {
    // best-effort — a failed write just means the next call re-throttles from empty state
  }
}

export interface ThrottleDeps {
  read: (path: string) => number | undefined;
  write: (path: string, value: number) => void;
}

export interface ShouldEmitHeartbeatParams {
  sessionId: string;
  now: number;
  intervalMs?: number;
  stateDir?: string;
  deps?: ThrottleDeps;
}

/**
 * Throttles heartbeat emission to at most one per `intervalMs` per session
 * (default `DEFAULT_HEARTBEAT_INTERVAL_MS`, N=2 minutes). `PostToolUse`
 * fires on every tool call, so this is the gate that keeps most invocations
 * a no-op — only state-file I/O, no network, on the throttled path.
 */
export function shouldEmitHeartbeat(params: ShouldEmitHeartbeatParams): boolean {
  const intervalMs = params.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const stateDir = params.stateDir ?? HEARTBEAT_STATE_DIR;
  const deps = params.deps ?? { read: defaultReadLastEmitted, write: defaultWriteLastEmitted };
  const path = join(stateDir, `${sanitizeSessionId(params.sessionId)}.txt`);

  const last = deps.read(path);
  if (last !== undefined && params.now - last < intervalMs) {
    return false;
  }
  deps.write(path, params.now);
  return true;
}

export interface PostSignalBatchParams {
  baseUrl: string;
  token: string;
  events: SessionSignalEvent[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fire-and-forget POST to `/api/signals`. Every failure mode — DNS/network
 * error, timeout, non-2xx response, a thrown exception from `fetchImpl`
 * itself — is caught and swallowed here; the caller never needs its own
 * try/catch around this call.
 */
export async function postSignalBatch(params: PostSignalBatchParams): Promise<boolean> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? HARD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(new URL("/api/signals", params.baseUrl).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ events: params.events }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type SignalCliEventType = "session_start" | "heartbeat" | "session_end";

export interface RunHookDeps {
  resolveCreds: typeof resolveCreds;
  resolveGitContext: typeof resolveGitContext;
  shouldEmitHeartbeat: typeof shouldEmitHeartbeat;
  isGovernedWorkspace: typeof isGovernedWorkspace;
  postSignalBatch: typeof postSignalBatch;
  now: () => Date;
}

const defaultDeps: RunHookDeps = {
  resolveCreds,
  resolveGitContext,
  shouldEmitHeartbeat,
  isGovernedWorkspace,
  postSignalBatch,
  now: () => new Date(),
};

/**
 * Orchestrates one hook invocation end to end. Every early return below is a
 * deliberate silent no-op (missing session id, no resolvable credentials,
 * throttled heartbeat) — none of them are errors from the agent's
 * perspective, so none of them throw.
 */
export async function runHook(
  eventType: SignalCliEventType,
  input: HookStdinInput,
  deps: Partial<RunHookDeps> = {}
): Promise<void> {
  const d: RunHookDeps = { ...defaultDeps, ...deps };
  const sessionId = input.session_id;
  if (!sessionId) return;

  try {
    const cwd = input.cwd ?? process.cwd();
    const now = d.now();

    if (eventType === "heartbeat") {
      const emit = d.shouldEmitHeartbeat({ sessionId, now: now.getTime() });
      if (!emit) return;
    }

    if (!d.isGovernedWorkspace(cwd)) return; // non-governed repo: leak nothing, not even a creds lookup

    const creds = await d.resolveCreds({ cwd, clientName: AGENT_NAME });
    if (!creds.ok) return; // no token resolvable — never start an interactive flow from a hook

    const { repository, branch } = d.resolveGitContext(cwd);
    const event = buildSignalEvent({ eventType, sessionId, repository, branch, now });

    await d.postSignalBatch({ baseUrl: creds.baseUrl, token: creds.token, events: [event] });
  } catch {
    // Defense in depth: every dependency above already swallows its own
    // failures, but a hook must never throw regardless of which dependency
    // changes underneath it — this is what the "runHook never throws" test
    // pins.
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function parseEventTypeArg(arg: string | undefined): SignalCliEventType | undefined {
  if (arg === "session_start" || arg === "heartbeat" || arg === "session_end") return arg;
  return undefined;
}

/**
 * Entry point for `arbitra-mcp hook <event>`: reads Claude Code's hook JSON
 * from stdin and emits the signal. Resolves (never rejects) — the caller
 * exits 0 afterwards. A watchdog guarantees the process exits 0 even if
 * something outside the fetch call's own AbortController hangs (e.g. a slow
 * keychain read).
 */
export async function runHookCli(args: string[]): Promise<void> {
  const watchdog = setTimeout(() => process.exit(0), WATCHDOG_TIMEOUT_MS);
  watchdog.unref();

  try {
    const eventType = parseEventTypeArg(args[0]);
    if (!eventType) return;

    const raw = await readStdin();
    let input: HookStdinInput = {};
    try {
      input = raw ? (JSON.parse(raw) as HookStdinInput) : {};
    } catch {
      input = {};
    }

    await runHook(eventType, input);
  } catch {
    // swallow — fire-and-forget, never surface a failure to the agent
  }
}
