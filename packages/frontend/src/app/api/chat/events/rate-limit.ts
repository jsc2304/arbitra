/**
 * In-memory, per-instance rate limiter for `POST /api/chat/events`.
 * Lives in its own file so Next.js does not flag non-route exports in
 * route.ts (same reason `../../llm/test/rate-limit.ts` exists).
 *
 * Why in-memory, not Firestore: this gate runs BEFORE
 * `verifyChatEventToken` in `route.ts`, whose only per-request cost is a
 * local JWT signature check — `google-auth-library` fetches Google's
 * certs once per warm instance and caches them (see `oauth2client.js`'s
 * `certificateCache`/`certificateExpiry`), so verifying any token, valid
 * or garbage, does not touch the network after the first request. A
 * Firestore-backed limiter here would add a billed read+write to every
 * single request — including every legitimate Chat event — to protect an
 * operation that is already free. An in-process counter costs nothing and
 * still bounds the pre-verification work per instance.
 *
 * What this is: a per-instance backstop. Each Cloud Run instance keeps
 * its own counters, so this is NOT a global quota — an attacker rotating
 * source IPs across many instances, or a flood spread across enough
 * instances, is not stopped by it. It only protects the single container
 * that happens to receive the traffic.
 *
 * What this is not: it is not the meaningful rate limit for this
 * endpoint. Once Slice E's decision buttons exist, the limit that
 * actually matters belongs on the decision path — keyed on the verified
 * Chat identity, evaluated AFTER `verifyChatEventToken`, since that is the
 * path doing real Firestore writes and state mutation. This gate exists
 * only to keep a request flood from burning CPU on signature checks
 * before that point.
 *
 * Threshold: legitimate traffic all arrives from Google Chat's shared
 * outbound infrastructure, so every real caller lands in the same bucket
 * here (bucketed by IP, not by workspace). The ceiling has to stay well
 * above real single-workspace volume (at most a few events per second in
 * bursts) while still bounding a runaway. 600 requests / 60s = 10 req/s
 * sustained is orders of magnitude above realistic legitimate volume.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 600;

/**
 * Cap on how many source IPs are tracked at once. The endpoint is public
 * and the bucket key is the caller's address, so without a cap a flood
 * from rotating addresses grows this map without bound — the same class of
 * attacker-driven resource growth the limiter exists to bound, moved from
 * CPU to memory. At the cap the map holds at most
 * `MAX_TRACKED_IPS * RATE_LIMIT_MAX_REQUESTS` timestamps.
 */
const MAX_TRACKED_IPS = 2_000;

const requestLog = new Map<string, number[]>();

export function __resetRateLimit(): void {
  requestLog.clear();
}

/**
 * Drop buckets with nothing left inside the window, and trim the rest.
 * Called only when the map is over its cap, so the cost is amortised
 * rather than paid on every request. If every tracked bucket is still
 * live afterwards the map is cleared outright: forgetting counters lets
 * traffic through that would otherwise have been rejected, which is the
 * same fail-open direction the rest of this path takes, and it keeps
 * memory bounded regardless of how many distinct addresses appear.
 */
function evictExpired(cutoff: number): void {
  for (const [trackedIp, timestamps] of requestLog) {
    const recent = timestamps.filter((ts) => ts > cutoff);
    if (recent.length === 0) requestLog.delete(trackedIp);
    else requestLog.set(trackedIp, recent);
  }
  if (requestLog.size > MAX_TRACKED_IPS) requestLog.clear();
}

export function checkChatEventsRateLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  if (requestLog.size > MAX_TRACKED_IPS) evictExpired(cutoff);
  const existing = requestLog.get(ip) ?? [];
  const recent = existing.filter((ts) => ts > cutoff);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

/** Test hook: number of source IPs currently tracked. */
export function __trackedIpCount(): number {
  return requestLog.size;
}
