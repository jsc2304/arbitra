import { NextRequest, NextResponse } from 'next/server';
import { CaseService, validateBody, detectCaseFields } from '@arbitra/backend';
import { createCaseSchema, caseFiltersSchema } from '@arbitra/shared';
import type { Case, Comment, GitContext } from '@arbitra/shared';
import { authenticate, handleError, requireProjectAccess } from '@/lib/api-helpers';
import { storeCommentAttachments } from '@/lib/comment-attachments';
import { resolveCaseShareUrl } from '@/lib/public-base-url';
import { assertPubliclyCreatableCaseType } from '@/lib/case-type-guard';

export const dynamic = 'force-dynamic';

const caseService = new CaseService();

/**
 * Apply git_context to auto-fill case fields that weren't explicitly provided.
 * Uses the auto-detection service for smart defaults.
 */
function applyGitContext(
  caseData: Case,
  gitContext?: GitContext,
): void {
  if (!gitContext) return;

  // Basic field mapping
  if (!caseData.current_branch && gitContext.branch) {
    caseData.current_branch = gitContext.branch;
  }
  if (!caseData.current_pr_ref && gitContext.pr_ref) {
    caseData.current_pr_ref = gitContext.pr_ref;
  }

  // Auto-detection: fill in fields the client didn't explicitly set
  const detection = detectCaseFields({
    git_context: gitContext,
    changed_files: gitContext.changed_files,
    pr_title: gitContext.pr_title,
    pr_body: gitContext.pr_body,
    pr_labels: gitContext.pr_labels,
    commit_messages: gitContext.commit_messages,
  });

  // Only apply detected values if the client sent defaults (not explicit choices)
  if (!caseData.case_type || caseData.case_type === 'other') {
    caseData.case_type = detection.case_type;
  }
  if ((!caseData.jira_refs || caseData.jira_refs.length === 0) && detection.jira_refs.length > 0) {
    caseData.jira_refs = detection.jira_refs;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const input = validateBody(createCaseSchema, body);
    assertPubliclyCreatableCaseType(input.case_type);
    const denied = await requireProjectAccess(input.project_id, auth.userId);
    if (denied) return denied;
    const created = await caseService.createCase(input, auth.userId);

    // Apply git_context to auto-fill branch/PR/repo fields
    if (body.git_context) {
      applyGitContext(created, body.git_context);
      const { CaseRepository } = await import('@arbitra/backend');
      const caseRepo = new CaseRepository();
      await caseRepo.update(created.case_id, {
        current_branch: created.current_branch,
        current_pr_ref: created.current_pr_ref,
        repository_id: created.repository_id,
        case_type: created.case_type,
        jira_refs: created.jira_refs,
      });
    }

    // Convert unstructured case-creation uploads into an initial comment so
    // files stay attached to the conversation instead of becoming a parallel
    // case-level file bucket.
    if (input.attachments?.length) {
      const { collections, generateId } = await import('@arbitra/backend');
      const commentId = generateId('comment');
      const attachments = await storeCommentAttachments({
        caseId: created.case_id,
        commentId,
        actorId: auth.userId,
        attachments: input.attachments,
      });
      const comment: Comment = {
        comment_id: commentId,
        parent_type: 'case',
        parent_id: created.case_id,
        author_id: auth.userId,
        body: 'Initial context files attached.',
        created_at: new Date().toISOString(),
        source: 'human',
        attachment_refs: attachments.map((artifact) => artifact.artifact_id),
      };
      await collections.comments().doc(comment.comment_id).set(comment);
    }

    const share_url = resolveCaseShareUrl(request, created.case_id, created.status);
    return NextResponse.json(share_url ? { ...created, share_url } : created, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const params = Object.fromEntries(request.nextUrl.searchParams);
    const filters = validateBody(caseFiltersSchema, params);

    const { checkIsAdmin, getAccessibleProjectIds, isEffectiveMember, collections } = await import('@arbitra/backend');
    const admin = await checkIsAdmin(auth.userId);

    // If a specific project filter is set, verify access
    if (filters.project_id && !admin) {
      const projectDoc = await collections.projects().doc(filters.project_id).get();
      if (projectDoc.exists && !isEffectiveMember(projectDoc.data()!, auth.userId)) {
        return NextResponse.json({ cases: [], finding_counts: {} });
      }
    }

    const result = await caseService.listCases(filters);

    // If not admin, filter cases to accessible projects only
    if (!admin) {
      const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleIds !== 'all') {
        const accessibleSet = new Set(accessibleIds);
        result.cases = result.cases.filter((c) => accessibleSet.has(c.project_id));
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
