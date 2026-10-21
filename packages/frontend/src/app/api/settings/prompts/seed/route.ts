import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';

/**
 * POST /api/settings/prompts/seed
 * Seeds the built-in default prompts into Firestore as editable v1 templates.
 * Skips slugs that already have a template (won't overwrite customizations).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const backend = await import('@arbitra/backend');
    const { requireRole, collections } = backend;
    const generateId = backend.generateId as (type: string) => string;
    const { DEFAULT_PROMPTS } = backend;

    await requireRole(auth.userId, ['admin']);

    const promptTemplates = (collections as { promptTemplates(): any }).promptTemplates();
    const now = new Date().toISOString();

    const seeded: string[] = [];
    const skipped: string[] = [];

    for (const prompt of Object.values(DEFAULT_PROMPTS)) {
      // Check if this slug already has a template
      const existing = await promptTemplates
        .where('slug', '==', prompt.slug)
        .limit(1)
        .get();

      if (!existing.empty) {
        skipped.push(prompt.slug);
        continue;
      }

      const templateId = generateId('promptTemplate');
      await promptTemplates.doc(templateId).set({
        template_id: templateId,
        slug: prompt.slug,
        name: prompt.name,
        content: prompt.content,
        version: 1,
        is_active: true,
        created_at: now,
        updated_at: now,
        created_by: auth.userId,
      });
      seeded.push(prompt.slug);
    }

    return NextResponse.json({ seeded, skipped });
  } catch (error) {
    return handleError(error);
  }
}
