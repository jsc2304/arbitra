'use client';

import { isBlockingFindingStatus, type Finding, type FindingStatus } from '@arbitra/shared';
import { SeverityBadge } from '../shared/severity-badge';
import { MarkdownContent } from '../shared/markdown-content';
import { FindingStatusBadge } from '../shared/finding-status-badge';
import { FindingVerificationBadge } from '../shared/finding-verification-badge';

/** Background tint applied to the entire card when a decision has been made. */
const decisionTints: Partial<Record<FindingStatus, string>> = {
  accepted: 'bg-blue-500/5 dark:bg-blue-400/5',
  fixed: 'bg-emerald-500/5 dark:bg-emerald-400/5',
  waived: 'bg-amber-500/5 dark:bg-amber-400/5',
  contested: 'bg-orange-500/5 dark:bg-orange-400/5',
  resolved: 'bg-emerald-500/5 dark:bg-emerald-400/5',
  waiver_proposed: 'bg-yellow-500/5 dark:bg-yellow-400/5',
  waived_on_completion: 'bg-gray-500/5 dark:bg-gray-400/5',
};

/**
 * Foreground status badge for terminal/decided findings. Replaces the
 * earlier faded-watermark "stamp" — user feedback called out that the watermark
 * read as background noise. Now: solid amber/blue/emerald pill at the
 * top-right header position so the state is unmissable. Color tokens
 * mirror the existing decision/finding-status palette so dark mode and
 * light mode match.
 */
const statusBadgeConfig: Partial<Record<FindingStatus, { label: string; classes: string }>> = {
  waived: {
    label: 'WAIVED',
    classes:
      'bg-amber-500 text-white dark:bg-amber-600 dark:text-amber-50 border-amber-600 dark:border-amber-700',
  },
  accepted: {
    label: 'ACCEPTED',
    classes:
      'bg-blue-500 text-white dark:bg-blue-600 dark:text-blue-50 border-blue-600 dark:border-blue-700',
  },
  fixed: {
    label: 'FIXED',
    classes:
      'bg-emerald-500 text-white dark:bg-emerald-600 dark:text-emerald-50 border-emerald-600 dark:border-emerald-700',
  },
  resolved: {
    label: 'RESOLVED',
    classes:
      'bg-emerald-500 text-white dark:bg-emerald-600 dark:text-emerald-50 border-emerald-600 dark:border-emerald-700',
  },
  contested: {
    label: 'CONTESTED',
    classes:
      'bg-orange-500 text-white dark:bg-orange-600 dark:text-orange-50 border-orange-600 dark:border-orange-700',
  },
  // Agent proposed a waiver; awaiting human confirmation. Yellow "PROPOSED"
  // pill signals the reviewer still needs to act — the finding keeps blocking.
  waiver_proposed: {
    label: 'WAIVER PROPOSED',
    classes:
      'bg-yellow-500 text-white dark:bg-yellow-600 dark:text-yellow-50 border-yellow-600 dark:border-yellow-700',
  },
  // Closed administratively at completion (no human confirmed the proposal).
  // Muted grey pill — terminal state, nothing owed, so it must not read as a
  // warning next to the actionable yellow one above.
  waived_on_completion: {
    label: 'WAIVED ON COMPLETION',
    classes:
      'bg-gray-500 text-white dark:bg-gray-600 dark:text-gray-50 border-gray-600 dark:border-gray-700',
  },
};

const originLabels: Record<string, string> = {
  reviewer: 'Reviewer',
  rule_engine: 'Rule Engine',
  test_engine: 'Test Engine',
  human: 'Human',
};

const categoryLabels: Record<string, string> = {
  bug: 'Bug',
  architecture_violation: 'Architecture Violation',
  rule_violation: 'Rule Violation',
  rule_override_conflict: 'Rule Override Conflict',
  missing_evidence: 'Missing Evidence',
  test_gap: 'Test Gap',
  security_risk: 'Security Risk',
  performance_risk: 'Performance Risk',
  maintainability_issue: 'Maintainability',
  clarification_needed: 'Needs Clarification',
  large_diff_warning: 'Large Diff',
  diff_exceeds_limit: 'Diff Limit Exceeded',
  risk_downgrade_audit: 'Risk Downgrade',
};

interface FindingCardProps {
  finding: Finding;
  selected?: boolean;
  onClick?: () => void;
}

