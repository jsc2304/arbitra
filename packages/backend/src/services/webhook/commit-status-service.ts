import type { Case, CaseStatus, Evidence, EvidenceType } from '@arbitra/shared';
import { SCOPED_CASE_TYPES, caseShareUrl } from '@arbitra/shared';
import { CompletenessEvaluator } from '../evidence/completeness-evaluator.js';
import { collections } from '../../lib/firestore.js';
import { parsePrUrl } from '../diff/diff-resolver.js';

/**
 * GitHub commit-status `context` Arbitra publishes under. Marking this string
 * as a REQUIRED status check in a repo's branch protection is what actually
 * blocks the merge — see `docs/onboarding-guide.md` § "Enforcing at merge"
 * for the exact GitHub setup steps (issue #988: this code publishes the
 * signal, branch protection config is what turns it into an enforced gate).
 */
export const ARBITRA_COMMIT_STATUS_CONTEXT = 'arbitra/case';

/** GitHub's own hard cap on a commit status `description`. */
const GITHUB_DESCRIPTION_MAX_LENGTH = 140;

export type CommitStatusState = 'success' | 'pending' | 'failure' | 'error';

export interface CommitStatusVerdict {
  state: CommitStatusState;
  description: string;
}

/**
 * `case_type` values whose PR is never GATED by a commit status — Observed
 * Cases (issue #986/ADR-0001) and Assistant Tasks (Clerk's own shortened
 * lifecycle) both run outside the governed evidence/review/approval matrix,
 * so a verdict computed against them would either misrepresent a policy that
 * was never in effect (Observed) or permanently fail a lifecycle with no
 * `approved` state to reach (Assistant Task). Reuses the exact same case-type
 * set the state machine itself scopes out of the governed matrix
 * (`status-transitions.ts`) so the two can never drift apart.
 *
 * Since #1024, "never gated" no longer means "no status published" — see
 * `publishCaseCommitStatus`, which now publishes an unconditional `success`
 * for these case types so a required `arbitra/case` check doesn't block
 * their PRs forever.
 */
export function isEnforcedCase(case_: Pick<Case, 'case_type'>): boolean {
  return case_.case_type === undefined || !SCOPED_CASE_TYPES.has(case_.case_type);
}

/**
 * Maps a case's current status + evidence-completeness result to a GitHub
 * commit-status verdict (issue #988).
 *
 * Mapping, documented here as the single source of truth (also mirrored in
 * `docs/onboarding-guide.md` § "Enforcing at merge"):
 *
 * This is the STATUS half of the verdict only. Since issue #1045 the
 * `success` results below are additionally gated on the commit being
 * published against by `applyApprovalCommitPin` — a `success` here means
 * "the case says yes", not yet "this commit may merge".
 *
 *   - `rejected`                                  → `failure`, "case rejected"
 *   - `approved` / `pending_merge` / `done`        → `success`
 *   - required evidence missing (any other status) → `failure`,
 *     "evidence missing: <types>" (+ any blocking-status reason below)
 *   - `needs_human_decision` / `verification_pending`
 *                                                   → `failure`,
 *     "awaiting human decision" / "awaiting manual verification" — an
 *     Enforced Case sitting here needs a human before it can merge, so this
 *     is a blocking failure (AC: "awaiting approval produces a failing
 *     check"), not merely `pending`.
 *   - otherwise, evidence satisfied but review not yet complete (`open`,
 *     `exploration`, `ready_for_build`, `in_build`, `in_validation`,
 *     `in_review`) → `pending`, "review in progress" / "case in progress"
 *     — nothing is blocked yet, the pipeline is still working.
 */
export function computeCommitStatusVerdict(
  status: CaseStatus,
  missing: EvidenceType[],
): CommitStatusVerdict {
  if (status === 'rejected') {
    return { state: 'failure', description: 'case rejected' };
  }
  if (status === 'approved' || status === 'pending_merge' || status === 'done') {
    return { state: 'success', description: 'case approved' };
  }

  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`evidence missing: ${missing.join(', ')}`);
  }
  if (status === 'needs_human_decision') {
    reasons.push('awaiting human decision');
  } else if (status === 'verification_pending') {
    reasons.push('awaiting manual verification');
  } else if (status === 'in_review') {
    reasons.push('review in progress');
  }

  const blocking =
    missing.length > 0 || status === 'needs_human_decision' || status === 'verification_pending';

  if (reasons.length === 0) {
    reasons.push(`case status: ${status}`);
  }

  return {
    state: blocking ? 'failure' : 'pending',
    description: reasons.join('; ').slice(0, GITHUB_DESCRIPTION_MAX_LENGTH),
  };
}

