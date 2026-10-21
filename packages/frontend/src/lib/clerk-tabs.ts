/**
 * `/clerk` tab definitions (#832 slice 1).
 *
 * Kept out of `app/clerk/page.tsx` on purpose: a Next.js App Router page
 * file may only export the whitelisted page fields (`default`, `metadata`,
 * `generateStaticParams`, …) — anything else fails `next build`'s page-type
 * validation ("... is not a valid Page export field"), even though `tsc`
 * and node-only unit tests never run that check. `resolveClerkTab` needs to
 * be imported by `page.test.tsx` directly, so it — and the type/constant it
 * depends on — live here instead of being exported from the page.
 */

/** `ask` is the default and the only tab that existed before Context. */
export type ClerkTab = 'ask' | 'context' | 'scheduled';

/**
 * The `scheduled` tab (task blueprints, #793 slice B3) landed as exactly the
 * one-entry addition this array's own doc comment anticipated — no rewrite
 * of the page's tab-bar or conditional render, which keys on `tab.key` from
 * this array rather than hardcoding an `ask`-or-`context` branch.
 */
export const CLERK_TABS: { key: ClerkTab; label: string }[] = [
  { key: 'ask', label: 'Ask' },
  { key: 'context', label: 'Context' },
  { key: 'scheduled', label: 'Scheduled' },
];

const VALID_TABS: ClerkTab[] = CLERK_TABS.map((tab) => tab.key);

/**
 * The `?tab=` query param wins when it names a real tab (deep-linkable, same
 * pattern as `settings/page.tsx`); anything else — absent, unknown,
 * mistyped — falls back to `ask`, the tab this page had before Context
 * existed.
 */
export function resolveClerkTab(tabParam: string | null): ClerkTab {
  return tabParam && VALID_TABS.includes(tabParam as ClerkTab) ? (tabParam as ClerkTab) : 'ask';
}
