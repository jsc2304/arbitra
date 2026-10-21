/**
 * In-memory rate limiter used by the LLM test-ping endpoint.
 * Lives in its own file so Next.js does not flag non-route exports
 * in route.ts.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const userCallLog = new Map<string, number[]>();

export function __resetRateLimit(): void {
  userCallLog.clear();
}

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = userCallLog.get(userId) ?? [];
  const pruned = existing.filter((ts) => ts > cutoff);
  if (pruned.length >= RATE_LIMIT_MAX) {
    userCallLog.set(userId, pruned);
    return false;
  }
  pruned.push(now);
  userCallLog.set(userId, pruned);
  return true;
}
