/**
 * @file lifecycle-river-view — structural tests for readable case titles on the lifecycle river.
 *
 * Locks these guarantees:
 *   1. Desktop case-chip titles use `line-clamp-2` (no more "M…" pills).
 *   2. The chip is wrapped in a Tooltip primitive (full title + case ID
 *      visible on hover/focus). We assert the wrapper span the Tooltip
 *      primitive injects, plus the Link content.
 *   3. Mobile (<sm ≈ 640 px) renders a vertical stage accordion alongside
 *      the desktop river. We don't have access to a layout engine in jsdom
 *      so we just assert that the accordion container is rendered
 *      (Tailwind toggles visibility via `sm:hidden` / `hidden sm:block`).
 *
 * Behaviour-only tests; we do not exercise hover delays or media queries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Case } from '@arbitra/shared';
import LifecycleRiverView from '../lifecycle-river-view';

// `useAuth` drives the mobile accordion's default-expand logic. The default
// stub returns a null user (anon viewer → "open every non-empty stage"
// fallback). Individual tests override it via `mockUseAuth` to exercise the
// owned-by-current-user expansion path.
const mockUseAuth = vi.fn(() => ({ user: null as { uid: string } | null }));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => mockUseAuth(),
}));

afterEach(() => {
  mockUseAuth.mockReset();
  mockUseAuth.mockReturnValue({ user: null });
});

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_abc_123',
    title:
      'ATLAS-124 follow-up: make the CLI HTTP timeout configurable',
    description: '',
    source_type: 'jira',
    source_ref: '',
    project_id: 'proj_demo',
    repository_id: 'repo_demo',
    owner_user_id: 'usr_dev',
    status: 'open',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  } satisfies Case;
}

const projectMap = { proj_demo: 'Demo Project' };

describe('LifecycleRiverView — readable case titles', () => {
  it('renders desktop case chips with line-clamp-2 titles', () => {
    const cases = [makeCase()];
    const casesByStatus: Record<string, Case[]> = { open: cases };

    const html = renderToStaticMarkup(
      <LifecycleRiverView
        cases={cases}
        casesByStatus={casesByStatus}
        projectMap={projectMap}
        findingCounts={{}}
        activeRunsByCase={{}}
      />,
    );

    // Title text appears (no aggressive substring truncation in markup).
    expect(html).toContain('ATLAS-124');
    expect(html).toContain('make the CLI HTTP timeout configurable');
    // Title element uses the 2-line clamp utility instead of the previous single-line `truncate` class.
    expect(html).toContain('line-clamp-2');
    // The chip is wrapped in the Tooltip primitive. Assert the Tooltip's
    // structural signature in static markup: its wrapper `<span class="inline-flex">`
    // directly enclosing THIS chip's `<Link href="/cases/<id>">` anchor. Keying
    // off the chip's own href (not a bare `inline-flex`, which any flex element
    // would match) proves the Tooltip wraps this specific chip. The hover bubble
    // (`role="tooltip"`) only mounts client-side, so it is intentionally not
    // asserted in this SSR snapshot.
    expect(html).toMatch(/<span class="inline-flex"><a [^>]*href="\/cases\/case_abc_123"/);
  });

  it('renders the mobile accordion shell alongside the desktop river', () => {
    const cases = [makeCase()];
    const casesByStatus: Record<string, Case[]> = { open: cases };

    const html = renderToStaticMarkup(
      <LifecycleRiverView
        cases={cases}
        casesByStatus={casesByStatus}
        projectMap={projectMap}
        findingCounts={{}}
        activeRunsByCase={{}}
      />,
    );

    // Mobile accordion container is in the DOM (visibility toggles via
    // `sm:hidden`); presence proves the mobile branch ships.
    expect(html).toContain('data-testid="lifecycle-mobile-accordion"');
    // Stage labels render inside the accordion buttons.
    expect(html).toContain('aria-expanded');
    expect(html).toContain('Open');
  });

  it('fallback-expands every non-empty stage when no user is signed in (mobile)', () => {
    // useAuth returns a null user → no "owned" stages, so the accordion
    // falls back to "open every non-empty stage" so the view is never
    // blank-by-default. Our single "Open" stage body must therefore render.
    mockUseAuth.mockReturnValue({ user: null });
    const cases = [makeCase()];
    const casesByStatus: Record<string, Case[]> = { open: cases };

    const html = renderToStaticMarkup(
      <LifecycleRiverView
        cases={cases}
        casesByStatus={casesByStatus}
        projectMap={projectMap}
        findingCounts={{}}
        activeRunsByCase={{}}
      />,
    );

    // CaseListCard (mobile accordion body) renders the case_id in a
    // `font-mono` span underneath the title. Asserting that marker proves the
    // body expanded — distinct from the always-rendered desktop river, which
    // only emits the id via the chip's `/cases/<id>` href.
    expect(html).toMatch(/class="[^"]*font-mono[^"]*">case_abc_123</);
  });

  it('default-expands the stage owning the current user\'s case (mobile)', () => {
    // Sign in as usr_dev, who owns a case in the "Open" stage but not the
    // "In Build" stage (owned by usr_other). Because at least one stage is
    // "mine", the owned-stage path drives expansion and the fallback ("open
    // every non-empty stage") is suppressed (myStageStatuses.size > 0 → null).
    //
    // The owned "Open" stage's CaseListCard body renders the case_id inside a
    // `font-mono` span. We assert that mobile-accordion-specific marker —
    // `font-mono` for the owned case — to distinguish it from the desktop
    // river, which renders every case's id regardless of expansion state.
    mockUseAuth.mockReturnValue({ user: { uid: 'usr_dev' } });
    const owned = makeCase({ case_id: 'case_owned_1', owner_user_id: 'usr_dev' });
    const foreign = makeCase({
      case_id: 'case_foreign_2',
      owner_user_id: 'usr_other',
      status: 'in_build',
    });
    const cases = [owned, foreign];
    const casesByStatus: Record<string, Case[]> = {
      open: [owned],
      in_build: [foreign],
    };

    const html = renderToStaticMarkup(
      <LifecycleRiverView
        cases={cases}
        casesByStatus={casesByStatus}
        projectMap={projectMap}
        findingCounts={{}}
        activeRunsByCase={{}}
      />,
    );

    // CaseListCard (mobile accordion body) wraps the owned case_id in a
    // `font-mono` span. Its presence proves the owned "Open" stage expanded.
    expect(html).toMatch(/class="[^"]*font-mono[^"]*">case_owned_1</);
    // The un-owned "In Build" stage is collapsed, so its CaseListCard body is
    // NOT in the markup — i.e. no font-mono case_foreign_2. (The plain id
    // still appears in the always-rendered desktop river, so we only assert
    // the absence of the mobile-card-specific font-mono wrapper.)
    expect(html).not.toMatch(/class="[^"]*font-mono[^"]*">case_foreign_2</);
  });

  // Documented behaviour — async auth resilience.
  //
  // `StageAccordion` seeds its open/closed state from `defaultOpen` via
  // `useState`, then a `useEffect` re-opens the stage if `defaultOpen` flips
  // to `true` after a late `useAuth` resolution (Firebase auth arrives after
  // the first render). That effect cannot be exercised here: this suite uses
  // `renderToStaticMarkup`, which runs the initial render only and never fires
  // effects. The synchronous owned-stage path is covered by the test above;
  // the late-auth re-expand is verified by inspection of the
  // `useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen])`
  // guard in `lifecycle-river-view.tsx`, which only ever opens (never
  // force-collapses a stage the user expanded by hand).
});
