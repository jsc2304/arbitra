'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import type { PromptTemplate } from '@arbitra/shared';
import { useIsAdmin } from '../../hooks/use-is-admin';
import { useToast } from '../../providers/toast-provider';
import { useEscapeKey } from '../../hooks/use-escape-key';
import { getToken } from '../../lib/api-client';
import { RelativeTime } from '../shared/relative-time';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';
import EmptyState from '../shared/empty-state';
import { Input } from '../ui/input';

async function fetchPrompts(): Promise<{ templates: PromptTemplate[] }> {
  const token = await getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('/api/settings/prompts', { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

async function createPromptVersion(input: { slug: string; name?: string; content: string }): Promise<PromptTemplate> {
  const token = await getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('/api/settings/prompts', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

const SLUG_LABELS: Record<string, { name: string; description: string }> = {
  review_system: {
    name: 'Review System Prompt',
    description: 'System prompt used by the AI reviewer when analyzing code changes',
  },
  rule_evaluation_system: {
    name: 'Rule Evaluation Prompt',
    description: 'System prompt for AI-powered rule evaluation',
  },
};

function slugLabel(slug: string): { name: string; description: string } {
  return SLUG_LABELS[slug] ?? {
    name: slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `Prompt template: ${slug}`,
  };
}

export function PromptsPanel() {
  const { isAdmin } = useIsAdmin();
  const { addToast } = useToast();
  const { data, error, mutate } = useSWR('settings-prompts', fetchPrompts);
  const templates = data?.templates;

  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  async function seedDefaults() {
    setSeeding(true);
    try {
      const token = await getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/settings/prompts/seed', { method: 'POST', headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message ?? `Request failed: ${res.status}`);
      }
      const { seeded } = await res.json();
      addToast('success', `Loaded ${seeded.length} built-in prompt template${seeded.length !== 1 ? 's' : ''}`);
      mutate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to seed defaults');
    } finally {
      setSeeding(false);
    }
  }

  // Group templates by slug, keep only active (or latest) per slug
  const grouped = useMemo(() => {
    const bySlug: Record<string, PromptTemplate[]> = {};
    for (const t of templates ?? []) {
      if (!bySlug[t.slug]) bySlug[t.slug] = [];
      bySlug[t.slug]!.push(t);
    }
    // Sort each group by version descending
    for (const slug of Object.keys(bySlug)) {
      bySlug[slug]!.sort((a, b) => b.version - a.version);
    }
    return bySlug;
  }, [templates]);

  const slugs = Object.keys(grouped).sort();

  // Find the active template for a slug
  function activeTemplate(slug: string): PromptTemplate | undefined {
    const group = grouped[slug];
    if (!group) return undefined;
    return group.find((t) => t.is_active) ?? group[0];
  }

  if (error) {
    const is403 = error?.message?.includes('403') || error?.message?.includes('Admin');
    if (is403) {
      return (
        <div className="max-w-3xl">
          <EmptyState
            icon={
              <svg className="h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            }
            title="Admin access required"
            description="Only administrators can view and manage prompt templates."
          />
        </div>
      );
    }
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load prompts: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <section className="mb-8">
        <SectionHeader
          eyebrow
          title="Prompt Templates"
          description="View and manage the AI prompt templates used by the review and rule engines. Each edit creates a new version."
          className="mb-4"
        />

        {slugs.length === 0 ? (
          <EmptyState
            icon={
              <svg className="h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            }
            title="No custom prompts configured"
            description="The system is using built-in defaults. Load them to view and customize."
            action={
              isAdmin
                ? { label: seeding ? 'Loading…' : 'Load built-in defaults', onClick: seedDefaults, disabled: seeding }
                : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            {slugs.map((slug) => {
              const active = activeTemplate(slug);
              if (!active) return null;
              const label = slugLabel(slug);
              const versions = grouped[slug];

              return (
                <PromptCard
                  key={slug}
                  slug={slug}
                  label={label}
                  active={active}
                  versionCount={versions?.length ?? 1}
                  isAdmin={isAdmin}
                  onEdit={() => setEditingSlug(slug)}
                />
              );
            })}
          </div>
        )}
      </section>

      <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base/50 p-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <strong>Versioning:</strong> Each save creates a new version. The active version is used by the AI engines.
          Only admins can edit prompt templates. Changes take effect on the next review or rule evaluation run.
        </p>
      </div>

      {/* Edit Modal */}
      {editingSlug && (
        <EditPromptModal
          slug={editingSlug}
          template={activeTemplate(editingSlug)!}
          onClose={() => setEditingSlug(null)}
          onSaved={() => {
            mutate();
            addToast('success', `New version saved for "${slugLabel(editingSlug).name}"`);
            setEditingSlug(null);
          }}
        />
      )}
    </div>
  );
}

function PromptCard({
  slug,
  label,
  active,
  versionCount,
  isAdmin,
  onEdit,
}: {
  slug: string;
  label: { name: string; description: string };
  active: PromptTemplate;
  versionCount: number;
  isAdmin: boolean;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Truncate content to ~3 lines for preview
  const previewLines = active.content.split('\n').slice(0, 3).join('\n');
  const isTruncated = active.content.split('\n').length > 3 || active.content.length > 300;
  const displayContent = expanded ? active.content : previewLines.slice(0, 300);

  return (
    <Card padding="none">
      <div className="px-4 py-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {active.name || label.name}
              </p>
              <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-secondary-100 text-secondary-700 dark:bg-secondary-900/30 dark:text-secondary-400">
                v{active.version}
              </span>
              {versionCount > 1 && (
                <span className="text-[11px] text-gray-400 dark:text-gray-500">
                  ({versionCount} versions)
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {label.description}
            </p>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 font-mono">
              {slug}
            </p>
          </div>

          {isAdmin && (
            <button
              onClick={onEdit}
              className="bg-accent-700 hover:bg-accent-800 text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex-shrink-0"
            >
              Edit
            </button>
          )}
        </div>

        {/* Content preview */}
        <div className="mt-3 rounded-md border border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 p-3">
          <pre className="text-xs text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap break-words">
            {displayContent}
            {!expanded && isTruncated && '...'}
          </pre>
          {isTruncated && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-2 text-xs text-accent-700 dark:text-accent-300 hover:text-accent-800 dark:hover:text-accent-200 font-medium"
            >
              {expanded ? 'Show less' : 'Show full prompt'}
            </button>
          )}
        </div>

        {/* Footer metadata */}
        <div className="mt-2 flex items-center gap-4 text-[11px] text-gray-400 dark:text-gray-500">
          <RelativeTime timestamp={active.updated_at} prefix="Updated" />
          {(active.updated_by ?? active.created_by) && <span>by {active.updated_by ?? active.created_by}</span>}
        </div>
      </div>
    </Card>
  );
}

function EditPromptModal({
  slug,
  template,
  onClose,
  onSaved,
}: {
  slug: string;
  template: PromptTemplate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const label = slugLabel(slug);
  const [name, setName] = useState(template.name || label.name);
  const [content, setContent] = useState(template.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();

  useEscapeKey(onClose, true);

  const hasChanges = content !== template.content || name !== (template.name || label.name);

  async function handleSave() {
    if (!content.trim()) {
      setError('Prompt content cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createPromptVersion({ slug, name, content });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save prompt';
      setError(msg);
      addToast('error', msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface-raised rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 dark:border-border-subtle px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Prompt</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Saving creates a new version (currently v{template.version})
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {/* Slug (read-only) */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Slug
            </label>
            <input
              type="text"
              value={slug}
              readOnly
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm font-mono text-gray-500 dark:text-gray-400 cursor-not-allowed"
            />
          </div>

          {/* Name */}
          <Input
            wrapperClassName="mb-4"
            label="Name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Prompt template name"
          />

          {/* Content */}
          <Input
            as="textarea"
            wrapperClassName="mb-4"
            label="Prompt Content"
            className="font-mono min-h-[200px]"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            placeholder="Enter the prompt template content..."
          />

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges || !content.trim()}
            className="rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save as New Version'}
          </button>
        </div>
      </div>
    </div>
  );
}
