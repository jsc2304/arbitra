'use client';

/**
 * `<ConfirmPanel>` — the Tool / Device / Project rows + Confirm button.
 *
 * Spec: `docs/specs/device-flow-and-per-tool-tokens.md` §F.1, §J.2.
 *
 * Three project-state branches:
 *   - one match  → pre-selected, single confirm click
 *   - multi-match → picker seeded with matches first, then user's other projects
 *   - no match   → picker showing all projects + prominent "+ New project"
 *
 * The "+ New project" inline form calls `api.projects.create()` and auto-
 * selects the freshly-minted project.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Image from 'next/image';
import type { Project } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { formatExpiryCountdown, isExpired, useNowTick } from './connect-flow';

interface ProjectMatch {
  project_id: string;
  project_name: string;
  repositories: Array<{ repository_id: string; url: string; name: string }>;
}

interface ConfirmPanelProps {
  userCode: string;
  meta: {
    client_name: string;
    client_version?: string;
    device_label: string;
    repo_url?: string;
    repo_name?: string;
    expires_at: string;
  };
  matches: ProjectMatch[];
  allProjects: Project[];
  userEmail: string;
  userPhotoURL: string | null;
  onCancel: () => void;
  onApproved: (projectName: string) => void;
  onSwitchAccount: () => void;
  onNewProjectCreated: () => void;
}

/**
 * Title-case a normalized client_name for display. We don't try to cover every
 * possible MCP client — falls back to the raw slug capitalized at word
 * boundaries.
 */
export function formatClientName(clientName: string): string {
  const lookup: Record<string, string> = {
    cursor: 'Cursor',
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'arbitra-mcp-cli': 'Arbitra MCP (CLI)',
    'arbitra-mcp-unknown': 'Arbitra MCP',
  };
  if (lookup[clientName]) return lookup[clientName]!;
  return clientName
    .split('-')
    .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : s))
    .join(' ');
}

/**
 * Order projects so matches come first, then everything else from `allProjects`
 * that isn't already in the matches list. Stable sort within each group. Pure
 * helper — exported for tests.
 */
export function buildProjectOrder(
  matches: ProjectMatch[],
  allProjects: Project[],
): Array<{ project_id: string; project_name: string; matched: boolean }> {
  const matchIds = new Set(matches.map((m) => m.project_id));
  const ordered: Array<{ project_id: string; project_name: string; matched: boolean }> = [];
  for (const m of matches) {
    ordered.push({ project_id: m.project_id, project_name: m.project_name, matched: true });
  }
  for (const p of allProjects) {
    if (matchIds.has(p.project_id)) continue;
    ordered.push({ project_id: p.project_id, project_name: p.name, matched: false });
  }
  return ordered;
}

