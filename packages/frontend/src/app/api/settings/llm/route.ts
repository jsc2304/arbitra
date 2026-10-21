import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import type { LlmSettings } from '@arbitra/shared';
import { validateLlmSettings } from './llm-settings-validator';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await authenticate(request);
    const { getEffectiveLlmSettings, getHardcodedDefaults } = await import('@arbitra/backend');
    const effective = await getEffectiveLlmSettings();
    const defaults = getHardcodedDefaults(effective.provider);
    return NextResponse.json({
      settings: {
        provider: effective.provider,
        models: effective.models,
      },
      source: effective.source,
      defaults,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    // Admin-only check
    const { requireRole, collections, invalidateLlmSettingsCache } = await import('@arbitra/backend');
    await requireRole(auth.userId, ['admin']);

    const body = await request.json();
    const check = validateLlmSettings(body);
    if (!check.ok) {
      return NextResponse.json({ error: { message: `Validation: ${check.message}` } }, { status: 400 });
    }

    const settings: LlmSettings = {
      ...check.value,
      updated_at: new Date().toISOString(),
      updated_by: auth.userId,
    };

    await collections.settingsLlm().set(settings);
    invalidateLlmSettingsCache();

    return NextResponse.json({ settings });
  } catch (error) {
    return handleError(error);
  }
}
