'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { api } from '../../lib/api-client';
import { IdeAgentConnect } from '../setup/ide-agent-connect';
import { InitCommandTabs } from '../setup/init-command-tabs';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';

/**
 * Settings → IDE Agent panel. Mirrors the project-setup wizard's Step 5
 * shape: pick a project, install the MCP server in the IDE, optionally drop
 * `.arbitra/` into the repo. No token UI — the unified Connect flow mints
 * credentials in the browser on the first MCP tool call (see
 * `docs/specs/device-flow-and-per-tool-tokens.md`).
 */
export function SetupPanel() {
  const ARBITRA_URL = typeof window !== 'undefined' ? window.location.origin : '';
  const { data: projectsData } = useSWR('projects', () => api.projects.list());
  const projects = projectsData?.projects ?? [];

  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  const selectedProject = useMemo(
    () => (projectsData?.projects ?? []).find((p) => p.project_id === selectedProjectId) ?? null,
    [projectsData?.projects, selectedProjectId],
  );

  const { data: reposData } = useSWR(
    selectedProjectId ? `repos-${selectedProjectId}` : null,
    () => api.projects.repositories(selectedProjectId),
  );
  const repositories = reposData?.repositories ?? [];

  const displayProjectId = selectedProjectId || 'PROJECT_ID';

  return (
    <div className="max-w-3xl">
      <SectionHeader
        eyebrow
        title="IDE Agent Setup"
        description="Install Arbitra in your IDE. The first MCP tool call will print a one-time link to connect this project — no tokens to copy."
        className="mb-6"
      />

      {/* Step 1: Select Project */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-700 text-[10px] font-bold text-white">
            1
          </span>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">Select Project</h4>
        </div>
        <Card padding="compact">
          {projects.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No projects found. Create a project in the <strong>Projects</strong> tab first.
            </p>
          ) : (
            <>
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="">Choose a project...</option>
                {projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              </select>

              {selectedProject && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-300">Project ID:</span>
                    <code className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 font-mono text-gray-700 dark:text-gray-300">
                      {selectedProject.project_id}
                    </code>
                  </div>
                  {repositories.length > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      <span className="font-medium text-gray-700 dark:text-gray-300">Repositories:</span>
                      <ul className="mt-1 space-y-0.5 ml-2">
                        {repositories.map((repo) => (
                          <li key={repo.repository_id} className="flex items-center gap-1.5">
                            <svg className="h-3 w-3 text-gray-400 dark:text-gray-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                            </svg>
                            <code className="font-mono text-gray-700 dark:text-gray-300">{repo.name}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      </section>

      {/* Step 2: Install MCP server in the IDE */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-700 text-[10px] font-bold text-white">
            2
          </span>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">Install in your IDE</h4>
        </div>
        <Card padding="compact">
          <IdeAgentConnect projectId={selectedProjectId || null} />
        </Card>
      </section>

      {/* Step 3: Optional .arbitra/ bootstrap */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-700 text-[10px] font-bold text-white">
            3
          </span>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Optional: drop <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-xs">.arbitra/</code> into your repo
          </h4>
        </div>
        <Card padding="compact">
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-3 leading-relaxed">
            Run this in your repository root to write{' '}
            <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">.arbitra/</code>{' '}
            (agent instructions:{' '}
            <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">AGENTS.md</code>,{' '}
            <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">CREATE-CASE.md</code>)
            and a project pin (<code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">.arbitra/.env</code>{' '}
            with <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">ARBITRA_URL</code> +{' '}
            <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">ARBITRA_PROJECT_ID</code>).
            Skip if you only want the MCP server.
          </p>
          <InitCommandTabs
            url={ARBITRA_URL}
            projectId={displayProjectId}
          />
        </Card>
      </section>
    </div>
  );
}
