import { buildSignature } from '../detector-types.js';
import { openRepositoryToken } from '../../../lib/secret-box.js';
import type { Detector, DetectionResult, DetectorContext } from '../detector-types.js';

const ID = 'incomplete-repo-setup';

/**
 * Detector 6 — scans all projects and their linked repositories for missing or
 * broken GitHub webhook / auth configuration. Produces a nudge for each of
 * three distinct issues:
 *
 *   1. Webhook not receiving signed events — `github_repository_id` is absent,
 *      meaning no signed webhook event has ever arrived.
 *
 *   2. Webhook missing pull_request event — `webhook_misconfig_warned_at` is
 *      set but `pull_request_event_seen_at` is not, meaning only push events
 *      are arriving.
 *
 *   3. GitHub token not configured — `github_token` is absent or empty, so
 *      Arbitra cannot fetch PR details.
 *
 * Dedup is handled by the standard `intelligence_signature` mechanism: the
 * signature encodes the detector ID, target kind (`project`), and a stable
 * target ID derived from the repo and issue number. A nudge is skipped when a
 * non-terminal case with the same signature already exists.
 */
export const incompleteRepoSetupDetector: Detector = {
  id: ID,
  name: 'Incomplete repository setup',
  description:
    'Flags repositories with missing or broken GitHub webhook / auth configuration.',
  async run(ctx: DetectorContext): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];

    const [repos, projects] = await Promise.all([ctx.listRepositories(), ctx.listProjects()]);

    // Build a project_id → Project lookup so we can surface the project name.
    const projectById = new Map(projects.map((p) => [p.project_id, p]));

    for (const repo of repos) {
      const project = projectById.get(repo.project_id);
      const projectName = project?.name ?? repo.project_id;

      // ── Issue 1: no signed webhook event has ever arrived ────────────────
      if (!repo.github_repository_id) {
        results.push({
          detector_id: ID,
          signature: buildSignature(ID, 'project', `${repo.repository_id}:no-webhook`),
          target_kind: 'project',
          target_id: repo.project_id,
          title: `[${projectName}] Webhook not receiving signed events — ${repo.name}`,
          summary:
            `The GitHub webhook for \`${repo.name}\` has never delivered a signed event to Arbitra. ` +
            `This usually means the webhook is not installed or has no secret configured. ` +
            `Check the webhook settings at ${repo.url}/settings/hooks and make sure the Arbitra ` +
            `webhook URL is registered with a matching secret.`,
          evidence: {
            repository_id: repo.repository_id,
            repository_name: repo.name,
            repository_url: repo.url,
            issue: 'no_signed_webhook_event',
          },
          severity: 'medium',
          project_id: repo.project_id,
          repository_id: repo.repository_id,
        });
      }

      // ── Issue 2: webhook present but pull_request event never seen ───────
      if (repo.webhook_misconfig_warned_at && !repo.pull_request_event_seen_at) {
        results.push({
          detector_id: ID,
          signature: buildSignature(ID, 'project', `${repo.repository_id}:no-pr-event`),
          target_kind: 'project',
          target_id: repo.project_id,
          title: `[${projectName}] Webhook missing pull_request event — ${repo.name}`,
          summary:
            `The GitHub webhook for \`${repo.name}\` is delivering push events but no ` +
            `\`pull_request\` events have been received. Arbitra requires the \`pull_request\` ` +
            `event type to auto-link PRs to cases. ` +
            `Update the webhook at ${repo.url}/settings/hooks to include the \`pull_request\` event.`,
          evidence: {
            repository_id: repo.repository_id,
            repository_name: repo.name,
            repository_url: repo.url,
            webhook_misconfig_warned_at: repo.webhook_misconfig_warned_at,
            issue: 'missing_pull_request_event',
          },
          severity: 'medium',
          project_id: repo.project_id,
          repository_id: repo.repository_id,
        });
      }

      // ── Issue 3: GitHub token absent ─────────────────────────────────────
      // An undecryptable token (missing or rotated key) is as good as none.
      if (!openRepositoryToken(repo.github_token, repo.repository_id)) {
        results.push({
          detector_id: ID,
          signature: buildSignature(ID, 'project', `${repo.repository_id}:no-token`),
          target_kind: 'project',
          target_id: repo.project_id,
          title: `[${projectName}] GitHub token not configured — ${repo.name}`,
          summary:
            `No GitHub token is configured for \`${repo.name}\`. Without a token, Arbitra ` +
            `cannot fetch pull request details, reviewer lists, or check statuses. ` +
            `Add a GitHub personal access token (or GitHub App installation token) in the ` +
            `project settings for this repository.`,
          evidence: {
            repository_id: repo.repository_id,
            repository_name: repo.name,
            issue: 'missing_github_token',
          },
          severity: 'medium',
          project_id: repo.project_id,
          repository_id: repo.repository_id,
        });
      }
    }

    return results;
  },
};