export function ConfirmPanel({
  userCode,
  meta,
  matches,
  allProjects,
  userEmail,
  userPhotoURL,
  onCancel,
  onApproved,
  onSwitchAccount,
  onNewProjectCreated,
}: ConfirmPanelProps) {
  const { addToast } = useToast();
  const [deviceLabel, setDeviceLabel] = useState(meta.device_label);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectOrder = useMemo(
    () => buildProjectOrder(matches, allProjects),
    [matches, allProjects],
  );

  // Auto-select the single match (spec §F.1 "One match").
  useEffect(() => {
    if (selectedProjectId) return;
    if (matches.length === 1) {
      setSelectedProjectId(matches[0]!.project_id);
    } else if (matches.length === 0 && allProjects.length === 1) {
      // No match but only one project available — convenience pre-select.
      setSelectedProjectId(allProjects[0]!.project_id);
    }
  }, [matches, allProjects, selectedProjectId]);

  const now = useNowTick(true);
  const expired = isExpired(meta.expires_at, now);
  const countdown = formatExpiryCountdown(meta.expires_at, now);

  async function handleCreateProject(e: FormEvent) {
    e.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    setCreatingProject(true);
    setError(null);
    try {
      const created = await api.projects.create({ name });
      setSelectedProjectId(created.project_id);
      setShowNewProject(false);
      setNewProjectName('');
      onNewProjectCreated();
      addToast('success', `Project "${created.name}" created`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleApprove() {
    if (!selectedProjectId) {
      setError('Pick a project first');
      return;
    }
    setApproving(true);
    setError(null);
    try {
      const result = await api.auth.connect.approve({
        user_code: userCode,
        project_id: selectedProjectId,
        device_label: deviceLabel.trim() || meta.device_label,
      });
      onApproved(result.project_name);
    } catch (err) {
      // Never log the raw token or secret — there's none in this scope, but the
      // error from the backend can include a generic message and we surface that.
      const message = err instanceof Error ? err.message : 'Failed to confirm';
      setError(message);
    } finally {
      setApproving(false);
    }
  }

  const toolDisplay = `${formatClientName(meta.client_name)}${meta.client_version ? ` ${meta.client_version}` : ''}`;
  const confirmDisabled = !selectedProjectId || approving || expired;

  return (
    <div className="mx-auto max-w-2xl py-8 px-4">
      {/* Wrong-account guard (§J.2) */}
      <header className="mb-6 flex items-center justify-between rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {userPhotoURL ? (
            <Image
              src={userPhotoURL}
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 rounded-full"
            />
          ) : (
            <div className="h-8 w-8 rounded-full bg-gray-200 dark:bg-gray-700" />
          )}
          <div className="min-w-0">
            <p className="text-xs text-gray-500 dark:text-gray-400">Signed in as</p>
            <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{userEmail}</p>
          </div>
        </div>
        <button
          onClick={onSwitchAccount}
          className="text-xs text-accent hover:underline"
          data-testid="switch-account"
        >
          Not you? Switch account
        </button>
      </header>

      <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
        Connect {formatClientName(meta.client_name)} to Arbitra
      </h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Confirm the tool, device, and project below — then this code becomes a token in your OS keychain.
      </p>

      <div className="mt-6 rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-raised divide-y divide-gray-100 dark:divide-gray-800">
        {/* Tool */}
        <div className="px-4 py-3 grid grid-cols-[auto_1fr] gap-x-4 items-center">
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Tool</span>
          <span className="text-sm text-gray-900 dark:text-gray-100">{toolDisplay}</span>
        </div>
        {/* Device label — editable */}
        <div className="px-4 py-3 grid grid-cols-[auto_1fr] gap-x-4 items-center">
          <label htmlFor="device-label-input" className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Device</label>
          <input
            id="device-label-input"
            type="text"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            className="rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2 py-1 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
            data-testid="device-label-input"
          />
        </div>
        {/* Project picker */}
        <div className="px-4 py-3 grid grid-cols-[auto_1fr] gap-x-4 items-start">
          <label htmlFor="project-select" className="pt-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Project</label>
          <div>
            {!showNewProject ? (
              <ProjectPicker
                projects={projectOrder}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                onNewProject={() => setShowNewProject(true)}
              />
            ) : (
              <form onSubmit={handleCreateProject} className="flex gap-2" data-testid="new-project-form">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="New project name"
                  autoFocus
                  className="flex-1 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => { setShowNewProject(false); setNewProjectName(''); }}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingProject || !newProjectName.trim()}
                  className="rounded-md bg-accent-700 px-3 py-1 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300"
                >
                  {creatingProject ? 'Creating…' : 'Create'}
                </button>
              </form>
            )}
            {matches.length > 0 && !showNewProject && (
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                {matches.length === 1
                  ? `Matched from ${matches[0]!.repositories[0]?.url ?? meta.repo_url ?? 'your repo'}`
                  : `${matches.length} projects match this repo`}
              </p>
            )}
            {matches.length === 0 && meta.repo_url && !showNewProject && (
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                No project matches <code className="font-mono">{meta.repo_url}</code> yet.
              </p>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-4 py-2 text-sm text-red-700 dark:text-red-300" role="alert">
          {error}
        </div>
      )}

      {expired && (
        <div className="mt-4 rounded-md border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950/50 px-4 py-2 text-sm text-yellow-700 dark:text-yellow-300" role="alert" data-testid="expired-banner">
          This code has expired. Start over from your IDE.
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          onClick={onCancel}
          className="rounded-md border border-gray-300 dark:border-border-default px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-surface-base"
          data-testid="cancel-button"
        >
          Cancel
        </button>
        <button
          onClick={handleApprove}
          disabled={confirmDisabled}
          className="rounded-md bg-accent-700 px-6 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500"
          data-testid="confirm-button"
        >
          {approving ? 'Connecting…' : 'Confirm'}
        </button>
      </div>

      <p className="mt-4 text-center text-xs text-gray-500 dark:text-gray-400" data-testid="countdown">
        Code: <span className="font-mono">{userCode}</span> — {expired ? 'expired' : `expires in ${countdown}`}
      </p>
    </div>
  );
}

interface ProjectPickerProps {
  projects: Array<{ project_id: string; project_name: string; matched: boolean }>;
  value: string;
  onChange: (id: string) => void;
  onNewProject: () => void;
}

/**
 * Lightweight project picker — uses a native `<select>` with an `optgroup`
 * separating matches from the rest. We avoid building a custom Combobox here
 * because the project doesn't ship one and `<select>` is keyboard-accessible
 * out of the box. Search across 200+ projects would push us to a Combobox in a
 * follow-up.
 */
function ProjectPicker({ projects, value, onChange, onNewProject }: ProjectPickerProps) {
  const matches = projects.filter((p) => p.matched);
  const others = projects.filter((p) => !p.matched);
  const noProjects = projects.length === 0;

  return (
    <div className="flex gap-2 items-center">
      <select
        id="project-select"
        value={value}
        onChange={(e) => {
          if (e.target.value === '__new__') {
            onNewProject();
            return;
          }
          onChange(e.target.value);
        }}
        className="flex-1 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
        data-testid="project-select"
      >
        <option value="">{noProjects ? 'No projects yet' : 'Choose a project…'}</option>
        {matches.length > 0 && (
          <optgroup label="Matched from your repo">
            {matches.map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.project_name}</option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label={matches.length > 0 ? 'Other projects' : 'Your projects'}>
            {others.map((p) => (
              <option key={p.project_id} value={p.project_id}>{p.project_name}</option>
            ))}
          </optgroup>
        )}
        <option value="__new__">+ New project…</option>
      </select>
      {noProjects && (
        <button
          type="button"
          onClick={onNewProject}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800"
          data-testid="new-project-cta"
        >
          + New project
        </button>
      )}
    </div>
  );
}
