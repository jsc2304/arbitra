import type { Case } from '@arbitra/shared';
import { EventService } from '../event/event-service.js';
import { WorkspaceEventService } from '../workspace-event/workspace-event-service.js';
import { parsePrUrl } from '../diff/diff-resolver.js';
import { WebhookService } from './webhook-service.js';
import { fetchPullRequestDetails } from './github-adapter.js';
import {
  publishCaseCommitStatus,
  publishNoCaseCommitStatus,
  type CommitStatusState,
  type PublishCommitStatusResult,
} from './commit-status-service.js';

/**
 * Operator escape hatch for a required `arbitra/case` status check (issue
 * #1032). Once that context is REQUIRED in a repo's branch protection, a PR
 * whose head SHA never got a status is unmergeable with no self-service
 * recovery — this is that recovery: an admin can force a fresh publish
 * attempt for any PR without touching branch protection.
 *
 * Either a full PR URL, or `owner`/`repo`/`prNumber` — exactly one shape is
 * required, `resolvePrRef` below rejects anything else.
 */
export interface RepublishCommitStatusInput {
  prUrl?: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
}

export type RepublishCommitStatusResult =
  | {
    ok: true;
    prUrl: string;
    caseId: string | null;
    state: CommitStatusState;
    auditEventId: string;
  }
  | { ok: false; reason: string; prUrl?: string };

/**
 * Injectable seams for testing — defaults are the real production
 * collaborators.
 *
 * `resolveCase` defaults to `WebhookService.resolveCaseForPrRecovery`, the
 * SAME resolution ladder (branch-name case id → PR-text case id →
 * `findCaseByBranch` → `current_pr_ref`) `handleGitWebhook` runs — not a
 * re-implementation. `publishCase`/`publishNoCase` default to the exact
 * same publish functions the webhook path calls
 * (`publishCaseCommitStatus`, `publishNoCaseCommitStatus`). Sharing both
 * seams, not re-implementing either, is what guarantees a manual
 * re-publish can never compute a different verdict — or attach to a
 * different case — than the webhook would.
 */
export interface RepublishCommitStatusDeps {
  fetchPrDetails?: typeof fetchPullRequestDetails;
  resolveCase?: (input: {
    owner: string;
    repo: string;
    branch: string;
    title: string;
    body: string;
    prUrl: string;
  }) => Promise<{ repositoryRegistered: boolean; repositoryId?: string; case: Case | null }>;
  publishCase?: typeof publishCaseCommitStatus;
  publishNoCase?: typeof publishNoCaseCommitStatus;
  eventService?: EventService;
  workspaceEventService?: WorkspaceEventService;
}

interface ResolvedPrRef {
  owner: string;
  repo: string;
  number: number;
  prUrl: string;
}

/**
 * Normalizes a `RepublishCommitStatusInput` into `{owner, repo, number}`
 * plus the canonical `https://github.com/<owner>/<repo>/pull/<number>`
 * form the rest of this module expects. A `prUrl` is re-parsed (not used
 * verbatim) so a URL with a trailing slash, extra query string, or `.diff`
 * suffix still resolves to the same canonical ref the webhook stored on
 * `case_.current_pr_ref`.
 */
function resolvePrRef(input: RepublishCommitStatusInput): ResolvedPrRef | null {
  if (input.prUrl) {
    const parsed = parsePrUrl(input.prUrl);
    if (!parsed) return null;
    return {
      ...parsed,
      prUrl: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`,
    };
  }
  if (
    input.owner
    && input.repo
    && input.prNumber !== undefined
    && Number.isInteger(input.prNumber)
    && input.prNumber > 0
  ) {
    return {
      owner: input.owner,
      repo: input.repo,
      number: input.prNumber,
      prUrl: `https://github.com/${input.owner}/${input.repo}/pull/${input.prNumber}`,
    };
  }
  return null;
}

/**
 * Records the audit trail for an early-exit failure (PR lookup failed, or
 * the target repository isn't registered in Arbitra) — cases where no
 * `Case` was ever resolved, so the audit can only land on the workspace
 * activity feed, not a case timeline. Best-effort: a logging failure here
 * must never mask the real failure reason returned to the caller.
 */
async function recordEarlyFailureAudit(
  workspaceEventService: WorkspaceEventService,
  actorUserId: string,
  prUrl: string,
  reason: string,
): Promise<void> {
  try {
    await workspaceEventService.record({
      type: 'commit_status_republished',
      actor_user_id: actorUserId,
      summary: `Manual arbitra/case re-publish for PR ${prUrl} failed: ${reason}`,
      evidence: { pr_url: prUrl, published: false, failure_reason: reason },
    });
  } catch (err) {
    console.error(`[commit-status-admin] Failed to record audit for ${prUrl}:`, err);
  }
}

