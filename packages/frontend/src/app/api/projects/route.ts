import { NextRequest, NextResponse } from 'next/server';
import { createProjectSchema } from '@arbitra/shared';
import { validateBody } from '@arbitra/backend';
import { authenticate, handleError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { collections, checkIsAdmin, isEffectiveMember } = await import('@arbitra/backend');
    const snapshot = await collections.projects().get();
    const allProjects = snapshot.docs.map((doc) => doc.data());
    const admin = await checkIsAdmin(auth.userId);
    const projects = admin
      ? allProjects
      : allProjects.filter((p) => isEffectiveMember(p, auth.userId));
    return NextResponse.json({ projects });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    // `validateBody` directly (not the `validate` wrapper): `createProjectSchema`
    // has a `.default()`-bearing field (`description`), and `validate`'s
    // `ZodSchema<T>`-typed parameter collapses T's defaulted fields back to
    // `| undefined` at this call site (same `api-helpers.ts` generics quirk
    // `rule-sets/route.ts` POST documents) — `validateBody` is the same
    // underlying validator without that narrowing.
    const input = validateBody(createProjectSchema, await request.json());

    const { collections, generateId } = await import('@arbitra/backend');
    const now = new Date().toISOString();
    const project = {
      project_id: generateId('project'),
      name: input.name,
      description: input.description,
      owner_user_id: auth.userId,
      reviewer_pool: input.reviewer_pool ?? [],
      tech_leads: input.tech_leads ?? [auth.userId],
      members: input.members ?? [auth.userId],
      default_evidence_policy_id: input.default_evidence_policy_id ?? '',
      default_rule_set_refs: input.default_rule_set_refs ?? [],
      ...(input.default_validation_track ? { default_validation_track: input.default_validation_track } : {}),
      ...(input.default_language ? { default_language: input.default_language } : {}),
      created_at: now,
      updated_at: now,
    };

    await collections.projects().doc(project.project_id).set(project);
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