/**
 * Statuses whose `success` verdict is an assertion about a REVIEWED COMMIT
 * rather than about the case as a whole (issue #1045). These are exactly the
 * three statuses `computeCommitStatusVerdict` maps to `success` — the ones a
 * required `arbitra/case` check reads as "this commit may merge".
 */
export const APPROVAL_PINNED_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'approved',
  'pending_merge',
  'done',
]);

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Second half of the verdict, and the fix for issue #1045.
 *
 * `computeCommitStatusVerdict` answers "what does the CASE's state say" — a
 * pure status → verdict mapping, unchanged since #988. This function answers
 * the question that mapping cannot: "does that statement apply to THIS
 * commit?" A GitHub commit status is written against one SHA and read by
 * branch protection against the PR's CURRENT head, so an `approved` case that
 * keeps replaying `success` onto every later head SHA certifies commits
 * nobody reviewed. The two concerns are kept as two functions so the status
 * mapping stays independently testable and the commit binding is impossible
 * to skip on a publish path that computes a verdict.
 *
 * Only ever downgrades: a non-`success` verdict and any status outside
 * `APPROVAL_PINNED_STATUSES` pass through untouched, so nothing that was
 * blocking before can become passing here.
 *
 * An ABSENT pin fails closed. That covers legacy cases approved before this
 * shipped and cases that reached a pinned status without an approval at all
 * (auto-close on merge from `in_build`). Failing open would leave those
 * permanently exploitable by exactly the push-after-approval sequence the
 * issue reproduced; failing closed costs such a case one re-approval
 * (`request_changes` from `pending_merge` → re-review → approve), which
 * re-pins it.
 */
export function applyApprovalCommitPin(
  verdict: CommitStatusVerdict,
  case_: Pick<Case, 'status' | 'approved_head_sha'>,
  publishedSha: string,
): CommitStatusVerdict {
  if (verdict.state !== 'success') return verdict;
  if (!APPROVAL_PINNED_STATUSES.has(case_.status)) return verdict;

  const pinned = case_.approved_head_sha;
  if (pinned && pinned === publishedSha) return verdict;

  const description = pinned
    ? `approved commit superseded — ${shortSha(publishedSha)} was never reviewed (approved: ${shortSha(pinned)})`
    : 'approval is not pinned to a commit — re-approve to certify this one';

  return {
    state: 'failure',
    description: description.slice(0, GITHUB_DESCRIPTION_MAX_LENGTH),
  };
}

export interface PublishCommitStatusOptions {
  /**
   * PR head SHA to publish against. Preferred source: the webhook payload's
   * `commit_sha` (carried on `pr_opened`/`pr_updated` case events — see
   * `EventNotifier`). When absent (e.g. a status/lifecycle-change event with
   * no webhook payload of its own), the current PR head SHA is fetched from
   * GitHub.
   */
  headSha?: string;
  /** Auth token override — defaults to `GITHUB_TOKEN`, mirroring `PrMergeChecker`/`github-adapter.ts`. */
  token?: string;
  /**
   * Publish onto THIS PR ref instead of `case_.current_pr_ref` (issue
   * #1032). The admin recovery endpoint resolves a case through
   * a ladder that can match even when `current_pr_ref` is empty — exactly
   * the lost-`pull_request.opened`-delivery scenario the endpoint exists to
   * recover from. An operator supplying a PR URL is asserting which PR the
   * status belongs on; without this override `publishCaseCommitStatus`
   * would refuse with `no_pr_ref` and never publish anything, in precisely
   * the case it was built to unblock. Does NOT change verdict computation
   * — `computeCommitStatusVerdict` still runs unmodified against the
   * case's own status/evidence; only the publish TARGET changes. Every
   * webhook call site leaves this unset, so `case_.current_pr_ref` remains
   * the target there, unchanged from before this option existed.
   */
  prRefOverride?: string;
}

export interface PublishCommitStatusDeps {
  completenessEvaluator?: CompletenessEvaluator;
}

export type PublishCommitStatusResult =
  | { published: true; state: CommitStatusState }
  | { published: false; reason: string };

/**
 * Description published for a PR whose case is not part of the governed
 * matrix (Observed Case, Assistant Task) — issue #1024.
 */
function unenforcedDescription(caseType: Case['case_type']): string {
  return caseType === 'observed' ? 'observed — not enforced' : 'not enforced';
}

