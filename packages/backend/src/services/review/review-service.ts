import type { Case, Finding, Run, TokenUsage } from '@arbitra/shared';
import { getAllAdapters, buildConsensusAdapters } from './adapters/adapter-registry.js';
import { consolidateObservations } from './consolidation.js';
import type { ReviewObservation } from './adapters/reviewer-adapter.js';
import { RetriesExhaustedError } from './adapters/llm-adapter.js';
import { collections } from '../../lib/firestore.js';
import { EventService } from '../event/event-service.js';
import { generateId, deriveFindingId } from '../../lib/ids.js';
import { persistFinding } from '../../lib/finding-idempotency.js';
import { RunCompletionHandler } from '../orchestration/pipeline.js';
import type { PipelineAdapter } from '../orchestration/pipeline-adapter.js';
import { getConsensusConfig } from '../../lib/llm-provider.js';
import { detectSubmodulePaths, isPathInSubmodule } from '../diff/submodule-detection.js';
import { detectVendoredPaths, isPathInVendored } from '../diff/vendored-detection.js';
import type { FindingOrigin, KnowledgeAsset } from '@arbitra/shared';
import { KnowledgeRepository } from '../knowledge/knowledge-repository.js';
import { selectReviewKnowledge } from './review-knowledge.js';
import type { ReviewContext } from '../diff/review-context.js';
import { verifyFindings, type Verdict, type VerifierEvidence } from './verification/finding-verifier.js';
import { buildDiffCoverageFinding } from './diff-coverage.js';

/**
 * How much of the change the reviewed diff actually covered. Supplied by
 * `DiffResolver` via `FirestorePipelineAdapter.resolveAndRunReview`; omitted
 * by callers that hand over a diff they did not resolve themselves (the
 * `/api/runs` route, which rejects oversized payloads at the boundary).
 */
export interface DiffCoverageMeta {
  /** True when the diff was cut at the resolver's line cap. */
  truncated?: boolean;
  /** The registered repository's URL, for `owner/repo` when the case holds an internal id. */
  repositoryUrl?: string;
  /** Line count of the ORIGINAL diff, before any truncation. */
  lineCount?: number;
  /**
   * The commit SHA `DiffResolver` actually fetched this diff for (issue
   * #1054). Stamped onto the completed run as `Run.reviewed_head_sha` so
   * `review_run_completed` / `auto_approve_criteria_met` can require it to
   * match `Case.current_head_sha` at gate-evaluation time — binding the
   * review to the commit it reviewed, not merely to "a commit reviewed at
   * some point since the last changes_requested". Omitted by callers that
   * hand over a diff they did not resolve via `DiffResolver` (same set that
   * omits `truncated`/`lineCount` — the `/api/runs` route no longer accepts
   * a body diff at all, so in practice this is always supplied when set).
   */
  reviewedHeadSha?: string;
}

/** Aggregate counts of verification verdicts applied in a review run. */
interface VerificationStats {
  confirmed: number;
  refuted: number;
  uncertain: number;
  unverified: number;
}

/**
 * Classify a finding's origin from its diff `location` (file path) against the
 * sets of submodule roots and newly-added vendored paths the diff introduced:
 *   - inside a newly-added submodule         → `submodule`
 *   - inside a newly-added vendored tree      → `vendored`
 *   - everything else                         → `authored`
 *
 * Submodule takes precedence over vendored (a `vendor/sdk` submodule is a
 * submodule, not a copied tree). Both are conservative, diff-deterministic
 * signals: editing pre-existing authored code — even under a `vendor/` dir —
 * is NEVER tagged non-authored, so an authored high/critical finding always
 * keeps blocking the gate. See #633 (submodules) / #645 (vendored).
 *
 * Exported for unit testing the tagging rule in isolation.
 */
