'use client';

import { useState } from 'react';
import { isBlockingFindingStatus, type Finding, type FindingStatus } from '@arbitra/shared';
import { SeverityBadge } from '../shared/severity-badge';
import { MarkdownContent } from '../shared/markdown-content';
import { RelativeTime } from '../shared/relative-time';
import { isBlocking } from '../../lib/finding-selectors';
import { FindingStatusBadge } from '../shared/finding-status-badge';
import { FindingVerificationBadge } from '../shared/finding-verification-badge';

interface FindingsPanelProps {
  findings: Finding[];
}

const statusFilterOptions: { value: FindingStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'waived', label: 'Waived' },
  { value: 'contested', label: 'Contested' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'waiver_proposed', label: 'Waiver proposed' },
  { value: 'waived_on_completion', label: 'Waived on completion' },
];

const originLabels: Record<string, string> = {
  reviewer: 'Reviewer',
  rule_engine: 'Rule Engine',
  test_engine: 'Test Engine',
  human: 'Human',
};

export function FindingsPanel({ findings }: FindingsPanelProps) {
  const [statusFilter, setStatusFilter] = useState<FindingStatus | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered =
    statusFilter === 'all'
      ? findings
      : findings.filter((f) => f.status === statusFilter);

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Findings ({filtered.length})
          </h3>
          <span
            className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-[10px] font-bold cursor-help"
            title="Findings are issues identified by AI reviewers, rule checks, or human reviewers. Each finding has a severity (info to critical), a confidence score, and a status tracking its resolution."
          >
            ?
          </span>
        </div>
        {/* Mobile: dropdown filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FindingStatus | 'all')}
          className="sm:hidden rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300"
        >
          {statusFilterOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {/* Desktop: pill filters */}
        <div className="hidden sm:flex items-center gap-1">
          {statusFilterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(opt.value)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                statusFilter === opt.value
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-surface-base dark:hover:bg-border-subtle'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <p className="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {statusFilter === 'all' ? 'No findings yet' : 'No findings match this filter'}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
            {statusFilter === 'all'
              ? 'Findings are identified issues, risks, or review points. They appear here once the case enters review and AI reviewers or rule checks analyze the changes.'
              : `Try selecting "All" to see all findings regardless of status.`}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {filtered.map((finding) => {
            const isExpanded = expandedId === finding.finding_id;
            const isResolved = !isBlockingFindingStatus(finding.status);
            return (
              <li key={finding.finding_id} data-entity-id={finding.finding_id} className={`px-4 py-3 transition-colors rounded ${
                isResolved
                  ? 'opacity-60'
                  : isBlocking(finding)
                    ? 'border-l-[3px] border-l-orange-400 bg-orange-50/50 dark:bg-orange-900/10 hover:bg-orange-50 dark:hover:bg-orange-900/20'
                    : 'hover:bg-surface-base dark:hover:bg-border-subtle/50'
              }`}>
                <button
                  onClick={() =>
                    setExpandedId(isExpanded ? null : finding.finding_id)
                  }
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <SeverityBadge severity={finding.severity} />
                      <span
                        className={`text-sm font-medium truncate ${
                          isResolved
                            ? 'text-gray-400 dark:text-gray-500 line-through'
                            : 'text-gray-900 dark:text-gray-100'
                        }`}
                        title={finding.title}
                      >
                        {finding.title}
                      </span>
                      {finding.severity_contested && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-400">
                          Contested
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {finding.category.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {Math.round(finding.confidence * 100)}%
                      </span>
                      <FindingStatusBadge status={finding.status} />
                      <FindingVerificationBadge
                        status={finding.verification_status}
                        note={finding.verification_note}
                      />
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {originLabels[finding.origin_type] ?? finding.origin_type}
                      </span>
                      {finding.origin_type === 'reviewer' && finding.source_refs.length > 0 && (() => {
                        const match = finding.source_refs[0]?.match(/llm-(\w+)\s*\(([^)]+)\)/);
                        if (!match?.[2]) return null;
                        const model = match[2].replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                        return (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                            </svg>
                            {model}
                          </span>
                        );
                      })()}
                      <svg
                        className={`h-4 w-4 text-gray-400 dark:text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="mt-2 pl-2 border-l-2 border-gray-200 dark:border-border-subtle ml-1">
                    <MarkdownContent className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">{finding.description}</MarkdownContent>
                    {finding.resolution && (
                      <div className="mt-2">
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Resolution: </span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">{finding.resolution}</span>
                      </div>
                    )}
                    {finding.verification_note && (
                      <div className="mt-2">
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Verification: </span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">{finding.verification_note}</span>
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-400 dark:text-gray-500">
                      <span>ID: {finding.finding_id}</span>
                      <RelativeTime timestamp={finding.created_at} prefix="Created" />
                      {finding.verified_at && (
                        <RelativeTime timestamp={finding.verified_at} prefix="Verified" />
                      )}
                      {finding.verifier_model && (
                        <span>Verifier: {finding.verifier_model}</span>
                      )}
                      {finding.source_refs.length > 0 && (() => {
                        const ref = finding.source_refs[0];
                        const match = ref?.match(/llm-(\w+)\s*\(([^)]+)\)/);
                        if (match?.[2]) {
                          const model = match[2].replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                          return (
                            <span className="inline-flex items-center gap-1">
                              Reviewed by:
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                                </svg>
                                {model}
                              </span>
                            </span>
                          );
                        }
                        return <span>Reviewed by: {finding.source_refs.join(', ')}</span>;
                      })()}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

    </div>
  );
}
