import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RiskLevel, LlmProviderName } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockProjectDocGet = vi.fn();
const mockSettingsDocGet = vi.fn();

vi.mock('./firestore.js', () => ({
  collections: {
    projects: () => ({
      doc: () => ({
        get: mockProjectDocGet,
      }),
    }),
    settingsLlm: () => ({
      get: mockSettingsDocGet,
    }),
  },
}));

// Mock the provider SDK factories to avoid real imports
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (model: string) => ({ modelId: model, provider: 'anthropic' }),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => (model: string) => ({ modelId: model, provider: 'openai' }),
}));
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (model: string) => ({ modelId: model, provider: 'google' }),
}));

import {
  resolveModel,
  resolveModelForRisk,
  getModelForRisk,
  resolveModelForRiskWithProject,
  getModelForRiskWithProject,
  invalidateProjectConfigCache,
  invalidateLlmSettingsCache,
  getHardcodedDefaults,
  getDefaultModel,
} from './llm-provider.js';
import { LLM_MODELS } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firestoreDoc(data: Record<string, unknown> | null) {
  return {
    exists: data !== null,
    data: () => data,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveModelForRiskWithProject / getModelForRiskWithProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear both caches between tests
    invalidateProjectConfigCache();
    invalidateLlmSettingsCache();
    // Default: no global Firestore settings
    mockSettingsDocGet.mockResolvedValue(firestoreDoc(null));
    // Default: no project doc
    mockProjectDocGet.mockResolvedValue(firestoreDoc(null));
    // Clean env vars
    delete process.env.ARBITRA_LLM_MODEL;
    delete process.env.ARBITRA_LLM_MODEL_LOW;
    delete process.env.ARBITRA_LLM_MODEL_MEDIUM;
    delete process.env.ARBITRA_LLM_MODEL_HIGH;
    delete process.env.ARBITRA_LLM_MODEL_CRITICAL;
    delete process.env.ARBITRA_COST_GOVERNANCE;
    delete process.env.ARBITRA_LLM_PROVIDER;
  });

  // 1. No projectId -> falls through to global resolution
  it('should fall through to global resolution when no projectId is provided', async () => {
    const model = await getModelForRiskWithProject('low' as RiskLevel);
    // Should return the hardcoded default for anthropic/low
    expect(model).toBe('claude-haiku-4-5-20251001');
    // Should NOT have queried any project doc
    expect(mockProjectDocGet).not.toHaveBeenCalled();
  });

  it('resolveModelForRiskWithProject returns a model object when no projectId', async () => {
    const result = await resolveModelForRiskWithProject('medium' as RiskLevel);
    expect(result).toHaveProperty('modelId', 'claude-sonnet-5');
  });

  // Critical-tier default is a deliberate product decision (Sonnet, not Opus) —
  // this assertion exists so a silent tier change cannot ship unnoticed again.
  it('should resolve the hardcoded default for anthropic/critical', async () => {
    const model = await getModelForRiskWithProject('critical' as RiskLevel);
    expect(model).toBe('claude-sonnet-5');
    expect(mockProjectDocGet).not.toHaveBeenCalled();
  });

  // 2. ProjectId with no overrides on project -> falls through to global
  it('should fall through to global when project has no llm_overrides', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      // no llm_overrides field
    }));

    const model = await getModelForRiskWithProject('high' as RiskLevel, 'proj_1');
    // Falls through to global hardcoded default
    expect(model).toBe('claude-sonnet-5');
  });

  // 3. ProjectId with provider-only override -> uses project provider
  // (google's catalog entry is enabled:false — see llm-models.ts — so this
  // exercises the disabled-provider path, not a "happy path" override)
  it('should use project provider when only provider is overridden, and the provider is enabled', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        provider: 'openrouter' as LlmProviderName,
        // no per-risk models
      },
    }));

    const model = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    // Should use openrouter's hardcoded low model (openrouter has no
    // catalog entry, so it is never gated by the enabled flag).
    expect(model).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  // #1099: google is enabled:false in the catalog. A stored project
  // provider override naming a disabled provider must not reach the model
  // call — it silently did before this fix (#158/#161).
  it('falls back to the enabled default provider when the project provider override is disabled', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        provider: 'google' as LlmProviderName,
      },
    }));

    const model = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    // NOT gemini-3.5-flash (google's hardcoded low model) — google is
    // disabled, so this must fall back to the enabled default (anthropic).
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('resolveModelForRiskWithProject uses project provider for model instance', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        provider: 'openrouter' as LlmProviderName,
      },
    }));

    const result = await resolveModelForRiskWithProject('high' as RiskLevel, 'proj_1');
    expect(result).toHaveProperty('modelId', 'anthropic/claude-sonnet-5');
  });

  it('resolveModelForRiskWithProject falls back to the enabled default provider when the project provider override is disabled', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        provider: 'google' as LlmProviderName,
      },
    }));

    const result = await resolveModelForRiskWithProject('high' as RiskLevel, 'proj_1');
    // NOT gemini-2.5-pro (google's hardcoded high model) — google is disabled.
    expect(result).toHaveProperty('modelId', 'claude-sonnet-5');
  });

  // 4. ProjectId with model-per-risk override -> uses project model for that risk level
  it('should use project model when per-risk model is overridden', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        models: {
          critical: 'my-custom-critical-model',
        },
      },
    }));

    const model = await getModelForRiskWithProject('critical' as RiskLevel, 'proj_1');
    expect(model).toBe('my-custom-critical-model');
  });

  it('resolveModelForRiskWithProject returns model with overridden modelId', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        provider: 'openrouter' as LlmProviderName,
        models: {
          high: 'gpt-4-turbo',
        },
      },
    }));

    const result = await resolveModelForRiskWithProject('high' as RiskLevel, 'proj_1');
    expect(result).toHaveProperty('modelId', 'gpt-4-turbo');
  });

  // #1099: openai is enabled:false in the catalog. A stored project
  // model+provider override naming a disabled provider must fall back to
  // the enabled default's own model for that risk tier — never the stored
  // model id, which belongs to the disabled provider and is meaningless
  // once the call is redirected.
  it('falls back to the enabled default provider (and its own risk-tier model) when the project override provider is disabled', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        provider: 'google' as LlmProviderName,
        models: {
          high: 'gemini-2.5-pro',
        },
      },
    }));

    const model = await getModelForRiskWithProject('high' as RiskLevel, 'proj_1');
    const result = await resolveModelForRiskWithProject('high' as RiskLevel, 'proj_1');
    // NOT gemini-2.5-pro — google is disabled, so both the recorded model id
    // and the actual call must agree on the enabled fallback's own model.
    expect(model).toBe('claude-sonnet-5');
    expect(result).toHaveProperty('modelId', 'claude-sonnet-5');
  });

  // 5. Partial model overrides -> overridden risk levels use project config, others fall through
  it('should fall through for non-overridden risk levels', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: {
        models: {
          critical: 'custom-critical',
          // low, medium, high not overridden
        },
      },
    }));

    const critical = await getModelForRiskWithProject('critical' as RiskLevel, 'proj_1');
    expect(critical).toBe('custom-critical');

    // Clear cache so we re-fetch (same mock will be returned)
    invalidateProjectConfigCache('proj_1');

    const low = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    // Falls through to global default for anthropic/low
    expect(low).toBe('claude-haiku-4-5-20251001');
  });

  // 6. Firestore error -> graceful fallback to global
  it('should gracefully fall back to global on Firestore error', async () => {
    mockProjectDocGet.mockRejectedValue(new Error('Firestore unavailable'));

    const model = await getModelForRiskWithProject('medium' as RiskLevel, 'proj_1');
    // Falls through to global default
    expect(model).toBe('claude-sonnet-5');
  });

  it('resolveModelForRiskWithProject falls back on Firestore error', async () => {
    mockProjectDocGet.mockRejectedValue(new Error('Connection refused'));

    const result = await resolveModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    expect(result).toHaveProperty('modelId', 'claude-haiku-4-5-20251001');
  });
});

