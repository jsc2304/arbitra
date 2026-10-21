import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSave = vi.fn();
const mockDownload = vi.fn();
const mockGetMetadata = vi.fn();
const mockDelete = vi.fn();
const mockFile = vi.fn(() => ({
  save: mockSave,
  download: mockDownload,
  getMetadata: mockGetMetadata,
  delete: mockDelete,
}));

vi.mock('./storage.js', () => ({
  getBucket: () => ({ file: mockFile }),
}));

import {
  LocalStorageAdapter,
  CloudStorageAdapter,
  getArtifactStorage,
  setArtifactStorage,
  resetArtifactStorage,
  type ArtifactStorageAdapter,
} from './artifact-storage.js';

// ---------------------------------------------------------------------------
// LocalStorageAdapter (unchanged behavior — regression guard)
// ---------------------------------------------------------------------------

describe('LocalStorageAdapter', () => {
  let tmpDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arbitra-artifact-test-'));
    adapter = new LocalStorageAdapter(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and reads back a file as a data URL', async () => {
    const base64 = Buffer.from('hello world').toString('base64');
    const storagePath = await adapter.save('note.txt', 'text/plain', base64);

    expect(storagePath).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-note\.txt$/);

    const dataUrl = await adapter.read(storagePath);
    expect(dataUrl).toBe(`data:text/plain;base64,${base64}`);
  });

  it('sanitises unsafe filename characters', async () => {
    const base64 = Buffer.from('x').toString('base64');
    const storagePath = await adapter.save('a b/c?.png', 'image/png', base64);
    const filenamePart = storagePath.split('/').pop()!;
    expect(filenamePart).not.toMatch(/[ ?]/);
  });

  it('falls back to a generic content type when the .meta sidecar is missing', async () => {
    const base64 = Buffer.from('x').toString('base64');
    const storagePath = await adapter.save('note.txt', 'text/plain', base64);
    // Delete just the sidecar to simulate a pre-existing file without metadata.
    await fs.unlink(path.join(tmpDir, `${storagePath}.meta`));

    const dataUrl = await adapter.read(storagePath);
    expect(dataUrl.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });

  it('delete tolerates a missing file without throwing', async () => {
    await expect(adapter.delete('2026/01/01/missing-file.txt')).resolves.toBeUndefined();
  });

  it('read rejects when the file does not exist', async () => {
    await expect(adapter.read('2026/01/01/missing-file.txt')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CloudStorageAdapter
// ---------------------------------------------------------------------------

describe('CloudStorageAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads bytes with contentType metadata and returns a date-prefixed path', async () => {
    mockSave.mockResolvedValue(undefined);

    const adapter = new CloudStorageAdapter();
    const base64 = Buffer.from('payload').toString('base64');
    const storagePath = await adapter.save('report.pdf', 'application/pdf', base64);

    expect(storagePath).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-report\.pdf$/);
    expect(mockFile).toHaveBeenCalledWith(storagePath);
    expect(mockSave).toHaveBeenCalledWith(
      Buffer.from(base64, 'base64'),
      expect.objectContaining({
        contentType: 'application/pdf',
        metadata: expect.objectContaining({ contentType: 'application/pdf' }),
      }),
    );
  });

  it('sanitises unsafe filename characters the same way as LocalStorageAdapter', async () => {
    mockSave.mockResolvedValue(undefined);

    const adapter = new CloudStorageAdapter();
    const storagePath = await adapter.save('a b/c?.png', 'image/png', Buffer.from('x').toString('base64'));
    const filenamePart = storagePath.split('/').pop()!;
    expect(filenamePart).not.toMatch(/[ ?]/);
  });

  it('reads back a data URL using the content type from object metadata', async () => {
    const buffer = Buffer.from('payload');
    mockDownload.mockResolvedValue([buffer]);
    mockGetMetadata.mockResolvedValue([{ contentType: 'application/pdf' }, {}]);

    const adapter = new CloudStorageAdapter();
    const dataUrl = await adapter.read('2026/08/03/abcd1234-report.pdf');

    expect(dataUrl).toBe(`data:application/pdf;base64,${buffer.toString('base64')}`);
  });

  it('falls back to a generic content type when object metadata omits it', async () => {
    mockDownload.mockResolvedValue([Buffer.from('x')]);
    mockGetMetadata.mockResolvedValue([{}, {}]);

    const adapter = new CloudStorageAdapter();
    const dataUrl = await adapter.read('some/path');

    expect(dataUrl.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });

  it('read propagates an error when the object does not exist', async () => {
    const notFound = Object.assign(new Error('No such object'), { code: 404 });
    mockDownload.mockRejectedValue(notFound);
    mockGetMetadata.mockRejectedValue(notFound);

    const adapter = new CloudStorageAdapter();
    await expect(adapter.read('missing/object')).rejects.toThrow('No such object');
  });

  it('delete tolerates a missing object via ignoreNotFound', async () => {
    mockDelete.mockResolvedValue(undefined);

    const adapter = new CloudStorageAdapter();
    await adapter.delete('missing/object');

    expect(mockFile).toHaveBeenCalledWith('missing/object');
    expect(mockDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
});

// ---------------------------------------------------------------------------
// getArtifactStorage() adapter selection
// ---------------------------------------------------------------------------

describe('getArtifactStorage adapter selection', () => {
  const originalBucket = process.env['GCS_BUCKET'];

  beforeEach(() => {
    resetArtifactStorage();
  });

  afterEach(() => {
    resetArtifactStorage();
    if (originalBucket === undefined) {
      delete process.env['GCS_BUCKET'];
    } else {
      process.env['GCS_BUCKET'] = originalBucket;
    }
  });

  it('selects CloudStorageAdapter when GCS_BUCKET is configured', () => {
    process.env['GCS_BUCKET'] = 'demo-arbitra-artifacts';
    expect(getArtifactStorage()).toBeInstanceOf(CloudStorageAdapter);
  });

  it('falls back to LocalStorageAdapter when GCS_BUCKET is unset', () => {
    delete process.env['GCS_BUCKET'];
    expect(getArtifactStorage()).toBeInstanceOf(LocalStorageAdapter);
  });

  it('caches the selected instance across calls until reset', () => {
    delete process.env['GCS_BUCKET'];
    const first = getArtifactStorage();

    // Changing the env var after the singleton is created must not matter —
    // only resetArtifactStorage() forces re-evaluation.
    process.env['GCS_BUCKET'] = 'now-set';
    const second = getArtifactStorage();

    expect(second).toBe(first);
    expect(second).toBeInstanceOf(LocalStorageAdapter);
  });

  it('setArtifactStorage overrides the singleton regardless of env', () => {
    const fake: ArtifactStorageAdapter = {
      save: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
    };

    process.env['GCS_BUCKET'] = 'demo-arbitra-artifacts';
    setArtifactStorage(fake);

    expect(getArtifactStorage()).toBe(fake);
  });
});
