import type { KnowledgeAsset, KnowledgeStatus, KnowledgeType } from '@arbitra/shared';

/**
 * Knowledge-asset types that carry review-relevant guidance. Only these are
 * injected into the review prompt. `implementation_note` and `mock_template`
 * are authoring aids, not review guidance, so they are excluded.
 */
export const REVIEW_KNOWLEDGE_TYPES: readonly KnowledgeType[] = [
  'review_guideline',
  'precedent',
  'anti_pattern',
  'architecture_decision',
  'exception_policy',
];

/** Only human-trusted assets steer the reviewer; 'suggested' is agent-authored and unreviewed. */
const ELIGIBLE_STATUSES = new Set<KnowledgeStatus>(['verified', 'canonical']);

/** Token discipline: hard cap on the number of assets injected, mirroring MAX_PROMPT_FINDINGS=20. */
export const MAX_PROMPT_ASSETS = 8;

/** Per-asset body truncation length (chars). */
export const MAX_ASSET_BODY_CHARS = 2000;

/** Overall budget (chars of asset bodies) across all injected assets. */
export const MAX_ASSETS_BODY_BUDGET_CHARS = 12_000;

const TRUNCATION_SUFFIX = '… [truncated]';

function truncateBody(body: string): string {
  if (body.length <= MAX_ASSET_BODY_CHARS) return body;
  return body.slice(0, MAX_ASSET_BODY_CHARS) + TRUNCATION_SUFFIX;
}

/**
 * Filter, rank, and cap the candidate knowledge assets for injection into a
 * review prompt. Pure — no I/O — so the selection policy is unit-testable in
 * isolation (mirrors the exported `classifyFindingOrigin` pattern).
 *
 * Filtering:
 *   - status ∈ {verified, canonical} (never suggested/deprecated/superseded)
 *   - type ∈ REVIEW_KNOWLEDGE_TYPES
 *   - not expired (expires_at in the past, relative to `now`)
 *   - non-empty body (whitespace-only rows exist in real data)
 *
 * Ranking + caps (token discipline):
 *   - sort by trust_level desc, then updated_at desc
 *   - at most MAX_PROMPT_ASSETS assets
 *   - each body truncated to MAX_ASSET_BODY_CHARS
 *   - stop adding once the summed body length exceeds MAX_ASSETS_BODY_BUDGET_CHARS
 *
 * Returned assets carry truncated bodies, ready to inject verbatim.
 */
export function selectReviewKnowledge(
  candidates: KnowledgeAsset[],
  now: Date = new Date(),
): KnowledgeAsset[] {
  const nowMs = now.getTime();

  const eligible = candidates.filter((asset) => {
    if (!ELIGIBLE_STATUSES.has(asset.status)) return false;
    if (!REVIEW_KNOWLEDGE_TYPES.includes(asset.type)) return false;
    if (asset.expires_at) {
      const expiresMs = new Date(asset.expires_at).getTime();
      // Guard against unparseable expiry dates — treat NaN as non-expiring.
      if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) return false;
    }
    if (!asset.body || asset.body.trim().length === 0) return false;
    return true;
  });

  eligible.sort((a, b) => {
    if (b.trust_level !== a.trust_level) return b.trust_level - a.trust_level;
    return b.updated_at.localeCompare(a.updated_at);
  });

  const selected: KnowledgeAsset[] = [];
  let bodyBudget = 0;
  for (const asset of eligible) {
    if (selected.length >= MAX_PROMPT_ASSETS) break;
    const body = truncateBody(asset.body);
    // Strict priority order, deliberate: `eligible` is already sorted highest-
    // trust/most-recent first, so once the running total would exceed budget,
    // stop rather than `continue` — a smaller lower-priority asset must never
    // displace a larger higher-priority one that didn't fit.
    if (bodyBudget + body.length > MAX_ASSETS_BODY_BUDGET_CHARS) break;
    bodyBudget += body.length;
    selected.push({ ...asset, body });
  }

  return selected;
}
