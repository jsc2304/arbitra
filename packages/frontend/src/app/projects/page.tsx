'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import type { Project } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { Breadcrumb } from '../../components/shared/breadcrumb';
import { TrackBadge } from '../../components/shared/track-badge';
import EmptyState from '../../components/shared/empty-state';
import { SkeletonCard } from '../../components/shared/skeleton';
import { useIsAdmin } from '../../hooks/use-is-admin';
import { useToast } from '../../providers/toast-provider';
import { useEscapeKey } from '../../hooks/use-escape-key';

export default function ProjectsPage() {
  const { data, isLoading, mutate } = useSWR('projects', () => api.projects.list());
  const projects = data?.projects ?? [];
  const { isAdmin } = useIsAdmin();
  const { addToast } = useToast();

  const [showNewProject, setShowNewProject] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newTrack, setNewTrack] = useState<'direct' | 'manual'>('direct');
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEscapeKey(() => setDeleteTarget(null), !!deleteTarget);
  useEscapeKey(() => setShowNewProject(false), showNewProject);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.projects.create({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        default_validation_track: newTrack,
      });
      addToast('success', 'Project created');
      setNewName('');
      setNewDescription('');
      setNewTrack('direct');
      setShowNewProject(false);
      mutate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.projects.delete(deleteTarget.project_id);
      addToast('success', 'Project deleted');
      mutate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-8">
      <Breadcrumb items={[{ label: 'Projects' }]} />

      <div className="flex items-center justify-between mt-4 mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">Projects</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage projects, repositories, and team assignments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/setup/new-project"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 transition-colors"
          >
            Guided Setup
          </Link>
          <button
            onClick={() => setShowNewProject(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-800 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Project
          </button>
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={
            <svg className="h-12 w-12 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
            </svg>
          }
          title="No projects yet"
          description="Create your first project to start managing cases."
          action={{ label: 'Create Project', onClick: () => setShowNewProject(true) }}
        />
      )}

      {/* Project list */}
      {!isLoading && projects.length > 0 && (
        <div className="space-y-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.project_id}
              project={project}
              isAdmin={isAdmin}
              onDelete={() => setDeleteTarget(project)}
            />
          ))}
        </div>
      )}

      {/* New Project Modal */}
      {showNewProject && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowNewProject(false); }}
        >
          <div className="mx-4 w-full max-w-md rounded-lg bg-surface-raised shadow-xl">
            <div className="border-b border-gray-200 dark:border-border-subtle px-6 py-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">New Project</h3>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="My Project"
                  className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Optional description..."
                  rows={2}
                  className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default Validation Track</label>
                <select
                  value={newTrack}
                  onChange={(e) => setNewTrack(e.target.value as 'direct' | 'manual')}
                  className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                >
                  <option value="direct">Direct</option>
                  <option value="manual">Manual</option>
                </select>
              </div>
            </div>
            <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
              <button
                onClick={() => setShowNewProject(false)}
                disabled={creating}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleteTarget(null); }}
        >
          <div className="mx-4 w-full max-w-sm rounded-lg bg-surface-raised shadow-xl">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
                  <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete Project</h3>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Permanently delete <strong>{deleteTarget.name}</strong> and all linked repositories? This cannot be undone.
              </p>
            </div>
            <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project, isAdmin, onDelete }: { project: Project; isAdmin: boolean; onDelete: () => void }) {
  const track = project.default_validation_track ?? 'direct';
  const memberCount = (project.members ?? []).length;

  return (
    <Link
      href={`/projects/${project.project_id}`}
      className="block rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm transition-all group"
    >
      <div className="px-5 py-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 group-hover:text-accent-700 dark:group-hover:text-accent-300 transition-colors truncate" title={project.name}>
              {project.name}
            </h3>
            <span className="flex-shrink-0">
              <TrackBadge track={track} />
            </span>
          </div>
          {project.description && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2" title={project.description}>
              {project.description}
            </p>
          )}
          <div className="mt-2 flex items-center gap-4 text-xs text-gray-400 dark:text-gray-500">
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
              </svg>
              {memberCount} member{memberCount !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
              </svg>
              {project.reviewer_pool.length} reviewer{project.reviewer_pool.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isAdmin && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete();
              }}
              className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1"
              title="Delete project"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          )}
          <svg className="h-4 w-4 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </div>
      </div>
    </Link>
  );
}
