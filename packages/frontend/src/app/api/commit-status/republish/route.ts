import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticate, handleError, invalidJsonResponse, validationErrorResponse } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/commit-status/republish` — admin-only recovery path for a
 * required `arbitra/case` GitHub status check (issue #1032). Once that
 * context is required in a repo's branch protection rule, a PR whose head
 * SHA never received the status is unmergeable and today's only fix is an
 * admin editing branch protection at the exact moment someone is trying to
 * merge. This route is the self-service replacement: it forces a fresh
 * publish attempt for a given PR without touching branch protection at all.
 *
 * Either `pr_url` (a full GitHub PR URL) or `owner` + `repo` + `pr_number`
 * — accepting both shapes means an operator can paste a link straight from
 * GitHub without reformatting it.
 *
 * Neither case resolution nor verdict computation is reimplemented here —
 * `republishCommitStatus`
 * (`packages/backend/src/services/webhook/commit-status-admin-service.ts`)
 * resolves the case through `WebhookService.resolveCaseForPrRecovery`, the
 * SAME ladder `handleGitWebhook` runs (not just an exact `current_pr_ref`
 * match), then publishes through the exact same
 * `publishCaseCommitStatus`/`publishNoCaseCommitStatus` seam the webhook
 * calls — see docs/onboarding-guide.md § "Enforcing at Merge" for why exact
 * parity here matters (a lost `pull_request.opened` delivery is both this
 * endpoint's reason to exist and the scenario where `current_pr_ref` is
 * empty).
 *
 * Auth mirrors `POST /api/intelligence/run-admin`: bearer-authenticated,
 * then gated on the `admin` role via `requireRole`. Audited unconditionally
 * — `republishCommitStatus` records who triggered the re-publish and for
 * which PR whether or not the publish itself succeeds.
 */
const republishRequestSchema = z.union([
  z.object({ pr_url: z.string().trim().min(1) }),
  z.object({
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    pr_number: z.number().int().positive(),
  }),
]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { requireRole, republishCommitStatus } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return invalidJsonResponse();
    }

    const parsed = republishRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return validationErrorResponse(
        'Invalid request payload — expected { pr_url } or { owner, repo, pr_number }',
        parsed.error.issues,
      );
    }

    const input = 'pr_url' in parsed.data
      ? { prUrl: parsed.data.pr_url }
      : { owner: parsed.data.owner, repo: parsed.data.repo, prNumber: parsed.data.pr_number };

    const result = await republishCommitStatus(input, auth.userId);

    if (!result.ok) {
      return NextResponse.json(
        { error: { code: 'REPUBLISH_FAILED', message: result.reason, pr_url: result.prUrl } },
        { status: 422 },
      );
    }

    return NextResponse.json({
      pr_url: result.prUrl,
      case_id: result.caseId,
      state: result.state,
      audit_event_id: result.auditEventId,
    });
  } catch (error) {
    return handleError(error);
  }
}
