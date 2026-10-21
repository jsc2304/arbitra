'use client';

import { useState, useMemo, useCallback } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import type { Project, Repository, RuleSet, Rule, EvidencePolicyRulesMap } from '@arbitra/shared';
import { api } from '../../../lib/api-client';
import { Breadcrumb } from '../../../components/shared/breadcrumb';
import { useAuth } from '../../../providers/auth-provider';
import { useIsAdmin } from '../../../hooks/use-is-admin';
import { useUserMap } from '../../../hooks/use-users';
import { useToast } from '../../../providers/toast-provider';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { RuleSetList } from '@/components/knowledge/rule-set-list';
import { RuleSetWizard } from '@/components/knowledge/rule-set-wizard';
import { RuleEditorModal } from '@/components/knowledge/rule-editor-modal';
import { RuleSetEditorModal } from '@/components/knowledge/rule-set-editor-modal';
import { PolicyEditor } from '@/components/knowledge/policy-editor';
import { LifecycleSection } from '@/components/project/lifecycle-section';
import { LlmOverridesSection } from '@/components/project/llm-overrides-section';
import { WebhookSection } from '@/components/project/webhook-section';
import { RelativeTime } from '@/components/shared/relative-time';
import LoadingSpinner from '@/components/shared/loading-spinner';
import EmptyState from '@/components/shared/empty-state';

type Tab = 'overview' | 'integrations' | 'repositories' | 'rules' | 'evidence';

const tabs: { id: Tab; label: string; title?: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'integrations', label: 'Integrations', title: 'AI models and chat-notification webhooks for this project' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'rules', label: 'Rules' },
  { id: 'evidence', label: 'Evidence Policy' },
];

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.projectId;

  const { data: project, error, isLoading, mutate } = useSWR(
    projectId ? ['project', projectId] : null,
    () => api.projects.get(projectId),
  );

  const tabParam = searchParams.get('tab') as Tab | null;
  const validTabs: Tab[] = ['overview', 'integrations', 'repositories', 'rules', 'evidence'];
  const initialTab: Tab = tabParam && validTabs.includes(tabParam) ? tabParam : 'overview';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    const url = tab === 'overview'
      ? `/projects/${projectId}`
      : `/projects/${projectId}?tab=${tab}`;
    router.replace(url, { scroll: false });
  }, [projectId, router]);

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Breadcrumb items={[{ label: 'Projects', href: '/projects' }, { label: 'Loading...' }]} />
        <div className="mt-6 animate-pulse space-y-4">
          <div className="h-8 w-64 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-4 w-96 bg-gray-100 dark:bg-gray-800 rounded" />
          <div className="h-64 bg-gray-100 dark:bg-gray-800 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Breadcrumb items={[{ label: 'Projects', href: '/projects' }, { label: 'Not Found' }]} />
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base/50 px-6 py-12 text-center">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Project not found</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            The project you are looking for does not exist or has been deleted.
          </p>
          <Link
            href="/projects"
            className="mt-4 inline-flex items-center gap-1 text-sm text-accent-700 dark:text-accent-300 hover:text-accent-800 dark:hover:text-accent-200"
          >
            Back to Projects
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Breadcrumb items={[{ label: 'Projects', href: '/projects' }, { label: project.name }]} />

      <div className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{project.name}</h1>
        {project.description && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{project.description}</p>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-border-subtle mb-6">
        <nav className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              title={tab.title}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-accent text-accent-700 dark:text-accent-300'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'overview' && <OverviewTab project={project} onUpdate={mutate} />}
      {activeTab === 'integrations' && <IntegrationsTab project={project} onUpdate={mutate} />}
      {activeTab === 'repositories' && <RepositoriesTab project={project} />}
      {activeTab === 'rules' && <RulesTab projectId={projectId} />}
      {activeTab === 'evidence' && <EvidenceTab projectId={projectId} />}
    </div>
  );
}

/* ── Overview Tab ───────────────────────────────────────────────── */

