/**
 * Shared LLM provider resolution.
 *
 * Used by the review adapter, the rule-engine LLM evaluation runner,
 * and (later) the orchestration agent. Centralises provider selection,
 * API-key handling and default model IDs so every consumer behaves
 * consistently.
 *
 * Cost/Latency Governance: Risk-based model selection automatically
 * picks cheaper/faster models for low-risk cases and more capable
 * models for high/critical risk cases, reducing LLM costs by 60-80%.
 *
 * Priority chain for model resolution (highest wins):
 * 1. Firestore /settings/llm (admin UI, cached 5 min)
 * 2. Per-risk env var (ARBITRA_LLM_MODEL_LOW, etc.)
 * 3. Global env var (ARBITRA_LLM_MODEL)
 * 4. RISK_BASED_MODELS / DEFAULT_MODELS hardcoded below
 */

import type { LanguageModel } from 'ai';
import type { RiskLevel, LlmSettings, LlmProviderName, ConsensusModelSpec } from '@arbitra/shared';
import { LLM_PROVIDERS } from '@arbitra/shared';

const DEFAULT_MODELS: Record<LlmProviderName, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.5',
  google: 'gemini-3.5-flash',
  openrouter: 'anthropic/claude-sonnet-5',
};

/** Single source of truth for resolving the active provider name. */
function getProvider(providerName?: LlmProviderName | string): LlmProviderName {
  return (providerName ?? process.env.ARBITRA_LLM_PROVIDER ?? 'anthropic') as LlmProviderName;
}

// ---------------------------------------------------------------------------
// Catalog `enabled` enforcement (#1099)
//
// LLM_PROVIDERS.enabled used to be UI-only: a stored Firestore config
// (global /settings/llm or a project's llm_overrides) or a hardcoded literal
// (helper-bot-service.ts) reached the actual API call regardless of the
// flag, so an admin disabling a broken/unverified provider in Settings had
// no effect on review runs (#158/#161).
// Every place below that turns a stored or literal provider name into an
// actual call now runs it through `enforceProviderEnabled` first.
// ---------------------------------------------------------------------------

/**
 * True if `provider` may actually be called. A provider with no catalog
 * entry (e.g. `openrouter`, which has no admin-facing enabled/disabled
 * toggle — see llm-models.ts) is treated as enabled: the catalog only gates
 * providers an admin can pick in the Settings UI.
 */
function isProviderEnabled(provider: LlmProviderName): boolean {
  const entry = LLM_PROVIDERS.find((p) => p.id === provider);
  return entry ? entry.enabled : true;
}

/** First enabled catalog provider, in catalog order; 'anthropic' as an ultimate fail-safe (it is the one entry the catalog always keeps enabled). */
function getEnabledFallbackProvider(): LlmProviderName {
  const entry = LLM_PROVIDERS.find((p) => p.enabled);
  return (entry?.id as LlmProviderName | undefined) ?? 'anthropic';
}

/**
 * If `provider` is disabled in the catalog, log a structured warning naming
 * where the stored/literal value came from and return the enabled fallback
 * provider instead. Returns `provider` unchanged when it is already enabled
 * (or not catalog-tracked). This never throws — a stale setting must stall
 * nothing; it degrades to the fallback provider loudly instead of calling
 * the disabled one silently.
 */
function enforceProviderEnabled(provider: LlmProviderName, source: string): LlmProviderName {
  if (isProviderEnabled(provider)) return provider;
  const fallback = getEnabledFallbackProvider();
  console.warn(
    `[LlmProvider] provider "${provider}" is disabled in the catalog (source: ${source}) — using enabled fallback "${fallback}" instead of silently calling a disabled provider`,
  );
  return fallback;
}

/**
 * Risk-based model tiers per provider.
 * Lower risk -> cheaper/faster model. Higher risk -> more capable model.
 *
 * Override per risk level via env vars:
 *   ARBITRA_LLM_MODEL_LOW, ARBITRA_LLM_MODEL_MEDIUM,
 *   ARBITRA_LLM_MODEL_HIGH, ARBITRA_LLM_MODEL_CRITICAL
 *
 * Or override all risk levels at once: ARBITRA_LLM_MODEL
 */