/**
 * Re-publishes the `arbitra/case` commit status for a PR, on demand.
 *
 * Resolution and verdict mirror the webhook path exactly:
 *   1. Fetch the PR's current head SHA, branch, title, and body from
 *      GitHub (`fetchPullRequestDetails`) — this endpoint has no webhook
 *      payload of its own to read those from.
 *   2. Resolve the case through `WebhookService.resolveCaseForPrRecovery`
 *      — the SAME ladder `handleGitWebhook` uses (branch-name case id, PR
 *      text, `current_branch`, then `current_pr_ref`), read-only (no
 *      linking, no event emission as a side effect of a status
 *      re-publish). Also validates the target repository is registered in
 *      Arbitra at all (issue #1032, M1) — an unregistered repository is
 *      refused outright rather than falling through to a "no case,
 *      success" publish.
 *   3. A matched case publishes through `publishCaseCommitStatus` — the
 *      enforced-verdict mapping for a governed case, or the unconditional
 *      `success` for Observed/Assistant-Task cases. No matched case
 *      publishes through `publishNoCaseCommitStatus` (`success`,
 *      "no case — not enforced"), same as a PR the webhook could never
 *      link.
 *
 * None of the mapping or resolution logic is re-implemented here — see
 * `RepublishCommitStatusDeps`.
 *
 * Audited unconditionally: an event is recorded whether or not the publish
 * itself succeeds, so a failed re-publish attempt (still no head SHA,
 * GitHub still down, repository not registered) is as visible as a
 * successful one. Attached to the case timeline (`CaseEvent`, type
 * `commit_status_republished`) when a case was found, or to the workspace
 * activity feed (`WorkspaceEvent`, same type) when it was not.
 */
export async function republishCommitStatus(
  input: RepublishCommitStatusInput,
  actorUserId: string,
  deps: RepublishCommitStatusDeps = {},
): Promise<RepublishCommitStatusResult> {
  const fetchPrDetails = deps.fetchPrDetails ?? fetchPullRequestDetails;
  const resolveCase = deps.resolveCase
    ?? ((resolveInput) => new WebhookService().resolveCaseForPrRecovery(resolveInput));
  const publishCase = deps.publishCase ?? publishCaseCommitStatus;
  const publishNoCase = deps.publishNoCase ?? publishNoCaseCommitStatus;
  const eventService = deps.eventService ?? new EventService();
  const workspaceEventService = deps.workspaceEventService ?? new WorkspaceEventService();

  const ref = resolvePrRef(input);
  if (!ref) {
    return { ok: false, reason: 'invalid_pr_reference' };
  }
  const { owner, repo, number, prUrl } = ref;

  const details = await fetchPrDetails(owner, repo, number);
  if (!details) {
    await recordEarlyFailureAudit(workspaceEventService, actorUserId, prUrl, 'pr_lookup_failed');
    return { ok: false, reason: 'pr_lookup_failed', prUrl };
  }

  const resolution = await resolveCase({
    owner,
    repo,
    branch: details.branch,
    title: details.title,
    body: details.body,
    prUrl,
  });

  if (!resolution.repositoryRegistered) {
    await recordEarlyFailureAudit(workspaceEventService, actorUserId, prUrl, 'repository_not_registered');
    return { ok: false, reason: 'repository_not_registered', prUrl };
  }

  const case_ = resolution.case;

  const publishResult: PublishCommitStatusResult = case_
    ? await publishCase(case_, {}, { headSha: details.headSha, prRefOverride: prUrl })
    : await publishNoCase(prUrl, { headSha: details.headSha });

  const auditPayload: Record<string, unknown> = {
    pr_url: prUrl,
    case_id: case_?.case_id ?? null,
    published: publishResult.published,
    ...(publishResult.published
      ? { state: publishResult.state }
      : { failure_reason: publishResult.reason }),
  };

  let auditEventId: string;
  if (case_) {
    const summary = publishResult.published
      ? `Manually re-published arbitra/case status (${publishResult.state}) for PR ${prUrl}`
      : `Manual arbitra/case re-publish for PR ${prUrl} failed: ${publishResult.reason}`;
    const event = await eventService.emit(case_.case_id, 'commit_status_republished', {
      ...auditPayload,
      summary,
    }, actorUserId);
    auditEventId = event.event_id;
  } else {
    const summary = publishResult.published
      ? `Manually re-published arbitra/case status (${publishResult.state}) for PR ${prUrl} — no linked case`
      : `Manual arbitra/case re-publish for PR ${prUrl} failed: ${publishResult.reason} — no linked case`;
    const event = await workspaceEventService.record({
      type: 'commit_status_republished',
      actor_user_id: actorUserId,
      summary,
      evidence: auditPayload,
    });
    auditEventId = event.event_id;
  }

  if (!publishResult.published) {
    return { ok: false, reason: publishResult.reason, prUrl };
  }

  return {
    ok: true,
    prUrl,
    caseId: case_?.case_id ?? null,
    state: publishResult.state,
    auditEventId,
  };
}
