'use client';

/**
 * Showcase Dossier — flat, chronological, print-friendly rendering of a
 * single case's full audit trail. Built for reviewers (PM/BU profiles) who
 * judge a case by "cleanest audit trail / best knowledge asset / boldest use
 * case".
 *
 * Pure additive sub-route at /cases/[caseId]/dossier. Does not affect the
 * existing tabbed case detail view. Print chrome (sidebar/header/footer/
 * helper-bot) is hidden via the `dossier-print-root` class + global
 * `@media print` rules in globals.css.
 *
 * Data assembly is FE-only (no new backend route): findings, evidence,
 * decisions, comments, events, runs are fetched in parallel via the
 * existing per-case endpoints; knowledge assets are fetched once globally
 * and filtered to those linked to this case via `source_case_refs` or the
 * case's own `knowledge_context_refs`. SWR keys match the keys used by the
 * existing tabbed views so the cache is shared.
 */

import { useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import type {
  CaseEvent,
  Comment,
  Decision,
  Evidence,
  KnowledgeAsset,
} from '@arbitra/shared';
import { useCase } from '../../../../hooks/use-case';
import { useUserMap } from '../../../../hooks/use-users';
import { useProjectMap } from '../../../../hooks/use-projects';
import { useRepositoryMap } from '../../../../hooks/use-repositories';
import { api } from '../../../../lib/api-client';
import { actorDisplayName } from '../../../../lib/actor-display';
import { DECISION_TYPE_LABELS } from '../../../../lib/decision-type-labels';
import { getEvidenceLabel } from '../../../../lib/evidence-labels';
import { StatusBadge } from '../../../../components/shared/status-badge';
import { RiskBadge } from '../../../../components/shared/risk-badge';
import { TrackBadge } from '../../../../components/shared/track-badge';
import { ActorSignature } from '../../../../components/shared/actor-signature';
import { MarkdownContent } from '../../../../components/shared/markdown-content';
import { Breadcrumb } from '../../../../components/shared/breadcrumb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['done', 'rejected']);

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatElapsed(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Identify the exploration- and build-summary comments. The lifecycle routes
 * (`/api/agent/explore` and `/api/agent/build-complete`) tag their summary
 * comments structurally with `kind: 'exploration_summary' | 'build_summary'`
 * — the dossier prefers that tag (see `findSummaryByKind`).
 *
 * Backwards compatibility: comments created before the tag was introduced
 * have no `kind`. For those, we fall back to *temporal proximity* against
 * the matching lifecycle event:
 *   - exploration summary  ↔  closest ide_agent comment within ±5 min of
 *                              the latest `exploration_completed` event.
 *   - build summary        ↔  closest ide_agent comment within ±5 min of
 *                              the latest `case_ready_for_build` event.
 * The temporal fallback also acts as defense-in-depth on top of PR #504's
 * exclude-already-matched fix in case a future write path forgets the tag.
 *
 * Returns the comment_ids of the matched summary comments so the
 * "Discussion" section can filter them out.
 */
const SUMMARY_PAIR_WINDOW_MS = 5 * 60 * 1000;

function findSummaryByKind(
  comments: Comment[],
  kind: 'exploration_summary' | 'build_summary',
): Comment | undefined {
  // Newest first — if the lifecycle ran twice (rare, e.g. re-exploration),
  // the latest summary wins, matching the temporal-fallback behavior which
  // pairs against the latest matching event.
  const tagged = comments.filter((c) => c.kind === kind);
  if (tagged.length === 0) return undefined;
  return [...tagged].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
}

function findSummaryComment(
  events: CaseEvent[],
  comments: Comment[],
  eventType: string,
  excludeIds?: ReadonlySet<string>,
): Comment | undefined {
  const evt = [...events]
    .filter((e) => e.type === eventType)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  if (!evt) return undefined;
  const target = new Date(evt.created_at).getTime();
  let best: Comment | undefined;
  let bestDelta = Infinity;
  for (const c of comments) {
    if (c.source !== 'ide_agent') continue;
    if (excludeIds?.has(c.comment_id)) continue;
    const delta = Math.abs(new Date(c.created_at).getTime() - target);
    if (delta < bestDelta && delta <= SUMMARY_PAIR_WINDOW_MS) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DossierPage() {
  const params = useParams<{ caseId: string }>();
  const caseId = params.caseId;
  const { caseData, error, isLoading } = useCase(caseId);

  // Scope the global @media print rule in globals.css to this route only.
  // Without this flag, hitting Cmd+P on any other page would render blank
  // because globals.css hides everything outside `.dossier-print-root`.
  useEffect(() => {
    document.body.classList.add('dossier-route');
    return () => {
      document.body.classList.remove('dossier-route');
    };
  }, []);

  // Parallel fetches — keys match the case-detail page so cache is shared.
  const { data: eventsData } = useSWR(
    caseId ? ['events', caseId] : null,
    () => api.cases.events(caseId),
  );
  const { data: evidenceData } = useSWR(
    caseId ? ['evidence', caseId] : null,
    () => api.cases.evidence(caseId),
  );
  const { data: decisionsData } = useSWR(
    caseId ? ['decisions', caseId] : null,
    () => api.cases.decisions(caseId),
  );
  const { data: commentsData } = useSWR(
    caseId ? ['comments', 'case', caseId] : null,
    () => api.cases.comments(caseId),
  );
  const { data: knowledgeData } = useSWR(
    caseId ? ['knowledge', 'all-for-dossier'] : null,
    () => api.knowledge.list(),
  );

  const projectMap = useProjectMap();
  const repoMap = useRepositoryMap();

  const events = eventsData?.events ?? [];
  const evidence = evidenceData?.evidence ?? [];
  const decisions = decisionsData?.decisions ?? [];
  const comments = commentsData?.comments ?? [];
  const allKnowledge = knowledgeData?.assets ?? [];

  // Resolve user names for all actors that appear in the dossier.
  const actorIds = useMemo(() => {
    const ids = new Set<string>();
    if (caseData?.owner_user_id) ids.add(caseData.owner_user_id);
    if (caseData?.assigned_reviewer_id) ids.add(caseData.assigned_reviewer_id);
    for (const d of decisions) ids.add(d.actor_id);
    for (const e of evidence) ids.add(e.created_by);
    for (const c of comments) ids.add(c.author_id);
    for (const e of events) {
      if (e.actor_id) ids.add(e.actor_id);
    }
    return [...ids].filter((id) => id && !id.startsWith('system') && !id.startsWith('system:'));
  }, [caseData, decisions, evidence, comments, events]);
  const userMap = useUserMap(actorIds);

  // Identify summary comments so the Discussion section can exclude them.
  // Prefer the structural `kind` tag set by the lifecycle routes; fall back
  // to temporal pairing for legacy comments that pre-date the tag (or any
  // future write path that forgets it). When falling back, exclude the
  // already-matched exploration comment from the build-summary candidate
  // pool so a single ide_agent comment posted between two tightly-spaced
  // lifecycle events doesn't render under both headings (PR #504).
  const exploreSummary = useMemo(
    () =>
      findSummaryByKind(comments, 'exploration_summary')
      ?? findSummaryComment(events, comments, 'exploration_completed'),
    [events, comments],
  );
  const buildSummary = useMemo(
    () =>
      findSummaryByKind(comments, 'build_summary')
      ?? findSummaryComment(
        events,
        comments,
        'case_ready_for_build',
        exploreSummary ? new Set([exploreSummary.comment_id]) : undefined,
      ),
    [events, comments, exploreSummary],
  );
  const summaryIds = new Set(
    [exploreSummary?.comment_id, buildSummary?.comment_id].filter(Boolean) as string[],
  );

  // Knowledge assets linked to this case: either source_case_refs includes
  // caseId, or case.knowledge_context_refs references the asset id.
  const linkedKnowledge: KnowledgeAsset[] = useMemo(() => {
    if (!caseData) return [];
    const contextRefs = new Set(caseData.knowledge_context_refs ?? []);
    return allKnowledge.filter(
      (k) => k.source_case_refs?.includes(caseId) || contextRefs.has(k.knowledge_id),
    );
  }, [allKnowledge, caseData, caseId]);

  // Audit metrics.
  const metrics = useMemo(() => {
    if (!caseData) return null;
    const decisionsWithRationale = decisions.filter(
      (d) => d.rationale && d.rationale.trim().length > 0,
    ).length;
    const terminalEvent = events.find(
      (e) => e.type === 'case_completed' || e.type === 'case_rejected',
    );
    const terminalIso = terminalEvent?.created_at ?? null;
    const stillActive = !TERMINAL_STATUSES.has(caseData.status);
    return {
      evidenceCount: evidence.length,
      decisionsCount: decisions.length,
      decisionsWithRationale,
      knowledgeCount: linkedKnowledge.length,
      commentsCount: comments.filter((c) => !summaryIds.has(c.comment_id)).length,
      elapsed: formatElapsed(caseData.created_at, terminalIso) + (stillActive ? ' (active)' : ''),
    };
  }, [caseData, evidence, decisions, comments, linkedKnowledge, events, summaryIds]);

  if (isLoading) {
    return (
      <div className="dossier-print-root flex items-center justify-center min-h-[60vh]">
        <span className="text-sm text-gray-500">Loading dossier...</span>
      </div>
    );
  }

  if (error || !caseData) {
    return (
      <div className="dossier-print-root flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Failed to load case</h2>
          <p className="mt-1 text-sm text-red-600">
            {error?.message ?? 'Case not found'}
          </p>
          <Link href="/board" className="mt-4 inline-block text-sm text-accent-700">
            Back to Board
          </Link>
        </div>
      </div>
    );
  }

  // Data slicing for the body.
  const evidenceRegisteredEvents = events.filter((e) => e.type === 'evidence_registered');
  const evidenceById = new Map(evidence.map((e) => [e.evidence_id, e]));

  // Group evidence by type, preserving chronological order within each group.
  const evidenceByType = new Map<string, Evidence[]>();
  for (const e of [...evidence].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )) {
    const arr = evidenceByType.get(e.type) ?? [];
    arr.push(e);
    evidenceByType.set(e.type, arr);
  }

  // Decisions chronological (oldest → newest) — pair manual_track approve+
  // manual_validation_confirmed when adjacent and same actor within 5s,
  // mirroring DecisionHistory's grouping.
  const decisionsChrono = [...decisions].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const PAIR_WINDOW = 5000;
  type DecisionEntry =
    | { kind: 'single'; decision: Decision }
    | { kind: 'pair'; approve: Decision; validation: Decision };
  const decisionEntries: DecisionEntry[] = [];
  for (let i = 0; i < decisionsChrono.length; i++) {
    const cur = decisionsChrono[i]!;
    const next = decisionsChrono[i + 1];
    if (
      next &&
      cur.type === 'approve' &&
      next.type === 'manual_validation_confirmed' &&
      cur.actor_id === next.actor_id &&
      Math.abs(new Date(cur.created_at).getTime() - new Date(next.created_at).getTime()) < PAIR_WINDOW
    ) {
      decisionEntries.push({ kind: 'pair', approve: cur, validation: next });
      i++;
    } else {
      decisionEntries.push({ kind: 'single', decision: cur });
    }
  }

  // Comments chronological, summaries removed.
  const discussionComments = [...comments]
    .filter((c) => !summaryIds.has(c.comment_id))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const projectName = projectMap[caseData.project_id] ?? caseData.project_id;
  const repoInfo = repoMap[caseData.repository_id];
  const repoLabel = repoInfo?.name ?? caseData.repository_id;
  const repoUrl = repoInfo?.url;
  const prUrl =
    caseData.current_pr_ref && /^https?:\/\//.test(caseData.current_pr_ref)
      ? caseData.current_pr_ref
      : undefined;

  return (
    <div className="dossier-print-root max-w-6xl mx-auto px-4 md:px-8 py-6 print:p-0 print:max-w-none">
      {/* On-screen breadcrumb + actions; hidden in print. */}
      <div className="print:hidden flex items-center justify-between gap-3 mb-4">
        <Breadcrumb
          items={[
            { label: 'Board', href: '/board' },
            { label: caseData.title, href: `/cases/${caseId}` },
            { label: 'Dossier' },
          ]}
        />
        <div className="flex items-center gap-2">
          <Link
            href={`/cases/${caseId}`}
            className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            Back to Case
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800"
          >
            Print / Save PDF
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-6 print:block">
        {/* ───── Main story column ───── */}
        <article className="min-w-0 space-y-8">
          {/* 1. Header */}
          <header className="border-b border-gray-200 dark:border-border-subtle pb-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span className="font-mono break-all">{caseData.case_id}</span>
              <span>·</span>
              <span className="print-keep-color"><StatusBadge status={caseData.status} /></span>
              <span>·</span>
              <span className="print-keep-color"><RiskBadge level={caseData.risk_level} /></span>
              <span>·</span>
              <span className="print-keep-color"><TrackBadge track={caseData.validation_track} /></span>
            </div>
            <h1 className="text-2xl md:text-3xl font-mono font-semibold tracking-tight text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
              {caseData.title}
            </h1>
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <DefRow label="Project" value={projectName} />
              <DefRow
                label="Repository"
                value={
                  repoUrl ? (
                    <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="text-accent-700 dark:text-accent-300 hover:underline break-all">
                      {repoLabel}
                    </a>
                  ) : (
                    repoLabel
                  )
                }
              />
              <DefRow
                label="Branch"
                value={caseData.current_branch ? <code className="font-mono text-xs break-all">{caseData.current_branch}</code> : '—'}
              />
              <DefRow
                label="PR"
                value={
                  prUrl ? (
                    <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-accent-700 dark:text-accent-300 hover:underline break-all">
                      {prUrl}
                    </a>
                  ) : (
                    caseData.current_pr_ref || '—'
                  )
                }
              />
              <DefRow label="Owner" value={resolveActorLabel(caseData.owner_user_id, undefined, userMap)} />
              {caseData.assigned_reviewer_id && (
                <DefRow label="Reviewer" value={resolveActorLabel(caseData.assigned_reviewer_id, undefined, userMap)} />
              )}
              <DefRow label="Created" value={formatTimestamp(caseData.created_at)} />
              <DefRow
                label={TERMINAL_STATUSES.has(caseData.status) ? 'Closed' : 'Updated'}
                value={formatTimestamp(caseData.updated_at)}
              />
            </dl>
          </header>

          {/* 2. Description */}
          <Section title="Description" subtitle="Why this case exists">
            {caseData.description ? (
              <MarkdownContent>{caseData.description}</MarkdownContent>
            ) : (
              <Empty>No description provided.</Empty>
            )}
          </Section>

          {/* 3. Exploration summary */}
          <Section title="Exploration Summary" subtitle="What was investigated and planned">
            {exploreSummary ? (
              <SummaryBlock comment={exploreSummary} userMap={userMap} />
            ) : (
              <Empty>No exploration summary recorded.</Empty>
            )}
          </Section>

          {/* 4. Build summary */}
          <Section title="Build Summary" subtitle="What was implemented">
            {buildSummary ? (
              <SummaryBlock comment={buildSummary} userMap={userMap} />
            ) : (
              <Empty>No build summary recorded.</Empty>
            )}
          </Section>

          {/* 5. Evidence */}
          <Section
            title="Evidence"
            subtitle={`${evidence.length} item${evidence.length === 1 ? '' : 's'} registered`}
          >
            {evidence.length === 0 ? (
              <Empty>No evidence registered.</Empty>
            ) : (
              <div className="space-y-5">
                {[...evidenceByType.entries()].map(([type, items]) => (
                  <div key={type}>
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                      {getEvidenceLabel(type)}{' '}
                      <span className="text-xs font-normal text-gray-400">({items.length})</span>
                    </h3>
                    <ul className="space-y-2">
                      {items.map((e) => (
                        <li
                          key={e.evidence_id}
                          className="border border-gray-200 dark:border-border-subtle rounded-md px-3 py-2 break-inside-avoid"
                        >
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-gray-900 dark:text-gray-100">
                                {e.summary || <span className="text-gray-400 italic">No summary</span>}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                                <span>Source: {e.source_type}</span>
                                {e.machine_readable && (
                                  <span className="print-keep-color inline-flex items-center rounded bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5">
                                    machine-readable
                                  </span>
                                )}
                                <span>{formatTimestamp(e.created_at)}</span>
                                <span className="inline-flex items-center gap-1.5">
                                  <span>{resolveActorLabel(e.created_by, e.actor_metadata, userMap)}</span>
                                  <ActorSignature meta={e.actor_metadata} />
                                </span>
                                <Link
                                  href={`/cases/${caseId}?tab=dossier&section=evidence&evidence=${e.evidence_id}`}
                                  className="print:hidden text-secondary-600 dark:text-secondary-400 hover:text-secondary-700 dark:hover:text-secondary-300 hover:underline"
                                >
                                  View evidence →
                                </Link>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {/* Surface any evidence_registered events that did not resolve to
                    a current evidence row (rare — cleanup or expired). */}
                {evidenceRegisteredEvents.length > evidence.length && (
                  <p className="text-xs text-gray-400 italic">
                    {evidenceRegisteredEvents.length - evidence.length} additional historical evidence event(s) not shown.
                  </p>
                )}
              </div>
            )}
          </Section>

          {/* 6. Decisions */}
          <Section
            title="Decisions"
            subtitle={`${decisions.length} decision${decisions.length === 1 ? '' : 's'} filed`}
          >
            {decisions.length === 0 ? (
              <Empty>No decisions filed.</Empty>
            ) : (
              <ol className="space-y-3">
                {decisionEntries.map((entry, idx) => (
                  <li key={idx} className="break-inside-avoid">
                    {entry.kind === 'single' ? (
                      <DecisionRow decision={entry.decision} userMap={userMap} caseId={caseId} />
                    ) : (
                      <DecisionRow
                        decision={entry.approve}
                        pairValidation={entry.validation}
                        userMap={userMap}
                        caseId={caseId}
                      />
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {/* 7. Discussion */}
          <Section
            title="Discussion"
            subtitle={`${discussionComments.length} comment${discussionComments.length === 1 ? '' : 's'} (excludes summaries above)`}
          >
            {discussionComments.length === 0 ? (
              <Empty>No discussion threads on this case.</Empty>
            ) : (
              <ol className="space-y-4">
                {discussionComments.map((c) => (
                  <li
                    key={c.comment_id}
                    className="break-inside-avoid border-l-2 border-gray-200 dark:border-border-subtle pl-4"
                  >
                    <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-1">
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        {resolveActorLabel(c.author_id, c.actor_metadata, userMap)}
                      </span>
                      <ActorSignature meta={c.actor_metadata} />
                      <span>·</span>
                      <span>{formatTimestamp(c.created_at)}</span>
                    </div>
                    <MarkdownContent>{c.body}</MarkdownContent>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {/* 8. Knowledge */}
          <Section
            title="Knowledge"
            subtitle={`${linkedKnowledge.length} asset${linkedKnowledge.length === 1 ? '' : 's'} linked to or produced by this case`}
          >
            {linkedKnowledge.length === 0 ? (
              <Empty>No knowledge assets linked.</Empty>
            ) : (
              <ul className="space-y-3">
                {linkedKnowledge.map((k) => (
                  <li
                    key={k.knowledge_id}
                    className="border border-gray-200 dark:border-border-subtle rounded-md px-3 py-2 break-inside-avoid"
                  >
                    <div className="flex items-baseline justify-between gap-3 flex-wrap">
                      <Link
                        href={`/knowledge/${k.knowledge_id}`}
                        className="text-sm font-semibold text-accent-700 dark:text-accent-300 hover:underline"
                      >
                        {k.title}
                      </Link>
                      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span className="uppercase tracking-wide">{k.type.replace(/_/g, ' ')}</span>
                        <span>·</span>
                        <span>{k.status}</span>
                      </div>
                    </div>
                    {k.summary && (
                      <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{k.summary}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Mobile / print metrics block — sidebar duplicates this for desktop.
              `print:block` forces this block visible in print regardless of
              viewport width, since browsers commonly evaluate print preview
              at letter/A4 as `lg` (which would otherwise hide it via `lg:hidden`)
              while the sidebar is `print:hidden` — leaving the print artifact
              with no metrics at all. */}
          {metrics && (
            <Section title="Audit Metrics" subtitle="Audit trail summary" className="lg:hidden print:block">
              <MetricsList metrics={metrics} />
            </Section>
          )}
        </article>

        {/* ───── Sidebar (desktop) — duplicates Audit Metrics so they're
              always visible while scrolling. Hidden in print (the in-flow
              "Audit Metrics" section above takes over for print layout). */}
        <aside className="hidden lg:block print:hidden">
          {metrics && (
            <div className="sticky top-4 space-y-4">
              <div className="border border-gray-200 dark:border-border-subtle rounded-lg p-4 bg-surface-raised">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
                  Audit Metrics
                </h2>
                <MetricsList metrics={metrics} />
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  subtitle,
  className = '',
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`break-inside-avoid ${className}`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {subtitle && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{subtitle}</p>
      )}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function DefRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100 break-words">{value}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-gray-400 dark:text-gray-500 italic">{children}</p>
  );
}

function SummaryBlock({
  comment,
  userMap,
}: {
  comment: Comment;
  userMap: Record<string, { display_name?: string | null; email?: string | null }>;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-2">
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {resolveActorLabel(comment.author_id, comment.actor_metadata, userMap)}
        </span>
        <ActorSignature meta={comment.actor_metadata} />
        <span>·</span>
        <span>{formatTimestamp(comment.created_at)}</span>
      </div>
      <MarkdownContent>{comment.body}</MarkdownContent>
    </div>
  );
}

function DecisionRow({
  decision,
  pairValidation,
  userMap,
  caseId,
}: {
  decision: Decision;
  pairValidation?: Decision;
  userMap: Record<string, { display_name?: string | null; email?: string | null }>;
  caseId: string;
}) {
  const cfg = DECISION_TYPE_LABELS[decision.type] ?? {
    label: decision.type,
    className: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-800',
  };
  const isApprove = decision.type === 'approve' || decision.type === 'auto_approve';
  const isReject = decision.type === 'reject';
  const accentBorder = isApprove
    ? 'border-l-corp-green'
    : isReject
    ? 'border-l-corp-red'
    : 'border-l-gray-300 dark:border-l-gray-600';
  return (
    <div className={`print-keep-border border-l-4 ${accentBorder} bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-r-md px-3 py-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`print-keep-color inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}
        >
          {cfg.label}
        </span>
        {pairValidation && (
          <span className="print-keep-color inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-secondary-700 dark:text-secondary-300 bg-secondary-50 dark:bg-secondary-950/50">
            + Manual validation confirmed
          </span>
        )}
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {formatTimestamp(decision.created_at)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <span>by {resolveActorLabel(decision.actor_id, decision.actor_metadata, userMap)}</span>
        <ActorSignature meta={decision.actor_metadata} />
        {decision.self_approved && (
          <span className="print-keep-color inline-flex items-center rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 text-[10px] uppercase">
            self-approved
          </span>
        )}
      </div>
      {decision.rationale && decision.rationale.trim().length > 0 && (
        <div className="mt-2">
          <MarkdownContent>{decision.rationale}</MarkdownContent>
        </div>
      )}
      {decision.finding_id && (
        <div className="mt-2 print:hidden">
          <Link
            href={`/cases/${caseId}?tab=dossier&section=findings&finding=${decision.finding_id}`}
            className="text-xs text-secondary-600 dark:text-secondary-400 hover:text-secondary-700 dark:hover:text-secondary-300 hover:underline"
          >
            View finding →
          </Link>
        </div>
      )}
    </div>
  );
}

interface Metrics {
  evidenceCount: number;
  decisionsCount: number;
  decisionsWithRationale: number;
  knowledgeCount: number;
  commentsCount: number;
  elapsed: string;
}

function MetricsList({ metrics }: { metrics: Metrics }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Evidence items', metrics.evidenceCount],
    ['Decisions', metrics.decisionsCount],
    [
      'Decisions w/ rationale',
      `${metrics.decisionsWithRationale} / ${metrics.decisionsCount}`,
    ],
    ['Knowledge assets', metrics.knowledgeCount],
    ['Comments', metrics.commentsCount],
    ['Elapsed', metrics.elapsed],
  ];
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-1 gap-y-2 gap-x-4 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <dt className="text-xs text-gray-500 dark:text-gray-400">{k}</dt>
          <dd className="font-mono text-sm text-gray-900 dark:text-gray-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// Resolve a display label for an actor id, preferring actor_metadata.client_name
// when present (mirrors the rest of the app), falling back to userMap, then to
// system / raw-id heuristics in actorDisplayName.
function resolveActorLabel(
  actorId: string | undefined,
  meta: import('@arbitra/shared').ActorMetadata | undefined,
  userMap: Record<string, { display_name?: string | null; email?: string | null }>,
): string {
  const user = actorId ? userMap[actorId] : undefined;
  const resolved = user?.display_name || user?.email || undefined;
  return actorDisplayName(actorId, meta, resolved ?? undefined).label;
}
