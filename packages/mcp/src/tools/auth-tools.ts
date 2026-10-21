/**
 * Auth / connection lifecycle tools.
 *
 * `reconnect` is an agent-invokable tool that clears the locally stored
 * keychain token for the resolved host + client and surfaces the Connect link
 * so the user can re-authenticate without shelling out to `arbitra-mcp login`.
 * It reuses the device-flow + prompt-builder logic in `mcp-creds.ts` — it does
 * NOT duplicate the RFC 8628 device flow.
 *
 * Hard constraints (see issue #26):
 *   - An `env`-sourced token (`ARBITRA_TOKEN`, CI / service) is NOT cleared —
 *     env tokens live in the process environment, captured at spawn, and can
 *     only be rotated by changing the env + a full restart.
 *   - `ARBITRA_URL` is never mutated here — it's fixed at process spawn. If the
 *     user's problem is a wrong HOST, the returned message tells them to change
 *     `ARBITRA_URL` in their MCP config and fully restart.
 */

import { z } from "zod";
import { deleteToken } from "../keychain.js";
import {
  envTokenReconnectResult,
  startReconnectFlow,
  type WithCredsContext,
} from "../mcp-creds.js";
import { textResult, type ToolDefinition, type ToolResult } from "../types.js";

export function tools(ctx: WithCredsContext): ToolDefinition[] {
  return [
    {
      name: "reconnect",
      description:
        "Reset Arbitra authentication for this MCP session. Use when a token is expired/invalid " +
        "(repeated 401s after the token was working) or when you suspect a wrong-host 401. " +
        "Clears the locally stored keychain token for the resolved host + client and returns a " +
        "Connect link to re-authenticate. After approving in the browser you MUST fully restart the " +
        "MCP server (env, including ARBITRA_URL and ARBITRA_TOKEN, is captured at process spawn — a " +
        "client reconnect alone is not enough). A wrong host must be fixed by editing ARBITRA_URL in " +
        "your MCP config; this tool cannot change it.",
      // No inputs — operates on the resolved host + client for this session.
      inputSchema: {
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Optional acknowledgement that this clears the stored token. The tool runs regardless; " +
              "this flag only documents intent."
          ),
      },
      handler: async (): Promise<ToolResult> => {
        // Read `tokenSource` regardless of `ok`: `ResolvedCredsFail` carries it
        // too (e.g. a `no_project_id` fail with an env token echoes
        // `tokenSource: "env"`). Guarding only on the `ok` shape would let that
        // env token slip through to the clear+flow path and falsely "reconnect"
        // a CI / service token that can only be rotated via env + restart.
        const tokenSource = ctx.creds.current.tokenSource;

        // Env tokens (CI / service) can't be cleared from here.
        if (tokenSource === "env") {
          return envTokenReconnectResult();
        }

        const clientName = ctx.creds.current.clientName;
        const baseUrl = ctx.creds.baseUrl;

        // Clear the stale keychain / fs-fallback token so the discovery chain
        // stops handing it back.
        try {
          const remover = ctx.deleteToken ?? deleteToken;
          await remover(baseUrl, clientName);
        } catch {
          /* best-effort — proceed to the Connect prompt regardless */
        }

        // Reset mutable creds to a missing-token state so subsequent tool calls
        // take the device-flow path until the new token lands.
        ctx.creds.current = {
          ok: false,
          reason: "no_token",
          baseUrl,
          clientName,
          deviceLabel: ctx.creds.current.deviceLabel,
          deviceId: ctx.creds.current.deviceId,
        };
        ctx.creds.token = undefined;

        try {
          return await startReconnectFlow(ctx);
        } catch (err) {
          // If the device flow can't be started (e.g. server unreachable), the
          // token is still cleared — tell the user to retry / restart.
          return textResult(
            `Cleared the stored Arbitra token for ${baseUrl}, but could not start a new ` +
              `Connect flow: ${err instanceof Error ? err.message : String(err)}. ` +
              `Run any Arbitra tool again to retry the Connect prompt, or restart the MCP server.`,
            true
          );
        }
      },
    },
  ];
}
