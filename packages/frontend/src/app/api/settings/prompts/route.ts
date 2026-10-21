import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import type { PromptTemplate } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await authenticate(request);

    const { collections } = await import('@arbitra/backend');
    const promptTemplates = (collections as { promptTemplates(): any }).promptTemplates();
    const snapshot = await promptTemplates
      .orderBy('slug')
      .orderBy('version', 'desc')
      .get();

    const templates = snapshot.docs.map((d: { data: () => PromptTemplate }) => d.data());
    return NextResponse.json({ templates });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    // Dynamic import — backend exports PromptService, invalidatePromptCache, generateId
    const backend = await import('@arbitra/backend');
    const { requireRole, collections } = backend;
    const generateId = backend.generateId as (type: string) => string;
    const invalidatePromptCache = (backend as Record<string, unknown>).invalidatePromptCache as
      ((slug?: string) => void) | undefined;

    await requireRole(auth.userId, ['admin']);

    const body = await request.json();
    const validated = validatePromptBody(body);

    // Find current active version for this slug
    const promptTemplates = (collections as { promptTemplates(): any }).promptTemplates();
    const activeSnapshot = await promptTemplates
      .where('slug', '==', validated.slug)
      .where('is_active', '==', true)
      .limit(1)
      .get();

    let nextVersion = 1;
    if (!activeSnapshot.empty) {
      const current = activeSnapshot.docs[0]!;
      nextVersion = current.data().version + 1;
      // Deactivate previous active version
      await current.ref.update({
        is_active: false,
        updated_at: new Date().toISOString(),
      });
    }

    const now = new Date().toISOString();
    const templateId = generateId('promptTemplate');
    const template = {
      template_id: templateId,
      slug: validated.slug,
      name: validated.name ?? `${validated.slug} v${nextVersion}`,
      description: validated.description,
      content: validated.content,
      version: nextVersion,
      is_active: true,
      created_at: now,
      updated_at: now,
      created_by: auth.userId,
    };

    await promptTemplates.doc(templateId).set(template);

    // Invalidate PromptService cache so the new version is picked up immediately
    invalidatePromptCache?.(validated.slug);

    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

interface ValidatedPromptBody {
  slug: string;
  name?: string;
  description?: string;
  content: string;
}

function validatePromptBody(body: unknown): ValidatedPromptBody {
  if (!body || typeof body !== 'object') {
    throw new Error('Validation: Request body must be a JSON object');
  }

  const { slug, name, description, content } = body as Record<string, unknown>;

  if (!slug || typeof slug !== 'string' || slug.trim() === '') {
    throw new Error('Validation: slug must be a non-empty string');
  }

  if (!content || typeof content !== 'string' || content.trim() === '') {
    throw new Error('Validation: content must be a non-empty string');
  }

  if (name !== undefined && typeof name !== 'string') {
    throw new Error('Validation: name must be a string');
  }

  if (description !== undefined && typeof description !== 'string') {
    throw new Error('Validation: description must be a string');
  }

  return {
    slug: slug.trim(),
    name: typeof name === 'string' ? name.trim() : undefined,
    description: typeof description === 'string' ? description.trim() : undefined,
    content: content.trim(),
  };
}