/**
 * Publishes the `arbitra/case` GitHub commit status for a case's linked PR
 * (issue #988, extended by #1024). This is the SINGLE publish function every
 * trigger point in the repo calls — see `EventNotifier.onCaseEvent`'s
 * `pr_opened`/`pr_updated` and `payload.to_status` hooks for where those
 * trigger points live, and `publishNoCaseCommitStatus` below for the sibling
 * entry point used when a PR has no case at all.
 *
 * Issue #1024: GitHub's required-status-check semantics block a merge while
 * a required context has never reported ("Expected — waiting for status").
 * Making `arbitra/case` a required check therefore demands that EVERY PR
 * eventually get a status — so an Observed Case (or Assistant Task) now
 * publishes an unconditional `success` ("observed — not enforced" / "not
 * enforced") instead of skipping the GitHub call entirely. Enforced-case
 * mapping (below) is unchanged from #988.
 *
 * Fail-soft by contract: every failure mode (no PR ref, unparsable PR URL,
 * SHA lookup failure, evidence read failure, GitHub API error, network
 * error) is caught internally, logged, and returned as
 * `{ published: false, reason }` — this function NEVER throws. Callers must
 * be free to call it inline from a webhook/lifecycle hot path without a
 * try/catch of their own.
 */
export async function publishCaseCommitStatus(
  case_: Case,
  deps: PublishCommitStatusDeps = {},
  options: PublishCommitStatusOptions = {},
): Promise<PublishCommitStatusResult> {
  try {
    // `prRefOverride` (issue #1032) lets a caller publish onto a
    // PR ref other than the case's own `current_pr_ref` — every webhook
    // call site leaves it unset, so `prRef` is `case_.current_pr_ref` there,
    // unchanged from before this option existed.
    const prRef = options.prRefOverride ?? case_.current_pr_ref;
    if (!prRef) {
      return { published: false, reason: 'no_pr_ref' };
    }

    const logLabel = `case ${case_.case_id}`;

    // The publish TARGET (repo + head SHA) is resolved BEFORE the verdict
    // since #1045: the verdict now depends on which commit is being
    // published against, so the SHA can no longer be a detail of the POST.
    const target = await resolvePublishTarget(prRef, options, logLabel);
    if ('reason' in target) {
      return { published: false, reason: target.reason };
    }

    if (!isEnforcedCase(case_)) {
      // Observed Cases and Assistant Tasks run outside the governed
      // evidence/review/approval matrix, so there is no verdict to compute
      // — but AC (#1024): the PR must still get a passing status, or a
      // required `arbitra/case` check would block it forever. No approval
      // pin applies either: these were never gated on a review at all.
      return await postStatus(
        target,
        { state: 'success', description: unenforcedDescription(case_.case_type) },
        targetUrlFor(case_),
        logLabel,
      );
    }

    // This function is READ-ONLY with respect to the case (issue #1046
    // review). The approval pin it reads below is written transactionally by
    // `applyTransitionInTransaction`, alongside the status change that earns
    // it — publishing a status must never be what decides which commit an
    // approval covers, or the pin would depend on a fire-and-forget
    // notification and race the auto `approved -> pending_merge` publish.
    const completenessEvaluator = deps.completenessEvaluator ?? new CompletenessEvaluator();
    const evidence = await fetchCaseEvidence(case_.case_id);
    const completeness = await completenessEvaluator.evaluate(case_, evidence);
    const verdict = applyApprovalCommitPin(
      computeCommitStatusVerdict(case_.status, completeness.missing),
      case_,
      target.sha,
    );

    return await postStatus(target, verdict, targetUrlFor(case_), logLabel);
  } catch (err) {
    console.error(
      `[commit-status] Failed to publish commit status for case ${case_.case_id}:`,
      err,
    );
    return { published: false, reason: 'exception' };
  }
}

function targetUrlFor(case_: Case): string | undefined {
  const baseUrl = process.env['ARBITRA_URL'];
  return baseUrl
    ? caseShareUrl({ baseUrl, caseId: case_.case_id, status: case_.status })
    : undefined;
}

/**
 * Publishes an unconditional `success` `arbitra/case` status for a PR that
 * never matched (or was deliberately not linked to) any Arbitra case at all
 * — issue #1024, AC: "A PR with no case carries `arbitra/case: success`".
 * Sibling entry point to `publishCaseCommitStatus`, used from
 * `WebhookService`'s `skipped_auto_creation` / `unlinked_pr_recorded`
 * branches, where no `Case` object exists to call that function with.
 *
 * Same fail-soft contract: never throws, every failure mode returns
 * `{ published: false, reason }`.
 */
