import type { Case, CaseStatus, Repository } from '@arbitra/shared';
import { TERMINAL_CASE_STATUSES, comparePrRefs, extractCaseIdFromBranch, extractCaseIdFromText } from '@arbitra/shared';
import { CaseRepository } from '../case/case-repository.js';
import { CaseService } from '../case/case-service.js';
import { EvidenceService } from '../evidence/evidence-service.js';
import { EventService } from '../event/event-service.js';
import { WorkspaceEventService } from '../workspace-event/workspace-event-service.js';
import {
  findDuplicateGithubRepositoryIds,
  repositoryIdConflictEventId,
  repositoryUrlConflictEventId,
} from './repository-identity.js';
import { collections } from '../../lib/firestore.js';
import { FieldValue } from 'firebase-admin/firestore';
import { RunCompletionHandler } from '../orchestration/pipeline.js';
import type { PipelineAdapter } from '../orchestration/pipeline-adapter.js';
import type { PreconditionResult } from '../orchestration/preconditions.js';
import { evaluateObservedCaseEscalation } from '../case/case-escalation-service.js';
import { publishCaseCommitStatus, publishNoCaseCommitStatus } from './commit-status-service.js';
import { fetchPullRequestChangedFiles } from './github-adapter.js';
import { openRepositoryToken } from '../../lib/secret-box.js';

/**
 * Source statuses whose auto-close-on-merge is eligible. These are intermediate
 * pipeline states where a merged PR is the definitive signal that the work is
 * done — waiting for downstream gates would leave the case orphaned.
 */
/**
 * All-zero commit sha that GitHub sends on branch-delete `push` events.
 * Carries no state change we care about and must not be emitted as `pr_updated`.
 */
const ZERO_COMMIT_SHA = '0000000000000000000000000000000000000000';

/**
 * How long to wait after a repo is first registered before a `push`-only
 * subscription is treated as a misconfiguration. A freshly added repo will
 * often see its first `push` before its first `pull_request`, so warning
 * immediately would cause false positives on normal onboarding.
 */
const MISCONFIG_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

const AUTO_CLOSE_ELIGIBLE_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'in_build',
  'in_validation',
  'in_review',
  'approved',
]);

/**
 * Source statuses where a PR merge is anomalous — the case hasn't yet passed
 * human gates or isn't far enough along the pipeline. We record the anomaly
 * but do NOT auto-close the case.
 */
const AUTO_CLOSE_ANOMALY_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'verification_pending',
  'needs_human_decision',
  'open',
  'exploration',
  'ready_for_build',
]);

/**
 * Feature flag gating auto-close on merge. Default: enabled.
 * Set ARBITRA_AUTO_CLOSE_ON_MERGE=false to disable (emits pr_merged event only,
 * no short-circuit auto-transition, no synthetic evidence).
 */
export function isAutoCloseOnMergeEnabled(): boolean {
  const raw = process.env['ARBITRA_AUTO_CLOSE_ON_MERGE'];
  if (raw === undefined) return true;
  return raw.toLowerCase() !== 'false';
}

/**
 * Feature flag gating auto-reject of orphan cases when their PR is closed
 * unmerged while the case is still in `open` (exploration never started).
 * Default: disabled. Set AUTO_REJECT_ORPHAN_ON_PR_CLOSED=true to enable.
 *
 * When enabled, the webhook emits an audit `comment_added` event then triggers
 * the pipeline so the synthetic `open → rejected` transition fires (gated by
 * the `pr_closed_before_exploration` precondition).
 */
export function isAutoRejectOrphanOnPrClosedEnabled(): boolean {
  const raw = process.env['AUTO_REJECT_ORPHAN_ON_PR_CLOSED'];
  if (raw === undefined) return false;
  return raw.toLowerCase() === 'true';
}

export interface GitWebhookPayload {
  action: string;
  /**
   * The raw GitHub event name (X-GitHub-Event header). Preserved here so the
   * handler can branch on event vs. action (e.g. `event === 'repository'`
   * with `action === 'renamed'`). Optional for backwards compatibility with
   * older callers of `handleGitWebhook` that synthesise payloads in tests.
   */
  event?: string;
  pr_number?: number;
  pr_url?: string;
  branch?: string;
  commit_sha?: string;
  /** `owner/repo` slug from the GitHub payload (`repository.full_name`). */
  repository: string;
  /**
   * Immutable numeric GitHub repository id (`repository.id`). Preferred key
   * for matching stored `Repository` rows — survives org/repo renames.
   */
  repository_id?: number;
  /**
   * Previous `owner/repo` slug on a `repository.renamed` event, reconstructed
   * from `changes.repository.name.from` + current owner. Used as a last-chance
   * fallback if the stored row has neither `github_repository_id` nor the new
   * `full_name`.
   */
  repository_old_full_name?: string;
  /**
   * GitHub's `repository.default_branch`, present on the `repository` object
   * of every webhook event that carries one (`pull_request`, `push`,
   * `repository`). Opportunistically backfilled onto the matched `Repository`
   * row (issue #1009) the same way `repository_id`/`repository` (→
   * `github_repository_id`/`github_full_name`) already are.
   */
  repository_default_branch?: string;
  /** PR title, extracted by parseGitHubWebhook */
  title?: string;
  /** PR description body, extracted by parseGitHubWebhook */
  body?: string;
  /** Changed file paths from the PR */
  changed_files?: string[];
  /**
   * Set by `handleGitWebhook` (after resolving the Arbitra `Repository` row,
   * so it has the per-repo token for the fetch — issue #1028) when
   * `fetchPullRequestChangedFiles` failed (bad/missing token, rate limit,
   * network error) rather than the PR genuinely changing no files — both
   * leave `changed_files` unset, but only this flag makes the two
   * distinguishable. A failure also records a deduped
   * `changed_files_fetch_failed` workspace event, so the signal reaches the
   * activity feed and not just Cloud Run logs. `false`/absent covers both
   * "fetch succeeded" and "fetch was never attempted" (e.g. non-`opened`/
   * `synchronize` actions, or a repo that never resolved to an Arbitra row).
   */
  changed_files_fetch_failed?: boolean;
  /** Whether the PR was merged (as opposed to just closed without merging) */
  merged?: boolean;
  /** Number of changed files in the PR (from GitHub webhook payload) */
  changed_file_count?: number;
}

export interface CIWebhookPayload {
  build_id: string;
  status: 'success' | 'failure';
  branch?: string;
  pr_ref?: string;
  report_url?: string;
  case_id?: string;
}

export type CIWebhookResult =
  | { ok: false; reason: 'missing_case_id' | 'case_not_found' }
  | { ok: true; action: 'evidence_registered' | 'ignored_terminal' };

/**
 * Branch prefixes that indicate actual development work and should surface an
 * unlinked PR nudge when no existing Arbitra case can be linked.
 */
const ALLOWED_BRANCH_PREFIXES = [
  'feat/', 'feature/', 'story/',
  'fix/', 'bugfix/', 'hotfix/',
  'refactor/', 'cleanup/', 'chore/',
  'docs/', 'test/', 'perf/',
  'ci/', 'build/', 'style/',
  'revert/', 'wip/',
  'security/', 'sec/',
  'claude/',       // Claude Code agent branches
  'cursor/',       // Cursor IDE agent branches
  'copilot/',      // Copilot agent branches
];

/**
 * Branch names or patterns that should never surface an unlinked PR nudge.
 * These are either protected branches, bot branches, or local-only branches.
 */
const BLOCKED_BRANCH_PATTERNS = [
  /^main$/,
  /^master$/,
  /^production$/,
  /^develop$/,
  /^staging$/,
  /^local\//,           // IDE agents that couldn't find a remote
  /^dependabot\//,      // Dependabot dependency updates
  /^renovate\//,        // Renovate dependency updates
  /^release\//,         // Release branches
  /^gh-pages$/,
];

/**
 * Decides whether a branch name should surface an unlinked PR nudge.
 * Returns a reason string if blocked, or null if allowed.
 */
export function shouldBlockAutoCaseCreation(branch: string | undefined): string | null {
  if (!branch) return 'no branch name provided';

  // Check blocked patterns first
  for (const pattern of BLOCKED_BRANCH_PATTERNS) {
    if (pattern.test(branch)) {
      return `branch "${branch}" matches blocked pattern ${pattern}`;
    }
  }

  // Check if branch starts with an allowed prefix
  const hasAllowedPrefix = ALLOWED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));
  if (!hasAllowedPrefix) {
    return `branch "${branch}" does not match any allowed prefix (${ALLOWED_BRANCH_PREFIXES.join(', ')})`;
  }

  return null;
}

/**
 * Decides whether a PR should be skipped due to having zero changed files.
 * Returns a reason string if blocked, or null if allowed.
 *
 * GitHub may report changed_files: 0 on 'opened' events before diffstat is computed.
 * Since 'synchronize' events don't record unlinked-PR nudges, this could skip
 * a valid PR. We accept this risk as it's rare and the alternative creates
 * more noise.
 */
export function shouldBlockZeroChangedFiles(changedFileCount: number | undefined): string | null {
  if (changedFileCount !== undefined && changedFileCount === 0) {
    return 'PR has zero changed files';
  }
  return null;
}

/**
 * Parsed identity of a GitHub repository reference: `host` + `owner` + `repo`,
 * lowercased. Two refs are the SAME repository iff all three fields are
 * equal — never a substring/prefix relationship on the raw string (issue
 * #1048: `owner/repo` is a prefix of any sibling repo whose name extends
 * it, e.g. `acme/api` vs `https://github.com/acme/api-gateway`).
 */
export interface ParsedRepoRef {
  host: string;
  owner: string;
  repo: string;
}

/** Every stored `Repository.url` is compared against this fixed host — see `parseRepoRef`'s doc comment for why a different host is a deliberate non-match, not a gap. Exported so registration-time validation (issue #1059 item 3) can reuse the exact same constant instead of duplicating the literal. */
export const GITHUB_HOST = 'github.com';

/**
 * Parses a repository reference — a stored `Repository.url` or an incoming
 * ref to compare it against — into `{ host, owner, repo }` for exact-field
 * comparison (issue #1048 follow-up F1).
 *
 * `Repository.url` is unvalidated free text (a plain `type="text"` field,
 * `packages/frontend/.../repositories/route.ts` stores
 * `body.url?.trim() ?? ''` with no format check), so this tolerates every
 * shape a person plausibly pastes there while still requiring an EXACT
 * match — never `.includes()` — on the parsed result:
 *
 *   - scheme: `https://`, `http://`, `ssh://`, `git://`, `git@host:owner/repo`
 *     shorthand, or NO scheme at all (`github.com/acme/api`)
 *   - a `www.` host prefix
 *   - embedded credentials (`https://token@github.com/...`,
 *     `https://user:pass@github.com/...`)
 *   - a trailing `.git`, trailing slash, extra path segments after the repo
 *     (`/tree/main`, `/pulls`, a browser-copied path) — only the first two
 *     path segments are ever read
 *   - a query string or fragment appended directly to the repo segment
 *     (`?tab=readme`, `#readme`) — exactly what copying a repository's own
 *     home-page URL out of a browser's address bar produces. A query/fragment
 *     that instead follows an extra path segment (`/tree/main?x`) is already
 *     covered by the point above: that segment is discarded entirely, query
 *     string and all
 *   - a completely bare `owner/repo` slug with no host at all — GitHub
 *     owner/org names never contain a `.` (GitHub's own naming rules), so a
 *     dot-free first segment before the first `/` means there is no host to
 *     parse; treated as implicitly `github.com`, mirroring how
 *     `resolveArbitraRepoResult`'s step 3 already builds its comparison
 *     target as `https://github.com/<payload.repository>`. This bare-slug
 *     branch requires EXACTLY two segments (`owner/repo`, optionally
 *     `.git`-suffixed) with nothing after — a third segment fails the whole
 *     parse (returns `null`) rather than being silently dropped, so a
 *     dot-free HOST string with a path (`localhost/foo/bar`) can never be
 *     misread as a bare owner/repo slug (issue #1059)
 *   - any casing
 *
 * DELIBERATE non-match, not a gap: a real, different host (a GitHub
 * Enterprise instance, `github.company.com`) never equals `github.com`.
 * `handleGitWebhook` is GitHub.com-webhook-specific — its step-3 comparison
 * target is always built on `github.com` — so a row genuinely hosted
 * elsewhere is a DIFFERENT system, and conflating hosts would reopen the
 * exact cross-repository collision this comparison exists to prevent, one
 * layer up (two different hosts could each have their own `acme/api`).
 * Nothing in this codebase's GitHub integration (`github-adapter.ts`,
 * `api.github.com`) supports Enterprise hosts today; if that changes, the
 * webhook payload would need to carry which host it came from before this
 * function could safely widen to match it.
 *
 * Returns `null` when the ref doesn't resolve to a `host/owner/repo` shape
 * at all (an unparseable ref is never treated as a match).
 */
