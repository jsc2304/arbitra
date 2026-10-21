/**
 * Loads ALL knowledge assets into a flat string for the helper-bot system
 * prompt. No scope filter — the bot answers platform-level questions and
 * surfaces relevant precedents/patterns regardless of org/project scope.
 *
 * Cached in-process for 60 seconds. Knowledge assets change rarely but
 * are user-editable, so we accept up to a minute of staleness in exchange
 * for amortizing the Firestore read across requests.
 */
import { collections } from '../../lib/firestore.js';

const CACHE_TTL_MS = 60_000;

let cached: string | null = null;
let cacheTimestamp = 0;
let inFlight: Promise<string> | null = null;

export async function loadKnowledgeAssets(): Promise<string> {
  const now = Date.now();
  if (cached !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cached;
  }
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<string> => {
    try {
      const snapshot = await collections.knowledgeAssets().get();
      const parts = snapshot.docs
        .map((doc) => doc.data())
        .map((asset) => `## Knowledge: ${asset.title}\n\n${asset.body}`);
      cached = parts.join('\n\n');
      cacheTimestamp = Date.now();
      return cached;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test-only: drop the cache so a fresh load can be observed. */
export function __resetKnowledgeCache(): void {
  cached = null;
  cacheTimestamp = 0;
  inFlight = null;
}