const RISK_BASED_MODELS: Record<LlmProviderName, Record<RiskLevel, string>> = {
  anthropic: {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-sonnet-5',
    high: 'claude-sonnet-5',
    critical: 'claude-sonnet-5',
  },
  openai: {
    low: 'gpt-5-mini',
    medium: 'gpt-5.5',
    high: 'gpt-5.5',
    critical: 'gpt-5.5',
  },
  google: {
    low: 'gemini-3.5-flash',
    medium: 'gemini-3.5-flash',
    // gemini-3.5-pro not GA yet (as of 2026-06) — keep 2.5-pro for high/critical
    high: 'gemini-2.5-pro',
    critical: 'gemini-2.5-pro',
  },
  openrouter: {
    low: 'anthropic/claude-haiku-4-5-20251001',
    medium: 'anthropic/claude-sonnet-5',
    high: 'anthropic/claude-sonnet-5',
    critical: 'anthropic/claude-sonnet-5',
  },
};

const RISK_ENV_KEYS: Record<RiskLevel, string> = {
  low: 'ARBITRA_LLM_MODEL_LOW',
  medium: 'ARBITRA_LLM_MODEL_MEDIUM',
  high: 'ARBITRA_LLM_MODEL_HIGH',
  critical: 'ARBITRA_LLM_MODEL_CRITICAL',
};

// ---------------------------------------------------------------------------
// Firestore settings cache (5 min TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSettings: LlmSettings | null = null;
let cacheTimestamp = 0;

/** Fetch LLM settings from Firestore with in-memory caching. */
async function getFirestoreSettings(): Promise<LlmSettings | null> {
  const now = Date.now();
  if (cacheTimestamp > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSettings;
  }

  try {
    const { collections } = await import('./firestore.js');
    const doc = await collections.settingsLlm().get();
    if (doc.exists) {
      cachedSettings = doc.data() as LlmSettings;
      cacheTimestamp = now;
      return cachedSettings;
    }
  } catch {
    // Firestore unavailable (e.g. demo mode) — fall through silently
  }

  cachedSettings = null;
  cacheTimestamp = now; // Cache the miss too, to avoid hammering Firestore
  return null;
}

/** Invalidate the cached settings (called after admin updates). */
export function invalidateLlmSettingsCache(): void {
  cachedSettings = null;
  cacheTimestamp = 0;
}

/**
 * Return the current effective LLM settings, merging Firestore, env vars,
 * and hardcoded defaults. Useful for the GET /api/settings/llm endpoint.
 */
export async function getEffectiveLlmSettings(): Promise<{
  provider: LlmProviderName;
  models: Record<RiskLevel, string>;
  source: 'firestore' | 'env' | 'default';
}> {
  const fsSettings = await getFirestoreSettings();
  if (fsSettings) {
    return {
      provider: fsSettings.provider,
      models: fsSettings.models,
      source: 'firestore',
    };
  }

  const provider = getProvider();
  const envModels = getEnvModels(provider);
  if (envModels) {
    return { provider, models: envModels, source: 'env' };
  }

  return {
    provider,
    models: RISK_BASED_MODELS[provider],
    source: 'default',
  };
}

/** Check if per-risk env vars are set (any present triggers env source). */
function getEnvModels(provider: LlmProviderName): Record<RiskLevel, string> | null {
  const low = process.env['ARBITRA_LLM_MODEL_LOW'];
  const medium = process.env['ARBITRA_LLM_MODEL_MEDIUM'];
  const high = process.env['ARBITRA_LLM_MODEL_HIGH'];
  const critical = process.env['ARBITRA_LLM_MODEL_CRITICAL'];

  if (low || medium || high || critical) {
    const defaults = RISK_BASED_MODELS[provider];
    return {
      low: low ?? defaults.low,
      medium: medium ?? defaults.medium,
      high: high ?? defaults.high,
      critical: critical ?? defaults.critical,
    };
  }
  return null;
}

