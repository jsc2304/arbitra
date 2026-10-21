/**
 * ActorMetadata captures authoritative client/model identity for an action
 * (comment, evidence registration, etc.) when the caller is an IDE agent or
 * other automated client.
 *
 * All fields are optional. The IDE agent / MCP client populates them directly
 * on the API call — this is a parallel, authoritative channel separate from
 * any self-report signature in the payload body (e.g. comment markdown).
 *
 * Convention: `client_name` is trimmed + lowercased on ingest so downstream
 * consumers can compare without worrying about casing.
 */
export interface ActorMetadata {
  /** e.g. "cursor", "claude-code", "cline" */
  client_name?: string;
  /** e.g. "0.42.1" */
  client_version?: string;
  /** e.g. "claude-opus-4-7", "gpt-5.4", "gemini-2.0" */
  model?: string;
}

/**
 * Normalize ActorMetadata for storage: trims whitespace on all fields and
 * lowercases `client_name` + `model` so downstream consumers can dedupe
 * without worrying about casing (e.g. `"Claude-Opus-4-7"` vs
 * `"claude-opus-4-7"`). `client_version` is trimmed but NOT lowercased —
 * version strings like `v1.0` vs `V1.0` are edge-case noise we tolerate.
 *
 * Returns undefined if the result has no populated fields.
 */
export function normalizeActorMetadata(
  meta: ActorMetadata | undefined,
): ActorMetadata | undefined {
  if (!meta) return undefined;
  const out: ActorMetadata = {};
  if (typeof meta.client_name === 'string') {
    const v = meta.client_name.trim().toLowerCase();
    if (v) out.client_name = v;
  }
  if (typeof meta.client_version === 'string') {
    const v = meta.client_version.trim();
    if (v) out.client_version = v;
  }
  if (typeof meta.model === 'string') {
    const v = meta.model.trim().toLowerCase();
    if (v) out.model = v;
  }
  if (!out.client_name && !out.client_version && !out.model) return undefined;
  return out;
}
