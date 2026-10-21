'use client';

import { useState } from 'react';
import type {
  KnowledgeAsset,
  KnowledgeScopeType,
  KnowledgeType,
} from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { useToast } from '@/providers/toast-provider';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { MarkdownContent } from '@/components/shared/markdown-content';
import { Button } from '@/components/ui/button';

interface KnowledgeEditorModalProps {
  mode: 'create' | 'edit';
  asset?: KnowledgeAsset;
  onClose: () => void;
  onSaved: () => void;
}

const inputClasses =
  'w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-700 dark:text-gray-200 shadow-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const selectClasses =
  'w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-700 dark:text-gray-200 shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const labelClasses =
  'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

const KNOWLEDGE_TYPES: { value: KnowledgeType; label: string }[] = [
  { value: 'precedent', label: 'Precedent' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'anti_pattern', label: 'Anti-pattern' },
  { value: 'mock_template', label: 'Mock Template' },
  { value: 'implementation_note', label: 'Implementation Note' },
  { value: 'review_guideline', label: 'Review Guideline' },
  { value: 'architecture_decision', label: 'Architecture Decision' },
  { value: 'exception_policy', label: 'Exception Policy' },
];

const SCOPE_TYPES: { value: KnowledgeScopeType; label: string }[] = [
  { value: 'global', label: 'Global' },
  { value: 'org', label: 'Organization' },
  { value: 'team', label: 'Team' },
  { value: 'project', label: 'Project' },
  { value: 'repo', label: 'Repository' },
];

function scopeRefHint(scopeType: KnowledgeScopeType): string {
  switch (scopeType) {
    case 'global':
      return '(use "global")';
    case 'org':
      return '(org id)';
    case 'team':
      return '(team id)';
    case 'project':
      return '(project id)';
    case 'repo':
      return '(repo id)';
  }
}

function scopeRefPlaceholder(scopeType: KnowledgeScopeType): string {
  switch (scopeType) {
    case 'global':
      return 'global';
    case 'org':
      return 'org_...';
    case 'team':
      return 'team_...';
    case 'project':
      return 'proj_...';
    case 'repo':
      return 'repo_...';
  }
}

export function KnowledgeEditorModal({
  mode,
  asset,
  onClose,
  onSaved,
}: KnowledgeEditorModalProps) {
  const { addToast } = useToast();
  useEscapeKey(onClose);

  const [title, setTitle] = useState(asset?.title ?? '');
  const [type, setType] = useState<KnowledgeType>(asset?.type ?? 'precedent');
  const [scopeType, setScopeType] = useState<KnowledgeScopeType>(
    (asset?.scope_type as KnowledgeScopeType) ?? 'global',
  );
  const [scopeRef, setScopeRef] = useState(asset?.scope_ref ?? 'global');
  const [summary, setSummary] = useState(asset?.summary ?? '');
  const [body, setBody] = useState(asset?.body ?? '');
  const [tags, setTags] = useState((asset?.tags ?? []).join(', '));
  const [expiresAt, setExpiresAt] = useState(
    asset?.expires_at ? asset.expires_at.slice(0, 10) : '',
  );
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const isCreate = mode === 'create';

  async function handleSave() {
    if (!title.trim()) {
      addToast('error', 'Title is required');
      return;
    }
    if (!type) {
      addToast('error', 'Type is required');
      return;
    }

    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    setSaving(true);
    try {
      if (isCreate) {
        await api.knowledge.create({
          title: title.trim(),
          type,
          summary,
          body,
          scope_type: scopeType,
          scope_ref: scopeRef || (scopeType === 'global' ? 'global' : ''),
          tags: parsedTags,
          expires_at: expiresAt
            ? new Date(expiresAt).toISOString()
            : undefined,
        });
        addToast('success', `Knowledge asset "${title.trim()}" created.`);
      } else if (asset) {
        await api.knowledge.update(asset.knowledge_id, {
          title: title.trim(),
          type,
          summary,
          body,
          scope_type: scopeType,
          scope_ref: scopeRef,
          tags: parsedTags,
          expires_at: expiresAt
            ? new Date(expiresAt).toISOString()
            : undefined,
        });
        addToast('success', `Knowledge asset "${title.trim()}" saved.`);
      }
      onSaved();
    } catch (err) {
      addToast(
        'error',
        err instanceof Error ? err.message : 'Failed to save knowledge asset',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-raised rounded-xl shadow-xl border border-gray-200 dark:border-border-subtle w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-border-subtle">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {isCreate ? 'New Knowledge Asset' : 'Edit Knowledge Asset'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className={labelClasses}>
              Title <span className="text-red-500">*</span>
            </label>
            <input
              className={inputClasses}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Prefer repository pattern for Firestore access"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClasses}>
                Type <span className="text-red-500">*</span>
              </label>
              <select
                className={selectClasses}
                value={type}
                onChange={(e) => setType(e.target.value as KnowledgeType)}
              >
                {KNOWLEDGE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClasses}>Scope</label>
              <select
                className={selectClasses}
                value={scopeType}
                onChange={(e) => {
                  const next = e.target.value as KnowledgeScopeType;
                  setScopeType(next);
                  if (next === 'global') setScopeRef('global');
                }}
              >
                {SCOPE_TYPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClasses}>
              Scope Reference
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                {scopeRefHint(scopeType)}
              </span>
            </label>
            <input
              className={inputClasses}
              value={scopeRef}
              onChange={(e) => setScopeRef(e.target.value)}
              placeholder={scopeRefPlaceholder(scopeType)}
            />
          </div>

          <div>
            <label className={labelClasses}>Summary</label>
            <textarea
              className={inputClasses}
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One or two sentences explaining the asset"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelClasses + ' mb-0'}>Body (markdown)</label>
              <button
                type="button"
                onClick={() => setShowPreview((p) => !p)}
                className="text-xs font-medium text-accent-700 dark:text-accent-300 hover:underline"
              >
                {showPreview ? 'Edit' : 'Preview'}
              </button>
            </div>
            {showPreview ? (
              <div className="min-h-[336px] rounded-md border border-gray-300 dark:border-border-default bg-surface-base dark:bg-surface-overlay px-3 py-2">
                {body.trim() ? (
                  <MarkdownContent>{body}</MarkdownContent>
                ) : (
                  <p className="text-sm italic text-gray-400 dark:text-gray-500">
                    Nothing to preview yet.
                  </p>
                )}
              </div>
            ) : (
              <textarea
                className={inputClasses + ' font-mono'}
                rows={14}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="# Context&#10;&#10;## Decision&#10;&#10;## Consequences"
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClasses}>
                Tags
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                  (comma-separated)
                </span>
              </label>
              <input
                className={inputClasses}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. firestore, repository, backend"
              />
            </div>
            <div>
              <label className={labelClasses}>
                Expires At
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                  (optional)
                </span>
              </label>
              <input
                type="date"
                className={inputClasses}
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-border-subtle">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !title.trim()} loading={saving} onClick={handleSave}>
            {saving ? 'Saving...' : isCreate ? 'Create Asset' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
