import { describe, expect, it } from 'vitest';
import { detectAvatarMime } from '../avatar-image-type';

function bytes(...b: number[]): Uint8Array {
  return Uint8Array.from(b);
}

/** Pad a prefix with zeros up to `len` so sniffers have enough to read. */
function padded(prefix: number[], len = 32): Uint8Array {
  const out = new Uint8Array(len);
  out.set(prefix, 0);
  return out;
}

describe('detectAvatarMime', () => {
  it('detects JPEG (FF D8 FF)', () => {
    expect(detectAvatarMime(padded([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
  });

  it('detects PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    expect(
      detectAvatarMime(padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
  });

  it('detects GIF87a', () => {
    expect(detectAvatarMime(padded([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif');
  });

  it('detects GIF89a', () => {
    expect(detectAvatarMime(padded([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
  });

  it('detects WEBP (RIFF....WEBP)', () => {
    // RIFF + 4 size bytes (ignored) + WEBP
    const buf = padded([
      0x52, 0x49, 0x46, 0x46,
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectAvatarMime(buf)).toBe('image/webp');
  });

  it('rejects an empty buffer', () => {
    expect(detectAvatarMime(new Uint8Array(0))).toBeNull();
  });

  it('rejects an all-zero buffer', () => {
    expect(detectAvatarMime(new Uint8Array(64))).toBeNull();
  });

  it('rejects a too-short buffer (< 12 bytes)', () => {
    expect(detectAvatarMime(bytes(0xff, 0xd8, 0xff))).toBeNull();
  });

  it('rejects a buffer with a wrong signature', () => {
    // Looks like a text file: "hello world\0\0..."
    expect(
      detectAvatarMime(
        padded([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x00]),
      ),
    ).toBeNull();
  });

  it('rejects RIFF without WEBP subtype (e.g. WAV)', () => {
    // RIFF....WAVE — a wav file masquerading as an image
    const buf = padded([
      0x52, 0x49, 0x46, 0x46,
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45,
    ]);
    expect(detectAvatarMime(buf)).toBeNull();
  });

  it('rejects a PNG with a single bit flipped in the signature', () => {
    const buf = padded([0x89, 0x50, 0x4e, 0x48, 0x0d, 0x0a, 0x1a, 0x0a]); // 'H' instead of 'G'
    expect(detectAvatarMime(buf)).toBeNull();
  });
});