describe('invalidateProjectConfigCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProjectConfigCache();
    invalidateLlmSettingsCache();
    mockSettingsDocGet.mockResolvedValue(firestoreDoc(null));
    delete process.env.ARBITRA_LLM_PROVIDER;
    delete process.env.ARBITRA_LLM_MODEL;
    delete process.env.ARBITRA_COST_GOVERNANCE;
  });

  it('should clear cache for a specific project, forcing re-fetch', async () => {
    // First call: project has overrides
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: { models: { low: 'model-v1' } },
    }));

    const first = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    expect(first).toBe('model-v1');

    // Update mock to return different data
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: { models: { low: 'model-v2' } },
    }));

    // Without invalidation, should still return cached v1
    const cached = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    expect(cached).toBe('model-v1');

    // After invalidation, should re-fetch and return v2
    invalidateProjectConfigCache('proj_1');
    const refreshed = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    expect(refreshed).toBe('model-v2');
  });

  it('should clear all entries when called without projectId', async () => {
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: { models: { low: 'cached-model' } },
    }));

    await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');

    // Change the mock return
    mockProjectDocGet.mockResolvedValue(firestoreDoc({
      project_id: 'proj_1',
      name: 'Test',
      llm_overrides: { models: { low: 'new-model' } },
    }));

    // Clear all
    invalidateProjectConfigCache();
    const result = await getModelForRiskWithProject('low' as RiskLevel, 'proj_1');
    expect(result).toBe('new-model');
  });
});

