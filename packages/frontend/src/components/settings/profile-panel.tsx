'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import useSWR from 'swr';
import type { User } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { validateCustomAvatarUrl, MAX_AVATAR_URL_LENGTH } from '../../lib/avatar-url';
import { ALLOWED_AVATAR_MIME_TYPES } from '../../lib/avatar-image-type';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';

/**
 * Self-service profile panel. Editable fields:
 *  1. Upload — a file becomes `custom_avatar_url` after being proxied to
 *     Firebase Storage by the backend (`POST /api/users/me/avatar`).
 *  2. Paste URL — external `https://` URL (Gravatar, GitHub avatar, etc.),
 *     written via `PATCH /api/users/me`.
 *
 * Both routes converge on the same `custom_avatar_url` field. URL paste is
 * kept as a secondary path because the upload covers the common case
 * (user has a file on their machine, not a hosted image).
 */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB (must match backend)
const DOWNSCALE_EDGE = 512;

/**
 * Downscale an image to at most `DOWNSCALE_EDGE` on the long edge. Returns
 * the original file if:
 *  - the canvas path is unavailable (SSR / exotic browser),
 *  - the image is already within bounds,
 *  - the format is GIF (may be animated; canvas would drop frames),
 *  - any step throws (we fall back to uploading the original).
 *
 * Output is re-encoded as PNG — lossless and smaller than a full-quality
 * JPEG for avatar-sized images in practice; also avoids a second decisions
 * about JPEG quality.
 */
async function maybeDownscale(file: File): Promise<File> {
  if (file.type === 'image/gif') return file;
  if (typeof window === 'undefined') return file;
  if (typeof createImageBitmap !== 'function') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    if (width <= DOWNSCALE_EDGE && height <= DOWNSCALE_EDGE) {
      bitmap.close?.();
      return file;
    }

    const scale = Math.min(DOWNSCALE_EDGE / width, DOWNSCALE_EDGE / height);
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) return file;

    return new File([blob], replaceExt(file.name, 'png'), { type: 'image/png' });
  } catch {
    return file;
  }
}