function OverviewTab({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const { user } = useAuth();
  const { isAdmin } = useIsAdmin();
  const isOwner = !!user && project.owner_user_id === user.uid;
  const canEdit = isOwner || isAdmin;
  const { addToast } = useToast();

  // Edit modal state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const [editDescription, setEditDescription] = useState(project.description);
  const [editMembers, setEditMembers] = useState<string[]>(project.members ?? []);
  const [editTechLeads, setEditTechLeads] = useState<string[]>(project.tech_leads);
  const [editReviewerPool, setEditReviewerPool] = useState<string[]>(project.reviewer_pool);
  const [editTrack, setEditTrack] = useState<'direct' | 'manual'>(project.default_validation_track ?? 'direct');
  const [editLanguage, setEditLanguage] = useState<'en' | 'de'>(project.default_language ?? 'en');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEscapeKey(() => { setEditing(false); setSaveError(null); }, editing);

  function openEditModal() {
    setEditName(project.name);
    setEditDescription(project.description);
    setEditMembers([...(project.members ?? [])]);
    setEditTechLeads([...project.tech_leads]);
    setEditReviewerPool([...project.reviewer_pool]);
    setEditTrack(project.default_validation_track ?? 'direct');
    setEditLanguage(project.default_language ?? 'en');
    setSaveError(null);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.projects.update(project.project_id, {
        name: editName.trim(),
        description: editDescription.trim(),
        members: editMembers,
        tech_leads: editTechLeads,
        reviewer_pool: editReviewerPool,
        default_validation_track: editTrack,
        default_language: editLanguage,
      });
      setEditing(false);
      addToast('success', 'Project updated');
      onUpdate();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const allUserIds = useMemo(
    () => [...(project.owner_user_id ? [project.owner_user_id] : []), ...(project.members ?? []), ...project.reviewer_pool, ...project.tech_leads],
    [project.owner_user_id, project.members, project.reviewer_pool, project.tech_leads],
  );
  const userMap = useUserMap(allUserIds);

  const track = project.default_validation_track ?? 'direct';

  return (
    <div className="space-y-6">
      {/* Project Settings Card */}
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-5">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide">Project Settings</h3>
          {canEdit && (
            <button
              onClick={openEditModal}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
              </svg>
              Edit
            </button>
          )}
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Project ID</dt>
            <dd className="mt-1 text-sm font-mono text-gray-700 dark:text-gray-300">{project.project_id}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Default Validation Track</dt>
            <dd className="mt-1">
              <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                track === 'manual'
                  ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400'
                  : 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400'
              }`}>
                {track === 'manual' ? 'Manual' : 'Direct'}
              </span>
            </dd>
          </div>
          {project.owner_user_id && (
            <div>
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Owner</dt>
              <dd className="mt-1">
                <span className="inline-flex items-center rounded bg-green-50 dark:bg-green-950/50 px-2 py-0.5 text-xs text-green-700 dark:text-green-400">
                  {userMap[project.owner_user_id]?.display_name ?? project.owner_user_id}
                </span>
              </dd>
            </div>
          )}
          {project.default_evidence_policy_id && (
            <div>
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Evidence Policy</dt>
              <dd className="mt-1 text-sm font-mono text-gray-700 dark:text-gray-300">{project.default_evidence_policy_id}</dd>
            </div>
          )}
          {project.default_rule_set_refs.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Rule Sets</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {project.default_rule_set_refs.map((r) => (
                  <span key={r} className="inline-flex items-center rounded bg-purple-50 dark:bg-purple-950/50 px-2 py-0.5 text-xs font-mono text-purple-700 dark:text-purple-400">{r}</span>
                ))}
              </dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium text-gray-500 dark:text-gray-400">Created</dt>
            <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              <RelativeTime timestamp={project.created_at} mode="absolute" />
              <span className="mx-1.5" aria-hidden="true">·</span>
              <RelativeTime timestamp={project.updated_at} prefix="Updated" />
            </dd>
          </div>
        </dl>
      </div>

      {/* Team Card */}
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-4">Team</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center rounded-md bg-surface-base dark:bg-surface-base px-3 py-2">
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{(project.members ?? []).length}</p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">Members</p>
          </div>
          <div className="text-center rounded-md bg-surface-base dark:bg-surface-base px-3 py-2">
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{project.reviewer_pool.length}</p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">Reviewers</p>
          </div>
          <div className="text-center rounded-md bg-surface-base dark:bg-surface-base px-3 py-2">
            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{project.tech_leads.length}</p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">Tech Leads</p>
          </div>
        </div>

        {(project.members ?? []).length > 0 ? (
          <div className="space-y-1.5">
            {(project.members ?? []).map((memberId) => {
              const u = userMap[memberId];
              const isReviewer = project.reviewer_pool.includes(memberId);
              const isTechLead = project.tech_leads.includes(memberId);
              return (
                <div key={memberId} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-base dark:hover:bg-border-subtle transition-colors">
                  <div className="h-6 w-6 rounded-full bg-secondary-100 dark:bg-secondary-900/50 flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-medium text-secondary-700 dark:text-secondary-300">
                      {(u?.display_name || memberId).charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <span className="text-sm text-gray-900 dark:text-gray-100 flex-1 min-w-0 truncate">
                    {u?.display_name ?? memberId}
                  </span>
                  <div className="flex gap-1 flex-shrink-0">
                    {isTechLead && (
                      <span className="inline-flex items-center rounded bg-secondary-50 dark:bg-secondary-950/50 px-1.5 py-0.5 text-[10px] font-medium text-secondary-700 dark:text-secondary-400">
                        Tech Lead
                      </span>
                    )}
                    {isReviewer && (
                      <span className="inline-flex items-center rounded bg-blue-50 dark:bg-blue-950/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                        Reviewer
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-500">No members added yet. Edit the project to add team members.</p>
        )}

        {/* Reviewer pool members not in members list */}
        {project.reviewer_pool.filter((r) => !(project.members ?? []).includes(r)).length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-border-subtle">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Additional Reviewers</p>
            <div className="flex flex-wrap gap-1">
              {project.reviewer_pool.filter((r) => !(project.members ?? []).includes(r)).map((r) => (
                <span key={r} className="inline-flex items-center rounded bg-blue-50 dark:bg-blue-950/50 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                  {userMap[r]?.display_name ?? r}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Tech leads not in members list */}
        {project.tech_leads.filter((l) => !(project.members ?? []).includes(l)).length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-border-subtle">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Additional Tech Leads</p>
            <div className="flex flex-wrap gap-1">
              {project.tech_leads.filter((l) => !(project.members ?? []).includes(l)).map((l) => (
                <span key={l} className="inline-flex items-center rounded bg-secondary-50 dark:bg-secondary-950/50 px-1.5 py-0.5 text-xs text-secondary-700 dark:text-secondary-400">
                  {userMap[l]?.display_name ?? l}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Lifecycle Profile */}
      <LifecycleSection project={project} onUpdate={onUpdate} />

      {/* Edit Project Modal */}
      {editing && (
        <EditProjectModal
          editName={editName}
          setEditName={setEditName}
          editDescription={editDescription}
          setEditDescription={setEditDescription}
          editMembers={editMembers}
          setEditMembers={setEditMembers}
          editTechLeads={editTechLeads}
          setEditTechLeads={setEditTechLeads}
          editReviewerPool={editReviewerPool}
          setEditReviewerPool={setEditReviewerPool}
          editTrack={editTrack}
          setEditTrack={setEditTrack}
          editLanguage={editLanguage}
          setEditLanguage={setEditLanguage}
          saving={saving}
          saveError={saveError}
          onSave={handleSave}
          onClose={() => { setEditing(false); setSaveError(null); }}
        />
      )}
    </div>
  );
}

/* ── Integrations Tab ──────────────────────────────────────────── */

function IntegrationsTab({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Configure how this project talks to AI providers and chat platforms.
      </p>

      {/* AI Model Overrides — most-edited setting, listed first */}
      <LlmOverridesSection project={project} onUpdate={onUpdate} />

      {/* Google Chat Webhook */}
      <WebhookSection project={project} onUpdate={onUpdate} />
    </div>
  );
}

/* ── Repositories Tab ──────────────────────────────────────────── */

function RepositoriesTab({ project }: { project: Project }) {
  const { data: reposData, mutate: mutateRepos } = useSWR(
    ['project-repos', project.project_id],
    () => api.projects.repositories(project.project_id),
  );
  const repos = reposData?.repositories ?? [];
  const [showAddRepo, setShowAddRepo] = useState(false);
  const { addToast } = useToast();

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/webhooks/git`
    : 'https://<your-domain>/api/webhooks/git';

  return (
    <div className="space-y-6">
      {/* Repository list */}
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-border-subtle px-5 py-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Repositories ({repos.length})
          </h3>
          <button
            onClick={() => setShowAddRepo(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Repository
          </button>
        </div>

        {repos.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">No repositories linked yet.</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Add a repository to enable webhook-based case creation.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {repos.map((repo) => (
              <RepoRow
                key={repo.repository_id}
                repo={repo}
                projectId={project.project_id}
                onUpdated={() => mutateRepos()}
                onDelete={async () => {
                  try {
                    await api.projects.deleteRepository(project.project_id, repo.repository_id);
                    addToast('success', 'Repository removed');
                    mutateRepos();
                  } catch (err) {
                    addToast('error', err instanceof Error ? err.message : 'Failed to remove repository');
                  }
                }}
              />
            ))}
          </ul>
        )}

        {showAddRepo && (
          <AddRepoForm
            projectId={project.project_id}
            onAdded={() => { mutateRepos(); setShowAddRepo(false); }}
            onCancel={() => setShowAddRepo(false)}
          />
        )}
      </div>

      {/* Webhook Setup Hint */}
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 px-4 py-3">
        <div className="flex items-start gap-2">
          <svg className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          <div>
            <p className="text-xs font-medium text-blue-700 dark:text-blue-400">Webhook Setup</p>
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
              To enable automatic case creation from Pull Requests, configure a webhook in your GitHub repository:
            </p>
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
              Repository Settings &rarr; Webhooks &rarr; Add webhook &rarr; Payload URL:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 rounded bg-blue-100 dark:bg-blue-900/50 px-2 py-1 text-xs font-mono text-blue-800 dark:text-blue-300 truncate">
                {webhookUrl}
              </code>
              <CopyButton text={webhookUrl} />
            </div>
            <p className="text-[11px] text-blue-500 dark:text-blue-500 mt-1.5">
              Events: Pull requests, Pushes. Content type: application/json.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Rules Tab ────────────────────────────────────────────────── */

function RulesTab({ projectId }: { projectId: string }) {
  const { data, isLoading, mutate } = useSWR(
    ['project-rules', projectId],
    () => api.rules.list(),
  );

  const [showWizard, setShowWizard] = useState(false);
  const [editingRuleSet, setEditingRuleSet] = useState<RuleSet | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);

  const ruleSets = data?.ruleSets ?? [];
  const rules = data?.rules ?? [];

  const filteredRuleSets = ruleSets.filter(
    (rs) => rs.project_id === projectId || !rs.project_id,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Rules define automated checks that run on every case during validation — metadata checks, diff pattern analysis, LLM evaluation, and more. A rule set groups related rules and can be activated per project.
        </p>
        <button
          onClick={() => setShowWizard(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent-700 px-3 py-2 text-sm font-medium text-white hover:bg-accent-800 transition-colors flex-shrink-0 ml-4"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Create Rule Set
        </button>
      </div>
      <RuleSetList
        ruleSets={filteredRuleSets}
        rules={rules}
        onRuleStatusChange={() => mutate()}
        onEditRuleSet={(rs) => setEditingRuleSet(rs)}
        onEditRule={(r) => setEditingRule(r)}
      />
      {showWizard && (
        <RuleSetWizard
          projectId={projectId}
          onClose={() => setShowWizard(false)}
          onCreated={() => { setShowWizard(false); mutate(); }}
        />
      )}
      {editingRuleSet && (
        <RuleSetEditorModal
          ruleSet={editingRuleSet}
          rules={rules.filter((r) => editingRuleSet.rule_refs.includes(r.rule_id))}
          allRules={rules}
          projectId={projectId}
          onClose={() => setEditingRuleSet(null)}
          onSaved={() => { setEditingRuleSet(null); mutate(); }}
        />
      )}
      {editingRule && (
        <RuleEditorModal
          rule={editingRule}
          onClose={() => setEditingRule(null)}
          onSaved={() => { setEditingRule(null); mutate(); }}
        />
      )}
    </div>
  );
}

/* ── Evidence Policy Tab ──────────────────────────────────────── */

/** Default rules for a newly created evidence policy. */
function buildDefaultPolicyRules(): EvidencePolicyRulesMap {
  return {
    low: {
      direct: { required_evidence_types: ['ci_result'], optional_evidence_types: ['unit_test_result'], four_eyes_required: false, allow_self_approval: false },
      manual: { required_evidence_types: ['manual_confirmation'], optional_evidence_types: [], four_eyes_required: false, allow_self_approval: false },
    },
    medium: {
      direct: { required_evidence_types: ['ci_result', 'unit_test_result'], optional_evidence_types: ['lint_result'], four_eyes_required: false, allow_self_approval: false },
      manual: { required_evidence_types: ['manual_confirmation'], optional_evidence_types: ['screenshot'], four_eyes_required: false, allow_self_approval: false },
    },
    high: {
      direct: { required_evidence_types: ['ci_result', 'unit_test_result', 'integration_test_result'], optional_evidence_types: ['lint_result'], four_eyes_required: false, allow_self_approval: false },
      manual: { required_evidence_types: ['manual_confirmation', 'screenshot'], optional_evidence_types: [], four_eyes_required: true, allow_self_approval: false },
    },
    critical: {
      direct: { required_evidence_types: ['ci_result', 'unit_test_result', 'integration_test_result'], optional_evidence_types: ['benchmark_result'], four_eyes_required: true, allow_self_approval: false },
      manual: { required_evidence_types: ['manual_confirmation', 'screenshot'], optional_evidence_types: [], four_eyes_required: true, allow_self_approval: false },
    },
  };
}

function EvidenceTab({ projectId }: { projectId: string }) {
  const { data, isLoading, mutate } = useSWR(
    ['project-evidence', projectId],
    () => api.evidencePolicies.list(),
  );
  const [creating, setCreating] = useState(false);

  const policies = data?.policies ?? [];
  const policy = policies.find((p) => p.project_id === projectId);

  async function handleCreatePolicy() {
    setCreating(true);
    try {
      await api.evidencePolicies.create({
        project_id: projectId,
        rules: buildDefaultPolicyRules(),
      });
      await mutate();
    } finally {
      setCreating(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Policies define what evidence is required before a case can progress to review — CI results, test outputs, screenshots, manual confirmations. Requirements are configured per risk level and validation track.
      </p>
      {policy ? (
        <PolicyEditor policy={policy} onPolicyUpdated={() => mutate()} />
      ) : (
        <EmptyState
          title="No evidence policy"
          description="This project does not have an evidence policy yet. Create one with sensible defaults to get started."
          action={{
            label: creating ? 'Creating...' : 'Create Policy',
            onClick: handleCreatePolicy,
            disabled: creating,
          }}
        />
      )}
    </div>
  );
}

/* ── Shared Sub-components ─────────────────────────────────────── */

function RepoRow({ repo, projectId, onUpdated, onDelete }: { repo: Repository; projectId: string; onUpdated: () => void; onDelete: () => void }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEscapeKey(() => { setShowConfirm(false); setShowEdit(false); }, showConfirm || showEdit);

  const providerLabels: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    other: 'Other',
  };

  // Surface the push-only hook warning once the backend has detected it.
  // The backend only stamps `webhook_misconfig_warned_at` when the hook has
  // delivered a `push` without ever delivering a `pull_request` more than 24h
  // after the repo was registered — i.e. the subscription is almost certainly
  // missing the `pull_request` event. Clears automatically once any
  // `pull_request` event arrives and flips `pull_request_event_seen_at`.
  const showMisconfigWarning = Boolean(
    repo.webhook_misconfig_warned_at && !repo.pull_request_event_seen_at,
  );

  return (
    <>
      <li className="px-5 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{repo.name}</span>
            <span className="inline-flex items-center rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase">
              {providerLabels[repo.provider] ?? repo.provider}
            </span>
            {repo.github_token && (
              <span className="inline-flex items-center rounded bg-green-50 dark:bg-green-900/30 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                Token set
              </span>
            )}
          </div>
          {repo.url && (
            <a
              href={repo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-accent-700 dark:hover:text-accent-300 font-mono truncate block"
            >
              {repo.url}
            </a>
          )}
          <p className="text-[10px] text-gray-400 dark:text-gray-500 font-mono mt-0.5">{repo.repository_id}</p>
          {showMisconfigWarning && (
            <div
              role="alert"
              className="mt-2 rounded border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200"
            >
              Webhook is subscribed only to <code className="font-mono">push</code>. Add{' '}
              <code className="font-mono">pull_request</code> so merges auto-close cases.{' '}
              <a href="/docs#git-webhooks" className="underline hover:no-underline">Setup guide</a>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setShowEdit(!showEdit)}
            className="text-gray-300 dark:text-gray-600 hover:text-accent-700 dark:hover:text-accent-300 transition-colors"
            title="Edit repository"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
            </svg>
          </button>
          <button
            onClick={() => setShowConfirm(true)}
            className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
            title="Remove repository"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>
        </div>
      </li>

      {showEdit && (
        <EditRepoForm
          repo={repo}
          projectId={projectId}
          onSaved={() => { onUpdated(); setShowEdit(false); }}
          onCancel={() => setShowEdit(false)}
        />
      )}

      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowConfirm(false); }}
        >
          <div className="mx-4 w-full max-w-sm rounded-lg bg-surface-raised shadow-xl">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
                  <svg className="h-5 w-5 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Remove Repository</h3>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Remove <strong>{repo.name}</strong> from this project? Existing cases linked to this repository will not be affected.
              </p>
            </div>
            <div className="border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await onDelete();
                  } finally {
                    setDeleting(false);
                    setShowConfirm(false);
                  }
                }}
                disabled={deleting}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AddRepoForm({ projectId, onAdded, onCancel }: { projectId: string; onAdded: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'other'>('github');
  const [githubToken, setGithubToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();

  useEscapeKey(onCancel, true);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.projects.addRepository(projectId, {
        name: name.trim(),
        url: url.trim(),
        provider,
        github_token: githubToken.trim() || undefined,
      });
      addToast('success', 'Repository added');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add repository');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-gray-200 dark:border-border-subtle px-5 py-4 space-y-3">
      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">Add Repository</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-repo"
            className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab' | 'other')}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">URL</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </div>
      {provider === 'github' && (
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            GitHub Token <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="ghp_..."
            className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">One token can be reused across repositories. Leave empty if a global GITHUB_TOKEN is configured on the server (recommended); only needed for private repos the global token cannot access.</p>
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !name.trim() || !url.trim()}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
        >
          {saving ? 'Adding...' : 'Add'}
        </button>
      </div>
    </form>
  );
}

function EditRepoForm({ repo, projectId, onSaved, onCancel }: { repo: Repository; projectId: string; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(repo.name);
  const [url, setUrl] = useState(repo.url ?? '');
  const [provider, setProvider] = useState<'github' | 'gitlab' | 'other'>(repo.provider);
  const [githubToken, setGithubToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maskedToken = repo.github_token || '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updates: { name?: string; url?: string; provider?: Repository['provider']; github_token?: string } = {};
      if (name.trim() !== repo.name) updates.name = name.trim();
      if (url.trim() !== (repo.url ?? '')) updates.url = url.trim();
      if (provider !== repo.provider) updates.provider = provider;
      if (githubToken.trim()) {
        updates.github_token = githubToken.trim();
      } else if (clearToken && repo.github_token) {
        updates.github_token = '';
      }
      if (Object.keys(updates).length === 0) {
        onSaved();
        return;
      }
      await api.projects.updateRepository(projectId, repo.repository_id, updates);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update repository');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-gray-200 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 px-5 py-4 space-y-3">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Edit Repository</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. my-service"
            className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab' | 'other')}
            className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">URL</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </div>
      {provider === 'github' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">GitHub Token</label>
          {maskedToken && !clearToken && (
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">Current: {maskedToken}</span>
              <button
                type="button"
                onClick={() => setClearToken(true)}
                className="text-[11px] text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
              >
                Remove token
              </button>
            </div>
          )}
          {clearToken && !githubToken.trim() && (
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs text-red-500 dark:text-red-400">Token will be removed on save.</span>
              <button
                type="button"
                onClick={() => setClearToken(false)}
                className="text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Undo
              </button>
            </div>
          )}
          <input
            type="password"
            value={githubToken}
            onChange={(e) => { setGithubToken(e.target.value); if (e.target.value.trim()) setClearToken(false); }}
            placeholder={maskedToken ? 'Enter new token to replace' : 'ghp_... (optional, falls back to global)'}
            className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            autoComplete="off"
          />
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">Optional — falls back to the server&apos;s global GITHUB_TOKEN if not set; only needed for private repos the global token cannot access. Leave empty to keep current token.</p>
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Cancel</button>
        <button
          type="submit"
          disabled={saving || !name.trim()}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </form>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="flex-shrink-0 rounded bg-blue-100 dark:bg-blue-900/50 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

/* ── Edit Project Modal ────────────────────────────────────────── */

function EditProjectModal({
  editName, setEditName,
  editDescription, setEditDescription,
  editMembers, setEditMembers,
  editTechLeads, setEditTechLeads,
  editReviewerPool, setEditReviewerPool,
  editTrack, setEditTrack,
  editLanguage, setEditLanguage,
  saving, saveError,
  onSave, onClose,
}: {
  editName: string; setEditName: (v: string) => void;
  editDescription: string; setEditDescription: (v: string) => void;
  editMembers: string[]; setEditMembers: (v: string[]) => void;
  editTechLeads: string[]; setEditTechLeads: (v: string[]) => void;
  editReviewerPool: string[]; setEditReviewerPool: (v: string[]) => void;
  editTrack: 'direct' | 'manual'; setEditTrack: (v: 'direct' | 'manual') => void;
  editLanguage: 'en' | 'de'; setEditLanguage: (v: 'en' | 'de') => void;
  saving: boolean; saveError: string | null;
  onSave: () => void; onClose: () => void;
}) {
  // User picker for members, reviewers, tech leads
  const { data: usersData } = useSWR('all-users', () => api.users.list());
  const allUsers = usersData?.users ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="mx-4 w-full max-w-lg rounded-lg bg-surface-raised shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-surface-raised border-b border-gray-200 dark:border-border-subtle px-6 py-4 z-10">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Project</h3>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default Validation Track</label>
            <select
              value={editTrack}
              onChange={(e) => setEditTrack(e.target.value as 'direct' | 'manual')}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            >
              <option value="direct">Direct</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default language</label>
            <select
              value={editLanguage}
              onChange={(e) => setEditLanguage(e.target.value as 'en' | 'de')}
              className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Language IDE agents use for case comments &amp; descriptions.</p>
          </div>

          <UserListEditor
            label="Members"
            description="Users who can view and work on cases in this project"
            selected={editMembers}
            onChange={setEditMembers}
            allUsers={allUsers}
          />
          <UserListEditor
            label="Reviewer Pool"
            description="Users eligible to review cases"
            selected={editReviewerPool}
            onChange={setEditReviewerPool}
            allUsers={allUsers}
          />
          <UserListEditor
            label="Tech Leads"
            description="Users with elevated decision authority"
            selected={editTechLeads}
            onChange={setEditTechLeads}
            allUsers={allUsers}
          />

          {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}
        </div>
        <div className="sticky bottom-0 bg-surface-raised border-t border-gray-200 dark:border-border-subtle px-6 py-4 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving || !editName.trim()}
            className="rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserListEditor({
  label, description, selected, onChange, allUsers,
}: {
  label: string;
  description: string;
  selected: string[];
  onChange: (v: string[]) => void;
  allUsers: Array<{ user_id: string; display_name: string; email: string }>;
}) {
  const [input, setInput] = useState('');

  const available = allUsers.filter((u) => !selected.includes(u.user_id));
  const filtered = input.trim()
    ? available.filter((u) =>
        u.display_name.toLowerCase().includes(input.toLowerCase()) ||
        u.email.toLowerCase().includes(input.toLowerCase())
      )
    : [];

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-0.5">{label}</label>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{description}</p>

      {/* Selected pills */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {selected.map((id) => {
            const u = allUsers.find((u) => u.user_id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                {u?.display_name ?? id}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((s) => s !== id))}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                >
                  &times;
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search users..."
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
        />
        {filtered.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-md border border-gray-200 dark:border-border-subtle bg-surface-raised shadow-lg max-h-40 overflow-y-auto">
            {filtered.slice(0, 10).map((u) => (
              <button
                key={u.user_id}
                type="button"
                onClick={() => {
                  onChange([...selected, u.user_id]);
                  setInput('');
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-gray-700 transition-colors"
              >
                <span className="text-gray-900 dark:text-gray-100">{u.display_name}</span>
                <span className="text-gray-400 dark:text-gray-500 ml-2 text-xs">{u.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
