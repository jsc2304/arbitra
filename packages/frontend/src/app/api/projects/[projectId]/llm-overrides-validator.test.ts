import { describe, it, expect, vi } from 'vitest';
import { validateLlmOverrides } from './llm-overrides-validator';

describe('validateLlmOverrides', () => {
  it('accepts null (clears overrides)', () => {
    expect(validateLlmOverrides(null, 'p1')).toEqual({ ok: true });
  });

  it('accepts empty object', () => {
    expect(validateLlmOverrides({}, 'p1')).toEqual({ ok: true });
  });

  it('accepts a known, enabled provider and catalog model', () => {
    const result = validateLlmOverrides(
      { provider: 'anthropic', models: { low: 'claude-haiku-4-5-20251001', critical: 'claude-sonnet-5' } },
      'p1',
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects an unknown provider', () => {
    const result = validateLlmOverrides({ provider: 'skynet' }, 'p1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Unknown llm_overrides.provider/);
  });

  // #1099: google is known (has catalog model entries) but flagged
  // enabled: false (#1068) — a project must not be able to store it as an
  // override, or resolveModelForRiskWithProject silently keeps calling it.
  it('rejects a known but disabled provider (google)', () => {
    const result = validateLlmOverrides({ provider: 'google' }, 'p1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/disabled/i);
      expect(result.message).toMatch(/anthropic/);
    }
  });

  it('warns but accepts an unknown model ID (preserves legacy values)', () => {
    const warn = vi.fn();
    const result = validateLlmOverrides(
      { provider: 'anthropic', models: { low: 'claude-legacy-1' } },
      'p1',
      warn,
    );
    expect(result).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/claude-legacy-1/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/p1/);
  });

  it('rejects non-object llm_overrides', () => {
    const result = validateLlmOverrides('garbage', 'p1');
    expect(result.ok).toBe(false);
  });

  it('rejects non-object models', () => {
    const result = validateLlmOverrides({ models: 'nope' }, 'p1');
    expect(result.ok).toBe(false);
  });

  it('rejects non-string model values', () => {
    const result = validateLlmOverrides({ models: { low: 42 } }, 'p1');
    expect(result.ok).toBe(false);
  });

  it('allows empty string model values (treated as inherit)', () => {
    const warn = vi.fn();
    const result = validateLlmOverrides({ models: { low: '', medium: '' } }, 'p1', warn);
    expect(result).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });
});
