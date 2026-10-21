import { describe, it, expect } from 'vitest';
import {
  createProjectSchema,
  updateProjectSchema,
  notificationConfigSchema,
} from '../validation/project-validators.js';

describe('createProjectSchema', () => {
  it('accepts a minimal valid project (only name)', () => {
    expect(createProjectSchema.safeParse({ name: 'Arbitra Core' }).success).toBe(true);
  });

  it('defaults description to empty string', () => {
    const result = createProjectSchema.safeParse({ name: 'Arbitra Core' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBe('');
  });

  it('rejects when name is missing', () => {
    expect(createProjectSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(createProjectSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only name', () => {
    expect(createProjectSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims a padded name', () => {
    const result = createProjectSchema.safeParse({ name: '  Arbitra Core  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('Arbitra Core');
  });

  it('accepts optional membership arrays', () => {
    const result = createProjectSchema.safeParse({
      name: 'Arbitra Core',
      reviewer_pool: ['usr_1'],
      tech_leads: ['usr_2'],
      members: ['usr_1', 'usr_2'],
      default_rule_set_refs: ['rs_1'],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid default_validation_track (tightening: today's route does not validate this)", () => {
    const result = createProjectSchema.safeParse({ name: 'x', default_validation_track: 'auto' });
    expect(result.success).toBe(false);
  });

  it('accepts both valid default_validation_track values', () => {
    for (const vt of ['direct', 'manual']) {
      const result = createProjectSchema.safeParse({ name: 'x', default_validation_track: vt });
      expect(result.success, `default_validation_track "${vt}"`).toBe(true);
    }
  });

  it("rejects an invalid default_language", () => {
    expect(createProjectSchema.safeParse({ name: 'x', default_language: 'fr' }).success).toBe(false);
  });

  it('accepts both valid default_language values', () => {
    for (const lang of ['en', 'de']) {
      expect(createProjectSchema.safeParse({ name: 'x', default_language: lang }).success, lang).toBe(true);
    }
  });

  it('rejects an unknown top-level field (issue #1070: .strict())', () => {
    const result = createProjectSchema.safeParse({ name: 'x', some_typo_field: 'value' });
    expect(result.success).toBe(false);
  });

  it('rejects reviewer_pool/tech_leads/members that are not string arrays', () => {
    expect(createProjectSchema.safeParse({ name: 'x', reviewer_pool: 'not-an-array' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'x', tech_leads: [1, 2] }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'x', members: { a: 1 } }).success).toBe(false);
  });
});

describe('updateProjectSchema', () => {
  it('accepts an empty object (no fields to update)', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a partial update with only name', () => {
    expect(updateProjectSchema.safeParse({ name: 'Renamed project' }).success).toBe(true);
  });

  it('rejects an empty name when provided', () => {
    expect(updateProjectSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only name when provided', () => {
    expect(updateProjectSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims a padded name when provided', () => {
    const result = updateProjectSchema.safeParse({ name: '  Renamed project  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('Renamed project');
  });

  it('rejects an invalid default_language', () => {
    expect(updateProjectSchema.safeParse({ default_language: 'fr' }).success).toBe(false);
  });

  it('accepts a valid lifecycle_profile (reused from lifecycle-profile-validators)', () => {
    const result = updateProjectSchema.safeParse({
      lifecycle_profile: { preset: 'standard' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid lifecycle_profile preset', () => {
    const result = updateProjectSchema.safeParse({
      lifecycle_profile: { preset: 'chaotic' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts llm_overrides with a provider and models map', () => {
    const result = updateProjectSchema.safeParse({
      llm_overrides: { provider: 'anthropic', models: { high: 'claude-opus-4-7' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null llm_overrides (clears overrides)', () => {
    const result = updateProjectSchema.safeParse({ llm_overrides: null });
    expect(result.success).toBe(true);
  });

  it('accepts notification_webhook_url and notification_templates', () => {
    const result = updateProjectSchema.safeParse({
      notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/x/messages',
      notification_templates: { case_approved: '{{case_title}} approved' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown field instead of silently stripping or persisting it (issue #1070: .strict())', () => {
    const result = updateProjectSchema.safeParse({ some_typo_field: 'value' });
    expect(result.success).toBe(false);
  });

  it('rejects a client-supplied notification_delivery (server-owned field, spec Slice C item 4)', () => {
    // Reverting the `notification_delivery: notificationDeliveryForbiddenSchema`
    // field (or widening it to accept a value) would let a client spoof its
    // own delivery status via PATCH.
    const result = updateProjectSchema.safeParse({
      notification_delivery: { last_success_at: '2026-08-01T00:00:00.000Z' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an update with no notification_delivery key at all', () => {
    const result = updateProjectSchema.safeParse({ name: 'Renamed' });
    expect(result.success).toBe(true);
  });

  it('rejects reviewer_pool/tech_leads/members that are not string arrays', () => {
    expect(updateProjectSchema.safeParse({ reviewer_pool: 'not-an-array' }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ tech_leads: [1, 2] }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ members: { a: 1 } }).success).toBe(false);
  });

  it('accepts null and empty-string notification_webhook_url (kept in sync with notificationConfigSchema)', () => {
    expect(updateProjectSchema.safeParse({ notification_webhook_url: null }).success).toBe(true);
    expect(updateProjectSchema.safeParse({ notification_webhook_url: '' }).success).toBe(true);
  });

  it('rejects a non-Google-Chat notification_webhook_url (kept in sync with notificationConfigSchema)', () => {
    const result = updateProjectSchema.safeParse({ notification_webhook_url: 'https://evil.example.com/hook' });
    expect(result.success).toBe(false);
  });

  it('validates notification_events against the catalog (kept in sync with notificationConfigSchema)', () => {
    expect(updateProjectSchema.safeParse({ notification_events: { not_a_real_event: true } }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ notification_events: { case_approved: true } }).success).toBe(true);
  });
});

describe('notificationConfigSchema — notification_delivery is server-owned', () => {
  it('rejects a client-supplied notification_delivery.last_success_at', () => {
    const result = notificationConfigSchema.safeParse({
      notification_delivery: { last_success_at: '2026-08-01T00:00:00.000Z' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a client-supplied notification_delivery.last_error', () => {
    const result = notificationConfigSchema.safeParse({
      notification_delivery: { last_error: { at: '2026-08-01T00:00:00.000Z', code: '500', message: 'spoofed' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a request that omits notification_delivery entirely, alongside valid notification fields', () => {
    const result = notificationConfigSchema.safeParse({
      notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/x/messages',
    });
    expect(result.success).toBe(true);
  });
});
