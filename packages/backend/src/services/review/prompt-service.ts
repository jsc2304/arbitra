/**
 * PromptService — Versioned prompt resolution with Firestore + hardcoded fallback.
 *
 * Follows the same 5-minute TTL caching pattern as llm-provider.ts.
 * When a Firestore-managed prompt template exists for a slug, it is used.
 * Otherwise, the hardcoded default from default-prompts.ts is returned.
 */

import { DEFAULT_PROMPTS } from './default-prompts.js';

interface CachedPrompt {
  content: string;
  version: string;
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedPrompt>();

export class PromptService {
  /**
   * Get the active prompt for a slug.
   * Falls back to the hardcoded default if no Firestore template is active.
   */
  async getPrompt(slug: string): Promise<{ content: string; version: string }> {
    // 1. Check cache
    const now = Date.now();
    const cached = cache.get(slug);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return { content: cached.content, version: cached.version };
    }

    // 2. Query Firestore for the active template
    try {
      const { collections } = await import('../../lib/firestore.js');
      const snapshot = await collections
        .promptTemplates()
        .where('slug', '==', slug)
        .where('is_active', '==', true)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0]!;
        const template = doc.data();
        const version = `${slug}:v${template.version}`;
        cache.set(slug, { content: template.content, version, timestamp: now });
        return { content: template.content, version };
      }
    } catch {
      // Firestore unavailable (e.g. demo mode) — fall through to default
    }

    // 3. Return hardcoded default
    const defaultPrompt = DEFAULT_PROMPTS[slug];
    if (defaultPrompt) {
      const version = `${slug}:hardcoded`;
      // Cache the default too to avoid repeated Firestore misses
      cache.set(slug, { content: defaultPrompt.content, version, timestamp: now });
      return { content: defaultPrompt.content, version };
    }

    // 4. Unknown slug — return empty with unknown version
    return { content: '', version: `${slug}:unknown` };
  }

  /** Invalidate cache for a specific slug, or all slugs if none specified. */
  static invalidateCache(slug?: string): void {
    if (slug) {
      cache.delete(slug);
    } else {
      cache.clear();
    }
  }
}

/** Standalone cache invalidation function (for API route imports). */
export function invalidatePromptCache(slug?: string): void {
  PromptService.invalidateCache(slug);
}
