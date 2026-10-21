import { describe, it, expect } from 'vitest';
import {
  LLM_MODELS,
  LLM_PROVIDERS,
  isKnownLlmModel,
  isKnownLlmProvider,
  isEnabledLlmProvider,
  isPreviewModel,
  modelsForProvider,
} from '../constants/llm-models.js';
import { RISK_LEVELS } from '../constants/risk-levels.js';

const VALID_RISK_LEVELS = new Set(RISK_LEVELS);
const VALID_PROVIDERS = new Set(LLM_PROVIDERS.map((p) => p.id));

describe('LLM_MODELS catalog', () => {
  it('every entry has a unique id', () => {
    const ids = LLM_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has a non-empty label', () => {
    for (const m of LLM_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('every entry uses a known provider', () => {
    for (const m of LLM_MODELS) {
      expect(VALID_PROVIDERS.has(m.provider)).toBe(true);
    }
  });

  it('every recommended_for value is a valid RiskLevel', () => {
    for (const m of LLM_MODELS) {
      if (!m.recommended_for) continue;
      for (const r of m.recommended_for) {
        expect(VALID_RISK_LEVELS.has(r)).toBe(true);
      }
    }
  });

  it('preview entries never carry recommended_for tags (defaults must not point at previews)', () => {
    for (const m of LLM_MODELS) {
      if (m.preview) {
        expect(m.recommended_for, `${m.id} is preview but has recommended_for`).toBeUndefined();
      }
    }
  });

  it('contains the Gemini 3.1 Pro Preview entry flagged as preview', () => {
    const entry = LLM_MODELS.find((m) => m.id === 'gemini-3.1-pro-preview');
    expect(entry).toBeDefined();
    expect(entry?.preview).toBe(true);
    expect(entry?.provider).toBe('google');
    expect(entry?.context_window).toBe(1_048_576);
  });

  it('anthropic and openai are enabled and populated; google stays disabled (un-reverified since structured-output fixes, #1068)', () => {
    const anthropic = LLM_MODELS.filter((m) => m.provider === 'anthropic');
    const google = LLM_MODELS.filter((m) => m.provider === 'google');
    const openai = LLM_MODELS.filter((m) => m.provider === 'openai');
    expect(anthropic.length).toBeGreaterThan(0);
    expect(google.length).toBeGreaterThan(0);
    expect(openai.length).toBeGreaterThan(0);
    expect(LLM_PROVIDERS.find((p) => p.id === 'anthropic')?.enabled).toBe(true);
    expect(LLM_PROVIDERS.find((p) => p.id === 'openai')?.enabled).toBe(true);
    expect(LLM_PROVIDERS.find((p) => p.id === 'google')?.enabled).toBe(false);
  });

  it('anthropic entries mirror the backend RISK_BASED_MODELS defaults', () => {
    const haiku = LLM_MODELS.find((m) => m.id === 'claude-haiku-4-5-20251001');
    const sonnet = LLM_MODELS.find((m) => m.id === 'claude-sonnet-5');
    expect(haiku?.provider).toBe('anthropic');
    expect(haiku?.recommended_for).toEqual(['low']);
    expect(sonnet?.provider).toBe('anthropic');
    expect(sonnet?.recommended_for).toEqual(['medium', 'high', 'critical']);
  });
});

describe('isKnownLlmProvider / isKnownLlmModel', () => {
  it('accepts catalog entries', () => {
    expect(isKnownLlmProvider('google')).toBe(true);
    expect(isKnownLlmModel('gemini-2.5-flash')).toBe(true);
    expect(isKnownLlmModel('gemini-3.5-flash')).toBe(true);
    expect(isKnownLlmModel('gemini-3.1-pro-preview')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isKnownLlmProvider('bogus')).toBe(false);
    expect(isKnownLlmModel('gemini-9.9-ultra')).toBe(false);
  });
});

describe('isEnabledLlmProvider (#1099)', () => {
  it('accepts the enabled providers', () => {
    expect(isEnabledLlmProvider('anthropic')).toBe(true);
    expect(isEnabledLlmProvider('openai')).toBe(true);
  });

  it('rejects known-but-disabled providers (isKnownLlmProvider still accepts them — that is the #1099 distinction)', () => {
    expect(isKnownLlmProvider('google')).toBe(true);
    expect(isEnabledLlmProvider('google')).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(isEnabledLlmProvider('bogus')).toBe(false);
  });
});

describe('modelsForProvider', () => {
  it('returns only entries for the given provider', () => {
    const google = modelsForProvider('google');
    expect(google.length).toBeGreaterThan(0);
    expect(google.every((m) => m.provider === 'google')).toBe(true);
  });

  it('returns an empty array for an unknown provider string', () => {
    expect(modelsForProvider('bogus')).toEqual([]);
  });
});

describe('isPreviewModel', () => {
  it('returns true for a catalog entry flagged preview', () => {
    expect(isPreviewModel('gemini-3.1-pro-preview')).toBe(true);
  });

  it('returns false for a catalog entry not flagged preview', () => {
    expect(isPreviewModel('gemini-2.5-flash')).toBe(false);
  });

  it('returns false for an unknown model id', () => {
    expect(isPreviewModel('gemini-9.9-ultra')).toBe(false);
  });
});
