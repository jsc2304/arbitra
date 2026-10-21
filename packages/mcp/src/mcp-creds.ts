/**
 * MCP-server-side credentials orchestration.
 *
 * `withCredsRetry` is the wrapper every tool handler runs through. If a token
 * is already known, the handler executes immediately. Otherwise the wrapper
 * **starts (or joins) a single in-flight device flow** and returns the spec
 * §D.6 markdown prompt to the agent immediately — it does NOT block on
 * `pollUntilComplete`. The polling runs as a detached background task that
 * writes the resulting token to the keychain on success (or marks the flow
 * expired/denied on failure). The user retries their tool call after
 * confirming in the browser — the next `withCredsRetry` invocation sees the
 * populated keychain and runs the handler normally.
 *
 * This avoids the 10-minute silent hang the inline-await pattern caused on
 * stdio MCP transports: Cursor / Claude Code / Codex sit on a "running tool"
 * spinner until the JSON-RPC response arrives, so awaiting the poll inline
 * means the markdown login link never reaches the user before the device code
 * expires.
 */

import {
  initDeviceFlow,
  pollUntilComplete,
  type DeviceInitResponse,
  type DevicePollResult,
  type DeviceTokenSuccess,
} from "./device-flow.js";
import {
  resolveCreds,
  writeArbitraEnv,
  type ResolvedCreds,
  type ResolveOptions,
} from "./credentials.js";
import { deleteToken, writeToken } from "./keychain.js";
import { textResult, type ToolResult } from "./types.js";

const CLIENT_NAME_LABELS: Record<string, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codex: "Codex",
};

function labelForClient(clientName: string): string {
  return CLIENT_NAME_LABELS[clientName] ?? "your tool";
}

export interface DeviceFlowHandle {
  init: DeviceInitResponse;
  baseUrl: string;
  startedAt: number;
  /** Resolves once the device flow reaches a terminal state. */
  completion: Promise<DevicePollResult>;
}

export interface MutableCreds {
  /** Most recently resolved creds. Updated when a device flow completes. */
  current: ResolvedCreds;
  baseUrl: string;
  token?: string;
}

export interface WithCredsContext {
  /** Mutable shared creds reference. */
  creds: MutableCreds;
  /** ResolveOptions for re-running the discovery chain after a flow completes. */
  resolveOpts: ResolveOptions;
  /** Inject a fresh device flow (tests). */
  startDeviceFlow?: (ctx: WithCredsContext) => Promise<DeviceFlowHandle>;
  /** Inject the writeToken (tests). */
  writeToken?: typeof writeToken;
  /** Inject the deleteToken used to clear an expired keychain token (tests). */
  deleteToken?: typeof deleteToken;
  /** Inject the writeArbitraEnv (tests). */
  writeArbitraEnv?: typeof writeArbitraEnv;
  /**
   * Inject the resolveCreds used after the background flow completes (tests).
   * Allows stateful test mocks without polluting process.env.
   */
  resolveCreds?: typeof resolveCreds;
  /**
   * Hook fired after the detached background polling promise resolves (tests).
   * Production code never sets this — the production background task just
   * writes the keychain and logs to stderr.
   */
  onBackgroundFlowSettled?: (result: DevicePollResult) => void;
}

/**
 * In-flight device-flow promise. Stored as the *promise* (not the resolved
 * handle) so two concurrent `ensureDeviceFlow` callers share the same
 * `initDeviceFlow` HTTP request instead of racing to fire two.
 *
 * The slot is cleared in three cases:
 *   - Detached polling reaches a terminal state (success / denied / expired)
 *   - Detached polling throws
 *   - `initDeviceFlow` itself rejects
 * Clearing on every terminal outcome means the next tool call after a 10-min
 * expiry or a user-denied flow starts a fresh device flow rather than serving
 * a stale handle.
 */
let pendingDeviceFlow: Promise<DeviceFlowHandle> | null = null;

/**
 * Tracks the background polling tasks spawned by `ensureDeviceFlow`. Tests
 * await these to assert post-poll side effects (keychain write, slot clear).
 * Production code never reads this — leaving promises unawaited is the whole
 * point of the markdown-first pattern.
 */
