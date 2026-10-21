import { describe, it, expect, vi } from 'vitest';
import { validateLlmSettings } from './llm-settings-validator';

describe('validateLlmSettings', () => {
  // anthropic and openai are enabled; google is enabled: false (see
  // llm-models.ts / #1068).
  const validModels = {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-sonnet-5',
    high: 'claude-sonnet-5',
    critical: 'claude-sonnet-5',
  };

  it('accepts a known, enabled provider and full catalog models', () => {
    const result = validateLlmSettings({ provider: 'anthropic', models: validModels });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe('anthropic');
      expect(result.value.models.low).toBe('claude-haiku-4-5-20251001');
    }
  });

  it('rejects an unknown provider', () => {
    const result = validateLlmSettings({ provider: 'skynet', models: validModels });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Unknown provider/);
  });

  // #1099: google is known (has catalog model entries) but flagged
  // enabled: false (#1068) — the global settings write boundary must not
  // let an admin store it, or resolveModel* silently keeps calling it.
  it('rejects a known but disabled provider (google), naming the enabled providers', () => {
    const result = validateLlmSettings({ provider: 'google', models: validModels });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/disabled/i);
      expect(result.message).toMatch(/anthropic/);
    }
  });

  it('rejects a missing provider', () => {
    const result = validateLlmSettings({ models: validModels });
    expect(result.ok).toBe(false);
  });

  it('warns but accepts an unknown model ID (preserves legacy values)', () => {
    const warn = vi.fn();
    const result = validateLlmSettings(
      {
        provider: 'anthropic',
        models: { ...validModels, low: 'claude-legacy-1' },
      },
      warn,
    );
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/claude-legacy-1/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/models.low/);
  });

  it('rejects non-object body', () => {
    const result = validateLlmSettings('garbage');
    expect(result.ok).toBe(false);
  });

  it('rejects non-object models', () => {
    const result = validateLlmSettings({ provider: 'anthropic', models: 'nope' });
    expect(result.ok).toBe(false);
  });

  it('rejects missing risk level', () => {
    const result = validateLlmSettings({
      provider: 'anthropic',
      models: { low: 'claude-haiku-4-5-20251001', medium: 'claude-sonnet-5', high: 'claude-sonnet-5' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/models\.critical/);
  });

  it('rejects empty-string model', () => {
    const result = validateLlmSettings({
      provider: 'anthropic',
      models: { ...validModels, medium: '   ' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects non-string model value', () => {
    const result = validateLlmSettings({
      provider: 'anthropic',
      models: { ...validModels, high: 42 },
    });
    expect(result.ok).toBe(false);
  });

  it('trims whitespace from model IDs', () => {
    const result = validateLlmSettings({
      provider: 'anthropic',
      models: {
        low: '  claude-haiku-4-5-20251001  ',
        medium: 'claude-sonnet-5',
        high: 'claude-sonnet-5',
        critical: 'claude-sonnet-5',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.models.low).toBe('claude-haiku-4-5-20251001');
  });
});
