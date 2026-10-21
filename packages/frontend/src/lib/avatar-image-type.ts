/**
 * Magic-number based image type sniffer for avatar uploads.
 *
 * Client-supplied `Content-Type` is not trustworthy (attacker can lie, or
 * bundle a script as `image/png`). We inspect the first bytes of the
 * uploaded buffer and accept only the four formats the profile panel
 * advertises.
 *
 * Signatures covered:
 *  - JPEG: `FF D8 FF`
 *  - PNG:  `89 50 4E 47 0D 0A 1A 0A`
 *  - WEBP: `52 49 46 46 .. .. .. .. 57 45 42 50`  (RIFF container w/ "WEBP" at offset 8)
 *  - GIF:  `47 49 46 38 37 61` or `47 49 46 38 39 61` ("GIF87a" / "GIF89a")
 *
 * Intentionally no dependency — this is five tiny byte comparisons.
 */

export const ALLOWED_AVATAR_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type AllowedAvatarMime = (typeof ALLOWED_AVATAR_MIME_TYPES)[number];

/** Maps each sniffed MIME to the extension we persist in Storage. */
export const AVATAR_MIME_EXTENSIONS: Record<AllowedAvatarMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Detect an allowed avatar image format from its leading bytes.
 * Returns `null` if the buffer does not match any supported signature
 * (empty, too short, wrong magic, unknown format).
 */
export function detectAvatarMime(buf: Uint8Array): AllowedAvatarMime | null {
  if (!buf || buf.length < 12) {
    // WEBP needs offset 11 ("P" of WEBP). 12 bytes is the minimum we can
    // inspect for all four formats; JPEG/PNG/GIF of that size aren't valid
    // anyway, so rejecting short buffers is correct.
    return null;
  }

  // JPEG — FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // GIF — "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WEBP — RIFF....WEBP. Size bytes 4..7 are ignored; we only check the
  // container tags at offsets 0..3 and 8..11.
  if (
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x45 && // E
    buf[10] === 0x42 && // B
    buf[11] === 0x50 // P
  ) {
    return 'image/webp';
  }

  return null;
}
