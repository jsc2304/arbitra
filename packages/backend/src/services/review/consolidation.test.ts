import { describe, it, expect } from 'vitest';
import { consolidateObservations } from './consolidation.js';
import type { ReviewObservation } from './adapters/reviewer-adapter.js';

function makeObservation(overrides: Partial<ReviewObservation> = {}): ReviewObservation {
  return {
    source: 'test-adapter',
    category: 'bug',
    severity: 'medium',
    confidence: 0.8,
    title: 'Found a bug',
    description: 'There is a bug in the code',
    location: 'src/foo.ts:10-20',
    ...overrides,
  };
}

describe('consolidateObservations', () => {
  it('should return empty for no observations', () => {
    const result = consolidateObservations('case_1', []);
    expect(result).toHaveLength(0);
  });

  it('should create one finding per unique signature', () => {
    const obs = [makeObservation()];
    const result = consolidateObservations('case_1', obs);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe('bug');
  });

  it('should merge duplicate observations by signature', () => {
    const obs = [
      makeObservation({ source: 'adapter-a', severity: 'medium', confidence: 0.8 }),
      makeObservation({ source: 'adapter-b', severity: 'medium', confidence: 0.6 }),
    ];
    const result = consolidateObservations('case_1', obs);
    expect(result).toHaveLength(1);
    expect(result[0]!.source_refs).toEqual(['adapter-a', 'adapter-b']);
    expect(result[0]!.confidence).toBe(0.7);
    expect(result[0]!.severity_contested).toBe(false);
  });

  it('should use max severity when merging', () => {
    const obs = [
      makeObservation({ source: 'adapter-a', severity: 'low' }),
      makeObservation({ source: 'adapter-b', severity: 'high' }),
    ];
    const result = consolidateObservations('case_1', obs);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe('high');
  });

  it('should set severity_contested when spread >= 2', () => {
    const obs = [
      makeObservation({ source: 'adapter-a', severity: 'low' }),
      makeObservation({ source: 'adapter-b', severity: 'critical' }),
    ];
    const result = consolidateObservations('case_1', obs);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity_contested).toBe(true);
    expect(result[0]!.severity).toBe('critical');
  });

  it('should NOT set severity_contested when spread < 2', () => {
    const obs = [
      makeObservation({ source: 'adapter-a', severity: 'medium' }),
      makeObservation({ source: 'adapter-b', severity: 'high' }),
    ];
    const result = consolidateObservations('case_1', obs);
    expect(result[0]!.severity_contested).toBe(false);
  });

  it('should keep different findings separate', () => {
    const obs = [
      makeObservation({ title: 'Bug A', description: 'First bug' }),
      makeObservation({ title: 'Bug B', description: 'Second bug' }),
    ];
    const result = consolidateObservations('case_1', obs);
    expect(result).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Consensus mode tests
  // -------------------------------------------------------------------------

  it('should NOT add consensus when reviewerCount is omitted', () => {
    const obs = [makeObservation()];
    const result = consolidateObservations('case_1', obs);
    expect(result[0]!.consensus).toBeUndefined();
  });

  it('should NOT add consensus when reviewerCount is 1', () => {
    const obs = [makeObservation()];
    const result = consolidateObservations('case_1', obs, 1);
    expect(result[0]!.consensus).toBeUndefined();
  });

  it('should add consensus metadata when reviewerCount >= 2', () => {
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro' }),
      makeObservation({ source: 'llm-anthropic', model: 'claude-sonnet-4-20250514' }),
    ];
    const result = consolidateObservations('case_1', obs, 2);
    expect(result).toHaveLength(1);
    expect(result[0]!.consensus).toBeDefined();
    expect(result[0]!.consensus!.reviewer_count).toBe(2);
    expect(result[0]!.consensus!.agreement_count).toBe(2);
    expect(result[0]!.consensus!.agreement_ratio).toBe(1.0);
    expect(result[0]!.consensus!.models).toEqual(['gemini-2.5-pro', 'claude-sonnet-4-20250514']);
  });

  it('should compute partial agreement ratio correctly', () => {
    // 3 reviewers, but only 1 flags the issue
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro' }),
    ];
    const result = consolidateObservations('case_1', obs, 3);
    expect(result[0]!.consensus!.reviewer_count).toBe(3);
    expect(result[0]!.consensus!.agreement_count).toBe(1);
    expect(result[0]!.consensus!.agreement_ratio).toBe(0.33);
  });

  it('should boost confidence when agreement_ratio >= 0.67', () => {
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro', confidence: 0.7 }),
      makeObservation({ source: 'llm-anthropic', model: 'claude-sonnet-4-20250514', confidence: 0.7 }),
    ];
    const result = consolidateObservations('case_1', obs, 2);
    // avg = 0.7, boosted by 0.15 → 0.85
    expect(result[0]!.confidence).toBe(0.85);
  });

  it('should reduce confidence when agreement_ratio <= 0.33', () => {
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro', confidence: 0.5 }),
    ];
    const result = consolidateObservations('case_1', obs, 3);
    // avg = 0.5, reduced by 0.15 → 0.35
    expect(result[0]!.confidence).toBe(0.35);
  });

  it('should cap boosted confidence at 1.0', () => {
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro', confidence: 0.95 }),
      makeObservation({ source: 'llm-anthropic', model: 'claude-sonnet-4-20250514', confidence: 0.95 }),
    ];
    const result = consolidateObservations('case_1', obs, 2);
    // avg = 0.95, boosted → capped at 1.0
    expect(result[0]!.confidence).toBe(1.0);
  });

  it('should floor reduced confidence at 0.1', () => {
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro', confidence: 0.05 }),
    ];
    const result = consolidateObservations('case_1', obs, 3);
    // avg = 0.05, reduced → floored at 0.1
    expect(result[0]!.confidence).toBe(0.1);
  });

  it('should NOT adjust confidence for mid-range agreement (0.34–0.66)', () => {
    // 2 out of 3 reviewers agree → ratio = 0.67, should boost
    // But 1 out of 2 → ratio = 0.5, no adjustment
    const obs = [
      makeObservation({ source: 'llm-google', model: 'gemini-2.5-pro', confidence: 0.6 }),
    ];
    const result = consolidateObservations('case_1', obs, 2);
    // ratio = 0.5 → no adjustment, confidence stays at 0.6
    expect(result[0]!.confidence).toBe(0.6);
  });
});
