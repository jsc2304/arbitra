import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ARBITRA_BUILD,
  ARBITRA_STAGE,
  ARBITRA_SPEC_VERSION,
  ARBITRA_API_VERSION,
} from '@arbitra/shared';
import { GET } from './route';

describe('GET /api/version', () => {
  const originalSha = process.env.BUILD_COMMIT_SHA;
  const originalDeployed = process.env.BUILD_DEPLOYED_AT;
  const originalPausedSchedulers = process.env.ARBITRA_PAUSED_SCHEDULERS;

  beforeEach(() => {
    delete process.env.BUILD_COMMIT_SHA;
    delete process.env.BUILD_DEPLOYED_AT;
    delete process.env.ARBITRA_PAUSED_SCHEDULERS;
  });

  afterEach(() => {
    if (originalSha === undefined) delete process.env.BUILD_COMMIT_SHA;
    else process.env.BUILD_COMMIT_SHA = originalSha;
    if (originalDeployed === undefined) delete process.env.BUILD_DEPLOYED_AT;
    else process.env.BUILD_DEPLOYED_AT = originalDeployed;
    if (originalPausedSchedulers === undefined) delete process.env.ARBITRA_PAUSED_SCHEDULERS;
    else process.env.ARBITRA_PAUSED_SCHEDULERS = originalPausedSchedulers;
  });

  it('returns build metadata from shared constants', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      build: ARBITRA_BUILD,
      stage: ARBITRA_STAGE,
      spec: ARBITRA_SPEC_VERSION,
      api: ARBITRA_API_VERSION,
    });
  });

  it('falls back to "unknown" / null when build env vars are absent', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.commit).toBe('unknown');
    expect(body.deployed_at).toBeNull();
  });

  it('reflects BUILD_COMMIT_SHA and BUILD_DEPLOYED_AT when set', async () => {
    process.env.BUILD_COMMIT_SHA = 'abc1234';
    process.env.BUILD_DEPLOYED_AT = '2026-04-26T10:00:00.000Z';
    const res = await GET();
    const body = await res.json();
    expect(body.commit).toBe('abc1234');
    expect(body.deployed_at).toBe('2026-04-26T10:00:00.000Z');
  });

  it('returns an empty paused_schedulers array when ARBITRA_PAUSED_SCHEDULERS is unset (prod / not paused)', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.paused_schedulers).toEqual([]);
  });

  it('parses ARBITRA_PAUSED_SCHEDULERS into paused_schedulers when set (dev, paused)', async () => {
    process.env.ARBITRA_PAUSED_SCHEDULERS = 'run_sweeper,blueprint_tick,intelligence';
    const res = await GET();
    const body = await res.json();
    expect(body.paused_schedulers).toEqual([
      'run_sweeper',
      'blueprint_tick',
      'intelligence',
    ]);
  });
});
