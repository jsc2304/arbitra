import { describe, it, expect } from 'vitest';
import type { KnowledgeAsset } from '@arbitra/shared';
import {
  selectReviewKnowledge,
  MAX_PROMPT_ASSETS,
  MAX_ASSET_BODY_CHARS,
  MAX_ASSETS_BODY_BUDGET_CHARS,
} from './review-knowledge.js';

const NOW = new Date('2026-07-03T00:00:00.000Z');

function makeAsset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    knowledge_id: 'ka_1',
    type: 'review_guideline',
    title: 'Verify vendor API signatures',
    summary: 'Do not flag platform API calls without checking.',
    body: 'LLM reviewers hallucinate platform API signatures — verify before flagging.',
    scope_type: 'project',
    scope_ref: 'proj_1',
    status: 'verified',
    version: 1,
    trust_level: 1,
    source_case_refs: [],
    source_decision_refs: [],
    tags: [],
    artifact_refs: [],
    created_by: 'usr_1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('selectReviewKnowledge — status filter', () => {
  it('includes verified and canonical', () => {
    const result = selectReviewKnowledge(
      [
        makeAsset({ knowledge_id: 'ka_v', status: 'verified' }),
        makeAsset({ knowledge_id: 'ka_c', status: 'canonical' }),
      ],
      NOW,
    );
    expect(result.map((a) => a.knowledge_id)).toEqual(
      expect.arrayContaining(['ka_v', 'ka_c']),
    );
    expect(result).toHaveLength(2);
  });

  it('excludes suggested, deprecated, and superseded', () => {
    const result = selectReviewKnowledge(
      [
        makeAsset({ knowledge_id: 'ka_s', status: 'suggested' }),
        makeAsset({ knowledge_id: 'ka_d', status: 'deprecated' }),
        makeAsset({ knowledge_id: 'ka_x', status: 'superseded' }),
      ],
      NOW,
    );
    expect(result).toHaveLength(0);
  });
});

describe('selectReviewKnowledge — type filter', () => {
  it('includes review-relevant types', () => {
    const types = [
      'review_guideline',
      'precedent',
      'anti_pattern',
      'architecture_decision',
      'exception_policy',
    ] as const;
    const result = selectReviewKnowledge(
      types.map((type, i) => makeAsset({ knowledge_id: `ka_${i}`, type })),
      NOW,
    );
    expect(result).toHaveLength(types.length);
  });

  it('excludes implementation_note and mock_template', () => {
    const result = selectReviewKnowledge(
      [
        makeAsset({ knowledge_id: 'ka_n', type: 'implementation_note' }),
        makeAsset({ knowledge_id: 'ka_m', type: 'mock_template' }),
      ],
      NOW,
    );
    expect(result).toHaveLength(0);
  });
});

describe('selectReviewKnowledge — expiry', () => {
  it('excludes assets whose expires_at is in the past', () => {
    const result = selectReviewKnowledge(
      [makeAsset({ expires_at: '2026-01-01T00:00:00.000Z' })],
      NOW,
    );
    expect(result).toHaveLength(0);
  });

  it('includes assets whose expires_at is in the future', () => {
    const result = selectReviewKnowledge(
      [makeAsset({ expires_at: '2027-01-01T00:00:00.000Z' })],
      NOW,
    );
    expect(result).toHaveLength(1);
  });

  it('includes assets with no expires_at', () => {
    const result = selectReviewKnowledge([makeAsset()], NOW);
    expect(result).toHaveLength(1);
  });
});

describe('selectReviewKnowledge — empty body', () => {
  it('skips empty and whitespace-only bodies', () => {
    const result = selectReviewKnowledge(
      [
        makeAsset({ knowledge_id: 'ka_empty', body: '' }),
        makeAsset({ knowledge_id: 'ka_ws', body: '   \n\t ' }),
        makeAsset({ knowledge_id: 'ka_ok', body: 'real content' }),
      ],
      NOW,
    );
    expect(result.map((a) => a.knowledge_id)).toEqual(['ka_ok']);
  });
});

describe('selectReviewKnowledge — ranking', () => {
  it('sorts by trust_level desc, then updated_at desc', () => {
    const result = selectReviewKnowledge(
      [
        makeAsset({ knowledge_id: 'low', trust_level: 1, updated_at: '2026-05-01T00:00:00Z' }),
        makeAsset({ knowledge_id: 'high_old', trust_level: 5, updated_at: '2026-01-01T00:00:00Z' }),
        makeAsset({ knowledge_id: 'high_new', trust_level: 5, updated_at: '2026-06-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(result.map((a) => a.knowledge_id)).toEqual(['high_new', 'high_old', 'low']);
  });
});

describe('selectReviewKnowledge — caps', () => {
  it('caps at MAX_PROMPT_ASSETS', () => {
    const candidates = Array.from({ length: MAX_PROMPT_ASSETS + 5 }, (_, i) =>
      makeAsset({ knowledge_id: `ka_${i}`, trust_level: i }),
    );
    const result = selectReviewKnowledge(candidates, NOW);
    expect(result).toHaveLength(MAX_PROMPT_ASSETS);
  });

  it('truncates each body to MAX_ASSET_BODY_CHARS with a suffix', () => {
    const longBody = 'x'.repeat(MAX_ASSET_BODY_CHARS + 500);
    const result = selectReviewKnowledge([makeAsset({ body: longBody })], NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.body.length).toBe(MAX_ASSET_BODY_CHARS + '… [truncated]'.length);
    expect(result[0]!.body.endsWith('… [truncated]')).toBe(true);
  });

  it('leaves short bodies untouched', () => {
    const result = selectReviewKnowledge([makeAsset({ body: 'short' })], NOW);
    expect(result[0]!.body).toBe('short');
  });

  it('stops adding once the overall body budget is exceeded', () => {
    // Bodies of MAX_ASSET_BODY_CHARS (no truncation) → budget 12000 fits 6
    // assets (6 × 2000 = 12000); the 7th would exceed the budget and is dropped.
    const body = 'y'.repeat(MAX_ASSET_BODY_CHARS);
    const expectedFit = Math.floor(MAX_ASSETS_BODY_BUDGET_CHARS / MAX_ASSET_BODY_CHARS);
    const candidates = Array.from({ length: expectedFit + 2 }, (_, i) =>
      // Descending trust_level so ordering is deterministic.
      makeAsset({ knowledge_id: `ka_${i}`, body, trust_level: 100 - i }),
    );
    const result = selectReviewKnowledge(candidates, NOW);
    expect(result).toHaveLength(expectedFit);
    expect(result.reduce((sum, a) => sum + a.body.length, 0)).toBeLessThanOrEqual(
      MAX_ASSETS_BODY_BUDGET_CHARS,
    );
  });
});