export async function publishNoCaseCommitStatus(
  prUrl: string,
  options: PublishCommitStatusOptions = {},
): Promise<PublishCommitStatusResult> {
  try {
    return await publishStatus(
      prUrl,
      { state: 'success', description: 'no case — not enforced' },
      options,
      () => undefined,
      `PR ${prUrl}`,
    );
  } catch (err) {
    console.error(`[commit-status] Failed to publish commit status for ${prUrl}:`, err);
    return { published: false, reason: 'exception' };
  }
}

/**
 * Everything the status POST needs, resolved once per publish: the parsed
 * repo coordinates, the auth headers, and — the part that matters for issue
 * #1045 — the exact SHA the status will be written against.
 */
interface PublishTarget {
  parsed: { owner: string; repo: string; number: number };
  headers: Record<string, string>;
  sha: string;
}

/**
 * First half of the shared low-level publish: parse the PR ref, build auth
 * headers, and resolve the head SHA (from `options.headSha` or a GitHub
 * lookup). Split out of `publishStatus` so `publishCaseCommitStatus` can see
 * the SHA BEFORE it computes a verdict — the approval pin (#1045) is a
 * statement about that specific commit, so the verdict cannot be computed
 * without it.
 */
async function resolvePublishTarget(
  prRef: string,
  options: PublishCommitStatusOptions,
  logLabel: string,
): Promise<PublishTarget | { reason: string }> {
  const parsed = parsePrUrl(prRef);
  if (!parsed) {
    console.warn(`[commit-status] Could not parse PR ref for ${logLabel}: ${prRef}`);
    return { reason: 'unparsable_pr_ref' };
  }

  const token = options.token ?? process.env['GITHUB_TOKEN'];
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Arbitra/1.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const sha = options.headSha ?? (await fetchPullRequestHeadSha(parsed, headers));
  if (!sha) {
    return { reason: 'no_head_sha' };
  }

  return { parsed, headers, sha };
}

/** Second half of the shared low-level publish: POST the status. */
async function postStatus(
  target: PublishTarget,
  verdict: CommitStatusVerdict,
  targetUrl: string | undefined,
  logLabel: string,
): Promise<PublishCommitStatusResult> {
  const { parsed, headers, sha } = target;
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/statuses/${sha}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: verdict.state,
      description: verdict.description,
      context: ARBITRA_COMMIT_STATUS_CONTEXT,
      ...(targetUrl ? { target_url: targetUrl } : {}),
    }),
  });

  if (!response.ok) {
    console.error(
      `[commit-status] GitHub API returned ${response.status} publishing status for `
      + `${parsed.owner}/${parsed.repo}@${sha} (${logLabel})`,
    );
    return { published: false, reason: `github_api_${response.status}` };
  }

  return { published: true, state: verdict.state };
}

/**
 * Shared low-level publish: resolve the target then POST. Used by
 * `publishNoCaseCommitStatus`; `publishCaseCommitStatus` calls the two
 * halves separately so it can apply the approval pin in between. Both entry
 * points still share one implementation of auth, SHA resolution, and error
 * handling, so they cannot drift.
 */
async function publishStatus(
  prRef: string,
  verdict: CommitStatusVerdict,
  options: PublishCommitStatusOptions,
  targetUrlFn: () => string | undefined,
  logLabel: string,
): Promise<PublishCommitStatusResult> {
  const target = await resolvePublishTarget(prRef, options, logLabel);
  if ('reason' in target) {
    return { published: false, reason: target.reason };
  }
  return await postStatus(target, verdict, targetUrlFn(), logLabel);
}

async function fetchCaseEvidence(caseId: string): Promise<Evidence[]> {
  const snap = await collections.evidence().where('case_id', '==', caseId).get();
  return snap.docs.map((d) => d.data());
}

async function fetchPullRequestHeadSha(
  parsed: { owner: string; repo: string; number: number },
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(
        `[commit-status] GitHub API returned ${response.status} fetching head sha for `
        + `${parsed.owner}/${parsed.repo}#${parsed.number}`,
      );
      return null;
    }
    const data = (await response.json()) as { head?: { sha?: string } };
    return data.head?.sha ?? null;
  } catch (err) {
    console.error(
      `[commit-status] Failed to fetch head sha for ${parsed.owner}/${parsed.repo}#${parsed.number}:`,
      err,
    );
    return null;
  }
}
