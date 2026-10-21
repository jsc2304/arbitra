'use client';

import { useState } from 'react';
import type { KnowledgeAsset, KnowledgeStatus, KnowledgeType } from '@arbitra/shared';
import { useCanEditKnowledge } from '@/hooks/use-can-edit-knowledge';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '../shared/relative-time';
import EmptyState from '../shared/empty-state';
import { statusColors, typeColors } from './knowledge-constants';

// Tooltips surface the lifecycle-stage semantics because "Suggested",
// "Canonical", "Superseded" etc. are domain terms. Without tooltips, first-time users of this page
// would have to read the product spec to understand what each filter
// selects.
const statusFilterOptions: { value: KnowledgeStatus | 'all'; label: string; tooltip: string }[] = [
  { value: 'all', label: 'All', tooltip: 'Show knowledge assets in every lifecycle stage' },
  { value: 'suggested', label: 'Suggested', tooltip: 'Proposed by automation or a contributor — not yet human-reviewed' },
  { value: 'verified', label: 'Verified', tooltip: 'Reviewed and confirmed accurate — ready for use in reviews' },
  { value: 'canonical', label: 'Canonical', tooltip: 'Authoritative source for its topic — the reference answer' },
  { value: 'deprecated', label: 'Deprecated', tooltip: 'No longer recommended — kept for historical reference' },
  { value: 'superseded', label: 'Superseded', tooltip: 'Replaced by a newer asset — follow the linked successor' },
];

const typeFilterOptions: { value: KnowledgeType | 'all'; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'precedent', label: 'Precedent' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'anti_pattern', label: 'Anti-pattern' },
  { value: 'mock_template', label: 'Mock Template' },
  { value: 'implementation_note', label: 'Impl. Note' },
  { value: 'review_guideline', label: 'Review Guideline' },
  { value: 'architecture_decision', label: 'Arch. Decision' },
  { value: 'exception_policy', label: 'Exception Policy' },
];

interface KnowledgeListProps {
  assets: KnowledgeAsset[];
  selectedId?: string | null;
  onSelect?: (asset: KnowledgeAsset) => void;
  onCreate?: () => void;
}

export function KnowledgeList({
  assets,
  selectedId,
  onSelect,
  onCreate,
}: KnowledgeListProps) {
  const [statusFilter, setStatusFilter] = useState<KnowledgeStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<KnowledgeType | 'all'>('all');
  const canEdit = useCanEditKnowledge();

  const filtered = assets.filter((asset) => {
    if (statusFilter !== 'all' && asset.status !== statusFilter) return false;
    if (typeFilter !== 'all' && asset.type !== typeFilter) return false;
    return true;
  });

  if (assets.length === 0) {
    return (
      <EmptyState
        title="No knowledge assets"
        description="Knowledge assets will appear here as cases produce learnings."
        action={
          canEdit && onCreate
            ? { label: 'New Knowledge Asset', onClick: onCreate }
            : undefined
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-surface-raised dark:border-border-subtle">
      <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-3 dark:border-border-subtle">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Knowledge Assets ({filtered.length})
          </h3>
          {canEdit && onCreate && (
            <Button
              onClick={onCreate}
              size="xs"
              className="ml-auto shrink-0 whitespace-nowrap"
            >
              + New
            </Button>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="scrollbar-subtle -mx-1 min-w-0 overflow-x-auto px-1 pb-1">
            <div className="flex w-max items-center gap-1">
              {statusFilterOptions.map((opt) => (
                <Button
                  key={opt.value}
                  onClick={() => setStatusFilter(opt.value)}
                  title={opt.tooltip}
                  aria-label={`${opt.label}: ${opt.tooltip}`}
                  aria-pressed={statusFilter === opt.value}
                  variant={statusFilter === opt.value ? 'neutral' : 'ghost'}
                  size="xs"
                  className="shrink-0 whitespace-nowrap"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as KnowledgeType | 'all')}
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-accent focus:ring-1 focus:ring-accent dark:border-border-default dark:bg-input-bg dark:text-gray-200 sm:w-44 sm:shrink-0"
          >
            {typeFilterOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-4">
          <EmptyState
            variant="filter"
            title="No matching assets"
            description="No assets match the current filters."
          />
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {filtered.map((asset) => {
            const isSelected = selectedId === asset.knowledge_id;
            return (
              <li
                key={asset.knowledge_id}
                onClick={() => onSelect?.(asset)}
                aria-current={isSelected ? 'true' : undefined}
                className={`relative px-4 py-3 ${
                  onSelect ? 'cursor-pointer hover:bg-surface-base dark:hover:bg-border-subtle/50' : ''
                } ${
                  isSelected
                    ? 'bg-accent/10 ring-1 ring-inset ring-accent/30 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
                    : ''
                }`}
              >
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100 break-words">
                    {asset.title}
                  </h4>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex max-w-full items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-tight ${
                        typeColors[asset.type] ?? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      <span className="truncate">{asset.type.replace(/_/g, ' ')}</span>
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColors[asset.status]}`}
                    >
                      {asset.status}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {asset.scope_type}
                    </span>
                    <RelativeTime
                      timestamp={asset.created_at}
                      className="text-xs text-gray-400 dark:text-gray-500"
                    />
                  </div>
                </div>

                {asset.summary && (
                  <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400 break-words">
                    {asset.summary}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
