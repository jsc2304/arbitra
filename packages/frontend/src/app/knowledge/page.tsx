'use client';

import { useState, useEffect, useCallback } from 'react';
import type { KnowledgeAsset } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { KnowledgeList } from '@/components/knowledge/knowledge-list';
import { KnowledgeDetail } from '@/components/knowledge/knowledge-detail';
import { KnowledgeEditorModal } from '@/components/knowledge/knowledge-editor-modal';
import ErrorCard from '@/components/shared/error-card';
import EmptyState from '@/components/shared/empty-state';
import LoadingSpinner from '@/components/shared/loading-spinner';

export default function KnowledgePage() {
  const [assets, setAssets] = useState<KnowledgeAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingAsset, setEditingAsset] = useState<KnowledgeAsset | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const knowledgeRes = await api.knowledge.list();
      setAssets(knowledgeRes.assets);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load knowledge assets.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const selectedAsset =
    assets.find((a) => a.knowledge_id === selectedId) ?? null;

  const handleSaved = useCallback(async () => {
    setEditingAsset(null);
    setIsCreating(false);
    await loadData();
  }, [loadData]);

  const handleDeleted = useCallback(async () => {
    setSelectedId(null);
    await loadData();
  }, [loadData]);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
      <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-2">
        Knowledge
      </h1>

      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        Verified patterns, precedents, and decisions that move through
        suggested → verified → canonical before influencing reviews. Rule Sets
        and Evidence Policies are managed per project.{' '}
        <a
          href="/docs#knowledge-rules"
          className="text-accent-700 dark:text-accent-300 hover:underline whitespace-nowrap"
        >
          Learn more →
        </a>
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="md" />
        </div>
      ) : error ? (
        <ErrorCard message={error} onRetry={loadData} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(22rem,32rem)_minmax(0,1fr)] lg:items-start">
          <div className="min-w-0">
            <KnowledgeList
              assets={assets}
              selectedId={selectedId}
              onSelect={(asset) => setSelectedId(asset.knowledge_id)}
              onCreate={() => setIsCreating(true)}
            />
          </div>

          {selectedAsset ? (
            <div className="min-w-0 lg:sticky lg:top-6">
              <KnowledgeDetail
                asset={selectedAsset}
                onEdit={(asset) => setEditingAsset(asset)}
                onDeleted={handleDeleted}
                onChanged={loadData}
              />
            </div>
          ) : (
            // Desktop-only placeholder. On mobile the right column is hidden
            // until a row is selected, so the list isn't pushed down by an
            // empty hint the user hasn't scrolled to.
            assets.length > 0 && (
              <div className="hidden min-w-0 lg:sticky lg:top-6 lg:block">
                <EmptyState
                  title="Select an asset to view details"
                  description="Choose a knowledge asset from the list to see its content, lifecycle, and metadata."
                />
              </div>
            )
          )}
        </div>
      )}

      {(isCreating || editingAsset) && (
        <KnowledgeEditorModal
          mode={isCreating ? 'create' : 'edit'}
          asset={editingAsset ?? undefined}
          onClose={() => {
            setIsCreating(false);
            setEditingAsset(null);
          }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
