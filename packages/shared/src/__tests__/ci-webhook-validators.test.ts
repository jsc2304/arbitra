import { describe, it, expect } from 'vitest';
import { ciWebhookSchema } from '../validation/ci-webhook-validators.js';

const validPayload = {
  build_id: 'build_123',
  status: 'success' as const,
};

describe('ciWebhookSchema', () => {
  it('accepts a minimal valid payload', () => {
    expect(ciWebhookSchema.safeParse(validPayload).success).toBe(true);
  });

  it('rejects when build_id is missing', () => {
    const { build_id, ...rest } = validPayload;
    expect(ciWebhookSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty build_id', () => {
    expect(ciWebhookSchema.safeParse({ ...validPayload, build_id: '' }).success).toBe(false);
  });

  it('rejects when status is missing', () => {
    const { status, ...rest } = validPayload;
    expect(ciWebhookSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts both valid status values', () => {
    for (const status of ['success', 'failure']) {
      expect(ciWebhookSchema.safeParse({ ...validPayload, status }).success, status).toBe(true);
    }
  });

  it("rejects an unrecognized status (tightening vs. today's silent success->failure coercion)", () => {
    const result = ciWebhookSchema.safeParse({ ...validPayload, status: 'pending' });
    expect(result.success).toBe(false);
  });

  it('accepts optional branch/pr_ref/report_url/case_id', () => {
    const result = ciWebhookSchema.safeParse({
      ...validPayload,
      branch: 'feature/x',
      pr_ref: 'https://github.com/org/repo/pull/1',
      report_url: 'https://ci.example.com/build/123',
      case_id: 'case_1',
    });
    expect(result.success).toBe(true);
  });
});
