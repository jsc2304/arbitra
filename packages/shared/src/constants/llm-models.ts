/**
 * Curated catalog of LLM models available for per-project overrides.
 *
 * Source of truth for the Gemini entries:
 *   https://ai.google.dev/gemini-api/docs/models
 *
 * Only stable (non-experimental) text-generation models are included,
 * except entries explicitly flagged `preview: true` — those are opt-in
 * for per-project overrides, surfaced with a "Preview" badge in the UI,
 * and must never carry `recommended_for` tags (defaults must never point
 * at a preview model). Anthropic is the active default provider (see
 * ARBITRA_LLM_PROVIDER in scripts/deploy.sh and the backend's
 * RISK_BASED_MODELS); its entries mirror the backend defaults. OpenAI is
 * schema-supported but not production-verified, so its entries are
 * intentionally empty and the provider is flagged `enabled: false` so the
 * UI filters it out.
 *
 * Google is likewise flagged `enabled: false` (#1068): the
 * `.nullish()`/repair-pass structured-output fixes (#907, #978, #1042) were
 * verified against Anthropic only and Gemini's key-omission behavior against
 * the current review/verifier schemas is unknown — re-enable only after a
 * live re-verification run (see #1068 option b) confirms schema
 * compatibility.
 */

import type { RiskLevel } from '../types/case.js';

export type LlmProvider = 'google' | 'anthropic' | 'openai';

export interface LlmModel {
  id: string;
  label: string;
  provider: LlmProvider;
  context_window?: number;
  notes?: string;
  recommended_for?: RiskLevel[];
  /** Preview models may change or be withdrawn by the provider; opt-in only, never a default. */
  preview?: boolean;
}

export const LLM_MODELS: LlmModel[] = [
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
    provider: 'google',
    context_window: 1_048_576,
    notes: 'fastest, cheapest (previous generation)',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'google',
    context_window: 1_048_576,
    notes: 'balanced price/performance (previous generation)',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'google',
    context_window: 1_048_576,
    notes: 'frontier performance on agentic and coding tasks, balanced price',
    recommended_for: ['low', 'medium'],
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    context_window: 1_048_576,
    notes: 'highest quality, deep reasoning',
    recommended_for: ['high', 'critical'],
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    provider: 'google',
    context_window: 1_048_576,
    notes: 'preview — may change or be withdrawn without notice',
    preview: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    context_window: 200_000,
    notes: 'fastest, cheapest Claude',
    recommended_for: ['low'],
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    context_window: 1_000_000,
    notes: 'near-Opus quality on coding and review work, balanced price',
    recommended_for: ['medium', 'high', 'critical'],
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini',
    provider: 'openai',
    notes: 'fast, cheap',
    recommended_for: ['low'],
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    notes: 'general-purpose default',
    recommended_for: ['medium', 'high', 'critical'],
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    provider: 'openai',
    notes: 'highest quality OpenAI model available at release',
  },
];

export const LLM_PROVIDERS: Array<{ id: LlmProvider; label: string; enabled: boolean }> = [
  // Un-reverified structured-output path since the Anthropic switch (see
  // #1068) — keep disabled until a live re-verification run confirms schema
  // compatibility.
  { id: 'google', label: 'Google Gemini', enabled: false },
  { id: 'anthropic', label: 'Anthropic Claude', enabled: true },
  { id: 'openai', label: 'OpenAI', enabled: true },
];

/** True if the given model ID exists in the curated catalog. */
export function isKnownLlmModel(modelId: string): boolean {
  return LLM_MODELS.some((m) => m.id === modelId);
}

/** True if the given provider string is a known `LlmProvider`. */
export function isKnownLlmProvider(provider: string): provider is LlmProvider {
  return LLM_PROVIDERS.some((p) => p.id === provider);
}

/**
 * True if the given provider is both known AND flagged `enabled: true`.
 *
 * `isKnownLlmProvider` only checks catalog membership — a provider like
 * `google` is "known" (it has model entries) but currently disabled
 * (#1068). Write boundaries that let an admin pick a provider (global
 * `/settings/llm`, a project's `llm_overrides`) must call this, not
 * `isKnownLlmProvider`, or a disabled provider slips back in (#1099).
 */
export function isEnabledLlmProvider(provider: string): provider is LlmProvider {
  return LLM_PROVIDERS.some((p) => p.id === provider && p.enabled);
}

/** Catalog entries for a given provider. */
export function modelsForProvider(provider: string) {
  return LLM_MODELS.filter((m) => m.provider === provider);
}

/** True if the given model ID is in the catalog and flagged `preview: true`. */
export function isPreviewModel(modelId: string): boolean {
  return LLM_MODELS.some((m) => m.id === modelId && m.preview === true);
}
