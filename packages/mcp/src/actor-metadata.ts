/**
 * Actor metadata auto-injection.
 *
 * Captures the MCP client identity (from the `initialize` handshake) and
 * exposes a small helper that returns the `ActorMetadata` payload the
 * Arbitra backend accepts on comment and evidence writes.
 *
 * Model identity is intentionally NOT auto-populated here. Users switch
 * LLM models per-prompt in Cursor / Claude Code, so an env var read once
 * at startup would go stale immediately and mislead the audit trail. The
 * agent is expected to self-sign comments (see Arbitra's AGENTS.md); MCP
 * only provides the reliable client identity.
 *
 * The backend normalizes these fields (lowercase `client_name`, trim
 * versions) — we mirror that normalization on the client so the payload
 * is already clean when it hits the wire.
 *
 * All fields are optional: if no clientInfo is available,
 * `buildActorMetadata()` returns `undefined` so callers can drop the
 * field entirely from their request body.
 */

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface ActorMetadata {
  client_name?: string;
  client_version?: string;
  // `model` is accepted by the backend and preserved when callers supply
  // it explicitly on an evidence item, but MCP does not auto-populate it.
  model?: string;
}

// Module-level ref. Populated once by setClientInfo() after the MCP
// `initialize` handshake completes. Kept as a mutable holder object so
// callers can capture a stable reference if they need one (tests, etc).
const clientInfoRef: { current: ClientInfo | undefined } = { current: undefined };

/**
 * Record the MCP clientInfo reported during the `initialize` handshake.
 * Safe to call with `undefined` (no-op). Safe to call multiple times; the
 * latest non-undefined value wins.
 */
export function setClientInfo(info: ClientInfo | undefined): void {
  if (info) {
    clientInfoRef.current = info;
  }
}

/**
 * Clear the captured clientInfo. Only intended for tests.
 */
export function resetClientInfoForTests(): void {
  clientInfoRef.current = undefined;
}

/**
 * Build the optional `actor_metadata` payload attached to comment and
 * evidence writes. Returns `undefined` when nothing is known so callers
 * can spread-conditional it into the request body.
 */
export function buildActorMetadata(): ActorMetadata | undefined {
  const client = clientInfoRef.current;
  const meta: ActorMetadata = {};

  if (client?.name) {
    const name = client.name.trim().toLowerCase();
    if (name) meta.client_name = name;
  }
  if (client?.version) {
    const version = client.version.trim();
    if (version) meta.client_version = version;
  }

  return Object.keys(meta).length === 0 ? undefined : meta;
}

/**
 * Conditionally merge `actor_metadata` into a request body. Returns the
 * original body untouched when no metadata is available, so existing
 * request shapes are preserved byte-for-byte when nothing is known.
 */
export function withActorMetadata<T extends Record<string, unknown>>(
  body: T
): T | (T & { actor_metadata: ActorMetadata }) {
  const meta = buildActorMetadata();
  if (meta === undefined) return body;
  return { ...body, actor_metadata: meta };
}