/** Exposed for the settings API to show defaults. */
export function getHardcodedDefaults(provider: LlmProviderName): Record<RiskLevel, string> {
  return { ...RISK_BASED_MODELS[provider] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a provider + model into a ready-to-use LanguageModel instance.
 *
 * Provider packages are imported dynamically so only the configured
 * provider needs to be installed.
 */
export async function resolveModel(
  providerName?: LlmProviderName | string,
  modelId?: string,
): Promise<LanguageModel> {
  const requestedProvider = getProvider(providerName);
  const provider = enforceProviderEnabled(requestedProvider, 'resolveModel caller');
  // A fallback means `modelId` (chosen for the disabled provider) no longer
  // makes sense — e.g. "gemini-3.5-flash" is not a valid Anthropic model id.
  // Risk-aware callers (resolveModelForRisk et al.) already pick a
  // risk-tier-correct fallback model before reaching here, so this branch
  // only fires for direct callers that bypassed those helpers.
  const model = provider !== requestedProvider
    ? DEFAULT_MODELS[provider]
    : (modelId ?? process.env.ARBITRA_LLM_MODEL ?? DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.anthropic);

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic()(model);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI()(model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI()(model);
    }
    case 'openrouter': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      })(model);
    }
    default:
      throw new Error(
        `Unknown LLM provider "${provider}". Supported: anthropic, openai, google, openrouter`,
      );
  }
}

/** Return the default model ID for a given provider. */
export function getDefaultModel(provider: LlmProviderName): string {
  return DEFAULT_MODELS[provider];
}

/**
 * Resolve the model id used by the adversarial finding verifier.
 *
 * Priority:
 *   1. `ARBITRA_VERIFIER_MODEL` env override (any provider's model id).
 *   2. The active provider's HIGH-risk model (`RISK_BASED_MODELS[provider].high`).
 *
 * Deliberately NOT the full risk/Firestore priority chain — the verifier always
 * wants a capable model regardless of the case's risk level, since its whole
 * job is to catch miscalibrated findings. Pure + synchronous so fail-soft
 * verdicts can still record the model id without an async call.
 */
export function resolveVerifierModelId(providerName?: LlmProviderName | string): string {
  const provider = getProvider(providerName);
  return (
    process.env.ARBITRA_VERIFIER_MODEL ??
    RISK_BASED_MODELS[provider]?.high ??
    DEFAULT_MODELS[provider]
  );
}

/** A concrete (provider, modelId) decision, before it is turned into a `LanguageModel`. */
interface ModelChoice {
  provider: LlmProviderName;
  modelId: string;
}

/**
 * Decide the (provider, modelId) pair for a risk level. Single decision
 * function behind both `resolveModelForRisk` (returns a `LanguageModel`) and
 * `getModelForRisk` (returns just the id, e.g. for recording on a run) so
 * the two can never disagree about which model was actually used (#1099 —
 * a disabled-provider fallback must be reflected identically in both, or
 * the audit trail records a model that was never actually called).
 *
 * Priority chain:
 * 1. Firestore /settings/llm (admin-configured, cached 5 min)
 * 2. Per-risk env var ARBITRA_LLM_MODEL_<RISK>
 * 3. Global env var ARBITRA_LLM_MODEL (overrides risk-based selection)
 * 4. RISK_BASED_MODELS[provider][riskLevel]
 * 5. DEFAULT_MODELS[provider]
 *
 * At whichever step decides the final provider, a disabled provider is
 * swapped for the enabled fallback (logging the source) and the stored
 * model id is discarded in favor of that fallback provider's model for
 * `riskLevel` — never the disabled provider's model id.
 *
 * If cost governance is disabled, falls through to default resolution.
 */
