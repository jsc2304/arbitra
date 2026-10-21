import type { ProofSection } from '../../../components/case/proof-tab';

export type Tab = 'proof' | 'runs' | 'comments' | 'timeline' | 'related';

export const TAB_IDS: readonly Tab[] = ['proof', 'runs', 'comments', 'timeline', 'related'];

// Legacy `?tab=` values that now resolve to the Proof tab with a specific
// accordion section auto-expanded. Preserves all existing deep-links
// (blocker strip, cockpit hero CTAs, next-action CTAs, bookmarks).
const LEGACY_PROOF_TABS: Record<string, ProofSection> = {
  findings: 'findings',
  evidence: 'evidence',
  decisions: 'decisions',
};

const SECTION_VALUES: Record<string, ProofSection> = {
  findings: 'findings',
  evidence: 'evidence',
  decisions: 'decisions',
};

export function resolveTabParam(
  raw: string | null,
  section: string | null,
): { tab: Tab; proofExpand?: ProofSection } {
  // Both `?tab=proof` (canonical) and `?tab=dossier` (legacy alias kept for
  // existing deep-links from the standalone print page and old bookmarks)
  // route to the Proof tab. An explicit `?section=` always wins, used by
  // activity-feed deep-links like `?tab=proof&section=findings&finding=<id>`.
  if ((raw === 'proof' || raw === 'dossier') && section && section in SECTION_VALUES) {
    return { tab: 'proof', proofExpand: SECTION_VALUES[section] };
  }
  if (!raw) return { tab: 'proof', proofExpand: 'findings' };
  if (raw === 'dossier') {
    return { tab: 'proof', proofExpand: 'findings' };
  }
  if (raw in LEGACY_PROOF_TABS) {
    return { tab: 'proof', proofExpand: LEGACY_PROOF_TABS[raw] };
  }
  if (TAB_IDS.includes(raw as Tab)) {
    return { tab: raw as Tab, proofExpand: raw === 'proof' ? 'findings' : undefined };
  }
  return { tab: 'proof', proofExpand: 'findings' };
}