export function parseRepoRef(raw: string | undefined | null): ParsedRepoRef | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // git@host:owner/repo(.git)? shorthand -> https://host/owner/repo(.git)?
  const sshShorthand = /^git@([^:\s]+):(.+)$/i.exec(s);
  if (sshShorthand) {
    s = `https://${sshShorthand[1]}/${sshShorthand[2]}`;
  }

  // Normalize every other scheme this comparison tolerates to https.
  s = s
    .replace(/^ssh:\/\//i, 'https://')
    .replace(/^git:\/\//i, 'https://')
    .replace(/^http:\/\//i, 'https://');

  if (!/^https:\/\//i.test(s)) {
    // No scheme at all. A dot in the first segment means it IS a host
    // ("github.com/acme/api") — add a scheme and fall through to the normal
    // parse below. No dot means a bare "owner/repo" slug with no host.
    const firstSegment = s.split('/', 1)[0] ?? '';
    if (firstSegment.includes('.')) {
      s = `https://${s}`;
    } else {
      // EXACTLY two segments, no more — anchored with `$` (past an optional
      // trailing slash and an optional query/fragment). Issue #1059: the
      // previous unanchored version silently absorbed a third path segment
      // ("localhost/foo/bar" -> owner="localhost", repo="foo", "/bar"
      // dropped), which is exactly what let a dot-free HOST string
      // ("localhost/foo/bar", the no-scheme-heuristic misclassification)
      // parse as if it were a bare owner/repo slug instead of failing to parse
      // at all. A genuine
      // 2-segment "host-without-dot/path" (e.g. "localhost/api") is still
      // indistinguishable from a real bare slug and is NOT solved here —
      // that residual ambiguity is unchanged from before this fix.
      const bareMatch = /^([^/\s@:]+)\/([^/\s?#]+)\/?(?:[?#].*)?$/.exec(s);
      if (!bareMatch) return null;
      return {
        host: GITHUB_HOST,
        owner: bareMatch[1]!.toLowerCase(),
        repo: bareMatch[2]!.replace(/\.git$/i, '').toLowerCase(),
      };
    }
  }

  // Strip embedded credentials right after the scheme: "https://user[:pass]@host/..."
  s = s.replace(/^(https:\/\/)[^/\s@]*@/i, '$1');

  const match = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s?#]+)/i.exec(s);
  if (!match) return null;

  return {
    host: match[1]!.toLowerCase().replace(/^www\./, ''),
    owner: match[2]!.toLowerCase(),
    repo: match[3]!.replace(/\.git$/i, '').toLowerCase(),
  };
}

/** True iff two parsed refs name the same repository — host, owner, AND repo all equal. */
export function sameRepoRef(a: ParsedRepoRef | null, b: ParsedRepoRef | null): boolean {
  return a !== null && b !== null && a.host === b.host && a.owner === b.owner && a.repo === b.repo;
}

function sanitizeEventIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function unlinkedPullRequestEventId(
  payload: GitWebhookPayload,
  resolvedArbitraRepoId?: string,
): string {
  const repoKey = sanitizeEventIdPart(
    resolvedArbitraRepoId
      ?? (payload.repository_id !== undefined ? String(payload.repository_id) : payload.repository),
  );
  const prKey = sanitizeEventIdPart(
    payload.pr_number !== undefined
      ? String(payload.pr_number)
      : payload.pr_url ?? payload.branch ?? 'unknown',
  );
  return `wse_unlinked_pr_${repoKey}_${prKey}`;
}

/**
 * Deterministic workspace-event id for a `changed_files_fetch_failed`
 * signal, scoped to `(arbitra repository, UTC day)` — mirrors the
 * `(github id, day)` dedup `repositoryIdConflictEventId` uses (issue #628):
 * a repo whose per-repo token is broken fails this fetch on every
 * `opened`/`synchronize` event for every open PR, and without this dedup
 * each one would spam a fresh workspace event. Repeat failures for the same
 * repo on the same day collapse onto a single document (the `record` write
 * is a `set` keyed by this id).
 */
function changedFilesFetchFailedEventId(
  resolvedArbitraRepoId: string,
  now: Date = new Date(),
): string {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `wse_changed_files_fetch_failed_${sanitizeEventIdPart(resolvedArbitraRepoId)}_${day}`;
}

function formatPullRequestLabel(payload: GitWebhookPayload): string {
  if (payload.pr_number !== undefined && payload.title) {
    return `#${payload.pr_number} ${payload.title}`;
  }
  if (payload.pr_number !== undefined) return `#${payload.pr_number}`;
  return payload.title ?? payload.pr_url ?? payload.branch ?? 'unknown PR';
}

/**
 * Records the head SHA this webhook observed onto the case's pending update
 * (issue #1045).
 *
 * `Case.current_head_sha` is what `applyTransitionInTransaction` copies into
 * `approved_head_sha` when the case is approved — a Firestore transaction
 * cannot call GitHub, so the commit an approval covers has to already be on
 * the document by then. Called from EVERY webhook path that both learns a
 * SHA and writes to the case (the branch-name link, the PR-text link, and
 * `updateCaseWithPR`), because a case whose head SHA was never recorded
 * approves into an unpinned state, which fails closed downstream.
 *
 * Skips the all-zero branch-delete SHA for the same reason `pr_updated` does
 * — it is not a commit — and skips a no-op rewrite so an unchanged case is
 * not touched.
 */
function recordObservedHeadSha(
  updates: Partial<Case>,
  payload: GitWebhookPayload,
  existing: Pick<Case, 'current_head_sha'>,
): void {
  const sha = payload.commit_sha;
  if (!sha || sha === ZERO_COMMIT_SHA) return;
  if (sha === existing.current_head_sha) return;
  updates.current_head_sha = sha;
}

/**
 * Re-link guard's reading of `comparePrRefs` (issue #813): may this incoming
 * PR overwrite the PR the case already owns?
 *
 * An INCONCLUSIVE comparison falls back to exact string equality — today's
 * behavior. Two refs that both fail to parse must not be assumed equivalent
 * here, because treating them as the same PR is what lets one link clobber
 * another. Note this is the OPPOSITE reading of `'unknown'` from
 * `ownsPullRequest` below, and deliberately so: there, guessing "different"
 * publishes a passing status onto a rejected PR; here, guessing "same"
 * steals a case. `PrRefComparison`'s doc comment carries the full argument.
 */
function refersToSamePr(a: string, b: string): boolean {
  const comparison = comparePrRefs(a, b);
  return comparison === 'unknown' ? a === b : comparison === 'same';
}

/**
 * Terminal-case exit's reading of `comparePrRefs` (issue #1046): does this
 * case own the PR the webhook is about?
 *
 * An INCONCLUSIVE comparison counts as OWNERSHIP — the fail-closed
 * direction. Returning `false` here routes the PR to the case-less
 * `success`, which is exactly the exploit: the first cut of this fix
 * returned `false` on any unparseable ref, so a `current_pr_ref` stored
 * without a scheme, with a `www.` prefix, in different casing, or in the
 * `api.github.com` form still turned a REJECTED case's own PR green on the
 * next push. Preserving the case's verdict is the safe guess — the cost of
 * guessing wrong is a stale failing check on a reused branch, which a human
 * can see and resolve, not a silent merge of rejected work.
 *
 * `parsePrRef` is tolerant enough that `'unknown'` should now be rare (every
 * shape above parses), but the fail direction is what makes this guard sound
 * rather than merely wide.
 */
function ownsPullRequest(
  storedRef: string | undefined,
  incomingPrUrl: string | undefined,
): boolean {
  if (!storedRef || !incomingPrUrl) return false;
  return comparePrRefs(storedRef, incomingPrUrl) !== 'different';
}

export class WebhookService {
  private readonly caseRepo: CaseRepository;
  private readonly evidenceService: EvidenceService;
  private readonly eventService: EventService;
  private readonly workspaceEventService: WorkspaceEventService;
  private readonly pipeline: RunCompletionHandler | null;

  constructor(
    caseRepo = new CaseRepository(),
    caseService = new CaseService(),
    evidenceService = new EvidenceService(),
    eventService = new EventService(),
    pipelineAdapter?: PipelineAdapter,
    workspaceEventService = new WorkspaceEventService(),
  ) {
    this.caseRepo = caseRepo;
    void caseService;
    this.evidenceService = evidenceService;
    this.eventService = eventService;
    this.workspaceEventService = workspaceEventService;
    this.pipeline = pipelineAdapter ? new RunCompletionHandler(pipelineAdapter) : null;
  }

  /**
   * Records a webhook rejection into observable state. Rejections are silent
   * HTTP 4xx responses that left agents guessing why their PR event never
   * propagated into a case transition. We surface them as:
   *   - a `webhook_rejected` case event when the branch matches an existing
   *     case (agent sees it in `get_case_context`), or
   *   - a `webhook_rejected` workspace event otherwise (visible in the
   *     activity feed).
   * Best-effort: failures here must never swallow the original rejection.
   */
  async logWebhookRejection(args: {
    reason: string;
    event?: string;
    action?: string;
    repository?: string;
    repository_id?: number;
    branch?: string;
    pr_url?: string;
  }): Promise<void> {
    const {
      reason, event, action, repository, repository_id, branch, pr_url,
    } = args;
    const summary = `Webhook rejected: ${reason}`;
    const payload: Record<string, unknown> = {
      reason,
      ...(event ? { event } : {}),
      ...(action ? { action } : {}),
      ...(repository ? { repository } : {}),
      ...(repository_id !== undefined ? { repository_id } : {}),
      ...(branch ? { branch } : {}),
      ...(pr_url ? { pr_url } : {}),
    };

    try {
      // Only attach the rejection to a case when we have resolved the
      // Arbitra repository_id. Without it, a rejection from repo A on
      // branch `main` would attach to a case in repo B also on `main`.
      let resolvedRepoId: string | undefined;
      if (repository !== undefined || repository_id !== undefined) {
        const resolved = await this.resolveArbitraRepo({ repository, repository_id }).catch(() => null);
        if (resolved) resolvedRepoId = resolved.repository_id;
      }
      if (branch && resolvedRepoId) {
        const existing = await this.findCaseByBranch(branch, resolvedRepoId);
        if (existing) {
          await this.eventService.emit(existing.case_id, 'webhook_rejected', payload, 'system');
          return;
        }
      }
      await this.workspaceEventService.record({
        type: 'webhook_rejected',
        actor_user_id: 'system:arbitra-webhook',
        summary,
        evidence: payload,
      });
    } catch (err) {
      console.error('[webhook] Failed to log webhook rejection:', err);
    }
  }

  async handleGitWebhook(payload: GitWebhookPayload): Promise<{ action: string; case_id?: string; reason?: string; repository_id?: string }> {
    // `repository` meta events (renamed/transferred/edited) don't map to a
    // case — they maintain the Repository row so later PR events can still
    // match. Handle before the PR-flow branches so the rest of this method
    // can assume it's looking at a PR/push.
    if (payload.event === 'repository') {
      return this.handleRepositoryEvent(payload);
    }

    // Backfill of `github_repository_id` on stored rows happens inline on the
    // awaited `resolveArbitraRepo` call used below before linking an existing
    // case or recording an unlinked-PR event. We used to fire an extra
    // background resolve here, but it raced the awaited path and produced
    // redundant same-patch writes with spurious warnings. Removed.

    // Surface unknown-repo events for observability. If the payload carries a
    // numeric repository id (real GitHub event, not a legacy-shaped test
    // payload) and `resolveArbitraRepo` cannot match it to a stored row,
    // emit a `webhook_rejected` workspace event so the operator can see which
    // GitHub repo tried to reach us without matching any arbitra-tracked repo.
    // Done before the per-action branches so PR, push, and closed events all
    // benefit. The resolved repo is also reused below to scope branch lookups
    // to the correct repository.
    let resolvedArbitraRepoId: string | undefined;
    if (payload.repository !== undefined || payload.repository_id !== undefined) {
      const resolution = await this.resolveArbitraRepoResult(payload).catch(
        () => ({ status: 'not_found' as const, repo: null }),
      );
      if (resolution.status === 'conflict') {
        // The numeric github id is owned by multiple Arbitra rows (issue
        // #628). `resolveArbitraRepoResult` already recorded a diagnosable
        // `webhook_repository_id_conflict` event (recorded exactly once
        // there) and STOPPED routing. We must EARLY-RETURN here, before the
        // per-action branches, for EVERY action — not just synchronize/push.
        // Falling through would let the `opened` branch record a misleading
        // unlinked-PR event against an ambiguous repo. Earlier versions
        // created a GARBAGE mis-attributed case here (project_id
        // `proj_default`, repository_id = raw payload slug). That is exactly
        // the mis-attribution #628 prevents.
        // Returning a non-mutating result here keeps the conflict signal clean:
        // no `webhook_rejected` "unknown repository" on top (the repo is known,
        // just ambiguous) and no fire-and-forget subscription-health work (which
        // would redundantly re-resolve into the same conflict). The PR itself
        // still needs an `arbitra/case` status though (issue #1024) — this
        // exit stops routing well before any case can be matched, so the PR
        // is case-less from Arbitra's perspective; no-op when there's no
        // `pr_url` to publish against (e.g. a bare `push`).
        //
        // NOTE (issue #1048 follow-up F2): an ambiguous step-3 URL match does
        // NOT reach this branch. Unlike a numeric-id conflict — impossible to
        // create through ordinary use, since registration enforces
        // `github_repository_id` uniqueness (409, see the repositories
        // route) — registration ALSO now enforces `url` uniqueness the same
        // way (409, same F2), so a NEW url conflict cannot be created
        // through ordinary use either. But a row pair that predates that
        // guard can still exist. Refusing to route it the same way this
        // id-conflict does would leave that pre-guard duplicate permanently
        // unroutable (never backfilled, so never self-healing) and would
        // publish a case-less `success` on every PR for BOTH rows forever.
        // Step 3 instead routes deterministically to the oldest matching row
        // while refusing to backfill onto it, and records the conflict for
        // an operator to clean up — see the step-3 ambiguity handling below.
        await this.publishNoCaseStatusForPayload(payload);
        return {
          action: 'ignored',
          reason: `repository_id conflict: github id ${payload.repository_id} owned by multiple Arbitra repositories`,
        };
      }
      if (resolution.repo) {
        resolvedArbitraRepoId = resolution.repo.repository_id;
        // Issue #1009: opportunistically backfill the repo's real default
        // branch from the payload — same "first webhook that carries it
        // wins" discipline as `github_repository_id`/`github_full_name`
        // above. Never overwrites a differing stored value with an older
        // payload's worth (GitHub's default branch can change, e.g. main
        // renamed to master); the latest webhook to arrive is authoritative,
        // mirroring how `github_full_name` is kept in sync on rename.
        if (
          payload.repository_default_branch !== undefined
          && payload.repository_default_branch !== resolution.repo.default_branch
        ) {
          await this.backfillRepositoryIdentity(resolution.repo.repository_id, {
            default_branch: payload.repository_default_branch,
          });
        }

        // Issue #1028: fetch the PR's real changed-file paths HERE, now that
        // the resolved `Repository` row — including its per-repo
        // `github_token`, if configured — is in hand. This used to happen
        // inside `parseGitHubWebhook`, which runs before repo resolution and
        // so could only ever fall back to the global `GITHUB_TOKEN`; a repo
        // configured with only a per-repo token failed this fetch every
        // time. Running it here also means an ambiguous `github_repository_id`
        // (the `'conflict'` branch above, which returns before this point)
        // never reaches this fetch either — the same guard that stops case
        // routing for that scenario (issue #628) now also stops it from
        // picking an arbitrary tenant's token.
        if (
          payload.event === 'pull_request'
          && (payload.action === 'opened' || payload.action === 'synchronize')
          && payload.pr_number !== undefined
        ) {
          const [owner, repoName] = payload.repository?.split('/') ?? [];
          if (owner && repoName) {
            const files = await fetchPullRequestChangedFiles(
              owner,
              repoName,
              payload.pr_number,
              openRepositoryToken(resolution.repo.github_token, resolution.repo.repository_id),
            );
            if (files) {
              payload.changed_files = files;
            } else {
              // Fetch failed (bad/missing token, rate limit, network error —
              // `fetchPullRequestChangedFiles` already logged the specifics).
              // `changed_files` stays unset so `detectCaseFields` falls back
              // to its text heuristic, exactly as a genuinely-empty
              // changeset would — but that made a persistent auth failure
              // indistinguishable from "this PR touched no files", silently
              // degrading Observed Case risk detection with no operator-
              // visible signal. Flag it on the payload AND record a
              // deduped workspace event (visible in the activity feed, not
              // just Cloud Run logs) so both consumers and operators can
              // tell the two apart.
              payload.changed_files_fetch_failed = true;
              console.error(
                `[webhook] changed_files_fetch_failed repo=${payload.repository} pr=${payload.pr_number} — ` +
                  'risk detection for this event falls back to the text heuristic instead of real file paths',
              );
              await this.workspaceEventService.record({
                event_id: changedFilesFetchFailedEventId(resolution.repo.repository_id),
                type: 'changed_files_fetch_failed',
                actor_user_id: 'system:arbitra-webhook',
                summary: `Failed to fetch changed files for ${formatPullRequestLabel(payload)} on ${payload.repository} — Observed Case risk detection falls back to the text heuristic`,
                evidence: {
                  repository: payload.repository,
                  repository_id: resolution.repo.repository_id,
                  pr_number: payload.pr_number,
                  pr_url: payload.pr_url,
                  has_repo_token: openRepositoryToken(resolution.repo.github_token, resolution.repo.repository_id) !== undefined,
                },
              }).catch((err) => {
                console.error('[webhook] Failed to record changed_files_fetch_failed workspace event:', err);
              });
            }
          }
        }
      } else if (payload.repository_id !== undefined) {
        await this.logWebhookRejection({
          reason: 'unknown repository',
          event: payload.event,
          action: payload.action,
          repository: payload.repository,
          repository_id: payload.repository_id,
          branch: payload.branch,
          pr_url: payload.pr_url,
        });
        // Do not early-return: downstream branches still handle legacy-shaped
        // payloads (no `repository_id`) and the per-branch flow degrades
        // gracefully (default project + raw slug). We only add observability.
      }
    }

    // Hook-subscription health check. Fire-and-forget: any failure here must
    // never block a real PR/push from landing. Runs AFTER repo resolution so it
    // is skipped on the conflict early-return above (which already resolved the
    // repo and would otherwise re-hit the same conflict here). Both ingest paths
    // (pull_request vs push) share the same observability.
    if (payload.event === 'pull_request' || payload.event === 'push') {
      this.checkWebhookSubscriptionHealth(payload).catch((err) => {
        console.error('[webhook] Subscription-health check failed:', err);
      });
    }

    if (payload.action === 'opened' && payload.pr_url) {
      // New PR → link it to an existing case when possible. If no safe match
      // exists, record a workspace-level nudge instead of creating a case.
      // IDE agents (Cursor, Claude Code) should create the case first, then
      // push + open a PR. Without these checks, the webhook would leave a
      // noisy unlinked-PR nudge for an otherwise valid workflow.
      if (payload.branch) {
        // Hybrid lookup (D-half of B+D): agents that create the case before
        // selecting/pushing a branch leave `current_branch` empty, so the
        // plain `findCaseByBranch` scan misses and we would record a duplicate
        // unlinked-PR nudge.
        // Try extracting a case id embedded in the branch name first and
        // link that case up. See `extractCaseIdFromBranch` for branch-name
        // conventions supported.
        const linkedByBranchName = await this.tryLinkCaseByBranchName(payload);
        if (linkedByBranchName) {
          return linkedByBranchName;
        }

        // Sharper dedup: a Jira-style branch (no embedded case_id token) can
        // still reference an Arbitra case via the PR title or body
        // ("Arbitra: case-pure-dawn-mQj7"). Link that up before the
        // current_branch scan misses and we record a duplicate unlinked-PR
        // nudge.
        const linkedByPrText = await this.tryLinkCaseByPrText(payload);
        if (linkedByPrText) {
          return linkedByPrText;
        }

        const existing = resolvedArbitraRepoId
          ? await this.findCaseByBranch(payload.branch, resolvedArbitraRepoId)
          : null;
        if (existing) {
          if (TERMINAL_CASE_STATUSES.has(existing.status)) {
            console.debug(`[webhook] Ignoring webhook for case ${existing.case_id} in terminal state: ${existing.status}`);
            // The branch matched a terminal case. Which status this PR
            // deserves depends on PR IDENTITY, not on the status alone —
            // see `publishTerminalCaseStatus` (issues #1024 / #1046).
            await this.publishTerminalCaseStatus(existing, payload);
            return { action: 'ignored', case_id: existing.case_id, reason: `case in terminal state: ${existing.status}` };
          }
          // Link the PR to the existing case instead of creating a new one
          const updated = await this.updateCaseWithPR(payload, existing);
          return { action: updated ? 'case_updated' : 'no_matching_case', case_id: existing.case_id };
        }
      }

      // Guard: only record unlinked-PR nudges for branches that look like
      // actual work. This prevents noise from local/ branches (IDE agents
      // without remote), dependabot, release branches, or direct pushes to
      // main/production.
      const blockReason = shouldBlockAutoCaseCreation(payload.branch);
      if (blockReason) {
        await this.publishNoCaseStatusForPayload(payload);
        return { action: 'skipped_auto_creation', reason: blockReason };
      }

      // Guard: require at least one changed file in the PR.
      const zeroFileReason = shouldBlockZeroChangedFiles(payload.changed_file_count);
      if (zeroFileReason) {
        console.warn(`[webhook] Skipping case creation for PR: changed_file_count is 0 (branch: ${payload.branch})`);
        await this.publishNoCaseStatusForPayload(payload);
        return { action: 'skipped_auto_creation', reason: zeroFileReason };
      }

      await this.recordUnlinkedPullRequest(payload, resolvedArbitraRepoId);
      await this.publishNoCaseStatusForPayload(payload);
      return {
        action: 'unlinked_pr_recorded',
        reason: 'pull_request.opened did not match an existing Arbitra case',
      };
    }

    if ((payload.action === 'synchronize' || payload.action === 'push') && payload.branch) {
      // Drop branch-delete pushes. GitHub sends `push` with an all-zero after-sha
      // when a branch is deleted (e.g. the auto-delete that follows a merge).
      // Treating those as a `pr_updated` polluted case event logs with a fake
      // commit sha and masked the real merge event that never arrived because
      // the hook was missing `pull_request`. Input-layer guard only — no state
      // changes downstream.
      if (payload.commit_sha === ZERO_COMMIT_SHA) {
        console.info(
          `[webhook] webhook.push.branch_delete_skipped repo=${payload.repository ?? '?'} ref=${payload.branch}`,
        );
        return { action: 'ignored', reason: 'branch-delete push (zero commit sha)' };
      }
      // PR updated or push → Link PR to existing case by branch within the
      // same repository. Without resolving the repo we cannot safely look up:
      // a push to `main` from repo A would otherwise attach to a case on
      // `main` in repo B.
      const existingCase = resolvedArbitraRepoId
        ? await this.findCaseByBranch(payload.branch, resolvedArbitraRepoId)
        : null;
      if (existingCase && TERMINAL_CASE_STATUSES.has(existingCase.status)) {
        console.debug(`[webhook] Ignoring webhook for case ${existingCase.case_id} in terminal state: ${existingCase.status}`);
        // Same reasoning as the `opened` branch's terminal-case exit above,
        // and the same PR-identity split (issues #1024 / #1046). This is
        // the exit issue #1046 reproduced: a push to a REJECTED case's own
        // PR used to publish the case-less `success` here and unblock the
        // merge the rejection had just blocked.
        await this.publishTerminalCaseStatus(existingCase, payload);
        return { action: 'ignored', case_id: existingCase.case_id, reason: `case in terminal state: ${existingCase.status}` };
      }
      const updated = await this.updateCaseWithPR(payload, existingCase ?? undefined);
      if (!updated) {
        // No case matched this branch at all (issue #1024: an
        // empirical trace found `synchronize`/`push` on a case-less PR
        // published NOTHING). A required `arbitra/case` check evaluates the
        // PR's CURRENT head SHA, so every push must (re)publish — the
        // `opened` publish from the first commit doesn't cover later ones.
        await this.publishNoCaseStatusForPayload(payload);
      }
      return { action: updated ? 'case_updated' : 'no_matching_case' };
    }

    if (payload.action === 'closed' && payload.pr_url) {
      // PR merged or closed without merge — distinguish the two
      const case_ = await this.findCaseByPR(payload.pr_url);
      if (case_ && TERMINAL_CASE_STATUSES.has(case_.status)) {
        console.debug(`[webhook] Ignoring webhook for case ${case_.case_id} in terminal state: ${case_.status}`);
        return { action: 'ignored', case_id: case_.case_id, reason: `case in terminal state: ${case_.status}` };
      }
      if (case_) {
        if (payload.merged) {
          // Issue #996 repair: an Observed Case whose post-commit
          // `open → in_build` transition never landed (the process died, or
          // the transition call itself failed, between the claim commit and
          // that step) reads as stuck at `open` here — which the anomaly
          // branch just below would otherwise treat as "merged PR on a
          // gated/unexplored case" and never auto-close, silently. Re-drive
          // the transition via the same pipeline hook every other trigger
          // site uses before evaluating anything below, so a case that
          // recovers is judged on its recovered status.
          let sourceStatus = case_.status;
          if (case_.case_type === 'observed' && sourceStatus === 'open' && this.pipeline) {
            await this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
              console.error(`[webhook] observed-case repair transition failed for ${case_.case_id}:`, err);
            });
            try {
              sourceStatus = (await this.caseRepo.getById(case_.case_id)).status;
            } catch (err) {
              console.error(`[webhook] observed-case repair re-read failed for ${case_.case_id}:`, err);
            }
          }
          const flagEnabled = isAutoCloseOnMergeEnabled();

          // Anomaly branch: merged PR on a case in a gated or pre-build status.
          // Record the anomaly but do NOT auto-close; human intervention
          // required. We intentionally do NOT emit `pr_merged` here — the
          // case hasn't been through validation/review, so treating the
          // merge as a normal lifecycle signal would let the pipeline
          // silently advance it. The anomaly event is the ONLY signal the
          // activity feed/timeline should see for this path so operators can
          // spot and resolve manually.
          if (AUTO_CLOSE_ANOMALY_STATUSES.has(sourceStatus)) {
            await this.eventService.emit(
              case_.case_id,
              'case_anomaly_merge_on_gated_status',
              {
                pr_url: payload.pr_url,
                pr_number: payload.pr_number,
                branch: payload.branch,
                commit_sha: payload.commit_sha,
                source_status: sourceStatus,
                merged_at: new Date().toISOString(),
                reason: 'Merged PR on case in gated/unexplored status',
              },
              'system',
            );
            return { action: 'pr_merged_anomaly', case_id: case_.case_id, reason: `source status ${sourceStatus} is gated/unexplored` };
          }

          await this.eventService.emit(
            case_.case_id,
            'pr_merged',
            { pr_url: payload.pr_url, commit_sha: payload.commit_sha },
            'system',
          );

          // Eligible branch: short-circuit to `done` via pipeline auto-transition.
          // The new TRANSITION_MATRIX entries (in_build|in_validation|in_review|approved → done)
          // will fire because `pr_merged` precondition is satisfied by the event emitted above.
          let mergeAction = 'pr_merged_event';
          if (flagEnabled && AUTO_CLOSE_ELIGIBLE_STATUSES.has(sourceStatus)) {
            // Issue #1000: the transition itself is ALSO gated by
            // `all_steps_completed_or_not_high_critical_risk` now (AND-combined
            // with `pr_merged`) — an escalated or otherwise high/critical-risk
            // case with no approval decision documented does NOT get to close
            // just because its PR merged. Preview-evaluate that SAME gate here,
            // before writing anything, because the synthetic evidence and
            // audit comment below are an irreversible claim that the case
            // closed — the fire-and-forget `pipeline.onRunCompleted` call
            // further down is the only thing that actually runs the
            // transition, and by the time it settles (if it even resolves
            // before this handler returns) it is too late to un-write a false
            // "Case auto-closed on PR merge" comment.
            const gate = this.pipeline
              ? await this.pipeline
                  .evaluatePrecondition(case_, 'all_steps_completed_or_not_high_critical_risk')
                  .catch((err): PreconditionResult => {
                    console.error(
                      `[webhook] auto-close gate evaluation failed (case ${case_.case_id}), failing closed:`,
                      err,
                    );
                    return { satisfied: false, reason: 'gate evaluation threw' };
                  })
              : ({ satisfied: false, reason: 'no pipeline adapter configured' } as PreconditionResult);

            if (!gate.satisfied) {
              // Blocked: route into the SAME anomaly signal a human-gated
              // source status gets, rather than claiming closure. The
              // frontend already renders `case_anomaly_merge_on_gated_status`
              // generically off `source_status` — no UI change needed. The
              // `pr_merged` event emitted above still stands, so once the
              // case actually completes its steps and reaches `pending_merge`
              // the (`pr_merged`-only) `pending_merge → done` transition still
              // finds it satisfied; we are only refusing the SHORTCUT, not
              // the eventual close.
              mergeAction = 'pr_merged_gated';
              await this.eventService.emit(
                case_.case_id,
                'case_anomaly_merge_on_gated_status',
                {
                  pr_url: payload.pr_url,
                  pr_number: payload.pr_number,
                  branch: payload.branch,
                  commit_sha: payload.commit_sha,
                  source_status: sourceStatus,
                  merged_at: new Date().toISOString(),
                  reason: `Escalated/high-risk case with unmet evidence: ${gate.reason ?? 'gate not satisfied'}`,
                },
                'system',
              );
            } else {
              // Synthetic evidence: preserve completeness metrics for the case.
              // Non-critical: if evidence creation fails, auto-close still proceeds.
              try {
                await this.evidenceService.registerEvidence(
                  {
                    case_id: case_.case_id,
                    type: 'pr_merged',
                    source_type: 'webhook',
                    summary: `PR merged: ${payload.pr_url}${payload.commit_sha ? ` (merge SHA: ${payload.commit_sha})` : ''}`,
                    machine_readable: true,
                    artifact_ref: payload.pr_url,
                  },
                  'system',
                );
              } catch (err) {
                console.error(
                  `[webhook] Synthetic pr_merged evidence creation failed (case ${case_.case_id}):`,
                  err,
                );
              }

              // Audit comment: human-readable trail of the auto-close decision.
              await this.eventService.emit(
                case_.case_id,
                'comment_added',
                {
                  comment_type: 'system',
                  body: `Case auto-closed on PR merge. PR #${payload.pr_number ?? '?'} ${payload.pr_url} (source status: ${sourceStatus}).`,
                  pr_url: payload.pr_url,
                  pr_number: payload.pr_number,
                  source_status: sourceStatus,
                },
                'system',
              );
            }
          }

          // Trigger pipeline to evaluate auto-transitions. The pipeline itself
          // filters out auto-close-on-merge shortcut transitions when the
          // feature flag is disabled, so pending_merge → done still works.
          // Also the only thing that actually EXECUTES the transition above —
          // gated by the SAME precondition we just previewed, so a blocked
          // case's status genuinely does not change here.
          if (this.pipeline) {
            this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
              console.error(
                `[pipeline] onRunCompleted failed after pr_merged webhook (case ${case_.case_id}):`,
                err,
              );
            });
          }
          return { action: mergeAction, case_id: case_.case_id };
        } else {
          await this.eventService.emit(
            case_.case_id,
            'pr_closed',
            { pr_url: payload.pr_url },
            'system',
          );

          // Auto-reject orphan: case is still in `open` (exploration never
          // started) and the PR was closed unmerged. Without this the case
          // sits in `open` forever after the agent abandons the branch.
          // Mirrors the auto-close-on-merge flow: audit comment first, then
          // pipeline trigger so the synthetic open → rejected transition
          // (gated by `pr_closed_before_exploration`) fires.
          if (
            case_.status === 'open'
            && isAutoRejectOrphanOnPrClosedEnabled()
          ) {
            await this.eventService.emit(
              case_.case_id,
              'comment_added',
              {
                comment_type: 'system',
                body: `Case auto-rejected: PR #${payload.pr_number ?? '?'} closed unmerged before exploration started.`,
                pr_url: payload.pr_url,
                pr_number: payload.pr_number,
              },
              'system',
            );

            if (this.pipeline) {
              this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
                console.error(
                  `[pipeline] onRunCompleted failed after pr_closed orphan auto-reject (case ${case_.case_id}):`,
                  err,
                );
              });
            }
            return { action: 'pr_closed_auto_rejected', case_id: case_.case_id };
          }

          return { action: 'pr_closed_event', case_id: case_.case_id };
        }
      }
    }

    return { action: 'ignored' };
  }

  /**
   * Strict repository resolution for Session Signal refs (issue #1013).
   *
   * `resolveArbitraRepo`'s legacy step 3 used to be a `url.includes(payload.repository)`
   * substring match, on the premise that WEBHOOK payloads are safe to
   * substring-match because `repository` is always a well-formed `owner/repo`
   * GitHub slug. That premise was false (issue #1048): `owner/repo` is a
   * PREFIX of any sibling repo whose name extends it (`acme/api` is a
   * substring of `https://github.com/acme/api-gateway`), and unlike this
   * signal path, step 3 was the NORMAL first-webhook path for every freshly
   * registered repository — it also permanently backfilled the wrong row's
   * identity onto the wrong match. Step 3 now does the same exact-match-only
   * comparison this method does; the two paths differ only in which steps
   * exist at all (this method skips substring matching entirely and never had
   * a legacy id/full_name-less row to fall back through). Session Signals are
   * different from webhooks in another way: the emitting hook
   * (`packages/mcp/src/hooks/session-signal-hook.ts`,
   * `resolveGitContext`) falls back to a bare directory name when a workspace
   * has no git remote (e.g. a multi-repo container checkout), and a bare name
   * like `"arbitra"` is a substring of `https://github.com/acme/arbitra-app`
   * — the exact mis-attribution that created a junk "Observed: unknown" case
   * in the arbitra-app repository from an unrelated container session. A
   * signal ref must therefore match EXACTLY or stay unattributed:
   *
   *   1. `repository_id` — the ref IS a stored `Repository` doc id (no `/`,
   *      since Firestore doc ids can't contain one and every generated
   *      `repository_id` is slug-shaped without one).
   *   2. `github_full_name` — exact equality. `owner/repo` is globally unique
   *      on GitHub, so this is safe across every project/client.
   *   3. `url` — exact equality after `parseRepoRef` (host + owner + repo
   *      compared as parsed fields, tolerant of scheme, `www.`, embedded
   *      credentials, a `.git` suffix, trailing slash, extra path segments,
   *      and case — see `parseRepoRef`'s doc comment for the full list and
   *      for why a different host is a deliberate non-match), so `https://`
   *      vs `git@host:owner/repo.git` vs a trailing slash all still match —
   *      but NEVER a substring.
   *
   * Deliberately NOT matching on `Repository.name`: unlike `github_full_name`
   * or a remote `url`, `name` has no global uniqueness — it's scoped by
   * convention to a project, not enforced anywhere. Two different projects
   * (different Arbitra clients) can each hold a repo named e.g.
   * "arbitra-mcp"; a Session Signal carries no project context to disambiguate
   * by, so an exact-`name` step would cross-attribute one client's signal to
   * another client's repository of the same name. This is new attack surface
   * the legacy webhook path never had (it never matched bare names at all),
   * so it does not belong here either — matching only `repository_id`,
   * `github_full_name`, and normalized `url` keeps every match globally
   * unambiguous.
   *
   * No step here ever calls `.includes()` against a candidate string. Returns
   * `null` when nothing matches exactly — an unattributed signal is the
   * correct, safe outcome, not an error (mirrors `resolveArbitraRepoResult`'s
   * `not_found` contract).
   */
  async resolveRepositoryForSignal(repository: string): Promise<Repository | null> {
    const ref = repository.trim();
    if (!ref) return null;

    if (!ref.includes('/')) {
      try {
        const doc = await collections.repositories().doc(ref).get();
        if (doc.exists) return doc.data() as Repository;
      } catch (err) {
        console.warn(`[webhook] signal repository_id doc lookup failed for '${ref}':`, err);
      }
    }

    try {
      const snap = await collections.repositories().where('github_full_name', '==', ref).limit(1).get();
      if (!snap.empty) return snap.docs[0]!.data();
    } catch (err) {
      console.warn(`[webhook] signal github_full_name lookup failed for '${ref}':`, err);
    }

    const parsedRef = parseRepoRef(ref);
    if (parsedRef) {
      try {
        const snap = await collections.repositories().limit(200).get();
        const match = snap.docs.find((d) => sameRepoRef(parseRepoRef(d.data().url), parsedRef));
        if (match) return match.data();
      } catch (err) {
        console.warn(`[webhook] signal url lookup failed for '${ref}':`, err);
      }
    }

    return null;
  }

  async handleCIWebhook(payload: CIWebhookPayload): Promise<CIWebhookResult> {
    // Try to find case by explicit case_id only. Branch-only lookup is unsafe
    // without a repository scope (collisions on `main` across repos), and CI
    // webhooks don't carry a repository identifier — require the case_id on
    // the CI payload to attach evidence.
    const caseId = payload.case_id;

    if (!caseId) {
      console.warn(
        `[webhook] CI webhook without case_id is rejected (branch=${payload.branch ?? '<none>'}, build=${payload.build_id}); `
        + `re-emit with explicit case_id to attach evidence.`,
      );
      return { ok: false, reason: 'missing_case_id' };
    }

    const ciCase = await this.caseRepo.getById(caseId).catch(() => null);
    if (!ciCase) {
      // Explicit check before any evidence write — hardening. Previously
      // this fell through to `evidenceService.registerEvidence()` below,
      // which happened to also throw (its own internal `getById` re-fetch)
      // for an unknown case, but only *after* actor-metadata normalization
      // ran and relied on that unrelated call for the 404. Make the
      // case-existence gate explicit here so it can't silently regress if
      // `registerEvidence`'s internals ever change.
      console.warn(`[webhook] CI webhook for unknown case ${caseId} rejected (build=${payload.build_id}); no evidence written.`);
      return { ok: false, reason: 'case_not_found' };
    }
    if (TERMINAL_CASE_STATUSES.has(ciCase.status)) {
      console.debug(`[webhook] Ignoring CI webhook for case ${caseId} in terminal state: ${ciCase.status}`);
      return { ok: true, action: 'ignored_terminal' };
    }

    await this.evidenceService.registerEvidence(
      {
        case_id: caseId,
        type: 'ci_result',
        source_type: 'webhook',
        summary: `CI build ${payload.build_id}: ${payload.status}`,
        machine_readable: true,
      },
      'system',
    );

    // Trigger pipeline to evaluate auto-transitions after evidence arrival.
    // Non-critical: pipeline failure doesn't block the evidence registration
    // that already succeeded above — but log it so silent drops are visible.
    if (this.pipeline) {
      this.pipeline.onRunCompleted(caseId).catch((err) => {
        console.error(
          `[pipeline] onRunCompleted failed after ci_status webhook (case ${caseId}, build ${payload.build_id}):`,
          err,
        );
      });
    }

    return { ok: true, action: 'evidence_registered' };
  }

  private async recordUnlinkedPullRequest(
    payload: GitWebhookPayload,
    resolvedArbitraRepoId?: string,
  ): Promise<void> {
    await this.workspaceEventService.record({
      event_id: unlinkedPullRequestEventId(payload, resolvedArbitraRepoId),
      type: 'unlinked_pull_request',
      actor_user_id: 'system:arbitra-webhook',
      summary: `Pull request opened without linked Arbitra case: ${formatPullRequestLabel(payload)}`,
      evidence: {
        pr_url: payload.pr_url,
        pr_number: payload.pr_number,
        title: payload.title,
        branch: payload.branch,
        repository: payload.repository,
        github_repository_id: payload.repository_id,
        arbitra_repository_id: resolvedArbitraRepoId,
        reason: 'No existing case matched by branch-name case id, PR text case id, or branch within the resolved repository.',
        hint: 'Create an Arbitra case explicitly or add an existing case id to the branch name or PR body, then reopen/synchronize the PR so Arbitra can link it.',
      },
    });
  }

  /**
   * Publishes an unconditional `success` `arbitra/case` commit status for a
   * webhook payload whose PR will NOT get (or isn't linked to) an Arbitra
   * case (issue #1024, AC: "A PR with no case carries `arbitra/case:
   * success`"). A required `arbitra/case` check blocks a merge forever while
   * its context has never reported against the PR's CURRENT head SHA — so
   * every exit that lets a `pull_request` event finish without a case being
   * linked must call this, not just the first (`opened`) one. Call sites,
   * traced by enumerating every early return in `handleGitWebhook`:
   *   - the `repository_id` conflict early-return (before any per-action
   *     branch, covers `opened`/`synchronize`/`push` alike)
   *   - `opened`: branch matched a TERMINAL case (not relinked — case-less
   *     from this PR's perspective), auto-creation blocked by branch
   *     pattern, blocked by zero changed files, and the default unlinked-PR
   *     nudge
   *   - `synchronize`/`push`: branch matched a TERMINAL case, and no case
   *     matched at all (`no_matching_case`) — the latter is the fix for the
   *     reviewer-confirmed gap where a case-less PR's SECOND push published
   *     nothing, permanently blocking the normal review-fixup case
   *
   * Deliberately NOT called for: a branch-delete push (all-zero commit SHA —
   * no real commit to attach a status to), the `closed` action's terminal-
   * or no-case exits (the PR is already closed/merged, so there is no
   * pending merge left to unblock), or any `pull_request` action other than
   * opened/synchronize/closed (e.g. `reopened`, `edited` — these fall to the
   * catch-all `{ action: 'ignored' }` with no branch/pr context reliably
   * available here; a case-less PR reopened without a new push stays stuck
   * until its next `synchronize`, which the `no_matching_case` branch above
   * now covers).
   *
   * No-ops when `payload.pr_url` is absent (e.g. a bare `push` with no open
   * PR) — there's no PR to attach a status to.
   *
   * Fire-and-forget-safe but awaited inline (matching
   * `EventNotifier.onCaseEvent`'s call to the sibling `publishCaseCommitStatus`):
   * `publishNoCaseCommitStatus` is fail-soft by contract and never throws, so
   * no try/catch is needed here beyond logging a warning if it reports failure.
   */
  private async publishNoCaseStatusForPayload(payload: GitWebhookPayload): Promise<void> {
    if (!payload.pr_url) return;
    const result = await publishNoCaseCommitStatus(payload.pr_url, { headSha: payload.commit_sha });
    if (!result.published) {
      console.warn(
        `[webhook] Failed to publish no-case arbitra/case status for ${payload.pr_url}: ${result.reason}`,
      );
    }
  }

  /**
   * Status for a webhook whose branch matched a case in a TERMINAL status
   * (`done` / `rejected`) — issue #1046.
   *
   * The two situations behind that one condition are opposites, and before
   * #1046 both got the case-less `success`:
   *
   *   - **The terminal case's OWN PR.** A human rejected in the Courtroom,
   *     `failure`/"case rejected" landed on head SHA A, the merge was
   *     blocked — and then one push (or one click on GitHub's "Update
   *     branch") produced SHA B, which got `success` and merged the rejected
   *     work. Nothing else recovers: nothing closes the PR on rejection,
   *     nothing clears `current_branch`, and `DecisionService` refuses
   *     further transitions on a terminal case, so no later event ever
   *     re-publishes. The honest status here is the case's OWN verdict,
   *     which preserves the rejection.
   *   - **A branch reused after a terminal case that pointed at a DIFFERENT
   *     PR.** This PR genuinely has no case; the terminal one is stale
   *     governance that must not be re-linked. It keeps the case-less
   *     `success` from #1024 — without it a reused branch would be
   *     permanently blocked once `arbitra/case` is required.
   *
   * PR identity, not status, is what separates them. `publishCaseCommitStatus`
   * (not a bespoke verdict here) computes the own-PR status, so a terminal
   * Observed Case or Assistant Task still gets its unconditional "not
   * enforced" success — those were never gated on a review.
   */
  private async publishTerminalCaseStatus(
    case_: Case,
    payload: GitWebhookPayload,
  ): Promise<void> {
    if (!ownsPullRequest(case_.current_pr_ref, payload.pr_url)) {
      await this.publishNoCaseStatusForPayload(payload);
      return;
    }

    const result = await publishCaseCommitStatus(case_, {}, {
      headSha: payload.commit_sha,
      prRefOverride: payload.pr_url,
    });
    if (!result.published) {
      console.warn(
        `[webhook] Failed to publish terminal-case arbitra/case status for `
        + `${payload.pr_url} (case ${case_.case_id}, ${case_.status}): ${result.reason}`,
      );
    }
  }

  private async updateCaseWithPR(payload: GitWebhookPayload, prefetchedCase?: Case): Promise<boolean> {
    if (!payload.branch) return false;

    let case_: Case | null = prefetchedCase ?? null;
    if (!case_) {
      const resolved = await this.resolveArbitraRepo(payload).catch(() => null);
      if (!resolved) return false;
      case_ = await this.findCaseByBranch(payload.branch, resolved.repository_id);
    }
    if (!case_) return false;

    // Escalation (issue #987 / ADR-0001): a PR opened/synchronized against an
    // Observed Case is the first point real signal (changed files, title,
    // body) exists to classify risk — re-evaluate on every such enrichment.
    // No-op for any case that isn't (or is no longer) `case_type: 'observed'`
    // — see `evaluateObservedCaseEscalation`'s doc-comment for the full
    // idempotency/manual-case argument.
    if (case_.case_type === 'observed') {
      const escalation = await evaluateObservedCaseEscalation(
        case_,
        {
          branch: payload.branch,
          changedFiles: payload.changed_files,
          prTitle: payload.title,
          prBody: payload.body,
        },
        { eventService: this.eventService, caseRepo: this.caseRepo },
      ).catch((err) => {
        console.error(`[webhook] Escalation evaluation failed for case ${case_?.case_id}:`, err);
        return null;
      });
      if (escalation) {
        case_ = escalation.case;
        // Deliberately NOT triggering the pipeline here: escalation flips
        // `case_type` but never `status`, and the case still needs real
        // evidence/a build run before any engineering-lifecycle transition
        // can pass its preconditions — the next genuine signal (build_run
        // completion, review, another webhook) drives the pipeline as
        // normal. Matches `updateCaseWithPR`'s existing behavior for its
        // other field updates (pr_url/branch), which likewise don't trigger
        // the pipeline themselves.
      }
    }

    const updates: Partial<Case> = { updated_at: new Date().toISOString() };
    if (payload.pr_url && !case_.current_pr_ref) {
      updates.current_pr_ref = payload.pr_url;
    }
    if (payload.branch && payload.branch !== case_.current_branch) {
      updates.current_branch = payload.branch;
    }
    recordObservedHeadSha(updates, payload, case_);

    await this.caseRepo.update(case_.case_id, updates);

    await this.eventService.emit(
      case_.case_id,
      'pr_updated',
      { pr_url: payload.pr_url, commit_sha: payload.commit_sha },
      'system',
    );

    return true;
  }

  /**
   * Handles the top-level `repository` GitHub event. Today we only act on
   * `action: 'renamed'` — the stored `github_full_name` is refreshed and an
   * audit workspace event is written. Match is by numeric `repository.id` so
   * renames of either the repo short name or the owning org/user resolve
   * cleanly. Returns an `ignored`-shaped response for unsupported actions to
   * keep GitHub's retry logic happy (200 OK).
   */
  private async handleRepositoryEvent(
    payload: GitWebhookPayload,
  ): Promise<{ action: string; reason?: string; repository_id?: string }> {
    if (payload.action !== 'renamed') {
      return { action: 'ignored', reason: `unsupported repository action: ${payload.action}` };
    }

    if (payload.repository_id === undefined) {
      await this.logWebhookRejection({
        reason: 'repository.renamed event missing numeric repository.id',
        event: 'repository',
        action: payload.action,
        repository: payload.repository,
      });
      return { action: 'ignored', reason: 'missing repository.id on rename event' };
    }

    // Try the robust id match first, then the legacy old-full_name path.
    const resolved = await this.resolveArbitraRepo({
      ...payload,
      // Feed the handler the OLD name so the fallback can find legacy rows
      // that never got their id backfilled before the rename happened.
      repository: payload.repository_old_full_name ?? payload.repository,
    });

    if (!resolved) {
      await this.logWebhookRejection({
        reason: `unknown repository on rename (id=${payload.repository_id}, old=${payload.repository_old_full_name}, new=${payload.repository})`,
        event: 'repository',
        action: payload.action,
        repository: payload.repository,
        repository_id: payload.repository_id,
      });
      return { action: 'ignored', reason: 'unknown repository on rename' };
    }

    const updates: Partial<Repository> = {
      github_full_name: payload.repository,
      github_repository_id: payload.repository_id,
      updated_at: new Date().toISOString(),
    };
    try {
      await collections.repositories().doc(resolved.repository_id).update(updates);
    } catch (err) {
      console.error(`[webhook] Failed to persist rename for ${resolved.repository_id}:`, err);
      return { action: 'ignored', reason: 'persistence failed' };
    }

    // Audit trail. Workspace-level because a rename affects the whole
    // workspace's repo wiring, not any single case.
    try {
      await this.workspaceEventService.record({
        type: 'arbitra_repo_renamed',
        actor_user_id: 'system:arbitra-webhook',
        summary: `Repository renamed on GitHub: ${payload.repository_old_full_name ?? '?'} → ${payload.repository}`,
        evidence: {
          repository_id: resolved.repository_id,
          github_repository_id: payload.repository_id,
          old_full_name: payload.repository_old_full_name,
          new_full_name: payload.repository,
        },
      });
    } catch (err) {
      console.error('[webhook] Failed to record arbitra_repo_renamed workspace event:', err);
    }

    return { action: 'repository_renamed', repository_id: resolved.repository_id };
  }

  /**
   * Finds the stored `Repository` row matching a webhook payload.
   *
   * Match order (rename-proof first):
   *   1. `github_repository_id` — immutable, survives every rename.
   *   2. `github_full_name` — cached slug, set on prior matches.
   *   3. `url`, by EXACT `parseRepoRef` equality (host + owner + repo, not
   *      the raw string) against `https://github.com/<payload.repository>`
   *      (issue #1048 — was a bare `url.includes(payload.repository)`
   *      substring match until then). NOT a rare legacy path: the
   *      repository-registration route writes neither `github_full_name` nor
   *      `github_repository_id`, so steps 1 and 2 miss for every freshly
   *      registered repository and this is its first-webhook match. When
   *      this path hits, we opportunistically backfill both
   *      `github_repository_id` and `github_full_name` so the next event
   *      takes the fast path. The backfill NEVER overwrites a populated id —
   *      that would let a payload with a stale full_name clobber a good row.
   *      When the scan finds MORE THAN ONE row whose url matches (issue
   *      #1048 follow-up F2), the ambiguity means a PRE-GUARD row pair —
   *      registration now enforces `url` uniqueness (409) the same way it
   *      enforces `github_repository_id`'s, so a NEW duplicate cannot be
   *      created through ordinary use, but a row pair registered before
   *      that guard existed can still collide. Refusing to route at all
   *      here — unlike the `github_repository_id` conflict below, which
   *      registration has ALWAYS prevented — would leave such a pre-guard
   *      duplicate permanently unroutable (backfill never runs, so it can
   *      never self-heal) and publish a case-less `success` on every PR for
   *      both rows forever. So this ONLY refuses the backfill; it still
   *      ROUTES, deterministically, to the oldest matching row
   *      (`created_at` ascending, `repository_id` as a stable tiebreaker) —
   *      never to whichever row a Firestore query happens to return first.
   *      Either way the conflict is recorded so an operator can deduplicate.
   */
  private async resolveArbitraRepo(
    payload: { repository?: string; repository_id?: number },
    options: { readOnly?: boolean } = {},
  ): Promise<Repository | null> {
    return (await this.resolveArbitraRepoResult(payload, options)).repo;
  }

  /**
   * Richer variant of `resolveArbitraRepo` that distinguishes "no row matched"
   * (`status: 'not_found'`) from "the row could not be resolved because the
   * GitHub id is in conflict" (`status: 'conflict'`). `handleGitWebhook` uses
   * the discriminator so it does NOT log a misleading `webhook_rejected`
   * "unknown repository" on top of the already-recorded conflict event — the
   * repo is known, it's just ambiguous. The `'matched'` case is identical to
   * the legacy behaviour. `repo` mirrors the public method's `Repository | null`
   * so the thin wrapper above stays a one-liner.
   */
  private async resolveArbitraRepoResult(
    payload: { repository?: string; repository_id?: number },
    options: { readOnly?: boolean } = {},
  ): Promise<{ status: 'matched' | 'not_found' | 'conflict'; repo: Repository | null }> {
    // `readOnly: true` (issue #1032) — used by the admin recovery
    // path's `resolveCaseForPrRecovery`, which must perform ZERO Firestore
    // writes: an admin re-publish must not opportunistically stamp
    // `github_full_name`/`github_repository_id` backfill onto a repository
    // row off the step-3 url match — even now that step 3 is exact-match-only
    // (issue #1048) rather than substring, an admin-supplied slug landing on
    // the wrong row would still poison that row's future webhook routing.
    // Every write below (backfill, conflict event, mismatch event) is
    // skipped in this mode; matching itself is unchanged — a `readOnly`
    // caller may still learn "matched", it just never persists what it
    // learned along the way.
    const readOnly = options.readOnly ?? false;
    // 1. Primary: match by numeric id.
    if (payload.repository_id !== undefined) {
      try {
        // Fetch a small bounded set (not `.limit(1)`) so we can DETECT whether
        // more than one Arbitra row owns this GitHub id. The normal case is
        // exactly one row, which behaves identically to the old `.limit(1)`
        // fast path — same routing, no extra event. When duplicates exist we
        // must NOT silently route to an arbitrary `docs[0]`; doing so would
        // non-deterministically mis-attribute the event to whichever Firestore
        // doc came back first (issue #628). The cap is generous enough that a
        // genuine 2+ conflict is always observed while bounding reads.
        const snap = await collections.repositories()
          .where('github_repository_id', '==', payload.repository_id)
          .limit(10)
          .get();
        if (!snap.empty) {
          const matchedRepos = snap.docs.map((d) => d.data());
          const conflicts = findDuplicateGithubRepositoryIds(matchedRepos);
          if (conflicts.length > 0) {
            // STOP. Record a diagnosable, deduped conflict event and ignore the
            // webhook rather than route to an arbitrary row. Do NOT fall through
            // to the full_name / url paths either — those could resolve to one
            // of the very rows in conflict and re-introduce arbitrary routing.
            if (!readOnly) {
              await this.recordRepositoryIdConflict(
                payload.repository_id,
                conflicts[0]!.repository_ids,
                payload.repository,
              );
            }
            return { status: 'conflict', repo: null };
          }
          return { status: 'matched', repo: matchedRepos[0]! };
        }
      } catch (err) {
        console.warn('[webhook] github_repository_id lookup failed:', err);
      }
    }

    if (!payload.repository) return { status: 'not_found', repo: null };
    const repositoryFullName = payload.repository;

    // 2. Fallback: cached full_name.
    try {
      const snap = await collections.repositories()
        .where('github_full_name', '==', repositoryFullName)
        .limit(1)
        .get();
      if (!snap.empty) {
        const repo = snap.docs[0]!.data();
        // Backfill id if this row was matched by full_name but has no id yet.
        if (!readOnly && payload.repository_id !== undefined && repo.github_repository_id === undefined) {
          // Preflight: never stamp this id if ANOTHER row already owns it —
          // doing so would manufacture exactly the duplicate the routing guard
          // above must then reject. Record the conflict and return this
          // name-matched row WITHOUT backfilling the contested id (the existing
          // owner keeps it), so we don't create a second owner.
          if (await this.otherRowOwnsGithubId(payload.repository_id, repo.repository_id)) {
            await this.recordRepositoryIdConflict(
              payload.repository_id,
              [repo.repository_id],
              repositoryFullName,
            );
            return { status: 'matched', repo };
          }
          await this.backfillRepositoryIdentity(repo.repository_id, {
            github_repository_id: payload.repository_id,
          });
          return { status: 'matched', repo: { ...repo, github_repository_id: payload.repository_id } };
        }
        // Defensive: stored id AND payload id both populated but they differ.
        // Could mean crossed-wire data (two arbitra rows accidentally sharing
        // a slug), GitHub reassigning an id (extremely rare), or a fork/rename
        // edge case. Do NOT auto-migrate — just surface it so an operator can
        // investigate. Also emit a workspace event for audit (cheap).
        if (
          payload.repository_id !== undefined
          && repo.github_repository_id !== undefined
          && repo.github_repository_id !== payload.repository_id
        ) {
          console.warn(
            `[webhook] repository.id mismatch for arbitra repo ${repo.repository_id}: `
            + `stored github_repository_id=${repo.github_repository_id}, `
            + `payload repository_id=${payload.repository_id}, `
            + `full_name=${repositoryFullName}`,
          );
          if (!readOnly) {
            try {
              await this.workspaceEventService.record({
                type: 'webhook_id_mismatch',
                actor_user_id: 'system:arbitra-webhook',
                summary: `Webhook repository.id mismatch on ${repositoryFullName}`,
                evidence: {
                  repository_id: repo.repository_id,
                  stored_github_repository_id: repo.github_repository_id,
                  payload_repository_id: payload.repository_id,
                  full_name: repositoryFullName,
                },
              });
            } catch (err) {
              console.error('[webhook] Failed to record webhook_id_mismatch audit event:', err);
            }
          }
        }
        return { status: 'matched', repo };
      }
    } catch (err) {
      console.warn('[webhook] github_full_name lookup failed:', err);
    }

    // 3. `url`, by EXACT `parseRepoRef` equality (issue #1048). Intentionally
    // scanned client-side — Firestore has no operator for a derived/parsed
    // comparison. Bounded by limit to avoid runaway reads on large workspaces.
    //
    // MUST be exact equality, never `.includes()`: `owner/repo` is a PREFIX
    // of any sibling repo whose name extends it — `acme/api` is a substring
    // of `https://github.com/acme/api-gateway`,
    // `acme/arbitra` is a substring of `.../arbitra-mcp` —
    // and both can be live, independently registered repositories in one org.
    // A substring hit here used to backfill the WRONG row's identity
    // (`github_repository_id`/`github_full_name`) onto the sibling
    // PERMANENTLY, after which the sibling's own webhooks would route there
    // via the step-1 fast path forever, and the victim repo's cases would
    // reject every one of its own PRs on repository mismatch.
    try {
      const targetRef = parseRepoRef(`https://github.com/${repositoryFullName}`);
      if (!targetRef) return { status: 'not_found', repo: null };

      const snap = await collections.repositories().limit(200).get();
      const matches = snap.docs.filter((d) => sameRepoRef(parseRepoRef(d.data().url), targetRef));

      if (matches.length > 1) {
        // Ambiguous: more than one Arbitra row's url resolves to the same
        // target — a PRE-GUARD duplicate registration (issue #1048 follow-up
        // F2 makes registration enforce `url` uniqueness the same way it
        // enforces `github_repository_id`'s, so this pair predates that
        // guard rather than being freshly creatable). Record it either way
        // so an operator can deduplicate, but do NOT refuse to route: unlike
        // the `github_repository_id` conflict above (which registration has
        // ALWAYS prevented), refusing here would leave the duplicate
        // permanently unroutable — backfill never runs, so it can never
        // self-heal — and publish a case-less `success` on every PR for
        // both rows forever. Route deterministically to the OLDEST
        // matching row (`created_at` ascending, `repository_id` as a stable
        // tiebreaker for equal/malformed timestamps) — never to whichever
        // row a Firestore query happens to return first — but skip the
        // backfill entirely: an ambiguous match must never risk stamping
        // `github_repository_id`/`github_full_name` onto the wrong row.
        if (!readOnly) {
          await this.recordRepositoryUrlConflict(repositoryFullName, matches.map((d) => d.data()));
        }
        const oldest = [...matches].sort((a, b) => {
          const aCreated = a.data().created_at ?? '';
          const bCreated = b.data().created_at ?? '';
          if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
          return a.data().repository_id < b.data().repository_id ? -1 : 1;
        })[0]!;
        return { status: 'matched', repo: oldest.data() };
      }

      const match = matches[0];
      if (match) {
        const repo = match.data();
        // `readOnly` short-circuits BEFORE any backfill is even computed —
        // this is the specific write finding #2 flagged: an admin-supplied
        // owner/repo slug reaching this match must never get stamped onto
        // `github_full_name` (poisoning future webhook routing through this
        // same lookup).
        if (readOnly) {
          return { status: 'matched', repo };
        }
        const backfill: Partial<Repository> = {};
        if (payload.repository_id !== undefined && repo.github_repository_id === undefined) {
          // Same preflight as the full_name path: only adopt the id if no other
          // row already owns it. On conflict, record it and backfill ONLY the
          // (safe) cached full_name, leaving the id to the existing owner.
          if (await this.otherRowOwnsGithubId(payload.repository_id, repo.repository_id)) {
            await this.recordRepositoryIdConflict(
              payload.repository_id,
              [repo.repository_id],
              repositoryFullName,
            );
          } else {
            backfill.github_repository_id = payload.repository_id;
          }
        }
        if (!repo.github_full_name) {
          backfill.github_full_name = repositoryFullName;
        }
        if (Object.keys(backfill).length > 0) {
          await this.backfillRepositoryIdentity(repo.repository_id, backfill);
          return { status: 'matched', repo: { ...repo, ...backfill } };
        }
        return { status: 'matched', repo };
      }
    } catch (err) {
      console.warn('[webhook] legacy url lookup failed:', err);
    }

    return { status: 'not_found', repo: null };
  }

  /**
   * Detects push-only GitHub webhook subscriptions and surfaces them as a
   * `webhook_misconfigured` workspace event. Runs on every `push` /
   * `pull_request` event but is strictly input-layer — no case state is
   * ever touched here.
   *
   *   - `pull_request` arrives → set `pull_request_event_seen_at` on the repo
   *     row (idempotent: only written when unset). This is the "healthy" flag.
   *   - `push` arrives, flag still unset, repo was first seen >24h ago, and
   *     no prior warning exists → emit one `webhook_misconfigured` workspace
   *     event and stamp `webhook_misconfig_warned_at` so the next push doesn't
   *     duplicate the warning. The UI keeps rendering the warning as long as
   *     `pull_request_event_seen_at` is unset.
   *
   * The 24h grace period avoids noise during normal onboarding, where the
   * first `push` to a freshly registered repo is expected before any PR has
   * been opened.
   */
  private async checkWebhookSubscriptionHealth(payload: GitWebhookPayload): Promise<void> {
    // Self-protect against branch-delete pushes. GitHub sends `push` with the
    // all-zero after-sha when a branch is deleted, and those pushes still
    // satisfy the "event === 'push' && no prior pull_request_event_seen_at"
    // shape we warn on — so without this guard every pre-existing repo
    // (whose flag is unset and created_at is >24h old) would emit a false
    // `webhook_misconfigured` on its next branch-delete push. The caller at
    // `handleGitWebhook` also drops zero-SHA pushes a few lines later, but
    // this function runs first; don't rely on callers to filter.
    if (payload.commit_sha === ZERO_COMMIT_SHA) return;

    const repo = await this.resolveArbitraRepo(payload).catch(() => null);
    if (!repo) return;

    const now = new Date();
    const nowIso = now.toISOString();

    if (payload.event === 'pull_request') {
      if (repo.pull_request_event_seen_at) return;
      try {
        // Clear the misconfig warning in the same write: the subscription
        // demonstrably delivers pull_request events now, so a lingering
        // warned-at stamp would misrepresent the repo's state (the UI alert
        // already keys on `warned_at && !seen_at`, this keeps the data model
        // honest too).
        await collections.repositories().doc(repo.repository_id).update({
          pull_request_event_seen_at: nowIso,
          webhook_misconfig_warned_at: FieldValue.delete(),
          updated_at: nowIso,
        });
      } catch (err) {
        console.warn(`[webhook] Failed to flip pull_request_event_seen_at on ${repo.repository_id}:`, err);
      }
      return;
    }

    // event === 'push'
    if (repo.pull_request_event_seen_at) return;
    if (repo.webhook_misconfig_warned_at) return;

    const createdAtMs = Date.parse(repo.created_at);
    if (!Number.isFinite(createdAtMs)) return;
    if (now.getTime() - createdAtMs < MISCONFIG_GRACE_PERIOD_MS) return;

    try {
      await this.workspaceEventService.record({
        type: 'webhook_misconfigured',
        actor_user_id: 'system:arbitra-webhook',
        summary: `GitHub webhook for ${repo.github_full_name ?? repo.name} is missing pull_request — auto-close on merge will not fire`,
        evidence: {
          repo_id: repo.repository_id,
          project_id: repo.project_id,
          github_full_name: repo.github_full_name,
          hint: 'GitHub webhook missing pull_request event — auto-close on merge will not fire',
        },
      });
    } catch (err) {
      console.error('[webhook] Failed to record webhook_misconfigured event:', err);
      return;
    }

    try {
      await collections.repositories().doc(repo.repository_id).update({
        webhook_misconfig_warned_at: nowIso,
        updated_at: nowIso,
      });
    } catch (err) {
      console.warn(`[webhook] Failed to stamp webhook_misconfig_warned_at on ${repo.repository_id}:`, err);
    }
  }

  /**
   * Opportunistic backfill of GitHub identity fields onto a legacy row.
   * Never clears or overwrites existing values (the caller filters those
   * cases out before invoking). Fire-and-forget logging on error — the
   * current request must not fail if the backfill write races a concurrent
   * update.
   */
  private async backfillRepositoryIdentity(
    repositoryId: string,
    patch: Partial<Pick<Repository, 'github_repository_id' | 'github_full_name' | 'default_branch'>>,
  ): Promise<void> {
    try {
      await collections.repositories().doc(repositoryId).update({
        ...patch,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[webhook] Backfill failed for ${repositoryId}:`, err);
    }
  }

  /**
   * Backfill preflight: returns `true` when an Arbitra repository row OTHER
   * than `candidateRepositoryId` already carries `githubRepositoryId`. Used to
   * stop a name/URL-matched row from being stamped with an id another row
   * already owns — which would manufacture exactly the duplicate the routing
   * guard then has to reject. A read failure is treated as "no conflict" so a
   * transient Firestore error never blocks a legitimate first-time backfill.
   */
  private async otherRowOwnsGithubId(
    githubRepositoryId: number,
    candidateRepositoryId: string,
  ): Promise<boolean> {
    try {
      const snap = await collections.repositories()
        .where('github_repository_id', '==', githubRepositoryId)
        .limit(10)
        .get();
      return snap.docs.some((d) => d.data().repository_id !== candidateRepositoryId);
    } catch (err) {
      console.warn('[webhook] github_repository_id preflight lookup failed:', err);
      return false;
    }
  }

  /**
   * Records a deduped, diagnosable `webhook_repository_id_conflict` workspace
   * event so an operator can see that a GitHub numeric id is owned by more than
   * one Arbitra row (routing) or would be duplicated by backfill. The event id
   * is deterministic per `(github id, UTC day)`, so a noisy repo collapses to a
   * single event per day instead of spamming the activity feed. Fire-and-forget:
   * a logging failure must never block the webhook request.
   */
  private async recordRepositoryIdConflict(
    githubRepositoryId: number,
    conflictingRepositoryIds: string[],
    fullName?: string,
  ): Promise<void> {
    try {
      await this.workspaceEventService.record({
        event_id: repositoryIdConflictEventId(githubRepositoryId),
        type: 'webhook_repository_id_conflict',
        actor_user_id: 'system:arbitra-webhook',
        summary:
          `Webhook ignored: GitHub repository id ${githubRepositoryId}`
          + ` is owned by more than one Arbitra repository`
          + (fullName ? ` (${fullName})` : ''),
        evidence: {
          github_repository_id: githubRepositoryId,
          conflicting_repository_ids: conflictingRepositoryIds,
          ...(fullName ? { full_name: fullName } : {}),
          hint:
            'Two or more Arbitra repository rows share this GitHub numeric id. '
            + 'Webhook routing was stopped to avoid mis-attributing the event. '
            + 'Resolve the duplicate so exactly one row owns this id.',
        },
      });
    } catch (err) {
      console.error('[webhook] Failed to record webhook_repository_id_conflict event:', err);
    }
  }

  /**
   * Records a deduped, diagnosable `webhook_repository_url_conflict`
   * workspace event (issue #1048) when step-3 url matching is ambiguous:
   * more than one Arbitra repository row's `url` resolves (via
   * `parseRepoRef`) to the same target. Unlike the numeric-id conflict
   * (`recordRepositoryIdConflict`), this does NOT mean routing stopped —
   * step 3 still routes to one of the rows (see its caller) — it means
   * backfill was skipped and a human should deduplicate the rows. The event
   * id is deterministic per `(repositoryFullName, UTC day)`, mirroring
   * `recordRepositoryIdConflict`'s dedup discipline. `evidence` carries each
   * conflicting row's `url` and `project_id`, not just its `repository_id`
   * — an operator needs to SEE which rows collide and where they live to
   * act on this, not just their opaque ids. Fire-and-forget: a logging
   * failure must never block the webhook request.
   */
  private async recordRepositoryUrlConflict(
    repositoryFullName: string,
    conflictingRepos: Array<Pick<Repository, 'repository_id' | 'project_id' | 'url'>>,
  ): Promise<void> {
    try {
      await this.workspaceEventService.record({
        event_id: repositoryUrlConflictEventId(repositoryFullName),
        type: 'webhook_repository_url_conflict',
        actor_user_id: 'system:arbitra-webhook',
        summary:
          `Repository url matching "${repositoryFullName}" is ambiguous across `
          + `${conflictingRepos.length} Arbitra repositories`,
        evidence: {
          repository_full_name: repositoryFullName,
          conflicting_repositories: conflictingRepos.map((r) => ({
            repository_id: r.repository_id,
            project_id: r.project_id,
            url: r.url,
          })),
          hint:
            'Two or more Arbitra repository rows resolve to the same GitHub url. '
            + 'Webhooks are routed to the oldest row but never backfilled onto it, '
            + 'so it cannot pick up github_repository_id and this event will keep '
            + 'recurring until an operator deduplicates the rows.',
        },
      });
    } catch (err) {
      console.error('[webhook] Failed to record webhook_repository_url_conflict event:', err);
    }
  }

  /**
   * Hybrid case lookup for `pull_request.opened`: parses the branch name for
   * an embedded Arbitra `case_id` and, if a matching non-terminal case on the
   * same repo exists, links the PR to it instead of letting the downstream
   * branch-scan miss and record an unlinked-PR nudge.
   *
   * Returns the response to surface to the caller when a link was made.
   * Returns `null` to signal "no branch-name link found, keep going" — the
   * caller then runs the existing `findCaseByBranch` / unlinked-PR flow.
   *
   * Repo mismatch intentionally falls through (returns null): we don't want
   * to misappropriate a case that happens to share a case-id shape with a
   * branch in a foreign repo. A warning is logged for operator visibility.
   */
  private async tryLinkCaseByBranchName(
    payload: GitWebhookPayload,
  ): Promise<{ action: string; case_id?: string; reason?: string } | null> {
    if (!payload.branch) return null;
    const candidateId = extractCaseIdFromBranch(payload.branch);
    if (!candidateId) return null;

    // Repo match: compare against the resolved arbitra repository_id so slug
    // renames don't misroute. If we can't resolve the payload repo, use the
    // raw slug as the candidate.
    let payloadRepoId: string = payload.repository;
    try {
      const resolved = await this.resolveArbitraRepo(payload);
      if (resolved) payloadRepoId = resolved.repository_id;
    } catch {
      // Use raw slug as the comparison key.
    }

    const existing = await this.matchCandidateCase(candidateId, payloadRepoId, 'Branch-name');
    if (!existing) return null;

    // Link: persist branch + PR on the existing case, emit a `pr_opened`
    // event, and leave an audit trail so the manual link is visible in the
    // case timeline.
    const updates: Partial<Case> = { updated_at: new Date().toISOString() };
    if (payload.branch !== existing.current_branch) {
      updates.current_branch = payload.branch;
    }
    if (payload.pr_url && payload.pr_url !== existing.current_pr_ref) {
      updates.current_pr_ref = payload.pr_url;
    }
    recordObservedHeadSha(updates, payload, existing);
    try {
      await this.caseRepo.update(existing.case_id, updates);
    } catch (err) {
      console.error(
        `[webhook] Failed to persist branch-name link on case ${existing.case_id}:`,
        err,
      );
      return null;
    }

    await this.eventService.emit(
      existing.case_id,
      'pr_opened',
      {
        pr_url: payload.pr_url,
        pr_number: payload.pr_number,
        branch: payload.branch,
        commit_sha: payload.commit_sha,
        linked_via: 'branch_name_case_id',
      },
      'system',
    );

    await this.eventService.emit(
      existing.case_id,
      'comment_added',
      {
        comment_type: 'system',
        body: `PR #${payload.pr_number ?? '?'} ${payload.pr_url ?? ''} manually linked via branch-name case_id (${existing.case_id}).`,
        pr_url: payload.pr_url,
        pr_number: payload.pr_number,
        linked_via: 'branch_name_case_id',
      },
      'system',
    );

    return { action: 'case_linked_by_branch_name', case_id: existing.case_id };
  }

  /**
   * Same shape as `tryLinkCaseByBranchName` but parses the case_id out of the
   * PR title + body instead of the branch name. Covers the common Jira-style
   * flow where the branch carries a ticket key (no embedded case_id) but the
   * PR description references the Arbitra case directly
   * ("Arbitra: case-pure-dawn-mQj7"). Without this hook the branch lookup
   * misses and we record an unlinked-PR nudge.
   *
   * `preferLabelledLine: true` makes an explicit `Arbitra-Case:` line win
   * over an earlier free-text case-id mention elsewhere in the title/body
   * (e.g. a problem description that names a *different* case before the
   * PR's own labelled line) — see issue #813.
   */
  private async tryLinkCaseByPrText(
    payload: GitWebhookPayload,
  ): Promise<{ action: string; case_id?: string; reason?: string } | null> {
    const combined = [payload.title ?? '', payload.body ?? ''].join('\n').trim();
    if (!combined) return null;
    const candidateId = extractCaseIdFromText(combined, { preferLabelledLine: true });
    if (!candidateId) return null;

    // Same repo-match guard as the branch-name path. Resolve the payload repo
    // to its arbitra repository_id so renames don't misroute, falling back to
    // the raw slug when resolution fails.
    let payloadRepoId: string = payload.repository;
    try {
      const resolved = await this.resolveArbitraRepo(payload);
      if (resolved) payloadRepoId = resolved.repository_id;
    } catch {
      // Use raw slug as the comparison key.
    }

    const existing = await this.matchCandidateCase(candidateId, payloadRepoId, 'PR-text');
    if (!existing) return null;

    // Re-link guard: the case already owns a *different* PR. Overwriting
    // current_pr_ref/current_branch here would steal the case out from under
    // the PR that's actually driving it (#813: a foreign case
    // id mentioned in prose in PR text got linked and clobbered the owning
    // case's current_pr_ref, which then broke that case's build-complete with
    // a branch-ownership 409). Re-delivery of the SAME PR event is exempt —
    // that's idempotent and must keep working. A case with no current_pr_ref
    // yet is not a re-link and links normally. Refs are compared by parsed
    // owner/repo/number identity (`refersToSamePr`), not raw string equality,
    // so a non-canonical but equivalent stored ref doesn't falsely trip this.
    if (
      existing.current_pr_ref
      && payload.pr_url
      && !refersToSamePr(existing.current_pr_ref, payload.pr_url)
    ) {
      console.warn(
        `[webhook] PR-text match for case ${existing.case_id} refused: `
        + `case already linked to ${existing.current_pr_ref}, payload PR is `
        + `${payload.pr_url}. Refusing to overwrite current_pr_ref/`
        + `current_branch. Falling through to unlinked-PR nudge.`,
      );
      return null;
    }

    const updates: Partial<Case> = { updated_at: new Date().toISOString() };
    if (payload.branch && payload.branch !== existing.current_branch) {
      updates.current_branch = payload.branch;
    }
    if (payload.pr_url && payload.pr_url !== existing.current_pr_ref) {
      updates.current_pr_ref = payload.pr_url;
    }
    recordObservedHeadSha(updates, payload, existing);
    try {
      await this.caseRepo.update(existing.case_id, updates);
    } catch (err) {
      console.error(
        `[webhook] Failed to persist PR-text link on case ${existing.case_id}:`,
        err,
      );
      return null;
    }

    await this.eventService.emit(
      existing.case_id,
      'pr_opened',
      {
        pr_url: payload.pr_url,
        pr_number: payload.pr_number,
        branch: payload.branch,
        commit_sha: payload.commit_sha,
        linked_via: 'pr_text_case_id',
      },
      'system',
    );

    await this.eventService.emit(
      existing.case_id,
      'comment_added',
      {
        comment_type: 'system',
        body: `PR #${payload.pr_number ?? '?'} ${payload.pr_url ?? ''} manually linked via PR-text case_id (${existing.case_id}).`,
        pr_url: payload.pr_url,
        pr_number: payload.pr_number,
        linked_via: 'pr_text_case_id',
      },
      'system',
    );

    return { action: 'case_linked_by_pr_text', case_id: existing.case_id };
  }

  private async findCaseByBranch(branch: string, repositoryId: string): Promise<Case | null> {
    // Limit raised from 1 to 2 so we can detect the ambiguous case (>1 case
    // on the same branch + repo) without scanning the whole collection. The
    // repository_id filter is required: without it, a push to `main` from
    // repo A would match a case on `main` in repo B.
    //
    // NOTE (issue #1046): `activeCases()` filters `deleted_at == null` ONLY —
    // there is no status filter here, so this returns TERMINAL cases too.
    // That is deliberate (callers need to know a terminal case owns the
    // branch), but the log line below used to call the result "non-terminal",
    // which is what made the terminal-case exits look safe when they were
    // publishing `success` onto rejected work. Callers decide what a terminal
    // match means — see `publishTerminalCaseStatus`.
    const snapshot = await collections.activeCases()
      .where('current_branch', '==', branch)
      .where('repository_id', '==', repositoryId)
      .limit(2)
      .get();
    if (snapshot.empty) return null;
    if (snapshot.docs.length > 1) {
      console.warn(
        `[webhook] findCaseByBranch matched >1 case for branch "${branch}" in repo "${repositoryId}"; `
        + `using ${snapshot.docs[0]!.data().case_id}. Multi-match may mean stale `
        + `current_branch on a legacy case.`,
      );
    }
    return snapshot.docs[0]!.data();
  }

  private async findCaseByPR(prUrl: string): Promise<Case | null> {
    return findCaseByPrUrl(prUrl);
  }

  /**
   * Shared candidate-case check used by BOTH the webhook's link-on-open
   * ladder (`tryLinkCaseByBranchName`/`tryLinkCaseByPrText`) and the
   * read-only recovery-resolution ladder (`resolveCaseForPrRecovery`,
   * issue #1032) — a candidate case id (parsed from a branch name or PR
   * text) is only a genuine match if it exists, belongs to the SAME
   * repository the PR is on, and is not already terminal. Single
   * implementation so the two callers can never diverge on what counts as
   * a match. Logs and returns `null` on any mismatch so the caller falls
   * through to the next rung of its ladder rather than claiming a foreign
   * or stale case.
   */
  private async matchCandidateCase(
    candidateId: string,
    repositoryId: string,
    matchedVia: 'Branch-name' | 'PR-text',
  ): Promise<Case | null> {
    let existing: Case | null;
    try {
      existing = await this.caseRepo.getById(candidateId);
    } catch {
      return null;
    }
    if (!existing) return null;

    if (existing.repository_id !== repositoryId) {
      console.warn(
        `[webhook] ${matchedVia} match for case ${existing.case_id} rejected: `
        + `case repo ${existing.repository_id} != resolved repo ${repositoryId}. `
        + `Falling through.`,
      );
      return null;
    }

    if (TERMINAL_CASE_STATUSES.has(existing.status)) {
      return null;
    }

    return existing;
  }

  /**
   * Read-only case-resolution ladder for the admin commit-status recovery
   * endpoint (issue #1032) — resolves a PR to "the case it belongs to" the
   * SAME way `handleGitWebhook` does, WITHOUT any of the mutation that
   * ladder performs as a side effect (no case gets (re-)linked, no event
   * gets emitted, no `current_pr_ref`/`current_branch` gets written). A
   * status re-publish must never silently change which case owns a PR —
   * only the webhook path performs linking; this method only answers
   * "which case, if any, does this PR currently belong to". Genuinely
   * write-free (issue #1032): `resolveArbitraRepo` is called
   * with `{ readOnly: true }`, so even its legacy substring-match fallback
   * — which would otherwise opportunistically stamp `github_full_name`
   * onto a `Repository` row — performs no Firestore write here.
   *
   * Ladder, in the SAME order `handleGitWebhook` tries them:
   *   1. Case id embedded in the branch name (`tryLinkCaseByBranchName`'s
   *      read half — `matchCandidateCase`).
   *   2. Case id referenced in the PR title/body (`tryLinkCaseByPrText`'s
   *      read half).
   *   3. `findCaseByBranch` — the case whose `current_branch` already
   *      equals this PR's branch, in the resolved repository.
   *   4. `findCaseByPrUrl` — exact `current_pr_ref` match, the fallback the
   *      webhook itself uses on `pull_request.closed` (`findCaseByPR`).
   *
   * A case matched at any rung but sitting in a TERMINAL status is treated
   * as "no case" (same as the webhook's terminal-case exits) — republishing
   * against a case that's done or rejected on a REUSED branch would resurrect
   * stale governance. The one exception, and the fix for issue #1046: a
   * terminal case that OWNS this PR (`current_pr_ref` names it) is returned,
   * because "no case → success" there would let an operator re-publish
   * launder a rejection into a green required check. See the
   * `findCaseByPrUrl` check at the top of the body, which runs before the
   * ladder for exactly that reason.
   *
   * That check does not ADD a Firestore read — it is rung 4, hoisted, and
   * its result is reused there. It does make rung 4's read unconditional
   * where it was previously skipped when an earlier rung matched. Kept
   * deliberately: a terminal case can own this PR without being reachable by
   * branch name, PR text, or `current_branch`, and the only way to know is
   * to look. This is the operator-triggered recovery endpoint, running at
   * human frequency, so one read on the hit path is the right trade against
   * an operator silently greening a rejected PR.
   *
   * Returns `repositoryRegistered: false` when `owner/repo` doesn't match
   * any Arbitra `Repository` row (issue #1032, M1) — the caller must refuse
   * to publish in that case rather than fall through to "no case, success",
   * which would let an admin write a status onto a repository Arbitra has
   * never onboarded.
   */
  async resolveCaseForPrRecovery(input: {
    owner: string;
    repo: string;
    branch: string;
    title: string;
    body: string;
    prUrl: string;
  }): Promise<{ repositoryRegistered: boolean; repositoryId?: string; case: Case | null }> {
    const resolvedRepo = await this
      .resolveArbitraRepo({ repository: `${input.owner}/${input.repo}` }, { readOnly: true })
      .catch(() => null);
    if (!resolvedRepo) {
      return { repositoryRegistered: false, case: null };
    }
    const repositoryId = resolvedRepo.repository_id;

    // Issue #1046: a TERMINAL case that OWNS this PR is never "no case".
    // Before this check the ladder mapped every terminal match to
    // `case: null` on every rung, so the admin escape hatch (#1036)
    // laundered a rejection into the same `success` the webhook path did —
    // an operator re-publish was a second, audited route to merging
    // rejected work. Runs BEFORE the ladder because every rung below
    // discards terminal cases, and a terminal owner must win over any of
    // them. Only fires when the case owns THIS PR, so a branch reused after
    // a terminal case pointing at a different PR still falls through to
    // `case: null` and the case-less success.
    const caseOwningPr = await findCaseByPrUrl(input.prUrl);
    if (caseOwningPr && TERMINAL_CASE_STATUSES.has(caseOwningPr.status)) {
      return { repositoryRegistered: true, repositoryId, case: caseOwningPr };
    }

    const branchNameCandidate = extractCaseIdFromBranch(input.branch);
    if (branchNameCandidate) {
      const matched = await this.matchCandidateCase(branchNameCandidate, repositoryId, 'Branch-name');
      if (matched) return { repositoryRegistered: true, repositoryId, case: matched };
    }

    const combinedText = [input.title, input.body].join('\n').trim();
    if (combinedText) {
      const textCandidate = extractCaseIdFromText(combinedText, { preferLabelledLine: true });
      if (textCandidate) {
        const matched = await this.matchCandidateCase(textCandidate, repositoryId, 'PR-text');
        if (matched) return { repositoryRegistered: true, repositoryId, case: matched };
      }
    }

    if (input.branch) {
      const byBranch = await this.findCaseByBranch(input.branch, repositoryId);
      if (byBranch) {
        // Non-terminal: the normal rung-3 match. Terminal: only when it owns
        // THIS PR (issue #1046) — the `findCaseByPrUrl` check above compares
        // `current_pr_ref` by exact string, so this catches an owner whose
        // stored ref is non-canonical (trailing slash, query string).
        if (
          !TERMINAL_CASE_STATUSES.has(byBranch.status)
          || ownsPullRequest(byBranch.current_pr_ref, input.prUrl)
        ) {
          return { repositoryRegistered: true, repositoryId, case: byBranch };
        }
      }
    }

    if (caseOwningPr && !TERMINAL_CASE_STATUSES.has(caseOwningPr.status)) {
      return { repositoryRegistered: true, repositoryId, case: caseOwningPr };
    }

    return { repositoryRegistered: true, repositoryId, case: null };
  }
}

/**
 * Exact-match lookup of the case currently linked to a PR, by
 * `current_pr_ref`. Exported (module-level, not a class method) so the
 * admin commit-status re-publish endpoint (issue #1032) resolves a case the
 * SAME way the webhook path does — `WebhookService.findCaseByPR` above is a
 * thin delegate to this function, not a parallel implementation, so the two
 * callers can never drift on how "the case for this PR" is decided.
 *
 * Exact string match on `current_pr_ref`. `comparePrRefs` (@arbitra/shared)
 * is the tolerant counterpart for comparing two refs already in hand — see
 * `ownsPullRequest` / `refersToSamePr` above for the two readings of it.
 */
export async function findCaseByPrUrl(prUrl: string): Promise<Case | null> {
  const snapshot = await collections.activeCases()
    .where('current_pr_ref', '==', prUrl)
    .limit(1)
    .get();
  return snapshot.empty ? null : snapshot.docs[0]!.data();
}