export function classifyFindingOrigin(
  location: string | undefined,
  submodulePaths: ReadonlySet<string>,
  vendoredPaths: ReadonlySet<string> = new Set(),
): FindingOrigin {
  if (isPathInSubmodule(location, submodulePaths)) return 'submodule';
  if (isPathInVendored(location, vendoredPaths)) return 'vendored';
  return 'authored';
}

function formatModel(model: unknown): string {
  const name = typeof model === 'string' ? model
    : (model && typeof model === 'object' && 'model' in model) ? String((model as Record<string, unknown>).model)
    : (model && typeof model === 'object' && 'modelId' in model) ? String((model as Record<string, unknown>).modelId)
    : String(model);
  return name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildReviewSummary(findings: Finding[], model?: string, consensusCount?: number): string {
  const modelPart = model ? `Reviewed by ${formatModel(model)}` : 'AI review complete';
  const consensusSuffix = consensusCount && consensusCount >= 2
    ? ` (consensus: ${consensusCount} models)`
    : '';
  if (findings.length === 0) {
    return `${modelPart} — no issues found${consensusSuffix}`;
  }
  const bySeverity: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }
  const parts = Object.entries(bySeverity)
    .sort(([a], [b]) => {
      const order = ['critical', 'high', 'medium', 'low', 'info'];
      return order.indexOf(a) - order.indexOf(b);
    })
    .map(([sev, count]) => `${count} ${sev}`);
  return `${modelPart} — ${parts.join(', ')} finding${findings.length !== 1 ? 's' : ''}${consensusSuffix}`;
}

export class ReviewService {
  private readonly eventService: EventService;
  private readonly pipeline: RunCompletionHandler | null;
  private readonly knowledgeRepo: KnowledgeRepository;

  constructor(
    eventService = new EventService(),
    pipelineAdapter?: PipelineAdapter,
    knowledgeRepo = new KnowledgeRepository(),
  ) {
    this.eventService = eventService;
    this.pipeline = pipelineAdapter ? new RunCompletionHandler(pipelineAdapter) : null;
    this.knowledgeRepo = knowledgeRepo;
  }

  /**
   * Fetch the case's evidence docs projected to `{type, summary}` for the
   * verifier (CI/test results etc.). Fail-soft: an evidence-store hiccup must
   * never fail a review run — degrade to an empty list.
   */
  private async fetchVerifierEvidence(caseId: string): Promise<VerifierEvidence[]> {
    try {
      const snap = await collections
        .evidence()
        .where('case_id', '==', caseId)
        .get();
      return snap.docs.map((doc) => {
        const data = doc.data() as { type?: unknown; summary?: unknown };
        return {
          type: typeof data.type === 'string' ? data.type : 'unknown',
          summary: typeof data.summary === 'string' ? data.summary : '',
        };
      });
    } catch (err) {
      console.warn(
        `[ReviewService] Failed to load evidence for verification (case ${caseId}):`,
        err,
      );
      return [];
    }
  }

