import { isKnownLlmProvider, isEnabledLlmProvider, isKnownLlmModel, LLM_PROVIDERS } from '@arbitra/shared';

const ENABLED_PROVIDER_LIST = LLM_PROVIDERS.filter((p) => p.enabled).map((p) => p.id).join(', ');

export type LlmOverridesValidationResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Validate `llm_overrides` on a PATCH payload.
 *  - Unknown provider   -> reject with 400.
 *  - Disabled provider  -> reject with 400 naming the enabled providers
 *                          (#1099 — a disabled provider stored here used to
 *                          reach production review runs unchanged).
 *  - Unknown model ID   -> warn and keep (preserves legacy values).
 *  - `null` is allowed (clears overrides).
 */
export function validateLlmOverrides(
  value: unknown,
  projectId: string,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): LlmOverridesValidationResult {
  if (value === null || value === undefined) return { ok: true };
  if (typeof value !== 'object') {
    return { ok: false, message: 'llm_overrides must be an object or null' };
  }
  const v = value as { provider?: unknown; models?: unknown };
  if (v.provider !== undefined && v.provider !== null && v.provider !== '') {
    if (typeof v.provider !== 'string' || !isKnownLlmProvider(v.provider)) {
      return { ok: false, message: `Unknown llm_overrides.provider: ${String(v.provider)}` };
    }
    if (!isEnabledLlmProvider(v.provider)) {
      return {
        ok: false,
        message: `llm_overrides.provider "${v.provider}" is disabled. Enabled providers: ${ENABLED_PROVIDER_LIST}`,
      };
    }
  }
  if (v.models !== undefined && v.models !== null) {
    if (typeof v.models !== 'object') {
      return { ok: false, message: 'llm_overrides.models must be an object' };
    }
    for (const [risk, modelId] of Object.entries(v.models as Record<string, unknown>)) {
      if (modelId === '' || modelId === undefined || modelId === null) continue;
      if (typeof modelId !== 'string') {
        return { ok: false, message: `llm_overrides.models.${risk} must be a string` };
      }
      if (!isKnownLlmModel(modelId)) {
        // Warn but do not reject: preserves legacy values saved before the
        // curated catalog existed.
        warn(
          `[project:${projectId}] llm_overrides.models.${risk} references unknown model "${modelId}"`,
        );
      }
    }
  }
  return { ok: true };
}
