import crypto from 'node:crypto';
import { ValidationError } from '@arbitra/shared';

/**
 * AES-256-GCM encryption for secrets Arbitra stores in Firestore
 * (per-repository GitHub tokens). The key comes from `ARBITRA_ENCRYPTION_KEY`
 * (32 bytes, base64). Stored form: `enc:v1:<base64(iv | tag | ciphertext)>`.
 */
const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer {
  const raw = process.env['ARBITRA_ENCRYPTION_KEY']?.trim();
  if (!raw) {
    throw new ValidationError(
      'ARBITRA_ENCRYPTION_KEY is not set; it is required to store repository tokens',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new ValidationError('ARBITRA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  return key;
}

export function sealSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error('Value is not a sealed secret');
  const buf = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), buf.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Plaintext of a stored repository token, or `undefined` when none is stored
 * or it cannot be decrypted (missing/rotated key). Callers then fall back to
 * `GITHUB_TOKEN`, exactly as for a repository without its own token.
 */
export function openRepositoryToken(
  stored: string | undefined | null,
  repositoryId?: string,
): string | undefined {
  if (!stored) return undefined;
  try {
    return openSecret(stored);
  } catch (err) {
    console.warn(
      `[secret-box] stored token of repository ${repositoryId ?? '(unknown)'} could not be decrypted:`,
      (err as Error).message,
    );
    return undefined;
  }
}
