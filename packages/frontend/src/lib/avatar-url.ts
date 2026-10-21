/**
 * Validation for the user-overridable `custom_avatar_url` field.
 *
 * Security-adjacent: the value is rendered as an `<img src>` in headers,
 * menus, and user lists across the app. We restrict to `https://` URLs of
 * bounded length to block `data:`, `javascript:`, plain `http://`, and
 * pathologically long strings.
 */

export const MAX_AVATAR_URL_LENGTH = 500;

export type AvatarUrlValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate a custom avatar URL.
 *
 * Rules:
 *  - Empty string or whitespace-only input is valid and means "clear override".
 *  - Must start with `https://` (case-insensitive on the scheme).
 *  - Must be at most {@link MAX_AVATAR_URL_LENGTH} chars.
 *  - Must parse as a URL via `new URL(...)`.
 */
export function validateCustomAvatarUrl(raw: unknown): AvatarUrlValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Avatar URL must be a string' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: '' };
  }

  if (trimmed.length > MAX_AVATAR_URL_LENGTH) {
    return {
      ok: false,
      error: `Avatar URL must be at most ${MAX_AVATAR_URL_LENGTH} characters`,
    };
  }

  if (!/^https:\/\//i.test(trimmed)) {
    return { ok: false, error: 'Avatar URL must start with https://' };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'Avatar URL must use the https protocol' };
    }
  } catch {
    return { ok: false, error: 'Avatar URL is not a valid URL' };
  }

  return { ok: true, value: trimmed };
}