function replaceExt(name: string, ext: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function ProfilePanel() {
  const { user: firebaseUser, refreshCustomAvatarUrl } = useAuth();
  const { addToast } = useToast();

  const { data, mutate } = useSWR<User>('me-profile', () => api.users.me());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [urlExpanded, setUrlExpanded] = useState(false);

  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [previewOk, setPreviewOk] = useState(true);

  // Seed the input from the fetched profile exactly once per load.
  useEffect(() => {
    setInput(data?.custom_avatar_url ?? '');
    setInlineError(null);
  }, [data?.custom_avatar_url]);

  const persisted = data?.custom_avatar_url ?? '';
  const dirty = input !== persisted;

  // Effective avatar rendered in the preview tile.
  const effectiveAvatar =
    (data?.custom_avatar_url ?? '') ||
    data?.avatar_url ||
    firebaseUser?.photoURL ||
    null;

  const displayName = data?.display_name ?? firebaseUser?.displayName ?? '';
  const email = data?.email ?? firebaseUser?.email ?? '';

  async function handleFile(file: File) {
    setUploadError(null);

    // Match on the advertised accept list — catches the obvious cases
    // client-side. The backend still sniffs magic numbers (source of truth).
    if (!(ALLOWED_AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) {
      setUploadError('Only JPEG, PNG, WEBP, or GIF images are supported.');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(
        `File is too large (${formatBytes(file.size)}). Max 2 MB.`,
      );
      return;
    }

    setUploading(true);
    try {
      const toUpload = await maybeDownscale(file);
      const updated = await api.users.uploadAvatar(toUpload);
      await mutate(updated, { revalidate: false });
      await refreshCustomAvatarUrl();
      addToast('success', 'Avatar uploaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(msg);
      addToast('error', msg);
    } finally {
      setUploading(false);
      // Reset the input so picking the same file twice still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const validation = validateCustomAvatarUrl(input);
    if (!validation.ok) {
      setInlineError(validation.error);
      return;
    }
    setInlineError(null);
    setSaving(true);
    try {
      const updated = await api.users.updateMe({ custom_avatar_url: validation.value });
      await mutate(updated, { revalidate: false });
      await refreshCustomAvatarUrl();
      addToast(
        'success',
        validation.value === '' ? 'Custom avatar cleared' : 'Custom avatar updated',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update avatar';
      addToast('error', msg);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setInput(persisted);
    setInlineError(null);
  }

  // Live preview — only when input is a valid-looking https URL.
  const livePreviewUrl = (() => {
    const v = validateCustomAvatarUrl(input);
    return v.ok && v.value !== '' ? v.value : null;
  })();

  const acceptAttr = ALLOWED_AVATAR_MIME_TYPES.join(',');

  return (
    <div className="max-w-3xl">
      <section className="mb-8">
        <SectionHeader eyebrow title="Profile" className="mb-3" />

        {/* Identity card */}
        <Card padding="compact" className="flex items-center gap-4 mb-4">
          {effectiveAvatar ? (
            <Image
              src={effectiveAvatar}
              alt=""
              className="h-16 w-16 rounded-full flex-shrink-0"
              width={64}
              height={64}
              unoptimized
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-secondary-100 dark:bg-secondary-900/50 flex items-center justify-center flex-shrink-0">
              <span className="text-xl font-medium text-secondary-700 dark:text-secondary-300">
                {(displayName || email || '?').charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="min-w-0">
            <p className="text-base font-medium text-gray-900 dark:text-gray-100 truncate">
              {displayName || '—'}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{email}</p>
          </div>
        </Card>

        {/* Upload — primary flow */}
        <Card padding="compact" className="mb-4">
          <div className="mb-2">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Upload a picture
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              JPEG, PNG, WEBP, or GIF. Max 2 MB. Large images are downscaled to 512 px
              before upload.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`rounded-md border-2 border-dashed px-4 py-6 flex flex-col items-center justify-center text-center transition-colors ${
              dragOver
                ? 'border-accent bg-accent/5'
                : 'border-gray-300 dark:border-gray-600 bg-surface-base'
            }`}
          >
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Drag an image here, or
            </p>
            <label
              htmlFor="avatar-file-input"
              className={`mt-2 inline-flex items-center rounded-md bg-accent-700 px-3 py-1.5 text-sm font-medium text-white cursor-pointer hover:bg-accent-800 ${
                uploading ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              {uploading ? 'Uploading…' : 'Choose file'}
            </label>
            <input
              ref={fileInputRef}
              id="avatar-file-input"
              type="file"
              accept={acceptAttr}
              onChange={onPickFile}
              disabled={uploading}
              className="sr-only"
              aria-label="Upload avatar image"
            />
            {uploadError && (
              <p className="mt-3 text-xs text-red-600 dark:text-red-400">
                {uploadError}
              </p>
            )}
          </div>
        </Card>

        {/* Divider + URL paste (secondary) */}
        <div className="relative mb-3">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <div className="w-full border-t border-gray-200 dark:border-border-subtle" />
          </div>
          <div className="relative flex justify-center">
            <button
              type="button"
              onClick={() => setUrlExpanded((v) => !v)}
              className="bg-surface-base px-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              aria-expanded={urlExpanded}
              aria-controls="avatar-url-section"
            >
              {urlExpanded ? '− use an external URL' : '+ or use an external URL'}
            </button>
          </div>
        </div>

        {urlExpanded && (
          <form
            id="avatar-url-section"
            onSubmit={handleSave}
            className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-4"
          >
            <label
              htmlFor="custom-avatar-url"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
            >
              Custom avatar URL
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Point at a Gravatar, GitHub avatar, or other https image. Leave empty
              to clear and fall back to your Google picture.
            </p>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                {livePreviewUrl && previewOk ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={livePreviewUrl}
                    alt=""
                    className="h-10 w-10 rounded-full border border-gray-200 dark:border-border-subtle object-cover"
                    onLoad={() => setPreviewOk(true)}
                    onError={() => setPreviewOk(false)}
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full border border-dashed border-gray-200 dark:border-border-subtle bg-surface-base flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-500">
                    {livePreviewUrl && !previewOk ? 'err' : 'prev'}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <input
                  id="custom-avatar-url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={input}
                  maxLength={MAX_AVATAR_URL_LENGTH + 50}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (inlineError) setInlineError(null);
                    setPreviewOk(true);
                  }}
                  placeholder="https://... — leave empty to clear and use Google's."
                  className={`w-full rounded-md border bg-surface-base px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent ${
                    inlineError
                      ? 'border-red-300 dark:border-red-700'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}
                />
                {inlineError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">{inlineError}</p>
                )}
                {!inlineError && (
                  <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                    Must start with <code className="font-mono">https://</code>, at most{' '}
                    {MAX_AVATAR_URL_LENGTH} characters.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleReset}
                disabled={!dirty || saving}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Reset
              </button>
              <button
                type="submit"
                disabled={!dirty || saving}
                className="rounded-md bg-accent-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
