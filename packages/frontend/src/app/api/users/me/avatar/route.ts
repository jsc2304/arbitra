import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { authenticate, handleError } from '@/lib/api-helpers';
import {
  ALLOWED_AVATAR_MIME_TYPES,
  AVATAR_MIME_EXTENSIONS,
  detectAvatarMime,
} from '@/lib/avatar-image-type';

export const dynamic = 'force-dynamic';

/**
 * POST /api/users/me/avatar — Upload a profile picture.
 *
 * Backend-proxied upload path (see `storage.rules`, which denies all direct
 * client access). The caller sends `multipart/form-data` with a single
 * `file` field. We validate size + magic-number, write to the app's default
 * Storage bucket at `avatars/{uid}/{timestamp}-{rand}.{ext}` with a
 * Firebase download token in object metadata, then update
 * `users/{uid}.custom_avatar_url` to the tokenised public URL.
 *
 * If the previous `custom_avatar_url` pointed into this bucket, delete the
 * old object after the new one is written. External URLs (Gravatar, GitHub
 * avatars) are left alone.
 *
 * The companion route `PATCH /api/users/me` remains the way to paste an
 * external URL or clear the override; both converge on the same
 * `custom_avatar_url` field.
 */

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

function errorJson(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

/**
 * Returns true iff `url` points at an object in `bucketName`. We do an
 * exact host match on `firebasestorage.googleapis.com` + path-prefix
 * `/v0/b/{bucket}/` so only URLs we minted ourselves count — Gravatar,
 * GitHub avatars, and arbitrary CDNs do not.
 */
function urlIsInBucket(url: string, bucketName: string): boolean {
  try {
    const u = new URL(url);
    if (u.host !== 'firebasestorage.googleapis.com') return false;
    return u.pathname.startsWith(`/v0/b/${bucketName}/o/`);
  } catch {
    return false;
  }
}

/**
 * Extract the object path (e.g. `avatars/abc/123.png`) from a Firebase
 * Storage download URL we previously minted. Returns `null` if the URL
 * shape is unexpected (defensive — caller falls back to skipping cleanup).
 */
function objectPathFromBucketUrl(url: string, bucketName: string): string | null {
  try {
    const u = new URL(url);
    const prefix = `/v0/b/${bucketName}/o/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const encoded = u.pathname.slice(prefix.length);
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    // Parse multipart first. `request.formData()` will throw if the body
    // isn't multipart or is malformed — map both to a single INVALID_REQUEST.
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorJson(
        400,
        'INVALID_REQUEST',
        'Request body must be multipart/form-data',
      );
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return errorJson(
        400,
        'VALIDATION_ERROR',
        'Missing file field',
        { field: 'file' },
      );
    }

    // `Blob.size` is set from the multipart parser — cheap pre-read bound
    // check so we don't materialise a huge buffer just to reject it.
    if (file.size > MAX_AVATAR_BYTES) {
      return errorJson(
        400,
        'VALIDATION_ERROR',
        `File too large (max ${MAX_AVATAR_BYTES} bytes)`,
        { field: 'file', max_bytes: MAX_AVATAR_BYTES, actual_bytes: file.size },
      );
    }

    const arrayBuf = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);

    // Re-check size in case the multipart parser under-reported. Belt +
    // braces; some Next runtimes set Blob.size from headers rather than
    // actual bytes read.
    if (bytes.byteLength > MAX_AVATAR_BYTES) {
      return errorJson(
        400,
        'VALIDATION_ERROR',
        `File too large (max ${MAX_AVATAR_BYTES} bytes)`,
        { field: 'file', max_bytes: MAX_AVATAR_BYTES, actual_bytes: bytes.byteLength },
      );
    }

    const sniffedMime = detectAvatarMime(bytes);
    if (!sniffedMime) {
      return errorJson(
        400,
        'INVALID_FILE_TYPE',
        `File must be one of: ${ALLOWED_AVATAR_MIME_TYPES.join(', ')}`,
        { field: 'file', allowed: ALLOWED_AVATAR_MIME_TYPES },
      );
    }

    const ext = AVATAR_MIME_EXTENSIONS[sniffedMime];
    const { collections, getBucket } = await import('@arbitra/backend');

    const userRef = collections.users().doc(auth.userId);
    const snap = await userRef.get();
    if (!snap.exists) {
      return errorJson(404, 'NOT_FOUND', 'User profile not found');
    }

    const bucket = getBucket();
    const bucketName = bucket.name;

    const objectPath = `avatars/${auth.userId}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const downloadToken = randomUUID();

    // Persist metadata with the Firebase download-token marker. The
    // `firebaseStorageDownloadTokens` custom metadata key is what Firebase
    // Storage uses to gate `?alt=media&token=...` reads — rotating or
    // removing the token revokes the public URL without deleting the
    // object, which `makePublic()` would not allow.
    const gcsFile = bucket.file(objectPath);
    await gcsFile.save(Buffer.from(bytes), {
      contentType: sniffedMime,
      resumable: false,
      metadata: {
        contentType: sniffedMime,
        cacheControl: 'public, max-age=3600',
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
          uploaded_by: auth.userId,
        },
      },
    });

    const publicUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/` +
      `${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`;

    const now = new Date().toISOString();
    await userRef.update({
      custom_avatar_url: publicUrl,
      updated_at: now,
    });

    // Best-effort delete of the previous uploaded avatar. Skipped for
    // external URLs (Gravatar, GitHub) and swallowed on failure — a
    // dangling object is not worth failing the request over; a janitor
    // can sweep them later if needed.
    const previous =
      typeof snap.data()?.custom_avatar_url === 'string'
        ? (snap.data()!.custom_avatar_url as string)
        : '';
    if (previous && urlIsInBucket(previous, bucketName)) {
      const prevPath = objectPathFromBucketUrl(previous, bucketName);
      if (prevPath && prevPath !== objectPath) {
        try {
          await bucket.file(prevPath).delete({ ignoreNotFound: true });
        } catch {
          // Intentional: don't leak cleanup errors to the caller.
        }
      }
    }

    const updated = await userRef.get();
    return NextResponse.json(updated.data());
  } catch (error) {
    return handleError(error);
  }
}
