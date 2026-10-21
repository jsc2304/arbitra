'use client';

import { useState } from 'react';
import type { KnowledgeAsset, KnowledgeStatus } from '@arbitra/shared';
import { useProjectMap } from '@/hooks/use-projects';
import { useUserMap } from '@/hooks/use-users';
import { useCanEditKnowledge } from '@/hooks/use-can-edit-knowledge';
import { api } from '@/lib/api-client';
import { useToast } from '@/providers/toast-provider';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { MarkdownContent } from '@/components/shared/markdown-content';
import { RelativeTime } from '@/components/shared/relative-time';
import { statusColors, typeColors } from './knowledge-constants';

const lifecycleSteps: KnowledgeStatus[] = [
  'suggested',
  'verified',
  'canonical',
];

interface KnowledgeDetailProps {
  asset: KnowledgeAsset;
  onEdit?: (asset: KnowledgeAsset) => void;
  onDeleted?: () => void;
  onChanged?: () => void;
}

export function KnowledgeDetail({
  asset,
  onEdit,
  onDeleted,
  onChanged,
}: KnowledgeDetailProps) {
  const currentStepIndex = lifecycleSteps.indexOf(asset.status);
  const projectMap = useProjectMap();
  const canEdit = useCanEditKnowledge();
  const userMap = useUserMap(asset.approved_by ? [asset.created_by, asset.approved_by] : [asset.created_by]);
  const userName = (id: string) => userMap[id]?.display_name ?? id;
  const { addToast } = useToast();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState<KnowledgeStatus | null>(
    null,
  );

  async function handleStatusChange(next: KnowledgeStatus) {
    setUpdatingStatus(next);
    try {
      await api.knowledge.updateStatus(asset.knowledge_id, next);
      addToast('success', `Status changed to ${next}.`);
      onChanged?.();
    } catch (err) {
      addToast(
        'error',
        err instanceof Error ? err.message : 'Failed to update status',
      );
    } finally {
      setUpdatingStatus(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.knowledge.delete(asset.knowledge_id);
      addToast('success', `Knowledge asset "${asset.title}" deleted.`);
      setConfirmingDelete(false);
      onDeleted?.();
    } catch (err) {
      addToast(
        'error',
        err instanceof Error ? err.message : 'Failed to delete asset',
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-border-subtle">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-start gap-2">
            <span
              className={`inline-flex max-w-full items-center rounded px-2 py-0.5 text-xs font-medium ${
                typeColors[asset.type] ??
                'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
              }`}
            >
              <span className="truncate">{asset.type.replace(/_/g, ' ')}</span>
            </span>
            <h3 className="min-w-0 flex-1 text-base font-semibold text-gray-900 dark:text-gray-100 break-words">
              {asset.title}
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:flex-shrink-0 xl:justify-end">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[asset.status]}`}
            >
              {asset.status}
            </span>
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => onEdit?.(asset)}
                  className="rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded-md border border-red-300 dark:border-red-800 bg-surface-raised px-3 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Lifecycle indicator */}
        {asset.status !== 'deprecated' && asset.status !== 'superseded' && (
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              Lifecycle
            </dt>
            <div className="flex items-center gap-1">
              {lifecycleSteps.map((step, i) => {
                const isCompleted = i <= currentStepIndex;
                const isCurrent = i === currentStepIndex;
                return (
                  <div key={step} className="flex items-center gap-1">
                    {i > 0 && (
                      <div
                        className={`h-0.5 w-6 ${
                          i <= currentStepIndex
                            ? 'bg-accent dark:bg-accent'
                            : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                      />
                    )}
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        isCurrent
                          ? 'bg-accent-light dark:bg-accent-light text-accent-700 dark:text-accent-300 ring-1 ring-accent dark:ring-accent-hover'
                          : isCompleted
                            ? 'bg-accent-light dark:bg-accent-light text-accent-700 dark:text-accent-300'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500'
                      }`}
                    >
                      {step}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {asset.summary && (
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Summary
            </dt>
            <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {asset.summary}
            </dd>
          </div>
        )}

        {asset.body && (
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              Content
            </dt>
            <dd className="mt-1 text-base leading-relaxed text-gray-700 dark:text-gray-300">
              <MarkdownContent>{asset.body}</MarkdownContent>
            </dd>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Scope
            </dt>
            <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {asset.scope_type === 'global'
                ? 'Global'
                : asset.scope_type === 'project'
                  ? `Project: ${projectMap[asset.scope_ref] ?? asset.scope_ref}`
                  : `${asset.scope_type} / ${asset.scope_ref}`}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Trust Level
            </dt>
            <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {asset.trust_level}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Version
            </dt>
            <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              v{asset.version}
            </dd>
          </div>
        </div>

        {asset.source_case_refs.length > 0 && (
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Source Cases
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {asset.source_case_refs.map((ref) => (
                <span
                  key={ref}
                  className="inline-flex rounded bg-surface-base dark:bg-surface-base border border-gray-200 dark:border-border-subtle px-2 py-0.5 text-xs font-mono text-gray-600 dark:text-gray-400"
                >
                  {ref}
                </span>
              ))}
            </dd>
          </div>
        )}

        {asset.tags.length > 0 && (
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Tags
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {asset.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400"
                >
                  {tag}
                </span>
              ))}
            </dd>
          </div>
        )}

        {/* Lifecycle status actions */}
        {canEdit &&
          asset.status !== 'deprecated' &&
          asset.status !== 'superseded' && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100 dark:border-border-subtle">
              {asset.status === 'suggested' && (
                <button
                  type="button"
                  disabled={updatingStatus !== null}
                  onClick={() => handleStatusChange('verified')}
                  className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-accent-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-base disabled:opacity-50"
                >
                  {updatingStatus === 'verified' ? 'Saving...' : 'Mark Verified'}
                </button>
              )}
              {asset.status === 'verified' && (
                <button
                  type="button"
                  disabled={updatingStatus !== null}
                  onClick={() => handleStatusChange('canonical')}
                  className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-accent-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-base disabled:opacity-50"
                >
                  {updatingStatus === 'canonical'
                    ? 'Saving...'
                    : 'Mark Canonical'}
                </button>
              )}
              {(asset.status === 'verified' ||
                asset.status === 'canonical') && (
                <button
                  type="button"
                  disabled={updatingStatus !== null}
                  onClick={() => handleStatusChange('deprecated')}
                  className="rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 disabled:opacity-50"
                >
                  {updatingStatus === 'deprecated'
                    ? 'Saving...'
                    : 'Deprecate'}
                </button>
              )}
            </div>
          )}

        <div className="flex flex-wrap gap-3 text-xs text-gray-400 dark:text-gray-500 pt-2 border-t border-gray-100 dark:border-border-subtle">
          <span>ID: {asset.knowledge_id}</span>
          <span>Created by: {userName(asset.created_by)}</span>
          {asset.approved_by && <span>Approved by: {userName(asset.approved_by)}</span>}
          <RelativeTime timestamp={asset.created_at} prefix="Created" />
          <RelativeTime timestamp={asset.updated_at} prefix="Updated" />
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete knowledge asset?"
        message={`"${asset.title}" will be permanently removed. References in old decision audit snapshots will remain as historical records.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
