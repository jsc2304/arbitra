'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { IdeAgentConnect } from './ide-agent-connect';
import { InitCommandTabs } from './init-command-tabs';

const TOTAL_STEPS = 5;

const STEP_LABELS = [
  'Create Project',
  'Connect Repository',
  'Configure Webhook',
  'Invite Team',
  'Install in IDE',
];

export function ProjectSetupWizard() {
  const router = useRouter();
  const { addToast } = useToast();

  const [currentStep, setCurrentStep] = useState(1);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultTrack, setDefaultTrack] = useState<'direct' | 'manual'>('direct');

  // Step 2
  const [repoName, setRepoName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoProvider, setRepoProvider] = useState<'github' | 'gitlab' | 'other'>('github');
  const [repoGithubToken, setRepoGithubToken] = useState('');

  // Step 3 — informational only, no state needed beyond copy

  // Step 4
  const [members, setMembers] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState('');
  const [reviewerPool, setReviewerPool] = useState<string[]>([]);
  const [reviewerInput, setReviewerInput] = useState('');
  const [techLeads, setTechLeads] = useState<string[]>([]);
  const [techLeadInput, setTechLeadInput] = useState('');

  // Step 5 — no token state. The unified Connect flow mints credentials in
  // the browser on the first MCP tool call (see /connect page + PR 4 MCP).

  // Copy button states
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const ARBITRA_URL = typeof window !== 'undefined' ? window.location.origin : '';

  function handleCopy(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  function addToList(
    value: string,
    list: string[],
    setList: (l: string[]) => void,
    setInput: (v: string) => void,
  ) {
    const trimmed = value.trim();
    if (trimmed && !list.includes(trimmed)) {
      setList([...list, trimmed]);
    }
    setInput('');
  }

  function removeFromList(
    value: string,
    list: string[],
    setList: (l: string[]) => void,
  ) {
    setList(list.filter((v) => v !== value));
  }

  async function handleStep1Submit() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const project = await api.projects.create({ name: name.trim(), description: description.trim() || undefined, default_validation_track: defaultTrack });
      setProjectId(project.project_id);
      setProjectName(project.name);
      addToast('success', `Project "${project.name}" created`);
      setCurrentStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSaving(false);
    }
  }

  async function handleStep2Submit() {
    if (!projectId || !repoName.trim() || !repoUrl.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.projects.addRepository(projectId, {
        name: repoName.trim(),
        url: repoUrl.trim(),
        provider: repoProvider,
        ...(repoGithubToken.trim() ? { github_token: repoGithubToken.trim() } : {}),
      });
      addToast('success', `Repository "${repoName.trim()}" connected`);
      setCurrentStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add repository');
    } finally {
      setSaving(false);
    }
  }

  async function handleStep4Submit() {
    if (!projectId) return;
    const hasChanges = members.length > 0 || reviewerPool.length > 0 || techLeads.length > 0;
    if (!hasChanges) {
      setCurrentStep(5);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.projects.update(projectId, {
        members,
        reviewer_pool: reviewerPool,
        tech_leads: techLeads,
      });
      addToast('success', 'Team members updated');
      setCurrentStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update team');
    } finally {
      setSaving(false);
    }
  }

  function handleCompleteSetup() {
    router.push(`/board?project_id=${projectId}`);
  }

  function handleNext() {
    setError(null);
    if (currentStep === 1) {
      handleStep1Submit();
    } else if (currentStep === 2) {
      handleStep2Submit();
    } else if (currentStep === 3) {
      setCurrentStep(4);
    } else if (currentStep === 4) {
      handleStep4Submit();
    } else if (currentStep === 5) {
      handleCompleteSetup();
    }
  }

  function handleSkip() {
    setError(null);
    if (currentStep < TOTAL_STEPS) {
      setCurrentStep(currentStep + 1);
    } else {
      handleCompleteSetup();
    }
  }

  function handleBack() {
    setError(null);
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  }

  const displayProjectIdForCmd = projectId ?? 'PROJECT_ID';

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Set Up Your Project
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Get your project connected to Arbitra in {TOTAL_STEPS} steps. Only the first step is required.
        </p>
      </div>

      {/* Step Indicator */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => {
            const step = i + 1;
            const isCompleted = step < currentStep;
            const isCurrent = step === currentStep;
            return (
              <div key={step} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                      isCompleted
                        ? 'bg-accent-700 text-white'
                        : isCurrent
                          ? 'bg-accent-700 text-white'
                          : 'border-2 border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500'
                    }`}
                  >
                    {isCompleted ? (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    ) : (
                      step
                    )}
                  </div>
                  <span
                    className={`mt-1.5 text-[10px] font-medium whitespace-nowrap ${
                      isCurrent
                        ? 'text-accent-700 dark:text-accent-300'
                        : isCompleted
                          ? 'text-gray-600 dark:text-gray-400'
                          : 'text-gray-400 dark:text-gray-500'
                    }`}
                  >
                    {STEP_LABELS[i]}
                  </span>
                </div>
                {step < TOTAL_STEPS && (
                  <div
                    className={`flex-1 h-0.5 mx-2 mt-[-1rem] ${
                      step < currentStep
                        ? 'bg-accent'
                        : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Step Content */}
      <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-6 mb-6">
        {currentStep === 1 && <Step1CreateProject
          name={name}
          setName={setName}
          description={description}
          setDescription={setDescription}
          defaultTrack={defaultTrack}
          setDefaultTrack={setDefaultTrack}
        />}

        {currentStep === 2 && <Step2ConnectRepository
          repoName={repoName}
          setRepoName={setRepoName}
          repoUrl={repoUrl}
          setRepoUrl={setRepoUrl}
          repoProvider={repoProvider}
          setRepoProvider={setRepoProvider}
          githubToken={repoGithubToken}
          setGithubToken={setRepoGithubToken}
        />}

        {currentStep === 3 && <Step3ConfigureWebhook
          arbiraUrl={ARBITRA_URL}
          onCopy={handleCopy}
          copiedField={copiedField}
        />}

        {currentStep === 4 && <Step4InviteTeam
          members={members}
          memberInput={memberInput}
          setMemberInput={setMemberInput}
          onAddMember={() => addToList(memberInput, members, setMembers, setMemberInput)}
          onRemoveMember={(v) => removeFromList(v, members, setMembers)}
          reviewerPool={reviewerPool}
          reviewerInput={reviewerInput}
          setReviewerInput={setReviewerInput}
          onAddReviewer={() => addToList(reviewerInput, reviewerPool, setReviewerPool, setReviewerInput)}
          onRemoveReviewer={(v) => removeFromList(v, reviewerPool, setReviewerPool)}
          techLeads={techLeads}
          techLeadInput={techLeadInput}
          setTechLeadInput={setTechLeadInput}
          onAddTechLead={() => addToList(techLeadInput, techLeads, setTechLeads, setTechLeadInput)}
          onRemoveTechLead={(v) => removeFromList(v, techLeads, setTechLeads)}
        />}

        {currentStep === 5 && <Step5IdeSetup
          arbitraUrl={ARBITRA_URL}
          projectIdForCmd={displayProjectIdForCmd}
          projectId={projectId}
          projectName={projectName}
        />}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <div>
          {currentStep > 1 && (
            <button
              onClick={handleBack}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            >
              Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {currentStep > 1 && currentStep < TOTAL_STEPS && (
            <button
              onClick={handleSkip}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            >
              Skip
            </button>
          )}
          <button
            onClick={handleNext}
            disabled={saving || (currentStep === 1 && !name.trim())}
            className="inline-flex items-center gap-2 rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
          >
            {saving && (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            {currentStep === TOTAL_STEPS ? 'Complete Setup' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Step Components ---- */

function Step1CreateProject({
  name,
  setName,
  description,
  setDescription,
  defaultTrack,
  setDefaultTrack,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  defaultTrack: 'direct' | 'manual';
  setDefaultTrack: (v: 'direct' | 'manual') => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Create Your Project
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        A project groups repositories, rules, and team members together.
      </p>

      <div className="space-y-4">
        <div>
          <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Project Name <span className="text-red-500">*</span>
          </label>
          <input
            id="project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., My App, Backend Services"
            className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="project-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description
          </label>
          <textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of what this project covers..."
            rows={3}
            className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none resize-none"
          />
        </div>

        <div>
          <label htmlFor="project-track" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Default Validation Track
          </label>
          <select
            id="project-track"
            value={defaultTrack}
            onChange={(e) => setDefaultTrack(e.target.value as 'direct' | 'manual')}
            className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          >
            <option value="direct">Direct — target system is programmatically accessible</option>
            <option value="manual">Manual — requires manual testing (e.g. remote desktop, hardware)</option>
          </select>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            New cases inherit this track unless explicitly overridden.
          </p>
        </div>
      </div>
    </div>
  );
}

function Step2ConnectRepository({
  repoName,
  setRepoName,
  repoUrl,
  setRepoUrl,
  repoProvider,
  setRepoProvider,
  githubToken,
  setGithubToken,
}: {
  repoName: string;
  setRepoName: (v: string) => void;
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  repoProvider: 'github' | 'gitlab' | 'other';
  setRepoProvider: (v: 'github' | 'gitlab' | 'other') => void;
  githubToken: string;
  setGithubToken: (v: string) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Connect a Repository
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Link a code repository so Arbitra can track pull requests and manage review cases.
      </p>

      <div className="space-y-4">
        <div>
          <label htmlFor="repo-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Repository Name
          </label>
          <input
            id="repo-name"
            type="text"
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="e.g., my-app"
            className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="repo-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Repository URL
          </label>
          <input
            id="repo-url"
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="e.g., https://github.com/org/repo"
            className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="repo-provider" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Provider
          </label>
          <select
            id="repo-provider"
            value={repoProvider}
            onChange={(e) => setRepoProvider(e.target.value as 'github' | 'gitlab' | 'other')}
            className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="other">Other</option>
          </select>
        </div>

        {repoProvider === 'github' && (
          <div>
            <label htmlFor="repo-github-token" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              GitHub Token
            </label>
            <input
              id="repo-github-token"
              type="password"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="ghp_... (optional)"
              className="w-full border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Optional — one token can be reused across all repositories. Leave empty if a global <code className="text-gray-500 dark:text-gray-400">GITHUB_TOKEN</code> is configured on the server (recommended for your own or org repos); only needed for private repositories the global token cannot access. Needs <code className="text-gray-500 dark:text-gray-400">repo</code> scope (read access).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Step3ConfigureWebhook({
  arbiraUrl,
  onCopy,
  copiedField,
}: {
  arbiraUrl: string;
  onCopy: (text: string, field: string) => void;
  copiedField: string | null;
}) {
  const webhookUrl = `${arbiraUrl}/api/webhooks/git`;

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Configure Webhook
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Set up a webhook so Arbitra can automatically create cases from pull requests.
      </p>

      {/* Webhook URL */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Webhook URL
        </label>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 select-all">
            {webhookUrl}
          </code>
          <button
            onClick={() => onCopy(webhookUrl, 'webhook-url')}
            className="rounded-md bg-gray-100 dark:bg-gray-700 px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors whitespace-nowrap"
          >
            {copiedField === 'webhook-url' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4">
        <h3 className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">Setup Instructions</h3>
        <ol className="space-y-2 text-sm text-blue-700 dark:text-blue-400">
          <li className="flex items-start gap-2">
            <span className="font-semibold flex-shrink-0">1.</span>
            <span>Go to your GitHub repository &rarr; <strong>Settings</strong> &rarr; <strong>Webhooks</strong> &rarr; <strong>Add webhook</strong></span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-semibold flex-shrink-0">2.</span>
            <span>Paste the URL above as the <strong>Payload URL</strong></span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-semibold flex-shrink-0">3.</span>
            <span>Set <strong>Content type</strong> to <code className="rounded bg-blue-100 dark:bg-blue-900/50 px-1">application/json</code></span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-semibold flex-shrink-0">4.</span>
            <span>
              Paste the <strong>Webhook Secret</strong> into the <strong>Secret</strong> field. Without a secret, GitHub sends unsigned deliveries and Arbitra rejects them (activity feed shows <em>&quot;Missing X-Hub-Signature-256 header&quot;</em>).
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-blue-600 dark:text-blue-400 hover:underline">How to retrieve the secret</summary>
                <div className="mt-1.5 ml-1 space-y-1 text-xs text-blue-700/90 dark:text-blue-400/90">
                  <p><strong>Arbitra admins:</strong> use the value of the server&apos;s <code className="rounded bg-blue-100 dark:bg-blue-900/50 px-1">GITHUB_WEBHOOK_SECRET</code> environment variable (kept in your secret manager).</p>
                  <p><strong>Developers:</strong> ask your Arbitra admin for the value — it&apos;s the same secret for every repo in this Arbitra instance.</p>
                </div>
              </details>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-semibold flex-shrink-0">5.</span>
            <span>Select <strong>individual events</strong>: <strong>Pull requests</strong>, <strong>Pushes</strong></span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function UserListSection({
  title,
  description,
  list,
  inputValue,
  setInputValue,
  onAdd,
  onRemove,
  inputId,
  placeholder,
}: {
  title: string;
  description: string;
  list: string[];
  inputValue: string;
  setInputValue: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  inputId: string;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-0.5">
        {title}
      </label>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">{description}</p>
      <div className="flex items-center gap-2 mb-2">
        <input
          id={inputId}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          className="flex-1 border border-gray-300 dark:border-border-default bg-input-bg rounded-md px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
        />
        <button
          onClick={onAdd}
          disabled={!inputValue.trim()}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
        >
          Add
        </button>
      </div>
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {list.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-border-subtle px-2.5 py-0.5 text-xs text-gray-700 dark:text-gray-300"
            >
              {item}
              <button
                onClick={() => onRemove(item)}
                className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Step4InviteTeam({
  members,
  memberInput,
  setMemberInput,
  onAddMember,
  onRemoveMember,
  reviewerPool,
  reviewerInput,
  setReviewerInput,
  onAddReviewer,
  onRemoveReviewer,
  techLeads,
  techLeadInput,
  setTechLeadInput,
  onAddTechLead,
  onRemoveTechLead,
}: {
  members: string[];
  memberInput: string;
  setMemberInput: (v: string) => void;
  onAddMember: () => void;
  onRemoveMember: (v: string) => void;
  reviewerPool: string[];
  reviewerInput: string;
  setReviewerInput: (v: string) => void;
  onAddReviewer: () => void;
  onRemoveReviewer: (v: string) => void;
  techLeads: string[];
  techLeadInput: string;
  setTechLeadInput: (v: string) => void;
  onAddTechLead: () => void;
  onRemoveTechLead: (v: string) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Invite Your Team
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Add team members by their email address. You can always change this later in project settings.
      </p>

      <div className="space-y-6">
        <UserListSection
          title="Members"
          description="General access to the project"
          list={members}
          inputValue={memberInput}
          setInputValue={setMemberInput}
          onAdd={onAddMember}
          onRemove={onRemoveMember}
          inputId="member-email"
          placeholder="user@example.com"
        />

        <UserListSection
          title="Reviewer Pool"
          description="Can review and provide feedback on cases"
          list={reviewerPool}
          inputValue={reviewerInput}
          setInputValue={setReviewerInput}
          onAdd={onAddReviewer}
          onRemove={onRemoveReviewer}
          inputId="reviewer-email"
          placeholder="reviewer@example.com"
        />

        <UserListSection
          title="Tech Leads"
          description="Can approve high-risk cases"
          list={techLeads}
          inputValue={techLeadInput}
          setInputValue={setTechLeadInput}
          onAdd={onAddTechLead}
          onRemove={onRemoveTechLead}
          inputId="tech-lead-email"
          placeholder="lead@example.com"
        />
      </div>
    </div>
  );
}

function Step5IdeSetup({
  arbitraUrl,
  projectIdForCmd,
  projectId,
  projectName,
}: {
  arbitraUrl: string;
  projectIdForCmd: string;
  projectId: string | null;
  projectName: string;
}) {
  return (
    <div>
      {/* Success header — the project is ready; the rest is "install the
          MCP server in your IDE" and the unified Connect flow handles the
          auth on the first tool call. No token generation here. */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40 p-4">
        <svg
          className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </svg>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-green-800 dark:text-green-200">
            Project ready
          </h2>
          <p className="mt-1 text-sm text-green-700 dark:text-green-300 leading-relaxed">
            &ldquo;{projectName}&rdquo; is set up. Next: install Arbitra in your
            IDE. The first tool call will connect this project automatically.
            <span className="block mt-1 text-xs text-green-700/80 dark:text-green-300/80">
              No tokens to copy. No env vars to set.
            </span>
          </p>
        </div>
      </div>

      {/* Per-IDE install snippet (Claude Code / Cursor / Codex / Other). */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          1. Install the MCP server in your IDE
        </h3>
        <IdeAgentConnect projectId={projectId} />
      </div>

      {/* Optional: drop .arbitra/ into the repo via the curl-pipe-bash
          script. Useful for Cursor (skill + slash commands + hooks live in
          .arbitra/ and .cursor/). Tokens are NOT written here. */}
      <div className="mb-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          2. Optional: drop <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono text-xs">.arbitra/</code> into your repo
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2 leading-relaxed">
          Writes <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">.arbitra/</code>{' '}
          (agent instructions: <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">AGENTS.md</code>,{' '}
          <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">CREATE-CASE.md</code>) and a project pin
          (<code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">.arbitra/.env</code> with{' '}
          <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">ARBITRA_URL</code> +{' '}
          <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 font-mono">ARBITRA_PROJECT_ID</code>).
          Skip this step if you only want the MCP server.
        </p>
        <InitCommandTabs
          url={arbitraUrl}
          projectId={projectIdForCmd}
        />
      </div>
    </div>
  );
}
