import { isKnownLlmProvider, isEnabledLlmProvider, isKnownLlmModel, LLM_PROVIDERS } from '@arbitra/shared';
import type { LlmSettings } from '@arbitra/shared';

const VALID_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

const ENABLED_PROVIDER_LIST = LLM_PROVIDERS.filter((p) => p.enabled).map((p) => p.id).join(', ');

export type LlmSettingsValidationResult =
  | { ok: true; value: Pick<LlmSettings, 'provider' | 'models'> }
  | { ok: false; message: string };

/**
 * Validate the PATCH payload for the global AI-model defaults.
 *  - Unknown provider   -> reject with 400.
 *  - Disabled provider  -> reject with 400 naming the enabled providers
 *                          (#1099 — a disabled provider stored here used to
 *                          reach production review runs unchanged).
 *  - Unknown model ID   -> warn and keep (preserves legacy values saved
 *                          before the curated catalog existed).
 *  - Each risk level must have a non-empty string model.
 */
export function validateLlmSettings(
  body: unknown,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): LlmSettingsValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'Request body must be a JSON object' };
  }

  const { provider, models } = body as Record<string, unknown>;

  if (typeof provider !== 'string' || provider === '' || !isKnownLlmProvider(provider)) {
    return { ok: false, message: `Unknown provider: ${String(provider)}` };
  }

  if (!isEnabledLlmProvider(provider)) {
    return {
      ok: false,
      message: `Provider "${provider}" is disabled. Enabled providers: ${ENABLED_PROVIDER_LIST}`,
    };
  }

  if (!models || typeof models !== 'object') {
    return { ok: false, message: 'models must be an object with risk level keys' };
  }

  const modelsObj = models as Record<string, unknown>;
  for (const level of VALID_RISK_LEVELS) {
    const value = modelsObj[level];
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, message: `models.${level} must be a non-empty string` };
    }
    if (!isKnownLlmModel(value.trim())) {
      // Warn but do not reject: preserves legacy values saved before the
      // curated catalog existed.
      warn(`[settings:llm] models.${level} references unknown model "${value.trim()}"`);
    }
  }

  return {
    ok: true,
    value: {
      provider: provider as LlmSettings['provider'],
      models: {
        low: (modelsObj.low as string).trim(),
        medium: (modelsObj.medium as string).trim(),
        high: (modelsObj.high as string).trim(),
        critical: (modelsObj.critical as string).trim(),
      },
    },
  };
}
