import { describe, it, expect } from 'vitest';
import { computeFindingSignature } from './finding-signature.js';
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

describe('computeFindingSignature – determinism', () => {
  it('should produce the same hash for identical inputs', () => {
    const obs = makeObservation();
    const sig1 = computeFindingSignature('case_1', obs);
    const sig2 = computeFindingSignature('case_1', obs);
    expect(sig1).toBe(sig2);
  });

  it('should produce a 64-character hex string (SHA-256)', () => {
    const sig = computeFindingSignature('case_1', makeObservation());
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeFindingSignature – different inputs produce different hashes', () => {
  it('should differ when case_id differs', () => {
    const obs = makeObservation();
    const sig1 = computeFindingSignature('case_1', obs);
    const sig2 = computeFindingSignature('case_2', obs);
    expect(sig1).not.toBe(sig2);
  });

  it('should differ when category differs', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ category: 'bug' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ category: 'security' }));
    expect(sig1).not.toBe(sig2);
  });

  it('should differ when location differs', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ location: 'src/a.ts:1-5' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ location: 'src/b.ts:10-20' }));
    expect(sig1).not.toBe(sig2);
  });

  it('should differ when title differs', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ title: 'Bug A' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ title: 'Bug B' }));
    expect(sig1).not.toBe(sig2);
  });

  it('should differ when description differs', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ description: 'First issue' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ description: 'Second issue' }));
    expect(sig1).not.toBe(sig2);
  });
});

describe('computeFindingSignature – normalization', () => {
  it('should produce same hash regardless of extra whitespace in location', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ location: 'src/foo.ts:10-20' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ location: '  src/foo.ts:10-20  ' }));
    expect(sig1).toBe(sig2);
  });

  it('should produce same hash regardless of case in location', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ location: 'SRC/Foo.ts' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ location: 'src/foo.ts' }));
    expect(sig1).toBe(sig2);
  });

  it('should produce same hash when title/description have extra whitespace', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({
      title: 'Found  a   bug',
      description: 'There   is a   bug',
    }));
    const sig2 = computeFindingSignature('case_1', makeObservation({
      title: 'Found a bug',
      description: 'There is a bug',
    }));
    expect(sig1).toBe(sig2);
  });

  it('should normalize punctuation away in claim (title+description)', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({
      title: 'Bug!',
      description: 'Found (a) bug.',
    }));
    const sig2 = computeFindingSignature('case_1', makeObservation({
      title: 'Bug',
      description: 'Found a bug',
    }));
    expect(sig1).toBe(sig2);
  });

  it('should handle empty/undefined location', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ location: undefined }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ location: '' }));
    expect(sig1).toBe(sig2);
  });

  it('should normalize line references in location', () => {
    const sig1 = computeFindingSignature('case_1', makeObservation({ location: 'file.ts line 10-20' }));
    const sig2 = computeFindingSignature('case_1', makeObservation({ location: 'file.ts line10-20' }));
    expect(sig1).toBe(sig2);
  });
});