async function decideModelForRisk(
  riskLevel: RiskLevel,
  providerName?: LlmProviderName | string,
): Promise<ModelChoice> {
  // Opt-out: governance disabled -> fall through to default resolution
  if (process.env.ARBITRA_COST_GOVERNANCE === 'false') {
    const requested = getProvider(providerName);
    const provider = enforceProviderEnabled(requested, 'default/env provider (cost governance disabled)');
    const modelId = provider === requested
      ? (process.env.ARBITRA_LLM_MODEL ?? DEFAULT_MODELS[provider])
      : DEFAULT_MODELS[provider];
    return { provider, modelId };
  }

  // 1. Firestore settings (admin UI)
  const fsSettings = await getFirestoreSettings();
  if (fsSettings) {
    const storedModel = fsSettings.models[riskLevel];
    if (storedModel) {
      const provider = enforceProviderEnabled(fsSettings.provider, 'global /settings/llm');
      const modelId = provider === fsSettings.provider
        ? storedModel
        : (RISK_BASED_MODELS[provider]?.[riskLevel] ?? DEFAULT_MODELS[provider]);
      return { provider, modelId };
    }
  }

  // 2. Per-risk env vars
  const envKey = RISK_ENV_KEYS[riskLevel];
  const envModel = process.env[envKey];
  if (envModel) {
    const requested = getProvider(providerName);
    const provider = enforceProviderEnabled(requested, `${envKey} env var`);
    const modelId = provider === requested
      ? envModel
      : (RISK_BASED_MODELS[provider]?.[riskLevel] ?? DEFAULT_MODELS[provider]);
    return { provider, modelId };
  }

  // 3. Global env var overrides risk-based selection
  if (process.env.ARBITRA_LLM_MODEL) {
    const requested = getProvider(providerName);
    const provider = enforceProviderEnabled(requested, 'ARBITRA_LLM_MODEL env var');
    const modelId = provider === requested
      ? process.env.ARBITRA_LLM_MODEL
      : (RISK_BASED_MODELS[provider]?.[riskLevel] ?? DEFAULT_MODELS[provider]);
    return { provider, modelId };
  }

  // 4. Hardcoded risk-based models
  const provider = enforceProviderEnabled(getProvider(providerName), 'default/env provider');
  const modelId = RISK_BASED_MODELS[provider]?.[riskLevel] ?? DEFAULT_MODELS[provider];
  return { provider, modelId };
}

/**
 * Resolve a model based on case risk level (Cost/Latency Governance).
 * See `decideModelForRisk` for the priority chain and the `enabled`
 * enforcement applied at whichever step decides the provider.
 */
export async function resolveModelForRisk(
  riskLevel: RiskLevel,
  providerName?: LlmProviderName | string,
): Promise<LanguageModel> {
  const { provider, modelId } = await decideModelForRisk(riskLevel, providerName);
  return resolveModel(provider, modelId);
}

/**
 * Return the consensus model configuration, if any.
 *
 * Sources (highest priority wins):
 * 1. Firestore /settings/llm → consensus_models array
 * 2. Env var ARBITRA_CONSENSUS_MODELS (JSON array of {provider, model})
 *
 * Returns null when consensus is not configured → single-model behavior.
 */
export async function getConsensusConfig(): Promise<ConsensusModelSpec[] | null> {
  // 1. Firestore settings
  const fsSettings = await getFirestoreSettings();
  if (fsSettings?.consensus_models && fsSettings.consensus_models.length >= 2) {
    return fsSettings.consensus_models;
  }

  // 2. Env var (JSON array)
  const envVal = process.env.ARBITRA_CONSENSUS_MODELS;
  if (envVal) {
    try {
      const parsed = JSON.parse(envVal);
      if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((s: Record<string, unknown>) => typeof s.provider === 'string' && typeof s.model === 'string')) {
        return parsed as ConsensusModelSpec[];
      }
    } catch {
      console.warn('[LlmProvider] ARBITRA_CONSENSUS_MODELS contains invalid JSON — falling back to single-model');
    }
  }

  return null;
}

/**
 * Get the model ID that would be selected for a given risk level.
 * Uses the same `decideModelForRisk` decision as `resolveModelForRisk`, so
 * the id returned here always matches what that function actually calls —
 * including the disabled-provider fallback (#1099).
 */
export async function getModelForRisk(
  riskLevel: RiskLevel,
  providerName?: LlmProviderName | string,
): Promise<string> {
  const { modelId } = await decideModelForRisk(riskLevel, providerName);
  return modelId;
}

