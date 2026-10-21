/**
 * MCP server config resolution.
 *
 * Thin wrapper over `resolveCreds()` that adds the MCP-specific
 * `requestTimeoutMs` knob. Returns a discriminated-union — never calls
 * `process.exit`, so the caller is free to handle the no-creds case via the
 * device-flow auto-trigger path.
 */

import {
  resolveCreds,
  type ResolvedCreds,
  type ResolveOptions,
} from "./credentials.js";

export interface ResolvedConfig {
  creds: ResolvedCreds;
  requestTimeoutMs: number;
}

export async function loadConfig(opts: ResolveOptions): Promise<ResolvedConfig> {
  const creds = await resolveCreds(opts);
  const raw = Number.parseInt(process.env.ARBITRA_REQUEST_TIMEOUT_MS ?? "10000", 10);
  const requestTimeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 10000;
  return { creds, requestTimeoutMs };
}
