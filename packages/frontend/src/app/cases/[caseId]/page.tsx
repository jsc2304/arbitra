'use client';

import { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { useCase } from '../../../hooks/use-case';
import { api } from '../../../lib/api-client';
import { getCasePollingInterval } from '../../../lib/case-polling';
import { CaseHeader } from '../../../components/case/case-header';
import { ActiveRunBanner } from '../../../components/case/active-run-banner';
import { CaseCockpitHero } from '../../../components/case/case-cockpit-hero';
import { BlockerStrip } from '../../../components/case/blocker-strip';
import { ProofTab, type ProofSection } from '../../../components/case/proof-tab';
import { AssistantCaseDetail } from '../../../components/case/assistant-case-detail';
import { resolveTabParam, type Tab } from './resolve-tab-param';
import { DecisionContextPanel } from '../../../components/case/decision-context-panel';
import { CommentsThread } from '../../../components/case/comments-thread';
import { EventTimeline } from '../../../components/case/event-timeline';
import { RunsPanel } from '../../../components/case/runs-panel';
import { ReviewNotApplicableAction } from '../../../components/case/review-not-applicable-action';
import { RelatedCasesPanel } from '../../../components/case/related-cases-panel';
import { Breadcrumb } from '../../../components/shared/breadcrumb';
import LoadingSpinner from '../../../components/shared/loading-spinner';
import { useProjectMap } from '../../../hooks/use-projects';
import { BOARD_VIEW_STORAGE_KEY } from '../../../lib/board-preferences';

const tabs: { id: Tab; label: string; tooltip: string }[] = [
  { id: 'proof', label: 'Proof', tooltip: 'Findings, evidence, and decisions for this case — the combined evaluation signal' },
  { id: 'runs', label: 'Runs', tooltip: 'Execution history: exploration, build, validation, and AI review runs with model and token details' },
  { id: 'comments', label: 'Comments', tooltip: 'Discussion thread between developers, reviewers, and stakeholders' },
  { id: 'timeline', label: 'Timeline', tooltip: 'Append-only audit log of all events on this case' },
  { id: 'related', label: 'Related', tooltip: 'Cases sharing the same branch, repository, project, or owner' },
];

export default function CasePage() {
  const params = useParams<{ caseId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const caseId = params.caseId;
  const { caseData, error, isLoading, mutate } = useCase(caseId);
  const projectMap = useProjectMap();
  const tabParam = searchParams.get('tab');
  const sectionParam = searchParams.get('section');
  const findingParam = searchParams.get('finding');
  const evidenceParam = searchParams.get('evidence');
  const decisionParam = searchParams.get('decision');
  const commentParam = searchParams.get('comment');
  const eventParam = searchParams.get('event');
  const { tab: initialTab, proofExpand: initialProofExpand } = resolveTabParam(
    tabParam,
    sectionParam,
  );
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  // Remount key for ProofTab — bumped whenever a legacy `?tab=findings`
  // style deep-link changes which section should be auto-expanded. Without
  // this, ProofTab's `initialExpand` would only apply on first mount and
  // subsequent in-page CTA clicks (e.g. "Provide Evidence") wouldn't
  // re-open the target section if the user had collapsed it.
  const [proofExpand, setProofExpand] = useState<ProofSection | undefined>(initialProofExpand);
  const [proofKey, setProofKey] = useState(0);

  // Sync activeTab when the `?tab=` query param changes while the page stays
  // mounted (e.g. in-page CTAs like "Provide Evidence" that `<Link>` to
  // `?tab=evidence`). Without this effect, `useState` only runs on mount and
  // subsequent URL updates would be ignored — the CTA click would change the
  // URL but not the visible tab.
  useEffect(() => {
    const { tab, proofExpand: nextExpand } = resolveTabParam(tabParam, sectionParam);
    setActiveTab((prev) => (prev === tab ? prev : tab));
    if (nextExpand) {
      setProofExpand(nextExpand);
      setProofKey((k) => k + 1);
    }
  }, [tabParam, sectionParam]);

  // Deep-link highlight: when the URL includes `finding=`, `evidence=`,
  // `decision=`, or `comment=`, scroll the matching DOM node into view and
  // apply a brief highlight pulse. Target nodes are expected to carry a
  // `data-entity-id="<id>"` attribute set by the relevant panel component.
  useEffect(() => {
    const id = findingParam ?? evidenceParam ?? decisionParam ?? commentParam ?? eventParam;
    if (!id) return;
    // Give the relevant panel a tick to render after section expansion.
    const handle = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-entity-id="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-corp-orange', 'bg-corp-orange/10');
      window.setTimeout(() => {
        el.classList.remove('ring-2', 'ring-corp-orange', 'bg-corp-orange/10');
      }, 2000);
    }, 150);
    return () => window.clearTimeout(handle);
  }, [findingParam, evidenceParam, decisionParam, commentParam, eventParam, tabParam, sectionParam]);

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    const url = tab === 'proof'
      ? `/cases/${caseId}`
      : `/cases/${caseId}?tab=${tab}`;
    router.replace(url, { scroll: false });
  }, [caseId, router]);

  // Overflow-menu state: shrink visible-tabs count until the real `<nav>`
  // stops scroll-overflowing. DOM-based convergence is more robust than
  // summing hidden-row widths — previous attempts missed async label
  // growth ("Findings" → "Findings (1)") because ResizeObserver didn't
  // fire reliably on the absolute-positioned measurement row.
  const tabNavRef = useRef<HTMLElement | null>(null);
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [splitIdx, setSplitIdx] = useState<number>(tabs.length - 1);
  const [menuOpen, setMenuOpen] = useState(false);

  // Project breadcrumb destination. Base href always points at the board with
  // the project filter applied; after mount we read the user's stored layout
  // preference and append `&layout=<value>` for `'board'` / `'lifecycle'`
  // (omitted for `'list'` because `/board` treats missing layout as list).
  // The hydration happens in a `useEffect` — NOT during render — so SSR and
  // first-paint HTML match and React doesn't flag a hydration mismatch.
  const projectId = caseData?.project_id;
  const projectBaseHref = projectId ? `/board?project_id=${projectId}` : undefined;
  const [projectHref, setProjectHref] = useState<string | undefined>(projectBaseHref);
  useEffect(() => {
    if (!projectId) {
      setProjectHref(undefined);
      return;
    }
    const base = `/board?project_id=${projectId}`;
    if (typeof window === 'undefined') {
      setProjectHref(base);
      return;
    }
    const stored = window.localStorage.getItem(BOARD_VIEW_STORAGE_KEY);
    const href =
      stored === 'board' || stored === 'lifecycle' ? `${base}&layout=${stored}` : base;
    setProjectHref(href);
  }, [projectId]);

  // Shrink loop: runs after every render. If the nav scroll-overflows, drop
  // one visible tab. State update triggers re-render, effect runs again, and
  // convergence happens in ≤ tabs.length steps.
  useLayoutEffect(() => {
    const nav = tabNavRef.current;
    if (!nav) return;
    if (nav.scrollWidth > nav.clientWidth && splitIdx > 0) {
      setSplitIdx((s) => s - 1);
    }
  });

  // Resize loop: when the viewport (or sidebar) changes the nav's available
  // width, reset to "all visible" and let the shrink loop re-converge from
  // scratch. Without the reset we would only ever shrink — tabs wouldn't
  // reappear when the user widens the window.
  useEffect(() => {
    const nav = tabNavRef.current;
    if (!nav) return;
    const ro = new ResizeObserver(() => {
      setSplitIdx(tabs.length - 1);
    });
    ro.observe(nav);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !chevronRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Eager fetches: required by the cockpit hero, blocker strip, and header that
  // render above-the-fold. All three use the same status-driven refresh cadence
  // as `useCase` so the lifecycle tracker, findings count, and evidence chips
  // stay in lockstep with the case status during the autonomous pipeline.
  const refreshInterval = getCasePollingInterval(caseData?.status);

  const { data: findingsData } = useSWR(
    caseId ? ['findings', caseId] : null,
    () => api.cases.findings(caseId),
    { refreshInterval },
  );

  const { data: eventsData } = useSWR(
    caseId ? ['events', caseId] : null,
    () => api.cases.events(caseId),
    { refreshInterval },
  );

  // Count-only fetches for runs/comments/related so the tab labels can show a
  // badge without the user having to click each tab first. Keys MUST match
  // the panel components' SWR keys exactly (`['runs', caseId]`,
  // `['comments', 'case', caseId]`, `['related', caseId]`) so the tab panels
  // reuse this cache instead of firing duplicate requests on activation.
  // Poll cadence is capped at 30s because the badges are at-a-glance only; the
  // active tab's panel retains its own faster `getCasePollingInterval` cadence.
  const countRefreshInterval = Math.max(refreshInterval, 30_000);
  const runsRefreshInterval = refreshInterval > 0 ? refreshInterval : 30_000;
  const { data: runsData } = useSWR(
    caseId ? ['runs', caseId] : null,
    () => api.runs.listForCase(caseId),
    { refreshInterval: runsRefreshInterval },
  );
  const { data: commentsData } = useSWR(
    caseId ? ['comments', 'case', caseId] : null,
    () => api.cases.comments(caseId),
    { refreshInterval: countRefreshInterval },
  );
  const { data: relatedData } = useSWR(
    caseId ? ['related', caseId] : null,
    () => api.cases.related(caseId),
    { refreshInterval: countRefreshInterval },
  );
  // Evidence + decisions fetched here so the Proof tab count reflects the
  // combined signal (findings + evidence + decisions), not findings alone.
  // Keys match the panels' own SWR keys so opening the Proof tab reuses
  // this cache rather than refiring requests.
  const { data: evidenceData } = useSWR(
    caseId ? ['evidence', caseId] : null,
    () => api.cases.evidence(caseId),
    { refreshInterval: countRefreshInterval },
  );
  const { data: decisionsData } = useSWR(
    caseId ? ['decisions', caseId] : null,
    () => api.cases.decisions(caseId),
    { refreshInterval: countRefreshInterval },
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <LoadingSpinner size="md" />
          <span className="text-sm text-gray-500">Loading case...</span>
        </div>
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-900">Failed to load case</h2>
          <p className="mt-1 text-sm text-red-600">
            {error?.message ?? 'Case not found'}
          </p>
          <a
            href="/board"
            className="mt-4 inline-block text-sm text-accent-700 hover:text-accent-800 dark:text-accent-300 dark:hover:text-accent-200"
          >
            Back to Board
          </a>
        </div>
      </div>
    );
  }

  const findings = findingsData?.findings ?? [];
  const events = eventsData?.events ?? [];
  const runsCount = runsData?.runs?.length ?? 0;
  const runs = runsData?.runs ?? [];
  const commentsCount = commentsData?.comments?.length ?? 0;
  const relatedCount =
    relatedData?.groups?.reduce((sum, g) => sum + g.cases.length, 0) ?? 0;
  const evidenceCount = evidenceData?.evidence?.length ?? 0;
  const decisionsCount = decisionsData?.decisions?.length ?? 0;
  const proofCount = findings.length + evidenceCount + decisionsCount;

  // Tab labels show `(N)` only when N > 0. Zero is intentionally rendered as
  // a bare label (no "(0)") so the counts act as a positive signal — "there
  // is content here worth clicking" — rather than as noise. Timeline has no
  // count because the event stream is always non-empty for any real case.
  function tabLabel(tab: Tab): string {
    const base = tabs.find((t) => t.id === tab)!.label;
    const count =
      tab === 'proof'
        ? proofCount
        : tab === 'runs'
        ? runsCount
        : tab === 'comments'
        ? commentsCount
        : tab === 'related'
        ? relatedCount
        : 0;
    return count > 0 ? `${base} (${count})` : base;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 md:py-5 space-y-3 md:space-y-4">
      <Breadcrumb
        items={[
          { label: 'Board', href: '/board' },
          ...(caseData.project_id
            ? [{ label: projectMap[caseData.project_id] || caseData.project_id, href: projectHref }]
            : []),
        ]}
      />
      <h1 className="mt-1 text-xl md:text-2xl font-mono font-semibold tracking-tight text-gray-900 dark:text-gray-100 break-words">
        {caseData.title}
      </h1>
      {/* Clerk tasks get a conversation-first body: the answer and thread lead,
          case-management furniture (cockpit, header, evidence, timeline,
          decisions) is demoted into a collapsed "Record" disclosure inside
          `AssistantCaseDetail`. Every other case type renders exactly as
          before — this branch does not touch that path. */}
      {caseData.case_type === 'assistant_task' ? (
        <AssistantCaseDetail
          caseData={caseData}
          events={events}
          findings={findings}
          runs={runs}
          relatedCounts={{
            evidence: evidenceCount,
            decisions: decisionsCount,
            comments: commentsCount,
            related: relatedCount,
          }}
          onTransition={() => mutate()}
        />
      ) : (
        <>
          <CaseCockpitHero caseData={caseData} findings={findings} events={events} />
          <BlockerStrip findings={findings} caseId={caseData.case_id} />
          <CaseHeader
            caseData={caseData}
            events={events}
            findings={findings}
            relatedCounts={{
              evidence: evidenceCount,
              decisions: decisionsCount,
              comments: commentsCount,
              related: relatedCount,
            }}
            onTransition={() => mutate()}
          />
          <ActiveRunBanner runs={runs} caseId={caseData.case_id} />
          <DecisionContextPanel caseId={caseData.case_id} />
        </>
      )}

      {(() => {
        const visibleTabs = tabs.slice(0, splitIdx + 1);
        const overflowTabs = tabs.slice(splitIdx + 1);
        const overflowHasActiveTab = overflowTabs.some((t) => t.id === activeTab);
        return (
          <div
            className="relative border-b border-gray-200 dark:border-border-subtle -mx-4 md:mx-0 px-4 md:px-0"
          >
            <nav ref={tabNavRef} className="flex items-center gap-0 -mb-px">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  title={tab.tooltip}
                  className={`px-3 md:px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                    activeTab === tab.id
                      ? 'border-accent text-accent-700 dark:border-accent-300 dark:text-accent-300'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  {tabLabel(tab.id)}
                </button>
              ))}
              {overflowTabs.length > 0 && (
                <div className="relative ml-auto">
                  <button
                    ref={chevronRef}
                    type="button"
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-label="More tabs"
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    className="inline-flex items-center justify-center px-2 py-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="m8.25 4.5 7.5 7.5-7.5 7.5M12 4.5l7.5 7.5-7.5 7.5"
                      />
                    </svg>
                    {overflowHasActiveTab && (
                      <span
                        className="ml-1 h-1.5 w-1.5 rounded-full bg-corp-orange"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {menuOpen && (
                    <ul
                      ref={menuRef}
                      role="menu"
                      className="absolute right-0 top-full mt-1 z-50 min-w-[12rem] rounded-md border border-gray-200 dark:border-gray-700 bg-surface-raised shadow-lg py-1"
                    >
                      {overflowTabs.map((tab) => (
                        <li key={tab.id} role="none">
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              handleTabChange(tab.id);
                              setMenuOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-sm ${
                              activeTab === tab.id
                                ? 'font-semibold text-corp-orange'
                                : 'text-gray-700 dark:text-gray-200 hover:bg-surface-base dark:hover:bg-gray-800'
                            }`}
                          >
                            {tabLabel(tab.id)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </nav>
          </div>
        );
      })()}

      <div>
        {activeTab === 'proof' && (
          <ProofTab
            key={proofKey}
            caseId={caseId}
            caseStatus={caseData.status}
            findings={findings}
            initialExpand={proofExpand ?? 'findings'}
          />
        )}
        {activeTab === 'runs' && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <ReviewNotApplicableAction
                caseId={caseId}
                caseStatus={caseData.status}
                reviewNotApplicable={caseData.review_not_applicable}
                runs={runs}
                onSuccess={() => mutate()}
              />
            </div>
            <RunsPanel caseId={caseId} />
          </div>
        )}
        {activeTab === 'comments' && (
          <CommentsThread
            caseId={caseId}
            parentType="case"
            parentId={caseId}
          />
        )}
        {activeTab === 'timeline' && (
          <EventTimeline events={events} caseId={caseId} />
        )}
        {activeTab === 'related' && (
          <RelatedCasesPanel caseId={caseId} />
        )}
      </div>
    </div>
  );
}
