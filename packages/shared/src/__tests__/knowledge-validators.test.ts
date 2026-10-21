import { describe, it, expect } from 'vitest';
import {
  createKnowledgeSchema,
  updateKnowledgeSchema,
  updateKnowledgeStatusSchema,
} from '../validation/knowledge-validators.js';

const validAsset = {
  title: 'Mocking Firestore batches',
  type: 'pattern' as const,
  summary: 'Use an in-memory fake batch to assert delete/update calls.',
  body: 'When a service issues a Firestore batch write, prefer a fake WriteBatch '
    + 'implementation over mocking every method individually — it keeps assertions '
    + 'close to the real interface contract.',
  scope_type: 'global' as const,
  scope_ref: 'global',
};

describe('createKnowledgeSchema', () => {
  it('accepts a valid minimal asset', () => {
    expect(createKnowledgeSchema.safeParse(validAsset).success).toBe(true);
  });

  it('rejects when title is missing', () => {
    const { title, ...rest } = validAsset;
    expect(createKnowledgeSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, title: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only title', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, title: '   ' }).success).toBe(false);
  });

  it('trims a padded title', () => {
    const result = createKnowledgeSchema.safeParse({ ...validAsset, title: '  Padded title  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('Padded title');
  });

  it('rejects when type is missing', () => {
    const { type, ...rest } = validAsset;
    expect(createKnowledgeSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an invalid type', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, type: 'random_type' }).success).toBe(false);
  });

  it('accepts all valid knowledge types', () => {
    const types = [
      'precedent', 'pattern', 'anti_pattern', 'mock_template',
      'implementation_note', 'review_guideline', 'architecture_decision', 'exception_policy',
    ];
    for (const t of types) {
      const result = createKnowledgeSchema.safeParse({ ...validAsset, type: t });
      expect(result.success, `type "${t}" should be valid`).toBe(true);
    }
  });

  it('rejects a summary shorter than 10 characters', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, summary: 'too short' }).success).toBe(false);
  });

  it('rejects a body shorter than 50 characters', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, body: 'too short' }).success).toBe(false);
  });

  // Issue #749 item 3: `summary`/`body` used to check `z.string().min(n)` on
  // the raw value, so a string of nothing but spaces — long enough to clear
  // the 10/50 floor by count alone — passed. Reverting the `.trim()` on
  // either field (back to plain `z.string().min(n)`) makes these two
  // whitespace-only assertions fail.
  it('rejects a whitespace-only summary padded past the 10-character floor', () => {
    const result = createKnowledgeSchema.safeParse({ ...validAsset, summary: ' '.repeat(15) });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only body padded past the 50-character floor', () => {
    const result = createKnowledgeSchema.safeParse({ ...validAsset, body: ' '.repeat(60) });
    expect(result.success).toBe(false);
  });

  it('trims a padded summary/body that clears the floor after trimming', () => {
    const result = createKnowledgeSchema.safeParse({
      ...validAsset,
      summary: `  ${validAsset.summary}  `,
      body: `  ${validAsset.body}  `,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe(validAsset.summary);
      expect(result.data.body).toBe(validAsset.body);
    }
  });

  it('rejects an invalid scope_type', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, scope_type: 'workspace' }).success).toBe(false);
  });

  it('accepts all valid scope_type values', () => {
    for (const st of ['global', 'org', 'team', 'project', 'repo']) {
      const result = createKnowledgeSchema.safeParse({ ...validAsset, scope_type: st });
      expect(result.success, `scope_type "${st}" should be valid`).toBe(true);
    }
  });

  it('rejects when scope_ref is missing', () => {
    const { scope_ref, ...rest } = validAsset;
    expect(createKnowledgeSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts an empty scope_ref (route does not check non-emptiness today)', () => {
    expect(createKnowledgeSchema.safeParse({ ...validAsset, scope_ref: '' }).success).toBe(true);
  });

  it('accepts optional tags as an array of strings', () => {
    const result = createKnowledgeSchema.safeParse({ ...validAsset, tags: ['firestore', 'testing'] });
    expect(result.success).toBe(true);
  });

  it('rejects tags containing a non-string element', () => {
    const result = createKnowledgeSchema.safeParse({ ...validAsset, tags: ['ok', 123] });
    expect(result.success).toBe(false);
  });

  it('accepts optional source_case_refs / source_decision_refs', () => {
    const result = createKnowledgeSchema.safeParse({
      ...validAsset,
      source_case_refs: ['case_1'],
      source_decision_refs: ['dec_1'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-array source_case_refs (route silently drops this today, schema rejects)', () => {
    const result = createKnowledgeSchema.safeParse({ ...validAsset, source_case_refs: 'case_1' });
    expect(result.success).toBe(false);
  });
});

describe('updateKnowledgeSchema', () => {
  it('accepts an empty object (no fields to update)', () => {
    expect(updateKnowledgeSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a partial update with only title', () => {
    expect(updateKnowledgeSchema.safeParse({ title: 'New title' }).success).toBe(true);
  });

  it('rejects an empty title when provided', () => {
    expect(updateKnowledgeSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only title when provided', () => {
    expect(updateKnowledgeSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('trims a padded title when provided', () => {
    const result = updateKnowledgeSchema.safeParse({ title: '  New title  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('New title');
  });

  it('rejects an invalid type when provided', () => {
    expect(updateKnowledgeSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rejects a whitespace-only summary padded past the 10-character floor when provided', () => {
    expect(updateKnowledgeSchema.safeParse({ summary: ' '.repeat(15) }).success).toBe(false);
  });

  it('rejects a whitespace-only body padded past the 50-character floor when provided', () => {
    expect(updateKnowledgeSchema.safeParse({ body: ' '.repeat(60) }).success).toBe(false);
  });

  it('trims a padded summary/body when provided', () => {
    const result = updateKnowledgeSchema.safeParse({
      summary: '  A summary with more than ten characters.  ',
      body: `  ${'A'.repeat(60)}  `,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('A summary with more than ten characters.');
      expect(result.data.body).toBe('A'.repeat(60));
    }
  });

  it('rejects a forbidden/unknown field (status is not patchable here)', () => {
    const result = updateKnowledgeSchema.safeParse({ status: 'verified' });
    expect(result.success).toBe(false);
  });

  it('rejects any other unknown field (strict mode mirrors the route\'s explicit key check)', () => {
    const result = updateKnowledgeSchema.safeParse({ knowledge_id: 'ka_1' });
    expect(result.success).toBe(false);
  });

  it('accepts all allowed fields together', () => {
    const result = updateKnowledgeSchema.safeParse({
      title: 'Updated title',
      summary: 'A summary with more than ten characters.',
      body: 'A'.repeat(60),
      type: 'anti_pattern',
      scope_type: 'project',
      scope_ref: 'proj_1',
      tags: ['a', 'b'],
      expires_at: '2027-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('updateKnowledgeStatusSchema', () => {
  it('accepts all valid status values', () => {
    for (const status of ['suggested', 'verified', 'canonical', 'deprecated', 'superseded']) {
      expect(updateKnowledgeStatusSchema.safeParse({ status }).success, `status "${status}"`).toBe(true);
    }
  });

  it('rejects a missing status', () => {
    expect(updateKnowledgeStatusSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid status', () => {
    expect(updateKnowledgeStatusSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });
});
