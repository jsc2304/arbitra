import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';
import { isAssistantRunType, isValidRunType, VALID_RUN_TYPES } from '@arbitra/shared';
import type { RunType } from '@arbitra/shared';

// Next.js runs from packages/frontend/ but .env is in monorepo root
loadEnv({ path: resolve(process.cwd(), '../../.env') });

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { case_id, run_type, diff } = body as { case_id: string; run_type?: string; diff?: unknown };

    if (!case_id) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'case_id is required' } },
        { status: 400 },
      );
    }

    if (run_type && !isValidRunType(run_type)) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid run_type '${run_type}'. Valid types: ${VALID_RUN_TYPES.join(', ')}`,
          },
        },
        { status: 400 },
      );
    }

    // After validation, run_type is guaranteed to be a valid RunType (or undefined)
    const validatedRunType = run_type as RunType | undefined;

    // Assistant runs are not creatable here, even though they are valid run
    // types. This route creates a run and completes it in the same breath,
    // which is a lie for an assistant run — one exists to be claimed and
    // executed (`AssistantIntakeService` creates it unclaimed; the sweep's
    // reattempt path is the only other writer). It also has consequences
    // beyond the run itself: `assistant_result_evidence_present` and
    // `assistant_terminal_failure_documented` both judge the case by its
    // LATEST assistant run, so an instantly-completed run minted here becomes
    // that latest attempt and carries no `task_result` — which would keep an
    // assistant case that had already produced a result out of `done`.
    if (validatedRunType && isAssistantRunType(validatedRunType)) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `run_type '${validatedRunType}' is created by the assistant intake, not through this route`,
          },
        },
        { status: 400 },
      );
    }

    const auth = await authenticate(request);
    const denied = await requireCaseAccess(case_id, auth.userId);
    if (denied) return denied;

    // Generic run creation (non-review): create completed run + trigger pipeline
    if (validatedRunType && validatedRunType !== 'review_run') {
      // Production: create run in Firestore + trigger pipeline
      const { FirestorePipelineAdapter, RunCompletionHandler } = await import('@arbitra/backend');
      const adapter = new FirestorePipelineAdapter();
      const run = await adapter.createRun(case_id, validatedRunType, auth.userId);
      await adapter.completeRun(run.run_id, case_id, `${validatedRunType} completed`);
      const pipeline = new RunCompletionHandler(adapter);
      const result = await pipeline.onRunCompleted(case_id);
      return NextResponse.json({ run: { ...run, status: 'completed' }, pipeline: result }, { status: 201 });
    }

    // Review run: resolve the diff SERVER-SIDE from the case's own PR/branch —
    // never from the request body. Issue #1047 (door 2): this route used to
    // accept a fully caller-supplied `diff` with only size caps, and never
    // checked that it corresponded to the case's actual change. Any project
    // member could submit a one-line benign diff, get a genuinely clean
    // review, and satisfy `review_run_completed` for a change the review
    // never saw. `resolveAndRunReview` is the same mechanism the autonomous
    // pipeline uses to auto-trigger review on `in_review` entry
    // (`pipeline.ts` `scheduleRunsForStatus` -> `firestore-pipeline-adapter.ts:773`):
    // it fetches the diff from GitHub for the case's `current_pr_ref` /
    // `current_branch`, so what gets reviewed is always the case's real
    // change, not caller input.
    //
    // A body `diff` is therefore rejected outright rather than silently
    // ignored (review follow-up on #1047): this route is unversioned and
    // additive-only, and silently dropping a field a
    // caller believes still does something would let them walk away
    // thinking their diff was reviewed when it never was — an honest 400 is
    // required instead. Nothing in production sends this field (verified: no
    // caller in the frontend UI, `arbitra-mcp`, or any backend service), so
    // this refusal breaks no legitimate caller.
    if (diff !== undefined) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'diff is no longer accepted for review runs — the diff is resolved server-side from the '
              + "case's current_pr_ref / current_branch so a caller-supplied diff can never satisfy the "
              + 'review gate for a change it does not represent. Omit the diff field.',
          },
        },
        { status: 400 },
      );
    }

    const { FirestorePipelineAdapter, collections } = await import('@arbitra/backend');
    const pipelineAdapter = new FirestorePipelineAdapter();
    // Pass the caller as trigger_source (default is 'system:pipeline') so a
    // manually-requested review's audit trail still names who asked for it.
    const { run, failureReason } = await pipelineAdapter.resolveAndRunReview(case_id, 1, auth.userId);

    if (!run) {
      // Issue #1054: distinguish "this case has nothing to review from" (fix
      // it by setting current_pr_ref / current_branch) from "a PR/branch is
      // set but GitHub would not give us the diff" (fix it by checking the
      // repo token, rate limits, or whether the PR/branch still exists) —
      // both used to collapse into the same message and sent operators
      // chasing the wrong problem.
      const message = failureReason === 'diff_fetch_failed'
        ? 'Cannot run review — the diff could not be fetched from GitHub for this case\'s PR/branch reference '
          + '(auth failure, rate limit, or the PR/branch no longer exists). Check the repository token and that '
          + 'the reference is still valid.'
        : 'Cannot run review — case has no PR or branch reference to resolve a diff from. '
          + 'Set current_pr_ref or current_branch on the case first.';
      return NextResponse.json(
        { error: { code: 'NO_DIFF_SOURCE', message } },
        { status: 400 },
      );
    }

    // Findings carry `case_id`, never a `run_id` (see packages/shared/src/types/finding.ts
    // and lib/finding-idempotency.ts — a finding's identity is a signature
    // deduplicated across re-reviews of the same case, not tied to one run).
    // Scope by case_id, mirroring every other findings query in this codebase
    // (e.g. GET /api/cases/[caseId]/findings) — a `run_id` filter here would
    // never match any document and this endpoint would always report zero
    // findings regardless of what the review actually found.
    const findingsSnap = await collections.findings().where('case_id', '==', run.case_id).get();
    const findings = findingsSnap.docs.map((doc) => doc.data());

    return NextResponse.json({ run, findings }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
