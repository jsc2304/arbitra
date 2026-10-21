import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import type { PromptTemplate } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> },
) {
  const { templateId } = await params;

  try {
    await authenticate(request);

    const { collections } = await import('@arbitra/backend');
    const promptTemplates = (collections as { promptTemplates(): any }).promptTemplates();
    const doc = await promptTemplates.doc(templateId).get();

    if (!doc.exists) {
      return NextResponse.json(
        { error: { message: 'Prompt template not found' } },
        { status: 404 },
      );
    }

    return NextResponse.json({ template: doc.data() as PromptTemplate });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> },
) {
  const { templateId } = await params;

  try {
    const auth = await authenticate(request);

    const backend = await import('@arbitra/backend');
    const { requireRole, collections } = backend;
    const invalidatePromptCache = (backend as Record<string, unknown>).invalidatePromptCache as
      ((slug?: string) => void) | undefined;

    await requireRole(auth.userId, ['admin']);

    const body = await request.json();
    const update = validatePatchBody(body);

    const promptTemplates = (collections as { promptTemplates(): any }).promptTemplates();
    const docRef = promptTemplates.doc(templateId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json(
        { error: { message: 'Prompt template not found' } },
        { status: 404 },
      );
    }

    const now = new Date().toISOString();
    const template = doc.data() as PromptTemplate;

    // If activating this version, deactivate other active versions for the same slug
    if (update.is_active === true) {
      const siblings = await promptTemplates
        .where('slug', '==', template.slug)
        .where('is_active', '==', true)
        .get();
      for (const sibling of siblings.docs) {
        if (sibling.id !== templateId) {
          await sibling.ref.update({ is_active: false, updated_at: now });
        }
      }
    }

    await docRef.update({ ...update, updated_at: now, updated_by: auth.userId });

    // Invalidate cache when active state changes
    if (update.is_active !== undefined) {
      invalidatePromptCache?.(template.slug);
    }

    const updated = { ...template, ...update, updated_at: now };
    return NextResponse.json({ template: updated });
  } catch (error) {
    return handleError(error);
  }
}

function validatePatchBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    throw new Error('Validation: Request body must be a JSON object');
  }

  const { name, description, is_active } = body as Record<string, unknown>;
  const update: Record<string, unknown> = {};

  // Only allow metadata updates — content is immutable per version
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('Validation: name must be a non-empty string');
    }
    update.name = name.trim();
  }

  if (description !== undefined) {
    if (typeof description !== 'string') {
      throw new Error('Validation: description must be a string');
    }
    update.description = description.trim();
  }

  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') {
      throw new Error('Validation: is_active must be a boolean');
    }
    update.is_active = is_active;
  }

  if (Object.keys(update).length === 0) {
    throw new Error('Validation: At least one field (name, description, is_active) must be provided');
  }

  return update;
}
