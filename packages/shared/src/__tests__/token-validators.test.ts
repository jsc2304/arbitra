import { describe, it, expect } from 'vitest';
import { createTokenSchema } from '../validation/token-validators.js';

describe('createTokenSchema', () => {
  it('accepts a minimal valid token (only name)', () => {
    expect(createTokenSchema.safeParse({ name: 'CI token' }).success).toBe(true);
  });

  it('rejects when name is missing', () => {
    expect(createTokenSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(createTokenSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only name', () => {
    expect(createTokenSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('trims a padded name', () => {
    const result = createTokenSchema.safeParse({ name: '  CI token  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('CI token');
  });

  it('accepts optional client/device metadata', () => {
    const result = createTokenSchema.safeParse({
      name: 'CI token',
      client_name: 'claude-code',
      client_version: '1.2.3',
      device_id: 'abcd1234',
      device_label: "Alex's MacBook",
    });
    expect(result.success).toBe(true);
  });

  it('coerces an empty-string metadata field to undefined instead of rejecting (route parity)', () => {
    const result = createTokenSchema.safeParse({
      name: 'CI token',
      client_name: '',
      client_version: '',
      device_id: '',
      device_label: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.client_name).toBeUndefined();
      expect(result.data.client_version).toBeUndefined();
      expect(result.data.device_id).toBeUndefined();
      expect(result.data.device_label).toBeUndefined();
    }
  });

  it('coerces a whitespace-only metadata field to undefined instead of rejecting (route parity)', () => {
    const result = createTokenSchema.safeParse({
      name: 'CI token',
      client_name: '   ',
      client_version: '   ',
      device_id: '   ',
      device_label: '   ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.client_name).toBeUndefined();
      expect(result.data.client_version).toBeUndefined();
      expect(result.data.device_id).toBeUndefined();
      expect(result.data.device_label).toBeUndefined();
    }
  });

  it('coerces a wrong-type metadata field to undefined instead of rejecting (route parity)', () => {
    const result = createTokenSchema.safeParse({
      name: 'CI token',
      client_name: 123,
      client_version: true,
      device_id: {},
      device_label: ['not', 'a', 'string'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.client_name).toBeUndefined();
      expect(result.data.client_version).toBeUndefined();
      expect(result.data.device_id).toBeUndefined();
      expect(result.data.device_label).toBeUndefined();
    }
  });

  it('trims a padded metadata field value', () => {
    const result = createTokenSchema.safeParse({ name: 'CI token', client_name: '  claude-code  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.client_name).toBe('claude-code');
  });

  it("accepts 'manual' and 'ci_service' created_via values", () => {
    for (const via of ['manual', 'ci_service']) {
      const result = createTokenSchema.safeParse({ name: 'x', created_via: via });
      expect(result.success, `created_via "${via}"`).toBe(true);
    }
  });

  it('accepts an arbitrary created_via value (permissive: route silently clamps to manual, not rejects)', () => {
    const result = createTokenSchema.safeParse({ name: 'x', created_via: 'unified_connect' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created_via).toBe('unified_connect');
  });

  it.each([null, 123])(
    'coerces non-string created_via value %j to undefined instead of rejecting (route parity)',
    (createdVia) => {
      const result = createTokenSchema.safeParse({ name: 'x', created_via: createdVia });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.created_via).toBeUndefined();
    },
  );

  it('passes a string created_via value through unchanged', () => {
    const result = createTokenSchema.safeParse({ name: 'x', created_via: 'custom_source' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created_via).toBe('custom_source');
  });
});