export function FindingCard({ finding, selected, onClick }: FindingCardProps) {
  const confidencePercent = Math.round(finding.confidence * 100);
  const isResolved = !isBlockingFindingStatus(finding.status);
  const statusBadge = statusBadgeConfig[finding.status];
  const tint = decisionTints[finding.status];

  function handleCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleCardKeyDown}
      data-testid={`finding-card-${finding.finding_id}`}
      className={`relative w-full text-left rounded-lg border p-4 transition-colors overflow-hidden cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
        isResolved ? 'opacity-90' : ''
      } ${
        selected
          ? 'border-accent dark:border-accent bg-accent-light dark:bg-accent-light ring-1 ring-accent dark:ring-accent'
          : 'border-gray-200 dark:border-border-subtle bg-surface-raised hover:border-gray-300 dark:hover:border-gray-600 hover:bg-surface-base dark:hover:bg-border-subtle'
      }`}
    >
      {/* Decision tint overlay — kept as a soft background hint behind
          the foreground badge. */}
      {tint && !selected && (
        <div className={`absolute inset-0 ${tint} pointer-events-none`} />
      )}

      {/* Card content — relative to sit above tint */}
      <div className="relative">
        {/* Header: title + severity + (terminal-state badge OR open-status pill) */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <SeverityBadge severity={finding.severity} />
            <h4
              className={`text-sm font-semibold truncate ${
                isResolved
                  ? 'text-gray-500 dark:text-gray-400'
                  : 'text-gray-900 dark:text-gray-100'
              }`}
              title={finding.title}
            >
              {finding.title}
            </h4>
          </div>
          {/* Verification badge wrapper only exists when a verdict is present —
              findings without verification_status keep the exact pre-feature DOM. */}
          {finding.verification_status ? (
            <div className="flex items-center gap-2 flex-shrink-0">
              {statusBadge ? (
                <span
                  data-testid={`finding-status-badge-${finding.status}`}
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider shadow-sm ${statusBadge.classes}`}
                >
                  {statusBadge.label}
                </span>
              ) : (
                <FindingStatusBadge status={finding.status} />
              )}
              <FindingVerificationBadge
                status={finding.verification_status}
                note={finding.verification_note}
              />
            </div>
          ) : statusBadge ? (
            <span
              data-testid={`finding-status-badge-${finding.status}`}
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider flex-shrink-0 shadow-sm ${statusBadge.classes}`}
            >
              {statusBadge.label}
            </span>
          ) : (
            <FindingStatusBadge status={finding.status} className="flex-shrink-0" />
          )}
        </div>

        {/* Severity contested warning */}
        {finding.severity_contested && (
          <div className="mt-2 flex items-center gap-1.5 rounded bg-orange-50 dark:bg-orange-950/50 border border-orange-200 dark:border-orange-800 px-2.5 py-1.5">
            <svg
              className="h-4 w-4 text-orange-500 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <span className="text-xs font-medium text-orange-700 dark:text-orange-400">
              Severity contested
            </span>
          </div>
        )}

        {/* Category */}
        <div className="mt-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {categoryLabels[finding.category] ?? finding.category.replace(/_/g, ' ')}
          </span>
        </div>

        {/* Description */}
        <MarkdownContent className="mt-2 text-base leading-relaxed text-gray-600 dark:text-gray-400 line-clamp-3">{finding.description}</MarkdownContent>

        {/* Confidence bar */}
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">Confidence</span>
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {confidencePercent}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className={`h-1.5 rounded-full transition-all ${
                confidencePercent >= 80
                  ? 'bg-green-500'
                  : confidencePercent >= 50
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
              }`}
              style={{ width: `${confidencePercent}%` }}
            />
          </div>
        </div>

        {/* Consensus indicator */}
        {finding.consensus && (
          <div className="mt-2 flex items-center gap-1.5">
            <span
              className={`inline-flex h-2 w-2 rounded-full flex-shrink-0 ${
                finding.consensus.agreement_ratio >= 0.67
                  ? 'bg-green-500'
                  : finding.consensus.agreement_ratio >= 0.34
                    ? 'bg-yellow-500'
                    : 'bg-gray-400'
              }`}
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Consensus: {finding.consensus.agreement_count}/{finding.consensus.reviewer_count} models
              {' '}({Math.round(finding.consensus.agreement_ratio * 100)}%)
            </span>
          </div>
        )}

        {/* Verification note — visible text fallback for the badge tooltip
            (tooltips are suppressed on touch). Compact, muted, line-clamped;
            mirrors the consensus/origin row styling. */}
        {finding.verification_status && finding.verification_note && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
            Verification: {finding.verification_note}
          </p>
        )}

        {/* Origin */}
        <div className="mt-3 flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
          <span>
            Origin: {originLabels[finding.origin_type] ?? finding.origin_type}
          </span>
          {finding.source_refs.length > 0 && (
            <span className="truncate">
              Reviewed by: {finding.source_refs.join(', ')}
            </span>
          )}
        </div>

        {/* Evidence refs */}
        {finding.evidence_refs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {finding.evidence_refs.map((ref) => (
              <span
                key={ref}
                className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-mono text-gray-600 dark:text-gray-400"
              >
                {ref}
              </span>
            ))}
          </div>
        )}

        {/* No per-finding actions here: Waive lives in the Decision
            panel's FindingWaiveList (decision-cluster/finding-waive-list)
            so all decision affordances sit in one place. */}
      </div>
    </div>
  );
}
