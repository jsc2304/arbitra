/**
 * Tests for the `reconnect` auth tool.
 *
 * Two paths:
 *   - env token   → returns the "can't clear" message, never touches the
 *                   keychain or starts a device flow.
 *   - keychain    → clears the token (deleteToken), resets mutable creds, and
 *                   returns the Connect link + full-restart instruction.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { tools } from "./auth-tools.js";
import {
  __resetPendingDeviceFlowForTests,
  __awaitBackgroundFlowsForTests,
  type MutableCreds,
  type WithCredsContext,
} from "../mcp-creds.js";
import type { ToolResult } from "../types.js";
import type { ResolvedCreds } from "../credentials.js";

function okCreds(
  token: string,
  tokenSource: "keychain" | "env" | "fs-fallback" = "keychain"
): ResolvedCreds {
  return {
    ok: true,
    baseUrl: "https://example.com",
    token,
    tokenSource,
    clientName: "cursor",
    deviceLabel: "test-host",
    deviceId: "0123456789abcdef",
  };
}

function reconnectTool(ctx: WithCredsContext) {
  const tool = tools(ctx).find((t) => t.name === "reconnect");
  if (!tool) throw new Error("reconnect tool not registered");
  return tool;
}

test("reconnect: env token returns the can't-clear message, never deletes or starts a flow", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_env_secret", "env"),
    baseUrl: "https://example.com",
    token: "arb_env_secret",
  };

  let deleteCalled = false;
  let flowStarted = false;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async () => {
      deleteCalled = true;
      return { removed: true };
    },
    startDeviceFlow: async () => {
      flowStarted = true;
      throw new Error("device flow must NOT start for an env token");
    },
  };

  const result = (await reconnectTool(ctx).handler({})) as ToolResult;

  assert.equal(deleteCalled, false, "env token must not be deleted");
  assert.equal(flowStarted, false, "env token must not start a device flow");
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /env token|ARBITRA_TOKEN/i);
  assert.match(result.content[0]?.text ?? "", /restart/i);
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.reason, "env_token_not_clearable");
  assert.equal(sc.requires_login, false);
  // Env tokens can only be rotated via env change + full restart.
  assert.equal(sc.restart_required, true);
  // Env creds untouched.
  assert.equal(mutable.current.ok, true);

  __resetPendingDeviceFlowForTests();
});

test("reconnect: keychain token is cleared and the Connect link + restart instruction is returned", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_stale", "keychain"),
    baseUrl: "https://example.com",
    token: "arb_stale",
  };

  let deletedBaseUrl: string | null = null;
  let deletedClient: string | null = null;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async (baseUrl, clientName) => {
      deletedBaseUrl = baseUrl;
      deletedClient = clientName;
      return { removed: true };
    },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_reconnect",
        user_code: "RCON-NCT1",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=RCON-NCT1",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
    }),
  };

  const result = (await reconnectTool(ctx).handler({})) as ToolResult;

  // Stale token cleared for the resolved host + client.
  assert.equal(deletedBaseUrl, "https://example.com");
  assert.equal(deletedClient, "cursor");
  // Mutable creds reset to a missing-token state.
  assert.equal(mutable.current.ok, false);
  assert.equal(mutable.token, undefined);
  // Connect link + user code surfaced.
  assert.match(result.content[0]?.text ?? "", /Reconnect Cursor to Arbitra/);
  assert.match(result.content[0]?.text ?? "", /RCON-NCT1/);
  assert.match(result.content[0]?.text ?? "", /connect\?code=RCON-NCT1/);
  // Full-restart instruction present.
  assert.match(result.content[0]?.text ?? "", /fully restart/i);
  // Wrong-host guidance present.
  assert.match(result.content[0]?.text ?? "", /ARBITRA_URL/);
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.requires_login, true);
  assert.equal(sc.reason, "reconnect_requested");
  assert.equal(sc.restart_required, true);
  assert.equal(sc.verification_uri_complete, "https://example.com/connect?code=RCON-NCT1");

  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});

test("reconnect: fs-fallback token takes the same clear + flow path as keychain", async () => {
  __resetPendingDeviceFlowForTests();
  const mutable: MutableCreds = {
    current: okCreds("arb_fs_stale", "fs-fallback"),
    baseUrl: "https://example.com",
    token: "arb_fs_stale",
  };

  let deleteCalled = false;
  const ctx: WithCredsContext = {
    creds: mutable,
    resolveOpts: { cwd: process.cwd(), clientName: "cursor" },
    deleteToken: async () => {
      deleteCalled = true;
      return { removed: true };
    },
    startDeviceFlow: async () => ({
      init: {
        device_code: "dev_reconnect_fs",
        user_code: "RCON-FS01",
        verification_uri: "https://example.com/connect",
        verification_uri_complete: "https://example.com/connect?code=RCON-FS01",
        expires_in: 600,
        interval: 0,
      },
      baseUrl: "https://example.com",
      startedAt: Date.now(),
      completion: Promise.resolve({ status: "expired" as const, error: "expired_token" as const }),
    }),
  };

  const result = (await reconnectTool(ctx).handler({})) as ToolResult;

  // fs-fallback is a local token → cleared and a new Connect flow is started,
  // exactly like the keychain path (only `env` is refused).
  assert.equal(deleteCalled, true, "fs-fallback token must be deleted");
  assert.equal(mutable.current.ok, false);
  assert.equal(mutable.token, undefined);
  assert.match(result.content[0]?.text ?? "", /RCON-FS01/);
  const sc = result.structuredContent as Record<string, unknown>;
  assert.equal(sc.requires_login, true);
  assert.equal(sc.reason, "reconnect_requested");
  assert.equal(sc.restart_required, true);

  await __awaitBackgroundFlowsForTests();
  __resetPendingDeviceFlowForTests();
});