const backgroundFlowTasks: Promise<void>[] = [];

/**
 * Reset module-level state. Tests only.
 */
export function __resetPendingDeviceFlowForTests(): void {
  pendingDeviceFlow = null;
  backgroundFlowTasks.length = 0;
}

/**
 * Returns a promise that resolves once every background polling task spawned
 * since the last reset has settled. Tests only.
 */
export async function __awaitBackgroundFlowsForTests(): Promise<void> {
  // Snapshot — tasks pushed after this point are not awaited here. Callers
  // that need fresh awaits should call this again.
  await Promise.allSettled(backgroundFlowTasks.slice());
}

/**
 * Idempotent device-flow starter. Concurrent calls within the device-code's
 * lifetime share the same flow — the shared slot holds the in-flight promise
 * so callers awaiting the slot all unblock on the same `init` result.
 *
 * Returns once `initDeviceFlow` resolves (i.e. the user_code is known). The
 * poll loop runs **detached** in a background task that writes credentials
 * on success; callers must not await the completion.
 */
async function ensureDeviceFlow(ctx: WithCredsContext): Promise<DeviceFlowHandle> {
  if (ctx.startDeviceFlow) {
    // Test path: the injected starter is responsible for producing a handle
    // and (if the test cares about post-flow side effects) wiring up its own
    // background task. We still register a background task here so concurrency
    // tests can await it.
    if (pendingDeviceFlow) return pendingDeviceFlow;
    const flowPromise = ctx.startDeviceFlow(ctx);
    pendingDeviceFlow = flowPromise;
    backgroundFlowTasks.push(
      (async () => {
        try {
          const handle = await flowPromise;
          const result = await handle.completion;
          await handleBackgroundCompletion(ctx, result);
        } catch (err) {
          await handleBackgroundError(ctx, err);
        } finally {
          if (pendingDeviceFlow === flowPromise) pendingDeviceFlow = null;
        }
      })()
    );
    flowPromise.catch(() => {
      if (pendingDeviceFlow === flowPromise) pendingDeviceFlow = null;
    });
    return flowPromise;
  }

  if (pendingDeviceFlow) {
    return pendingDeviceFlow;
  }

  const creds = ctx.creds.current;
  const baseUrl = ctx.creds.baseUrl;

  const startedAt = Date.now();
  // Forward-declare so the IIFE body can compare against its own slot pointer
  // when clearing on terminal outcomes. Using a holder object keeps the
  // self-reference type-safe — TS can't otherwise prove the inner `flowPromise`
  // is assigned before the nested async closure reads it.
  const slot: { promise: Promise<DeviceFlowHandle> | null } = { promise: null };
  const flowPromise: Promise<DeviceFlowHandle> = (async () => {
    const init = await initDeviceFlow(baseUrl, {
      client_name: creds.clientName,
      device_label: creds.deviceLabel,
      device_id: creds.deviceId,
    });

    // Kick off polling, but do NOT await — the returned handle exposes the
    // completion promise for tests; production callers ignore it.
    const completion = pollUntilComplete({
      baseUrl,
      deviceCode: init.device_code,
      expiresIn: init.expires_in,
      interval: init.interval,
    });

    const handle: DeviceFlowHandle = {
      init,
      baseUrl,
      startedAt,
      completion,
    };

    // Detach the post-poll work. The slot clears regardless of outcome so the
    // next tool call after expiry/denial/crash starts a fresh flow.
    const bg = (async () => {
      try {
        const result = await completion;
        await handleBackgroundCompletion(ctx, result);
      } catch (err) {
        await handleBackgroundError(ctx, err);
      } finally {
        if (pendingDeviceFlow === slot.promise) pendingDeviceFlow = null;
      }
    })();
    backgroundFlowTasks.push(bg);

    return handle;
  })();
  slot.promise = flowPromise;

  // If `init` itself rejects, drop the slot so the next caller can retry.
  flowPromise.catch(() => {
    if (pendingDeviceFlow === flowPromise) pendingDeviceFlow = null;
  });

  pendingDeviceFlow = flowPromise;
  return flowPromise;
}