describe('hardcoded defaults never reference preview models', () => {
  const previewIds = new Set(LLM_MODELS.filter((m) => m.preview).map((m) => m.id));

  it('catalog actually contains preview models (guards below are not vacuous)', () => {
    expect(previewIds.size).toBeGreaterThan(0);
  });

  it('getDefaultModel(google) is a non-preview model', () => {
    const id = getDefaultModel('google' as LlmProviderName);
    expect(previewIds.has(id)).toBe(false);
  });

  it('getHardcodedDefaults(google) risk tiers are non-preview models', () => {
    const defaults = getHardcodedDefaults('google' as LlmProviderName);
    for (const [risk, id] of Object.entries(defaults)) {
      expect(previewIds.has(id), `risk tier ${risk} points at preview model ${id}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// #1099 — provider `enabled` flag enforcement
//
// The catalog (packages/shared/src/constants/llm-models.ts) flags google
// and openai `enabled: false`. Before this fix, resolveModel and its risk
// variants never read that flag, so a stored Firestore override (global
// /settings/llm or a project's llm_overrides) or a hardcoded literal
// (helper-bot-service.ts) reached the actual provider call regardless.
// These tests drive the real resolution — no mirrored/stubbed logic — and
// cover every layer of the priority chain, not just the flag in isolation.
// ---------------------------------------------------------------------------

describe('enabled-flag enforcement (#1099)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProjectConfigCache();
    invalidateLlmSettingsCache();
    mockSettingsDocGet.mockResolvedValue(firestoreDoc(null));
    mockProjectDocGet.mockResolvedValue(firestoreDoc(null));
    delete process.env.ARBITRA_LLM_MODEL;
    delete process.env.ARBITRA_LLM_MODEL_LOW;
    delete process.env.ARBITRA_LLM_MODEL_MEDIUM;
    delete process.env.ARBITRA_LLM_MODEL_HIGH;
    delete process.env.ARBITRA_LLM_MODEL_CRITICAL;
    delete process.env.ARBITRA_COST_GOVERNANCE;
    delete process.env.ARBITRA_LLM_PROVIDER;
  });

  it('resolveModel() falls back to the enabled default when called directly with a disabled provider (defense in depth for direct callers)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveModel('google', 'gemini-3.5-flash');
    expect(result).toHaveProperty('provider', 'anthropic');
    expect(result).toHaveProperty('modelId', 'claude-sonnet-5');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('provider "google" is disabled'));
    warnSpy.mockRestore();
  });

  it('resolveModel() calls straight through for an enabled provider (no warning, no substitution)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveModel('anthropic', 'claude-haiku-4-5-20251001');
    expect(result).toHaveProperty('provider', 'anthropic');
    expect(result).toHaveProperty('modelId', 'claude-haiku-4-5-20251001');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // A stored Firestore LLM config beats the deployed env provider, so a stored
  // google override must not keep routing calls to Gemini once the provider is
  // disabled (#158/#161).
  it('a stored global /settings/llm google override no longer reaches Gemini — falls back to the enabled default for that risk tier', async () => {
    mockSettingsDocGet.mockResolvedValue(firestoreDoc({
      provider: 'google' as LlmProviderName,
      models: { low: 'gemini-3.5-flash', medium: 'gemini-3.5-flash', high: 'gemini-2.5-pro', critical: 'gemini-2.5-pro' },
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const modelId = await getModelForRisk('low' as RiskLevel);
    const result = await resolveModelForRisk('low' as RiskLevel);

    // NOT gemini-3.5-flash — google is disabled. Falls back to anthropic's
    // own low-tier model, and resolveModelForRisk/getModelForRisk agree.
    expect(modelId).toBe('claude-haiku-4-5-20251001');
    expect(result).toHaveProperty('provider', 'anthropic');
    expect(result).toHaveProperty('modelId', 'claude-haiku-4-5-20251001');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('global /settings/llm'));
    warnSpy.mockRestore();
  });

  // Precedence chain, not just the flag in isolation: an ENABLED global
  // Firestore override still beats ARBITRA_LLM_PROVIDER (env), confirming
  // the enabled-check did not disturb the documented priority order.
  it('an enabled global /settings/llm override still beats the env provider', async () => {
    process.env.ARBITRA_LLM_PROVIDER = 'openrouter';
    mockSettingsDocGet.mockResolvedValue(firestoreDoc({
      provider: 'anthropic' as LlmProviderName,
      models: { low: 'claude-haiku-4-5-20251001', medium: 'claude-sonnet-5', high: 'claude-sonnet-5', critical: 'claude-sonnet-5' },
    }));

    const modelId = await getModelForRisk('medium' as RiskLevel);
    const result = await resolveModelForRisk('medium' as RiskLevel);

    expect(modelId).toBe('claude-sonnet-5');
    expect(result).toHaveProperty('provider', 'anthropic');
  });
});
