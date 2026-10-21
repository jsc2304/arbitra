'use client';

import Link from 'next/link';
import type { WorkspaceEventBlockProps } from './index';
import { CopyButton } from './copy-button';

// Extracts the owner/repo pair from the `github_full_name` stashed in the
// event's evidence. Returns null for malformed values so the block can fall
// back to the raw string without crashing.
function parseOwnerRepo(fullName: string | undefined): { owner: string; repo: string } | null {
  if (!fullName || typeof fullName !== 'string') return null;
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Detail body for `webhook_misconfigured` workspace events.
 *
 * Shape reference (emitted by WebhookService.checkWebhookSubscriptionHealth):
 *   evidence: {
 *     repo_id, project_id, github_full_name, hint
 *   }
 *
 * The backend does NOT currently stash the GitHub hook_id, so the CLI
 * one-liner uses a `{HOOK_ID}` placeholder and we ALSO render a UI-steps
 * block that walks the user through the repo settings page (the guaranteed
 * path). Last-warned timestamp falls back to `event.timestamp` when
 * `warned_at` is absent — the backend doesn't stash that either right now.
 */
export function WebhookMisconfiguredBlock({ event }: WorkspaceEventBlockProps) {
  const evidence = (event.evidence ?? {}) as {
    github_full_name?: string;
    project_id?: string;
    repo_id?: string;
    warned_at?: string;
    hook_id?: string | number;
  };

  const parsed = parseOwnerRepo(evidence.github_full_name);
  const displayName = evidence.github_full_name ?? evidence.repo_id ?? '(unknown repo)';
  const warnedAt = evidence.warned_at ?? event.timestamp;
  const hookIdSlot = evidence.hook_id != null ? String(evidence.hook_id) : '{HOOK_ID}';

  // The CLI one-liner is the canonical fix but it needs a hook id. Render
  // it with `{HOOK_ID}` when the id is missing so users can swap it after
  // listing their hooks (`gh api /repos/<owner>/<repo>/hooks`).
  const cliCommand = parsed
    ? `gh api -X PATCH /repos/${parsed.owner}/${parsed.repo}/hooks/${hookIdSlot} -f 'events[]=pull_request' -f 'events[]=push' -f 'events[]=repository'`
    : null;

  const settingsHref = parsed
    ? `https://github.com/${parsed.owner}/${parsed.repo}/settings/hooks`
    : null;

  const projectHref = evidence.project_id
    ? `/projects/${evidence.project_id}?tab=repositories`
    : null;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Repository
        </div>
        <div className="mt-1 font-mono text-gray-900 dark:text-gray-100">{displayName}</div>
      </div>

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Fix via UI
        </div>
        {settingsHref ? (
          <ol className="mt-1 list-decimal list-inside space-y-1 text-gray-700 dark:text-gray-300">
            <li>
              Open the repo&apos;s webhook settings at{' '}
              <a
                href={settingsHref}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline break-all"
              >
                {settingsHref}
              </a>
              .
            </li>
            <li>
              Edit the Arbitra webhook and enable the{' '}
              <code className="rounded bg-surface-base dark:bg-surface-base/40 px-1">Pull requests</code>{' '}
              event (keep{' '}
              <code className="rounded bg-surface-base dark:bg-surface-base/40 px-1">Pushes</code>{' '}
              enabled).
            </li>
            <li>Save. The warning clears on the next PR event Arbitra observes.</li>
          </ol>
        ) : (
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Open the repo&apos;s webhook settings on GitHub and add the{' '}
            <code className="rounded bg-surface-base dark:bg-surface-base/40 px-1">Pull requests</code>{' '}
            event.
          </p>
        )}
      </div>

      {cliCommand && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Fix via CLI
          </div>
          <div className="mt-1 flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-surface-base dark:bg-surface-base/40 p-2 font-mono text-xs text-gray-800 dark:text-gray-200">
              {cliCommand}
            </pre>
            <CopyButton value={cliCommand} ariaLabel="Copy CLI fix command" />
          </div>
          {evidence.hook_id == null && parsed && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Replace{' '}
              <code className="rounded bg-surface-base dark:bg-surface-base/40 px-1">{'{HOOK_ID}'}</code>{' '}
              with the id from{' '}
              <code className="rounded bg-surface-base dark:bg-surface-base/40 px-1">
                gh api /repos/{parsed.owner}/{parsed.repo}/hooks
              </code>
              .
            </p>
          )}
        </div>
      )}

      {projectHref && (
        <div>
          <Link href={projectHref} className="text-accent hover:underline text-sm">
            Open repository settings in Arbitra →
          </Link>
        </div>
      )}

      <div className="border-t border-gray-100 dark:border-border-subtle pt-2">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Last warned:{' '}
          <time title={warnedAt} dateTime={warnedAt}>
            {warnedAt}
          </time>
        </div>
      </div>
    </div>
  );
}
