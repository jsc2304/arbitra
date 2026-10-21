import { describe, it, expect } from 'vitest';
import { normalizeActorMetadata } from '../types/actor-metadata.js';
import { actorMetadataSchema } from '../validation/actor-metadata-validators.js';

// ---------------------------------------------------------------------------
// normalizeActorMetadata
// ---------------------------------------------------------------------------

describe('normalizeActorMetadata', () => {
  it('returns undefined when input is undefined', () => {
    expect(normalizeActorMetadata(undefined)).toBeUndefined();
  });

  it('trims whitespace on all three fields', () => {
    const result = normalizeActorMetadata({
      client_name: '  cursor  ',
      client_version: '  0.42.1  ',
      model: '  claude-opus-4-7  ',
    });
    expect(result).toEqual({
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    });
  });

  it('lowercases client_name', () => {
    const result = normalizeActorMetadata({ client_name: 'Claude-Code' });
    expect(result).toEqual({ client_name: 'claude-code' });
  });

  it('lowercases model so casing variants dedupe downstream', () => {
    const result = normalizeActorMetadata({ model: 'Claude-Opus-4-7' });
    expect(result).toEqual({ model: 'claude-opus-4-7' });
  });

  it('trims but does NOT lowercase client_version', () => {
    const result = normalizeActorMetadata({ client_version: '  V1.0  ' });
    expect(result).toEqual({ client_version: 'V1.0' });
  });

  it('drops empty strings (post-trim)', () => {
    const result = normalizeActorMetadata({
      client_name: '   ',
      client_version: 'v1.2',
      model: '',
    });
    expect(result).toEqual({ client_version: 'v1.2' });
  });

  it('collapses an all-empty object to undefined', () => {
    const result = normalizeActorMetadata({
      client_name: '   ',
      client_version: '',
      model: undefined,
    });
    expect(result).toBeUndefined();
  });

  it('leaves already-normalized input unchanged', () => {
    const input = {
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    };
    expect(normalizeActorMetadata(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// actorMetadataSchema
// ---------------------------------------------------------------------------

describe('actorMetadataSchema', () => {
  it('accepts a fully-populated valid payload', () => {
    const result = actorMetadataSchema.safeParse({
      client_name: 'cursor',
      client_version: '0.42.1',
      model: 'claude-opus-4-7',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (all fields optional)', () => {
    const result = actorMetadataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys in strict mode', () => {
    const result = actorMetadataSchema.safeParse({
      client_name: 'cursor',
      // @ts-expect-error — intentional unknown key
      rogue_field: 'oops',
    });
    expect(result.success).toBe(false);
  });
});