async function handleBackgroundCompletion(
  ctx: WithCredsContext,
  result: DevicePollResult
): Promise<void> {
  try {
    if (result.status === "success") {
      await applyCreds(ctx, result.data);
      // JSON-RPC contract on stdio: anything we write to stdout would corrupt
      // the protocol. Use stderr so Cursor / Claude Code / Codex surface this
      // in their MCP-server log panes.
      process.stderr.write(
        `[arbitra-mcp] Credentials saved. Retry your tool call to continue.\n`
      );
    } else if (result.status === "denied") {
      process.stderr.write(
        `[arbitra-mcp] Device flow denied. Run your tool call again to start a fresh flow.\n`
      );
    } else if (result.status === "expired") {
      process.stderr.write(
        `[arbitra-mcp] Device flow expired (10-minute window elapsed). Run your tool call again to start a fresh flow.\n`
      );
    } else if (result.status === "invalid") {
      process.stderr.write(
        `[arbitra-mcp] Device flow invalid_grant. Run your tool call again.\n`
      );
    } else if (result.status === "network_error") {
      process.stderr.write(`[arbitra-mcp] Device flow network error: ${result.message}\n`);
    }
  } finally {
    ctx.onBackgroundFlowSettled?.(result);
  }
}

async function handleBackgroundError(
  ctx: WithCredsContext,
  err: unknown
): Promise<void> {
  process.stderr.write(
    `[arbitra-mcp] Background device-flow polling crashed: ${err instanceof Error ? err.message : String(err)}\n`
  );
  // Surface to tests via the same hook used for happy-path completion.
  ctx.onBackgroundFlowSettled?.({
    status: "network_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

async function applyCreds(
  ctx: WithCredsContext,
  success: DeviceTokenSuccess
): Promise<void> {
  const baseUrl = (success.server_url ?? ctx.creds.baseUrl).replace(/\/$/, "");
  const clientName = ctx.creds.current.clientName;
  const writer = ctx.writeToken ?? writeToken;
  await writer(baseUrl, clientName, success.access_token);
  if (success.project_id) {
    const envWriter = ctx.writeArbitraEnv ?? writeArbitraEnv;
    try {
      await envWriter(ctx.resolveOpts.cwd, {
        baseUrl,
        projectId: success.project_id,
      });
    } catch {
      // best-effort — the token is the critical part
    }
  }

  // Re-resolve so subsequent tool calls see the fresh state. The injection
  // point lets tests use a stateful mock instead of leaking ARBITRA_TOKEN
  // through process.env.
  const resolver = ctx.resolveCreds ?? resolveCreds;
  const fresh = await resolver(ctx.resolveOpts);
  ctx.creds.current = fresh;
  ctx.creds.baseUrl = baseUrl;
  if (fresh.ok) ctx.creds.token = fresh.token;
}

export function markdownLoginPrompt(
  clientName: string,
  baseUrl: string,
  userCode: string
): string {
  const label = labelForClient(clientName);
  const verificationUri = `${baseUrl}/connect`;
  const verificationUriComplete = `${baseUrl}/connect?code=${encodeURIComponent(userCode)}`;
  return (
    `**Connect ${label} to Arbitra**\n\n` +
    `To run Arbitra tools you need to authenticate. Open this link in your browser:\n\n` +
    `[Connect ${label} to Arbitra →](${verificationUriComplete})\n\n` +
    `Or visit ${verificationUri} and enter the code: **\`${userCode}\`**\n\n` +
    `The link expires in 10 minutes. After confirming in the browser, retry your original request — your tool will work without further prompts.`
  );
}

function loginPromptResult(
  clientName: string,
  baseUrl: string,
  userCode: string
): ToolResult {
  const md = markdownLoginPrompt(clientName, baseUrl, userCode);
  return {
    ...textResult(md),
    structuredContent: {
      requires_login: true,
      user_code: userCode,
      verification_uri: `${baseUrl}/connect`,
      verification_uri_complete: `${baseUrl}/connect?code=${encodeURIComponent(userCode)}`,
    },
  };
}

/**
 * Build the re-auth prompt returned when an expired keychain token is detected
 * on a 401. Mirrors `loginPromptResult` but with copy framed as a re-connect
 * (the previous token was rejected) rather than a first-time connect.
 */
function reauthPromptResult(
  clientName: string,
  baseUrl: string,
  userCode: string
): ToolResult {
  const label = labelForClient(clientName);
  const verificationUri = `${baseUrl}/connect`;
  const verificationUriComplete = `${baseUrl}/connect?code=${encodeURIComponent(userCode)}`;
  const md =
    `**Reconnect ${label} to Arbitra**\n\n` +
    `Your saved Arbitra token was rejected (expired, revoked, or for a different host). ` +
    `Open this link to re-authenticate:\n\n` +
    `[Reconnect ${label} to Arbitra →](${verificationUriComplete})\n\n` +
    `Or visit ${verificationUri} and enter the code: **\`${userCode}\`**\n\n` +
    `The link expires in 10 minutes. After confirming in the browser, retry your original request.`;
  return {
    ...textResult(md),
    structuredContent: {
      requires_login: true,
      reason: "token_expired",
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
    },
  };
}

/**
 * Start (or join) a device flow for the agent-invokable `reconnect` tool, then
 * return the Connect prompt + restart instruction. Reuses `ensureDeviceFlow`
 * (the same in-flight-dedup device-flow logic used by `withCredsRetry`) so the
 * device-flow logic is never duplicated. The `reconnect` tool clears the stale
 * keychain token before calling this; here we only kick off a fresh flow and
 * format the user-facing message.
 *
 * NOTE: a host (ARBITRA_URL) change still needs a FULL MCP server restart — the
 * env is captured at spawn. The message says so explicitly.
 */
export async function startReconnectFlow(ctx: WithCredsContext): Promise<ToolResult> {
  const flow = await ensureDeviceFlow(ctx);
  return reconnectToolResult(
    ctx.creds.current.clientName,
    ctx.creds.baseUrl,
    flow.init.user_code
  );
}

/**
 * Build the message returned by the `reconnect` tool after the stale keychain
 * token is cleared and a fresh device flow has started. Mirrors the re-auth
 * copy but adds the **mandatory full-restart** step (the device flow writes a
 * new keychain token, which is re-read per call — but reconnect is also the
 * remedy for wrong-host / stale-env situations, so we always tell the user to
 * restart to be safe).
 */
export function reconnectToolResult(
  clientName: string,
  baseUrl: string,
  userCode: string
): ToolResult {
  const label = labelForClient(clientName);
  const verificationUri = `${baseUrl}/connect`;
  const verificationUriComplete = `${baseUrl}/connect?code=${encodeURIComponent(userCode)}`;
  const md =
    `**Reconnect ${label} to Arbitra**\n\n` +
    `Your locally stored Arbitra token for \`${baseUrl}\` has been cleared. ` +
    `Open this link to re-authenticate:\n\n` +
    `[Reconnect ${label} to Arbitra →](${verificationUriComplete})\n\n` +
    `Or visit ${verificationUri} and enter the code: **\`${userCode}\`**\n\n` +
    `The link expires in 10 minutes. After you approve in the browser you must ` +
    `**fully restart the MCP server** (toggle it off/on, or quit and reopen ${label}) — ` +
    `a client "reconnect" alone is not enough.\n\n` +
    `If your problem is a **wrong host** (401/404 because the config points at the ` +
    `wrong Arbitra instance), this tool cannot fix it: change \`ARBITRA_URL\` in your ` +
    `MCP config and fully restart the server (the URL is read once at process spawn).`;
  return {
    ...textResult(md),
    structuredContent: {
      requires_login: true,
      reason: "reconnect_requested",
      restart_required: true,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
    },
  };
}

/**
 * Message returned by `reconnect` when the resolved token is an env
 * (`ARBITRA_TOKEN`, CI / service) token. Env tokens are captured at spawn and
 * live in the environment, not the keychain — this tool can't clear them.
 */
export function envTokenReconnectResult(): ToolResult {
  const md =
    `**Cannot clear an env token**\n\n` +
    `The active Arbitra token comes from the \`ARBITRA_TOKEN\` environment variable ` +
    `(CI / service token), not the OS keychain — \`reconnect\` cannot clear it.\n\n` +
    `To rotate it: unset or update \`ARBITRA_TOKEN\` in your environment / MCP config ` +
    `and **fully restart the MCP server**. The token is read once at process spawn, ` +
    `so a client reconnect alone has no effect.`;
  return {
    ...textResult(md, true),
    structuredContent: {
      requires_login: false,
      reason: "env_token_not_clearable",
      restart_required: true,
    },
  };
}

/**
 * Wrap a tool handler with the missing-creds → device-flow markdown pattern
 * **and** the expired-keychain-token → re-auth fallthrough.
 *
 * Strategy:
 *   1. If creds are missing → start (or join) a single in-flight device flow
 *      and return the spec §D.6 markdown prompt **immediately**. Polling runs
 *      detached in the background; on success it writes the token to the
 *      keychain. The user retries their tool call after confirming.
 *   2. If creds resolve → invoke the handler. If the handler swallowed a 401
 *      from the API (`_apiErrorStatus === 401`), the token is expired/invalid:
 *        - **env token** (`tokenSource === "env"`, CI / service): hard-fail —
 *          never enter an interactive flow in CI. Return the bare 401 error.
 *        - **keychain / fs-fallback token**: clear the stale token, reset the
 *          mutable creds, start (or join) a device flow, and return the
 *          Connect re-auth prompt with the `verification_uri_complete` link so
 *          the user can re-auth without guessing. **One attempt only** — the
 *          re-auth path does not re-invoke the handler, so there is no retry
 *          loop. The user retries their tool call after confirming.
 *
 * Note: the env vs keychain distinction is captured at process spawn. A token
 * or host change requires a FULL MCP server restart — see README.
 */
export function withCredsRetry<TArgs, TResult extends ToolResult>(
  ctx: WithCredsContext,
  handler: (args: TArgs) => Promise<TResult>
): (args: TArgs) => Promise<TResult | ToolResult> {
  return async (args: TArgs) => {
    if (!ctx.creds.current.ok) {
      const flow = await ensureDeviceFlow(ctx);
      return loginPromptResult(
        ctx.creds.current.clientName,
        ctx.creds.baseUrl,
        flow.init.user_code
      );
    }

    const tokenSource = ctx.creds.current.tokenSource;
    const result = await handler(args);

    // Read the internal 401 tag BEFORE stripping it. `_apiErrorStatus` is an
    // internal signal set by `errorResult`; it must never leak onto the MCP
    // wire, so we drop it from every result that returns to the client below.
    const apiErrorStatus = result._apiErrorStatus;
    delete result._apiErrorStatus;

    // Detect a 401 the handler swallowed into an error result. Only act on it
    // for non-env tokens — an env (CI/service) token must keep hard-failing.
    // Design assumption: a 401 from the Arbitra API is treated as an
    // expired/invalid token per the API contract; a 401 from an unrelated cause
    // would also clear the keychain token (accepted edge case).
    if (apiErrorStatus === 401 && tokenSource !== "env") {
      try {
        // Clear the stale token so the discovery chain no longer hands it back.
        const remover = ctx.deleteToken ?? deleteToken;
        await remover(ctx.creds.baseUrl, ctx.creds.current.clientName);
      } catch {
        /* best-effort — proceed to re-auth regardless */
      }

      // Reset mutable creds to a missing-token state so subsequent calls take
      // the device-flow path until the new token lands.
      const clientName = ctx.creds.current.clientName;
      ctx.creds.current = {
        ok: false,
        reason: "no_token",
        baseUrl: ctx.creds.baseUrl,
        clientName,
        deviceLabel: ctx.creds.current.deviceLabel,
        deviceId: ctx.creds.current.deviceId,
      };
      ctx.creds.token = undefined;

      const flow = await ensureDeviceFlow(ctx);
      return reauthPromptResult(clientName, ctx.creds.baseUrl, flow.init.user_code);
    }

    return result;
  };
}
