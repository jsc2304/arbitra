import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBucket } from './storage.js';

/**
 * Storage adapter interface for artifact file storage.
 * v1.0: LocalStorageAdapter (filesystem)
 * v1.1: CloudStorageAdapter (Google Cloud Storage)
 */
export interface ArtifactStorageAdapter {
  /** Save base64-encoded file data. Returns the storage path/key. */
  save(filename: string, contentType: string, base64Data: string): Promise<string>;
  /** Read file content as a data URL. */
  read(storagePath: string): Promise<string>;
  /** Delete a stored file. */
  delete(storagePath: string): Promise<void>;
}

/**
 * Local filesystem storage adapter.
 * Stores files under a configurable directory (default: .arbitra-storage/).
 * Files are organized by date prefix for manageable directory sizes.
 */
export class LocalStorageAdapter implements ArtifactStorageAdapter {
  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath
      ?? process.env['ARBITRA_STORAGE_PATH']
      ?? path.join(process.cwd(), '.arbitra-storage');
  }

  async save(filename: string, contentType: string, base64Data: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const uniqueId = randomUUID().slice(0, 8);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${date}/${uniqueId}-${safeName}`;
    const fullPath = path.join(this.basePath, storagePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Decode base64 and write binary
    const buffer = Buffer.from(base64Data, 'base64');
    await fs.writeFile(fullPath, buffer);

    // Also store content type metadata
    await fs.writeFile(`${fullPath}.meta`, JSON.stringify({ contentType, filename }));

    return storagePath;
  }

  async read(storagePath: string): Promise<string> {
    const fullPath = path.join(this.basePath, storagePath);
    const buffer = await fs.readFile(fullPath);
    const metaPath = `${fullPath}.meta`;

    let contentType = 'application/octet-stream';
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      contentType = meta.contentType ?? contentType;
    } catch {
      // Fallback if no meta file
    }

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  async delete(storagePath: string): Promise<void> {
    const fullPath = path.join(this.basePath, storagePath);
    await fs.unlink(fullPath).catch(() => {});
    await fs.unlink(`${fullPath}.meta`).catch(() => {});
  }
}

/**
 * Google Cloud Storage adapter, backed by the Firebase Admin default bucket
 * (`getBucket()` in `./storage.js`). On Cloud Run the container filesystem
 * is ephemeral, so `LocalStorageAdapter` silently loses artifact bytes
 * whenever an instance is recycled — this adapter persists them in GCS
 * instead.
 *
 * Same path shape as `LocalStorageAdapter` (date prefix + sanitised unique
 * filename) so `storage_path` values stay meaningful regardless of which
 * adapter wrote them. Content type is stored as GCS object metadata rather
 * than a `.meta` sidecar object — there's no filesystem to work around here.
 */
export class CloudStorageAdapter implements ArtifactStorageAdapter {
  async save(filename: string, contentType: string, base64Data: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const uniqueId = randomUUID().slice(0, 8);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${date}/${uniqueId}-${safeName}`;

    const buffer = Buffer.from(base64Data, 'base64');
    await getBucket().file(storagePath).save(buffer, {
      contentType,
      resumable: false,
      metadata: { contentType },
    });

    return storagePath;
  }

  async read(storagePath: string): Promise<string> {
    const file = getBucket().file(storagePath);
    const [[buffer], [metadata]] = await Promise.all([
      file.download(),
      file.getMetadata(),
    ]);

    const contentType = metadata.contentType ?? 'application/octet-stream';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  async delete(storagePath: string): Promise<void> {
    await getBucket().file(storagePath).delete({ ignoreNotFound: true });
  }
}

// Singleton
let adapter: ArtifactStorageAdapter | undefined;

export function getArtifactStorage(): ArtifactStorageAdapter {
  if (!adapter) {
    // With GCS_BUCKET set, artifacts go to Cloud Storage (or the storage
    // emulator when FIREBASE_STORAGE_EMULATOR_HOST is set too). Without it —
    // the local default from `.env.example` and the test setup — they are
    // written under ARBITRA_STORAGE_PATH / `.arbitra-storage/`.
    adapter = process.env['GCS_BUCKET']
      ? new CloudStorageAdapter()
      : new LocalStorageAdapter();
  }
  return adapter;
}

/**
 * Override the storage adapter (useful for testing or to force Cloud Storage
 * in an environment that doesn't set GCS_BUCKET).
 */
export function setArtifactStorage(a: ArtifactStorageAdapter): void {
  adapter = a;
}

/**
 * Clear the cached singleton so the next `getArtifactStorage()` call
 * re-evaluates `GCS_BUCKET` instead of returning a stale adapter. Test-only
 * seam — production code never needs to switch adapters at runtime.
 */
export function resetArtifactStorage(): void {
  adapter = undefined;
}
