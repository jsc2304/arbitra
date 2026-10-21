import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { openRepositoryToken, openSecret, sealSecret } from './secret-box.js';

const KEY = crypto.randomBytes(32).toString('base64');

describe('secret-box', () => {
  afterEach(() => {
    delete process.env['ARBITRA_ENCRYPTION_KEY'];
  });

  it('round-trips and never stores the plaintext', () => {
    process.env['ARBITRA_ENCRYPTION_KEY'] = KEY;
    const sealed = sealSecret('ghp_example_token');
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain('ghp_example_token');
    expect(openSecret(sealed)).toBe('ghp_example_token');
  });

  it('refuses to seal without a key', () => {
    expect(() => sealSecret('x')).toThrow(/ARBITRA_ENCRYPTION_KEY/);
  });

  it('rejects a key of the wrong length', () => {
    process.env['ARBITRA_ENCRYPTION_KEY'] = Buffer.from('short').toString('base64');
    expect(() => sealSecret('x')).toThrow(/32 bytes/);
  });

  it('openRepositoryToken returns undefined for plaintext, tampered or undecryptable values', () => {
    process.env['ARBITRA_ENCRYPTION_KEY'] = KEY;
    const sealed = sealSecret('ghp_example_token');
    expect(openRepositoryToken(sealed)).toBe('ghp_example_token');
    expect(openRepositoryToken(undefined)).toBeUndefined();
    expect(openRepositoryToken('ghp_plaintext')).toBeUndefined();
    expect(openRepositoryToken(sealed.slice(0, -4) + 'AAAA')).toBeUndefined();
    process.env['ARBITRA_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('base64');
    expect(openRepositoryToken(sealed)).toBeUndefined();
  });
});
