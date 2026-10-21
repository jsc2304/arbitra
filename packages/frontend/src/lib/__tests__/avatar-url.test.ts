import { describe, expect, it } from 'vitest';
import { validateCustomAvatarUrl, MAX_AVATAR_URL_LENGTH } from '../avatar-url';

describe('validateCustomAvatarUrl', () => {
  it('accepts an empty string as "clear override"', () => {
    const res = validateCustomAvatarUrl('');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('');
  });

  it('accepts a whitespace-only string as "clear override"', () => {
    const res = validateCustomAvatarUrl('   ');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('');
  });

  it('accepts a valid https URL and trims surrounding whitespace', () => {
    const res = validateCustomAvatarUrl('  https://cdn.example.com/me.png  ');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('https://cdn.example.com/me.png');
  });

  it('rejects http://', () => {
    const res = validateCustomAvatarUrl('http://cdn.example.com/me.png');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/https:\/\//);
  });

  it('rejects data: URLs', () => {
    const res = validateCustomAvatarUrl('data:image/png;base64,AAAA');
    expect(res.ok).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    const res = validateCustomAvatarUrl('javascript:alert(1)');
    expect(res.ok).toBe(false);
  });

  it('rejects strings longer than the max length', () => {
    const tooLong = `https://example.com/${'a'.repeat(MAX_AVATAR_URL_LENGTH)}`;
    const res = validateCustomAvatarUrl(tooLong);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/characters/);
  });

  it('rejects non-string input', () => {
    expect(validateCustomAvatarUrl(undefined).ok).toBe(false);
    expect(validateCustomAvatarUrl(null).ok).toBe(false);
    expect(validateCustomAvatarUrl(123).ok).toBe(false);
    expect(validateCustomAvatarUrl({}).ok).toBe(false);
  });

  it('rejects a string that starts with https:// but does not parse as a URL', () => {
    const res = validateCustomAvatarUrl('https://');
    expect(res.ok).toBe(false);
  });

  it('rejects mixed-scheme tricks like " https://..."-prefixed javascript', () => {
    // Even though we trim, the scheme check still runs after trim.
    const res = validateCustomAvatarUrl(' javascript:alert(1) ');
    expect(res.ok).toBe(false);
  });
});
