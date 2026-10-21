/**
 * RFC 8628 Device Authorization Grant — client-side helpers.
 *
 * Talks to the Arbitra `/api/auth/connect/{init,token}` endpoints (PR 1 of the
 * Device-Flow + Per-Tool Tokens initiative). The MCP server and the CLI
 * (`arbitra-mcp login`) both consume this module.
 */

import { setTimeout as delay } from "node:timers/promises";

export interface DeviceInitRequest {
  client_name: string;
  client_version?: string;
  device_label?: string;
  device_id?: string;
  repo_url?: string;
  repo_name?: string;
}

export interface DeviceInitResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  access_token: string;
  token_type: "Bearer";
  token_prefix?: string;
  project_id?: string;
  project_name?: string;
  server_url?: string;
}

export type DevicePollError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "network_error";

export type DevicePollResult =
  | { status: "success"; data: DeviceTokenSuccess }
  | { status: "pending"; error: "authorization_pending" }
  | { status: "slow_down"; error: "slow_down" }
  | { status: "denied"; error: "access_denied" }
  | { status: "expired"; error: "expired_token" }
  | { status: "invalid"; error: "invalid_grant" }
  | { status: "network_error"; message: string };

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export async function initDeviceFlow(
  baseUrl: string,
  body: DeviceInitRequest,
  fetchImpl: typeof fetch = fetch
): Promise<DeviceInitResponse> {
  const res = await fetchImpl(`${baseUrl}/api/auth/connect/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Device flow init failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as DeviceInitResponse;
}

export async function pollDeviceFlow(
  baseUrl: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch
): Promise<DevicePollResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/api/auth/connect/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: DEVICE_CODE_GRANT,
        device_code: deviceCode,
      }),
    });
  } catch (err) {
    return {
      status: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "network_error", message: `Non-JSON response (HTTP ${res.status})` };
  }

  if (res.ok && body && typeof body === "object" && (body as Record<string, unknown>).access_token) {
    return { status: "success", data: body as DeviceTokenSuccess };
  }

  const errorField = (body as Record<string, unknown> | null)?.error;
  switch (errorField) {
    case "authorization_pending":
      return { status: "pending", error: "authorization_pending" };
    case "slow_down":
      return { status: "slow_down", error: "slow_down" };
    case "access_denied":
      return { status: "denied", error: "access_denied" };
    case "expired_token":
      return { status: "expired", error: "expired_token" };
    case "invalid_grant":
      return { status: "invalid", error: "invalid_grant" };
    default:
      return {
        status: "network_error",
        message: `Unexpected token response (HTTP ${res.status}): ${JSON.stringify(body)}`,
      };
  }
}

export interface PollUntilCompleteOptions {
  baseUrl: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  /** Called every iteration with elapsed seconds. Use for spinner output. */
  onTick?: (elapsedSeconds: number, remainingSeconds: number) => void;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override the delay helper (tests). */
  delayMs?: (ms: number) => Promise<void>;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** After this many consecutive network errors, bail with `network_error`
 * instead of busy-looping for the full device-code lifetime. A wrong
 * ARBITRA_URL is the canonical reason every poll fails — the user shouldn't
 * wait 10 minutes to learn the URL is bad. */
const NETWORK_ERROR_BUDGET = 5;

/**
 * Drive the polling loop until success / terminal error / expiry. Honours
 * `slow_down` by bumping the local interval and counts repeated `slow_down`
 * responses against an internal strike counter — three strikes flips the loop
 * to `access_denied` per RFC 8628 §3.5 server-side behaviour.
 *
 * Polls immediately on the first iteration (no leading `sleep(interval)`) so
 * the agent notices a freshly confirmed authorisation within milliseconds
 * instead of waiting a full interval (typically 5 s) after the user clicks
 * Confirm.
 *
 * If `NETWORK_ERROR_BUDGET` consecutive polls fail with a network error, the
 * loop exits with `network_error` so the caller can surface a clear message
 * (typically "wrong ARBITRA_URL"). The counter resets on any successful HTTP
 * response, including `authorization_pending`.
 */
export async function pollUntilComplete(
  opts: PollUntilCompleteOptions
): Promise<DevicePollResult> {
  const sleep = opts.delayMs ?? ((ms: number) => delay(ms));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const deadline = started + opts.expiresIn * 1000;
  let interval = Math.max(1, opts.interval);
  let slowDownStrikes = 0;
  let consecutiveNetworkErrors = 0;
  let lastNetworkErrorMessage = "";

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { status: "denied", error: "access_denied" };
    }
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    opts.onTick?.(elapsed, remaining);

    const result = await pollDeviceFlow(opts.baseUrl, opts.deviceCode, fetchImpl);
    switch (result.status) {
      case "success":
      case "denied":
      case "expired":
      case "invalid":
        return result;
      case "slow_down":
        slowDownStrikes += 1;
        interval += 5;
        consecutiveNetworkErrors = 0;
        if (slowDownStrikes >= 3) {
          return { status: "denied", error: "access_denied" };
        }
        break;
      case "pending":
        consecutiveNetworkErrors = 0;
        break;
      case "network_error":
        consecutiveNetworkErrors += 1;
        lastNetworkErrorMessage = result.message;
        if (consecutiveNetworkErrors >= NETWORK_ERROR_BUDGET) {
          return {
            status: "network_error",
            message:
              `Polling failed ${NETWORK_ERROR_BUDGET} times in a row. ` +
              `Check your ARBITRA_URL (currently: ${opts.baseUrl}). ` +
              `Last error: ${lastNetworkErrorMessage}`,
          };
        }
        break;
    }

    await sleep(interval * 1000);
  }
  return { status: "expired", error: "expired_token" };
}
