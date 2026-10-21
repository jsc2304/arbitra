import type { FindingStatus, FindingVerificationStatus } from '@arbitra/shared';

/**
 * Single source of truth for finding-status badge colours (#207).
 *
 * Previously this exact map was copy-pasted into three components
 * (`findings-panel`, `courtroom/page`, `finding-card`) which drifted only
 * in class ordering. These are Tailwind utility-class strings — frontend-only,
 * no reason to live in `@arbitra/shared`.
 *
 * Keyed on the full `FindingStatus` union; the unit test in
 * `__tests__/badge-colors.test.ts` asserts every enum member has an entry so a
 * future status addition can't silently miss a colour.
 */
export const FINDING_STATUS_COLORS: Record<FindingStatus, string> = {
  open: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/50',
  accepted: 'text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/50',
  fixed: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/50',
  waived: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-800',
  contested: 'text-orange-700 bg-orange-50 dark:text-orange-400 dark:bg-orange-950/50',
  resolved: 'text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/50',
  // Agent proposed a waiver; awaiting human confirmation. Yellow = "still needs
  // a human action" (it remains a blocking status).
  waiver_proposed: 'text-yellow-700 bg-yellow-50 dark:text-yellow-400 dark:bg-yellow-950/50',
  // Proposal closed administratively at case completion. Neutral grey on
  // purpose: terminal and nothing is owed, so it must not read as a warning.
  waived_on_completion: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-800',
};

/**
 * Neutral fallback for off-list / unknown finding-status strings. Matches the
 * fallback the three call sites each duplicated inline.
 */
export const FINDING_STATUS_COLOR_FALLBACK =
  'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';

/** Resolve a finding-status colour with the neutral fallback applied. */
export function findingStatusColor(status: string): string {
  return FINDING_STATUS_COLORS[status as FindingStatus] ?? FINDING_STATUS_COLOR_FALLBACK;
}

/**
 * Colours for the AI-verifier verdict pill (`FindingVerificationStatus`).
 * Keyed on the full union; the unit test in `__tests__/badge-colors.test.ts`
 * asserts every member has an entry.
 *
 * `refuted` is the one solid/inverted pill in this map on purpose: the AI
 * verifier DISPROVED the finding, and that must not read as just another soft
 * status tint. Fill is red-700 (#B91C1C), not the corp-red token (#EE481D):
 * white on corp-red is only ~3.8:1 at text-xs, below WCAG AA; white on
 * red-700 is ~6.5:1. Same class works in both themes, so no dark: overrides.
 */
export const FINDING_VERIFICATION_COLORS: Record<FindingVerificationStatus, string> = {
  confirmed: 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/50',
  refuted: 'text-white bg-red-700',
  uncertain: 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/50',
  unverified: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-800',
};

/** Neutral fallback for off-list / unknown verification-status strings. */
export const FINDING_VERIFICATION_COLOR_FALLBACK = FINDING_STATUS_COLOR_FALLBACK;

/** Resolve a verification-status colour with the neutral fallback applied. */
export function findingVerificationColor(status: string): string {
  return (
    FINDING_VERIFICATION_COLORS[status as FindingVerificationStatus] ??
    FINDING_VERIFICATION_COLOR_FALLBACK
  );
}
