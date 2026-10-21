import { NextRequest, NextResponse } from 'next/server';
import { PrMergeChecker } from '@arbitra/backend';
import { authenticate, handleError, requireCaseAccess } from '@/lib/api-helpers';

const checker = new PrMergeChecker();

export async function POST(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    const { CaseRepository, EventService, FirestorePipelineAdapter, RunCompletionHandler } =
      await import('@arbitra/backend');
    const caseRepo = new CaseRepository();

    let case_;
    try {
      case_ = await caseRepo.getById(params.caseId);
    } catch {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Case not found' } },
        { status: 404 },
      );
    }

    if (case_.status !== 'pending_merge') {
      return NextResponse.json({ synced: true, merged: false, reason: 'not_pending_merge' });
    }

    if (!case_.current_pr_ref) {
      return NextResponse.json({ synced: true, merged: false, reason: 'no_pr_ref' });
    }

    const result = await checker.checkPrMergeStatus(case_.current_pr_ref);
    if (!result) {
      return NextResponse.json({ synced: false, reason: 'github_api_unavailable' });
    }

    if (!result.merged) {
      return NextResponse.json({ synced: true, merged: false });
    }

    // PR is merged — emit event and trigger auto-transition
    const eventService = new EventService();
    await eventService.emit(
      params.caseId,
      'pr_merged',
      { pr_url: case_.current_pr_ref, source: 'sync', merged_at: result.merged_at },
      'system',
    );

    const pipeline = new RunCompletionHandler(new FirestorePipelineAdapter());
    await pipeline.onRunCompleted(params.caseId);

    return NextResponse.json({ synced: true, merged: true });
  } catch (error) {
    return handleError(error);
  }
}