// ---------------------------------------------------------------------------
// Project config cache (5 min TTL, keyed by project_id)
// ---------------------------------------------------------------------------

const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;
const projectConfigCache = new Map<string, { data: { provider?: LlmProviderName; models?: Partial<Record<RiskLevel, string>> } | null; timestamp: number }>();

/** Invalidate project config cache (called after project settings update). */
export function invalidateProjectConfigCache(projectId?: string): void {
  if (projectId) {
    projectConfigCache.delete(projectId);
  } else {
    projectConfigCache.clear();
  }
}

async function getProjectLlmOverrides(projectId: string): Promise<{ provider?: LlmProviderName; models?: Partial<Record<RiskLevel, string>> } | null> {
  const now = Date.now();
  const cached = projectConfigCache.get(projectId);
  if (cached && now - cached.timestamp < PROJECT_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { collections } = await import('./firestore.js');
    const doc = await collections.projects().doc(projectId).get();
    if (doc.exists) {
      const project = doc.data();
      const overrides = project?.llm_overrides ?? null;
      projectConfigCache.set(projectId, { data: overrides, timestamp: now });
      return overrides;
    }
  } catch {
    // Firestore unavailable — fall through
  }

  projectConfigCache.set(projectId, { data: null, timestamp: now });
  return null;
}

/**
 * Decide the (provider, modelId) pair for a risk level with optional
 * project-level overrides. Single decision function behind both
 * `resolveModelForRiskWithProject` and `getModelForRiskWithProject` — see
 * `decideModelForRisk` for why that matters.
 *
 * Priority chain:
 * 1. Project-level llm_overrides (per-project model + optional provider)
 * 2. Firestore /settings/llm (global admin config)
 * 3. Per-risk env var ARBITRA_LLM_MODEL_<RISK>
 * 4. Global env var ARBITRA_LLM_MODEL
 * 5. RISK_BASED_MODELS[provider][riskLevel]
 *
 * A disabled project-override provider is swapped for the enabled fallback
 * (logging the source) with that fallback's own model for `riskLevel` —
 * never the stored override's model id (#1099).
 */
async function decideModelForRiskWithProject(
  riskLevel: RiskLevel,
  projectId?: string,
  providerName?: LlmProviderName | string,
): Promise<ModelChoice> {
  if (projectId) {
    const overrides = await getProjectLlmOverrides(projectId);
    if (overrides) {
      const overrideModelId = overrides.models?.[riskLevel];
      if (overrideModelId) {
        const requestedProvider = overrides.provider ?? getProvider(providerName);
        const provider = enforceProviderEnabled(requestedProvider, `project ${projectId} llm_overrides`);
        const modelId = provider === requestedProvider
          ? overrideModelId
          : (RISK_BASED_MODELS[provider]?.[riskLevel] ?? DEFAULT_MODELS[provider]);
        return { provider, modelId };
      }
      // If project has provider override but no model for this risk, use project provider
      if (overrides.provider) {
        return decideModelForRisk(riskLevel, overrides.provider);
      }
    }
  }

  return decideModelForRisk(riskLevel, providerName);
}

/**
 * Resolve a model based on case risk level with optional project-level
 * overrides. See `decideModelForRiskWithProject` for the priority chain and
 * the `enabled` enforcement applied at whichever step decides the provider.
 */
export async function resolveModelForRiskWithProject(
  riskLevel: RiskLevel,
  projectId?: string,
  providerName?: LlmProviderName | string,
): Promise<LanguageModel> {
  const { provider, modelId } = await decideModelForRiskWithProject(riskLevel, projectId, providerName);
  return resolveModel(provider, modelId);
}

/**
 * Get the model ID that would be selected for a given risk level,
 * project-aware. Uses the same `decideModelForRiskWithProject` decision as
 * `resolveModelForRiskWithProject`, so the id returned here always matches
 * what that function actually calls.
 */
export async function getModelForRiskWithProject(
  riskLevel: RiskLevel,
  projectId?: string,
  providerName?: LlmProviderName | string,
): Promise<string> {
  const { modelId } = await decideModelForRiskWithProject(riskLevel, projectId, providerName);
  return modelId;
}
