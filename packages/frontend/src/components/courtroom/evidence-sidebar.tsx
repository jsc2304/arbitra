'use client';

import useSWR from 'swr';
import { api } from '../../lib/api-client';
import LoadingSpinner from '../shared/loading-spinner';
import type { Evidence } from '@arbitra/shared';
import { getEvidenceLabel } from '../../lib/evidence-labels';

const sourceTypeIcons: Record<string, string> = {
  automated: 'A',
  manual: 'M',
  webhook: 'W',
  agent: 'G',
};

interface EvidenceSidebarProps {
  caseId: string;
  highlightedRefs?: string[];
  onEvidenceClick?: (evidence: Evidence) => void;
}

export function EvidenceSidebar({ caseId, highlightedRefs = [], onEvidenceClick }: EvidenceSidebarProps) {
  const { data, error, isLoading } = useSWR(
    ['case-evidence', caseId],
    () => api.cases.evidence(caseId),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner size="sm" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-3 py-2 text-sm text-red-700 dark:text-red-400">
        Failed to load evidence.
      </div>
    );
  }

  const evidenceList = data?.evidence ?? [];
  const highlightSet = new Set(highlightedRefs);

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-border-subtle px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Evidence ({evidenceList.length})
        </h3>
        {data?.satisfied !== undefined && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
              data.satisfied
                ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400'
                : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
            }`}
          >
            {data.satisfied ? 'Satisfied' : 'Not Satisfied'}
          </span>
        )}
      </div>

      {evidenceList.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          No evidence submitted yet.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {evidenceList.map((ev) => {
            const isHighlighted = highlightSet.has(ev.evidence_id);
            return (
              <li
                key={ev.evidence_id}
                onClick={() => onEvidenceClick?.(ev as Evidence)}
                className={`px-4 py-3 transition-colors cursor-pointer hover:bg-surface-base dark:hover:bg-border-subtle ${
                  isHighlighted
                    ? 'bg-accent-light dark:bg-accent-light border-l-2 border-l-accent dark:border-l-accent'
                    : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-gray-200 dark:bg-gray-700 text-[10px] font-bold text-gray-600 dark:text-gray-400">
                      {sourceTypeIcons[ev.source_type] ?? '?'}
                    </span>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {getEvidenceLabel(ev.type)}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0">
                    {ev.machine_readable ? 'machine' : 'human'}
                  </span>
                </div>

                {ev.summary && (
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
                    {ev.summary}
                  </p>
                )}

                <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
                  <span>{ev.source_type}</span>
                  <span>{ev.validation_track} track</span>
                  {ev.artifact_ref && (
                    <span className="font-mono truncate">{ev.artifact_ref}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
