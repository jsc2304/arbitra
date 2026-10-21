/**
 * Device-flow grant per RFC 8628.
 *
 * A doc in the `device_codes` collection. The Firestore document id is
 * `sha256(device_code)` (hex) — the raw `device_code` is **never** persisted.
 * The hash is the only thing the polling endpoint can present, and we look up
 * by hash.
 *
 * Lifecycle:
 *   pending  → approved → consumed
 *               └─ denied (Cancel button or 3-strike slow-down)
 *               └─ expired (cleaned by Firestore TTL on `expires_at`)
 *
 * See `docs/specs/device-flow-and-per-tool-tokens.md` §C.2.
 */
export type DeviceCodeStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface DeviceCode {
  /** Human-readable code shown in the IDE prompt, format `XXXX-XXXX` from the unambiguous alphabet. */
  user_code: string;
  status: DeviceCodeStatus;

  /** Normalized MCP client name, e.g. 'cursor', 'claude-code'. Lowercased + non-alphanumerics → '-'. */
  client_name: string;
  /** Free-text client version, optional. */
  client_version?: string;
  /** Human-friendly device label. Defaults to 'Unknown device' if not supplied. */
  device_label: string;
  /** Stable per-machine hash, sha256(hostname+mac) → 16 hex chars. Optional. */
  device_id?: string;

  /** Raw `git remote get-url origin` if the MCP client could find one. */
  repo_url?: string;
  /** Basename hint from the MCP client. */
  repo_name?: string;

  /** Set by `/api/auth/connect/approve` once the user confirms in the browser. */
  user_id?: string;
  /** Project the user picked on the confirm page. */
  project_id?: string;
  /** ISO timestamp of the approve click. */
  approved_at?: string;

  /** ISO timestamp of the last poll. Used for slow-down enforcement. */
  last_polled_at?: string;
  /** Current min poll interval (seconds). Starts at 5, +5s per slow-down strike. */
  poll_interval_seconds: number;
  /** Number of times the caller polled faster than `poll_interval_seconds`. 3 → access_denied. */
  slow_down_strikes: number;

  /** ISO timestamp, `created_at + 600s`. Firestore TTL policy keys off this field. */
  expires_at: string;
  created_at: string;
}
