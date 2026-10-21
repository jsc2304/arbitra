import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { createCaseTemplateSchema } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

// `?project_id=` alone was never an access check — any
// authenticated user could pass any project_id (or omit it) and read every
// project's templates. Filter through `getAccessibleProjectIds` (mirrors
// `/api/cases` GET); every `CaseTemplate` requires a `project_id`, so there
// are no global-scope rows to keep visible.
export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('project_id');

  try {
    const auth = await authenticate(request);
    const { checkIsAdmin, getAccessibleProjectIds, collections } = await import('@arbitra/backend');
    let query: FirebaseFirestore.Query = collections.caseTemplates();
    if (projectId) {
      query = query.where('project_id', '==', projectId);
    }
    const snapshot = await query.orderBy('name').get();
    let templates = snapshot.docs.map((doc) => doc.data());

    const isAdmin = await checkIsAdmin(auth.userId);
    if (!isAdmin) {
      const accessibleIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleIds !== 'all') {
        const accessibleSet = new Set(accessibleIds);
        templates = templates.filter((t) => accessibleSet.has(t.project_id));
      }
    }

    return NextResponse.json({ templates });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const { validateBody, collections, CaseTemplateService } = await import('@arbitra/backend');
    const input = validateBody(createCaseTemplateSchema, body);

    // Verify user has access to the target project (owner, reviewer, tech lead, or admin)
    const projectDoc = await collections.projects().doc(input.project_id).get();
    if (!projectDoc.exists) {
      return NextResponse.json({ error: { message: 'Project not found' } }, { status: 404 });
    }
    const project = projectDoc.data()!;
    const projectMembers = new Set([
      project.owner_user_id,
      ...(project.reviewer_pool ?? []),
      ...(project.tech_leads ?? []),
    ]);
    if (!projectMembers.has(auth.userId)) {
      const userDoc = await collections.users().doc(auth.userId).get();
      const roles: string[] = userDoc.exists ? (userDoc.data()!.roles ?? []) : [];
      if (!roles.includes('admin')) {
        return NextResponse.json({ error: { message: 'Not a member of this project' } }, { status: 403 });
      }
    }

    const service = new CaseTemplateService();
    const template = await service.create(input, auth.userId);
    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
