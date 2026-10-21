import { describe, it, expect } from 'vitest';
import { updateUserRolesSchema, updateUserProfileSchema } from '../validation/user-validators.js';

describe('updateUserRolesSchema', () => {
  it('accepts a single valid role', () => {
    expect(updateUserRolesSchema.safeParse({ roles: ['developer'] }).success).toBe(true);
  });

  it('accepts multiple valid roles', () => {
    expect(updateUserRolesSchema.safeParse({ roles: ['developer', 'reviewer', 'admin'] }).success).toBe(true);
  });

  it('rejects when roles is missing', () => {
    expect(updateUserRolesSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty roles array', () => {
    expect(updateUserRolesSchema.safeParse({ roles: [] }).success).toBe(false);
  });

  it('rejects a non-array roles value', () => {
    expect(updateUserRolesSchema.safeParse({ roles: 'admin' }).success).toBe(false);
  });

  it('rejects an invalid role', () => {
    expect(updateUserRolesSchema.safeParse({ roles: ['superuser'] }).success).toBe(false);
  });

  it('accepts all four valid roles', () => {
    for (const role of ['developer', 'reviewer', 'tech_lead', 'admin']) {
      expect(updateUserRolesSchema.safeParse({ roles: [role] }).success, role).toBe(true);
    }
  });
});

describe('updateUserProfileSchema', () => {
  it('accepts an empty string (clears the override)', () => {
    expect(updateUserProfileSchema.safeParse({ custom_avatar_url: '' }).success).toBe(true);
  });

  it('accepts a whitespace-only string (clears the override)', () => {
    expect(updateUserProfileSchema.safeParse({ custom_avatar_url: '   ' }).success).toBe(true);
  });

  it('accepts a valid https:// URL', () => {
    const result = updateUserProfileSchema.safeParse({ custom_avatar_url: 'https://cdn.example.com/me.png' });
    expect(result.success).toBe(true);
  });

  it('rejects an http:// URL', () => {
    const result = updateUserProfileSchema.safeParse({ custom_avatar_url: 'http://cdn.example.com/me.png' });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URL', () => {
    const result = updateUserProfileSchema.safeParse({ custom_avatar_url: 'data:image/png;base64,AAAA' });
    expect(result.success).toBe(false);
  });

  it('rejects a URL exceeding 500 characters', () => {
    const tooLong = `https://example.com/${'a'.repeat(500)}`;
    expect(updateUserProfileSchema.safeParse({ custom_avatar_url: tooLong }).success).toBe(false);
  });

  it('accepts custom_avatar_url absent — it is independently optional now that notification_chat_webhook is a sibling patchable field (spec Slice D); the route, not this schema, enforces "at least one field present"', () => {
    // Pre-Slice-D this schema modeled `custom_avatar_url` as the ONLY (and thus
    // required) field, so an empty object failed. Reverting `.optional()` on
    // `custom_avatar_url` back to required would fail this.
    expect(updateUserProfileSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a non-string custom_avatar_url', () => {
    expect(updateUserProfileSchema.safeParse({ custom_avatar_url: 123 }).success).toBe(false);
  });
});

describe('updateUserProfileSchema — notification_chat_webhook (spec Slice D)', () => {
  it('accepts a valid https://chat.googleapis.com/ webhook URL', () => {
    const result = updateUserProfileSchema.safeParse({
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x&token=y',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty string (clears the webhook)', () => {
    expect(updateUserProfileSchema.safeParse({ notification_chat_webhook: '' }).success).toBe(true);
  });

  it('accepts null (clears the webhook)', () => {
    expect(updateUserProfileSchema.safeParse({ notification_chat_webhook: null }).success).toBe(true);
  });

  it('rejects a non-Google-Chat https URL', () => {
    // Reverting to a bare `z.string().url()` (or no host check at all) would
    // let this through — the whole point of Slice D's validation is that the
    // webhook can only ever point at Google Chat's incoming-webhook host.
    const result = updateUserProfileSchema.safeParse({
      notification_chat_webhook: 'https://evil.example.com/webhook',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a plain http:// Google Chat-looking URL', () => {
    const result = updateUserProfileSchema.safeParse({
      notification_chat_webhook: 'http://chat.googleapis.com/v1/spaces/AAA/messages',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string, non-null value', () => {
    expect(updateUserProfileSchema.safeParse({ notification_chat_webhook: 42 }).success).toBe(false);
  });

  it('allows notification_chat_webhook to be omitted (avatar-only patch stays valid)', () => {
    expect(updateUserProfileSchema.safeParse({ custom_avatar_url: 'https://cdn.example.com/me.png' }).success).toBe(true);
  });
});