  async runReview(
    case_: Case,
    diff: string,
    actorId: string,
    reviewContext?: ReviewContext | null,
    repoToken?: string,
    /**
     * Retry bookkeeping: which attempt this is (1 = first try). Stamped
     * on the run doc so `RunCompletionHandler.handleRunFailure` can classify
     * a subsequent failure against `MAX_RUN_RETRIES` instead of every retry
     * looking like a fresh "attempt 1". Passed through by
     * `FirestorePipelineAdapter.resolveAndRunReview` / `RunCompletionHandler.retryRun`.
     */
    attempt = 1,
    /**
     * How much of the change `diff` covers (issue #877). `truncated` decides
     * whether this run raises the blocking `diff_exceeds_limit` finding;
     * `lineCount` is the pre-truncation size and defaults to the line count
     * of `diff` itself when the caller resolved no diff of its own.
     */
    diffMeta?: DiffCoverageMeta,
  ): Promise<{ run: Run; findings: Finding[] }> {
    const runId = generateId('run');
    const now = new Date().toISOString();

    // Create the review run. `reviewed_head_sha` (issue #1054) is stamped
    // here rather than only on completion: a run that fails before reaching
    // the completed-update below should still record what commit it was
    // FOR, for the same audit reason `trigger_source` is stamped at creation
    // rather than deferred.
    const run: Run = {
      run_id: runId,
      case_id: case_.case_id,
      run_type: 'review_run',
      trigger_source: actorId,
      status: 'running',
      input_refs: [],
      output_refs: [],
      created_at: now,
      updated_at: now,
      started_at: now,
      attempt,
      ...(diffMeta?.reviewedHeadSha ? { reviewed_head_sha: diffMeta.reviewedHeadSha } : {}),
    };
    await collections.runs().doc(runId).set(run);

    // Hoisted above the try so the catch-path failure update below can still
    // record whatever knowledge was selected before the failure, if any (see
    // assignment near the knowledge-selection block further down).
    let knowledgeIds: string[] = [];

    try {
      // Fetch previous findings for this case (for re-review delta context)
      const previousFindingsSnapshot = await collections
        .findings()
        .where('case_id', '==', case_.case_id)
        .where('origin_type', '==', 'reviewer')
        .get();
      const previousFindings: Finding[] = previousFindingsSnapshot.docs.map(
        (doc) => doc.data(),
      );

      // Fetch human-verified, review-relevant knowledge assets scoped to this
      // case's project/repo so the reviewer applies project-specific guidelines
      // and precedents (e.g. known false-positive classes for vendor APIs)
      // instead of re-raising them every run. Fail-soft: a knowledge outage
      // must never fail a review run — proceed with no assets on any error.
      let knowledgeAssets: KnowledgeAsset[] = [];
      try {
        const candidates = await this.knowledgeRepo.listForReviewScope(
          case_.project_id,
          case_.repository_id,
        );
        knowledgeAssets = selectReviewKnowledge(candidates);
      } catch (err) {
        console.warn(
          `[ReviewService] Failed to load review knowledge for case ${case_.case_id}:`,
          err,
        );
      }

      // Build adapter config with previous findings for delta-review.
      // Cap prompt findings to 20 most recent to avoid consuming too many tokens.
      const MAX_PROMPT_FINDINGS = 20;
      const promptFindings = previousFindings.length > MAX_PROMPT_FINDINGS
        ? [...previousFindings]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, MAX_PROMPT_FINDINGS)
        : previousFindings;
      const adapterConfig = promptFindings.length > 0 || knowledgeAssets.length > 0 || reviewContext
        ? {
            ...(promptFindings.length > 0 ? { previous_findings: promptFindings } : {}),
            ...(knowledgeAssets.length > 0 ? { knowledge_assets: knowledgeAssets } : {}),
            ...(reviewContext ? { review_context: reviewContext } : {}),
          }
        : undefined;

      // Record injected knowledge ids on the run for traceability.
      knowledgeIds = knowledgeAssets.map((a) => a.knowledge_id);
      if (knowledgeIds.length > 0) {
        run.input_refs = knowledgeIds;
      }

      // Resolve adapter list: consensus mode (multiple models) or single-model default
      const consensusSpecs = await getConsensusConfig();
      const adapters = consensusSpecs
        ? buildConsensusAdapters(consensusSpecs)
        : getAllAdapters();
      const reviewerCount = adapters.length;

      // Run all adapters in parallel
      const observationResults = await Promise.allSettled(
        adapters.map((adapter) => adapter.review(case_, diff, adapterConfig)),
      );

      // Collect all observations, token usage, and prompt version, tracking failures
      const allObservations: ReviewObservation[] = [];
      const adapterErrors: Array<{ index: number; error: unknown }> = [];
      let tokenUsage: TokenUsage | undefined;
      let promptVersion: string | undefined;
      for (let i = 0; i < observationResults.length; i++) {
        const result = observationResults[i]!;
        if (result.status === 'fulfilled') {
          const value = result.value;
          if (Array.isArray(value)) {
            allObservations.push(...value);
          } else {
            allObservations.push(...value.observations);
            if (value.token_usage) {
              if (tokenUsage) {
                tokenUsage.prompt_tokens += value.token_usage.prompt_tokens;
                tokenUsage.completion_tokens += value.token_usage.completion_tokens;
                tokenUsage.total_tokens += value.token_usage.total_tokens;
              } else {
                tokenUsage = { ...value.token_usage };
              }
            }
            // Capture prompt_version from the first successful adapter result
            if (!promptVersion && value.prompt_version) {
              promptVersion = value.prompt_version;
            }
          }
        } else {
          adapterErrors.push({ index: i, error: result.reason });
          console.error(
            `[ReviewService] Adapter ${adapters[i]?.name ?? i} failed for case ${case_.case_id}:`,
            result.reason instanceof Error ? result.reason.message : result.reason,
          );
        }
      }

      // If ALL adapters failed, treat the entire review as failed.
      // Re-throw the first error to preserve its type (e.g. RetriesExhaustedError)
      // so the outer catch block can emit the correct events.
      if (adapterErrors.length === adapters.length && adapters.length > 0) {
        const firstError = adapterErrors[0]!.error;
        if (firstError instanceof Error) {
          throw firstError;
        }
        throw new Error(`All review adapters failed: ${String(firstError)}`);
      }

      // Consensus denominator must reflect the adapters that actually returned
      // a result, not the configured count. Otherwise a transient failure on
      // some models is misread as disagreement and wrongly reduces the
      // surviving finding's confidence (agreementRatio = agreement / count).
      const succeededReviewerCount = adapters.length - adapterErrors.length;

      // Store raw observations (include prompt_version for traceability)
      for (const obs of allObservations) {
        await collections.rawReviewObservations().doc(generateId('event')).set({
          case_id: case_.case_id,
          run_id: runId,
          ...obs,
          ...(promptVersion ? { prompt_version: promptVersion } : {}),
          created_at: now,
        });
      }

      // Consolidate (Phase 1: hash-based dedup within this review run).
      // Pass the SUCCEEDED reviewer count so consensus metadata + confidence
      // adjustment reflect reviewers that actually ran (see above).
      const consolidated = consolidateObservations(case_.case_id, allObservations, succeededReviewerCount);

      // Phase 2: Deduplicate against existing findings from previous iterations.
      // Compare signatures directly — each persisted Finding stores its signature
      // at creation time, so no reconstruction is needed.
      // Exclude findings with status 'fixed' or 'resolved' so regressions can be
      // re-detected; those findings remain in the prompt context for the LLM.
      const existingSignatures = new Set<string>();
      for (const pf of previousFindings) {
        if (pf.signature && pf.status !== 'fixed' && pf.status !== 'resolved') {
          existingSignatures.add(pf.signature);
        }
      }
      const deduplicatedConsolidated = consolidated.filter(
        (cf) => !existingSignatures.has(cf.signature),
      );

      // Detect git submodule roots AND newly-added vendored trees introduced by
      // this diff so findings raised against code the author merely pulled in
      // can be tagged `origin: submodule` / `origin: vendored`. The precondition
      // gate then declines to auto-escalate / auto-block on those findings (the
      // author only ran `git submodule add` or copied a third-party tree). Both
      // signals are diff-deterministic and conservative — editing pre-existing
      // authored code is never tagged non-authored. See #633 / #645.
      const submodulePaths = detectSubmodulePaths(diff);
      const vendoredPaths = detectVendoredPaths(diff);

      // Verification step: re-check each consolidated finding against ground
      // truth (repo contents at the PR head + registered case evidence) via one
      // adversarial LLM verdict call BEFORE persisting. Refuted findings get a
      // near-zero confidence and stop gating the case lifecycle (the gate reads
      // `verification_status`). Skipped entirely when disabled or no findings;
      // in that case findings persist exactly as before (no verification
      // fields). Fail-soft: verification errors leave findings `unverified`,
      // which gates identically to unverified/confirmed today.
      const verificationEnabled = process.env.ARBITRA_REVIEW_VERIFICATION !== 'false';
      let verdicts = new Map<string, Verdict>();
      const verificationStats: VerificationStats = {
        confirmed: 0,
        refuted: 0,
        uncertain: 0,
        unverified: 0,
      };
      if (verificationEnabled && deduplicatedConsolidated.length > 0) {
        const evidence = await this.fetchVerifierEvidence(case_.case_id);
        verdicts = await verifyFindings(case_, deduplicatedConsolidated, {
          reviewContext,
          token: repoToken,
          evidence,
          repositoryUrl: diffMeta?.repositoryUrl,
        });
      }

      // Create findings from consolidated results
      const findings: Finding[] = [];
      for (const cf of deduplicatedConsolidated) {
        const origin = classifyFindingOrigin(cf.location, submodulePaths, vendoredPaths);
        const verdict = verdicts.get(cf.signature);

        // Confidence becomes verdict-derived (raw observations keep the
        // original confidence separately):
        //   confirmed → max(original, 0.9); uncertain → min(original, 0.5);
        //   refuted → 0.05; unverified / no-verdict → original untouched.
        let confidence = cf.confidence;
        if (verdict) {
          verificationStats[verdict.status]++;
          switch (verdict.status) {
            case 'confirmed':
              confidence = Math.max(cf.confidence, 0.9);
              break;
            case 'uncertain':
              confidence = Math.min(cf.confidence, 0.5);
              break;
            case 'refuted':
              confidence = 0.05;
              break;
            case 'unverified':
              break; // untouched
          }
        }

        const finding: Finding = {
          finding_id: deriveFindingId(cf.signature),
          case_id: case_.case_id,
          category: cf.category,
          severity: cf.severity,
          confidence,
          status: 'open',
          title: cf.title,
          description: cf.description,
          origin_type: 'reviewer',
          origin,
          source_refs: cf.source_refs,
          evidence_refs: [],
          rule_refs: [],
          severity_contested: cf.severity_contested,
          signature: cf.signature,
          ...(cf.consensus ? { consensus: cf.consensus } : {}),
          ...(verdict
            ? {
                verification_status: verdict.status,
                verification_note: verdict.note,
                verified_at: now,
                verifier_model: verdict.model,
              }
            : {}),
          created_at: now,
          updated_at: now,
        };
        // Create-only transactional write keyed by the deterministic id above
        // — two concurrent review runs deduplicating the same observation
        // signature race here instead of each inserting their own finding
        // (issue #739). See `lib/finding-idempotency.ts`.
        await persistFinding(finding);
        findings.push(finding);
      }
      const verificationRan = verdicts.size > 0;

      // Diff-coverage finding (issue #877). Raised AFTER the verification
      // block on purpose: this is a mechanical fact about what the reviewer
      // was handed, not an LLM claim about the code, so it must never be put
      // in front of the adversarial verifier — a `refuted` verdict there
      // would drop it straight out of every high/critical gate
      // (`authorBlockingFindings` filters refuted findings) and restore
      // exactly the auto-approve path this guard closes.
      //
      // `origin_type: 'reviewer'` and `origin: 'authored'` are both load-bearing:
      //   - the re-review dedup query above reads
      //     `where('origin_type', '==', 'reviewer')`, so any other value would
      //     hide this finding from `existingSignatures` and stack a fresh copy
      //     on every run;
      //   - `authorBlockingFindings` only gates on `authored` origin, so
      //     anything else would make the high finding non-blocking.
      const diffLineCount = diffMeta?.lineCount ?? diff.split('\n').length;
      const coverage = buildDiffCoverageFinding(
        case_.case_id,
        diffMeta?.truncated === true,
        diffLineCount,
      );
      if (coverage && !existingSignatures.has(coverage.signature)) {
        const coverageFinding: Finding = {
          finding_id: deriveFindingId(coverage.signature),
          case_id: case_.case_id,
          category: coverage.category,
          severity: coverage.severity,
          // Deterministic: the resolver measured this, nothing was inferred.
          confidence: 1,
          status: 'open',
          title: coverage.title,
          description: coverage.description,
          origin_type: 'reviewer',
          origin: 'authored',
          source_refs: [],
          evidence_refs: [],
          rule_refs: [],
          signature: coverage.signature,
          created_at: now,
          updated_at: now,
        };
        // Create-only transactional write — see the consolidated-findings
        // loop above (issue #739).
        await persistFinding(coverageFinding);
        findings.push(coverageFinding);
      }

      // Collect unique model names from all observations for summary & events
      const allModelNames = [...new Set(
        allObservations.map((obs) => obs.model).filter(Boolean) as string[],
      )];

      // Mark run as completed
      const finishedAt = new Date().toISOString();
      const runUpdate: Record<string, unknown> = {
        status: 'completed',
        finished_at: finishedAt,
        updated_at: finishedAt,
        // Observability: configured adapter count vs. how many actually
        // returned a result (the denominator used for consensus agreement).
        configured_reviewer_count: reviewerCount,
        succeeded_reviewer_count: succeededReviewerCount,
        // Diff coverage, recorded on the run so an audit can tell after the
        // fact whether this review saw the whole change (issue #877).
        diff_line_count: diffLineCount,
        diff_truncated: diffMeta?.truncated === true,
        summary: buildReviewSummary(
          findings,
          allModelNames.length > 0 ? allModelNames.join(', ') : tokenUsage?.model,
          // User-facing consensus reporting reflects reviewers that actually ran.
          succeededReviewerCount >= 2 ? succeededReviewerCount : undefined,
        ),
      };
      // For multi-model runs, store the model as comma-separated list
      if (tokenUsage) {
        if (allModelNames.length > 1) {
          tokenUsage.model = allModelNames.join(', ');
        }
        runUpdate.token_usage = tokenUsage;
      }
      // Store prompt version for governance traceability
      if (promptVersion) {
        runUpdate.prompt_version = promptVersion;
      }
      // Surface verification stats on the run doc when verification ran.
      if (verificationRan) {
        runUpdate.verification = verificationStats;
      }
      // Persist injected knowledge ids (the initial run doc was written with
      // input_refs: [] before selection ran).
      if (knowledgeIds.length > 0) {
        runUpdate.input_refs = knowledgeIds;
      }
      await collections.runs().doc(runId).update(runUpdate);

      // Bump last_referenced_at on each injected asset so usage recency is
      // visible in the knowledge view. Fail-soft — never block the run result
      // on a knowledge write (per-asset try/catch so one bad id can't skip the
      // rest).
      if (knowledgeIds.length > 0) {
        await Promise.all(
          knowledgeIds.map(async (id) => {
            try {
              await this.knowledgeRepo.patch(id, { last_referenced_at: finishedAt });
            } catch (err) {
              console.warn(
                `[ReviewService] Failed to bump last_referenced_at for knowledge ${id}:`,
                err,
              );
            }
          }),
        );
      }

      run.status = 'completed';
      run.finished_at = finishedAt;
      run.diff_line_count = diffLineCount;
      run.diff_truncated = diffMeta?.truncated === true;
      if (tokenUsage) run.token_usage = tokenUsage;

      // Clear stale `review_not_applicable` flag if a real review run completed
      // successfully after the case was previously marked not-applicable
      // (e.g. the user attached a PR later and re-ran review). Leaving the
      // flag stuck at true is semantically a lie — the precondition bypass
      // would still report `reason: 'review_not_applicable'` even though we
      // now have a valid review_run on the case.
      if (case_.review_not_applicable) {
        try {
          await collections.cases().doc(case_.case_id).update({
            review_not_applicable: false,
            updated_at: finishedAt,
          });
          await this.eventService.emit(
            case_.case_id,
            'review_not_applicable_cleared',
            { run_id: runId, reason: 'review_run_completed' },
            actorId,
          );
        } catch (err) {
          // Fail-soft — never block a successful review on a flag-clear hiccup.
          console.warn(
            `[ReviewService] Failed to clear review_not_applicable flag for case ${case_.case_id}:`,
            err,
          );
        }
      }

      await this.eventService.emit(
        case_.case_id,
        'review_completed',
        {
          run_id: runId,
          adapter_count: adapters.length,
          finding_count: findings.length,
          model: allModelNames.length > 1
            ? allModelNames.join(', ')
            : tokenUsage?.model,
          total_tokens: tokenUsage?.total_tokens,
          duration_ms: run.started_at ? new Date(finishedAt).getTime() - new Date(run.started_at).getTime() : undefined,
          ...(succeededReviewerCount >= 2 ? { consensus_models: succeededReviewerCount } : {}),
          ...(verificationRan ? { verified: verificationStats } : {}),
          diff_line_count: diffLineCount,
          ...(diffMeta?.truncated === true ? { diff_truncated: true } : {}),
        },
        actorId,
      );

      // Trigger autonomous pipeline to evaluate auto-transitions.
      // Non-critical: if the pipeline fails, the user can still manually
      // transition — but log the failure so silent drops are visible in
      // Cloud Logging / CI output instead of disappearing.
      if (this.pipeline) {
        this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
          console.error(
            `[pipeline] onRunCompleted failed after review run (case ${case_.case_id}, run ${runId}):`,
            err,
          );
        });
      }

      return { run, findings };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const runUpdate: Record<string, unknown> = {
        status: 'failed',
        error_message: errorMessage,
        finished_at: finishedAt,
        updated_at: finishedAt,
      };
      // Record whichever knowledge assets were selected before the failure
      // (e.g. the LLM call itself failed after selection ran) so a failed run
      // still shows what was in context, mirroring the success path above.
      if (knowledgeIds.length > 0) {
        runUpdate.input_refs = knowledgeIds;
      }
      await collections.runs().doc(runId).update(runUpdate);

      run.status = 'failed';
      run.error_message = errorMessage;
      if (knowledgeIds.length > 0) {
        run.input_refs = knowledgeIds;
      }

      // Emit run_failed event
      await this.eventService.emit(
        case_.case_id,
        'run_failed',
        { run_id: runId, error: errorMessage },
        actorId,
      );

      // Only emit run_retries_exhausted when retries actually occurred
      // (this is the LLM-adapter's OWN internal retry loop for a single
      // provider call — unrelated to the run-level attempt/backoff below).
      if (error instanceof RetriesExhaustedError) {
        await this.eventService.emit(
          case_.case_id,
          'run_retries_exhausted',
          { run_id: runId, error: errorMessage, attempts: error.attempts },
          actorId,
        );
      }

      // Run-level retry/backoff: a failed review_run is exactly the
      // durability gap that let a case sit stuck in `in_review` for weeks
      // (issue #710) — hand off to the pipeline's transient-failure retry
      // decision (re-schedule with backoff, or notify on exhaustion) and
      // re-evaluate the pipeline so the case reacts either way. Both calls
      // are fire-and-forget/best-effort: a failure here must never mask the
      // original review error being returned to the caller. Not re-entrant
      // against the case-pipeline lock — this runs after `onRunCompleted`'s
      // own (already-released) evaluation that triggered this review, not
      // from within it (see pipeline.ts's `attemptReview` fire-and-forget
      // comment).
      if (this.pipeline) {
        this.pipeline.handleRunFailure(run).catch((err) => {
          console.error(
            `[pipeline] handleRunFailure failed after review run failure (case ${case_.case_id}, run ${runId}):`,
            err,
          );
        });
        this.pipeline.onRunCompleted(case_.case_id).catch((err) => {
          console.error(
            `[pipeline] onRunCompleted failed after review run failure (case ${case_.case_id}, run ${runId}):`,
            err,
          );
        });
      }

      return { run, findings: [] };
    }
  }
}
