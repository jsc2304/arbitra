import { describe, it, expect } from 'vitest';
import { classifyRunFailure, retryBackoffMs, RUN_RETRY_BACKOFF_MS } from './run-retry-policy.js';

describe('classifyRunFailure', () => {
  it('classifies undefined/empty error messages as permanent (fail-closed default)', () => {
    expect(classifyRunFailure(undefined)).toBe('permanent');
    expect(classifyRunFailure(null)).toBe('permanent');
    expect(classifyRunFailure('')).toBe('permanent');
  });

  it('classifies timeouts as transient', () => {
    expect(classifyRunFailure('Request timeout after 30000ms')).toBe('transient');
    expect(classifyRunFailure('The operation timed out')).toBe('transient');
  });

  it('classifies network error codes as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) {
      expect(classifyRunFailure(`fetch failed: ${code}`)).toBe('transient');
    }
  });

  it('classifies HTTP 5xx and 429 as transient', () => {
    expect(classifyRunFailure('Request failed with status code 503')).toBe('transient');
    expect(classifyRunFailure('Upstream returned 500 Internal Server Error')).toBe('transient');
    expect(classifyRunFailure('429 Too Many Requests')).toBe('transient');
    expect(classifyRunFailure('rate limit exceeded, please retry')).toBe('transient');
  });

  it('classifies lease-expiry / sweep verdicts as transient', () => {
    expect(classifyRunFailure('Run lease expired (worker likely terminated mid-execution) — swept by stale-run sweeper')).toBe('transient');
    expect(classifyRunFailure('Run has no lease and exceeded the legacy max age — swept by stale-run sweeper')).toBe('transient');
  });

  it('classifies validation/permission/malformed-input errors as permanent', () => {
    expect(classifyRunFailure('Validation failed: missing required field case_id')).toBe('permanent');
    expect(classifyRunFailure('403 Forbidden — insufficient permissions')).not.toBe('transient');
    expect(classifyRunFailure('Malformed diff: could not parse hunk header')).toBe('permanent');
    expect(classifyRunFailure('No executor for run type: build_run')).toBe('permanent');
  });

  it('classifies an unrecognized error message as permanent (conservative default)', () => {
    expect(classifyRunFailure('Something completely unexpected happened')).toBe('permanent');
  });
});

describe('retryBackoffMs', () => {
  it('returns the configured backoff steps in order', () => {
    expect(retryBackoffMs(0)).toBe(RUN_RETRY_BACKOFF_MS[0]);
    expect(retryBackoffMs(1)).toBe(RUN_RETRY_BACKOFF_MS[1]);
  });

  it('clamps to the last configured step beyond the array length', () => {
    expect(retryBackoffMs(5)).toBe(RUN_RETRY_BACKOFF_MS[RUN_RETRY_BACKOFF_MS.length - 1]);
  });

  it('clamps negative input to the first step', () => {
    expect(retryBackoffMs(-1)).toBe(RUN_RETRY_BACKOFF_MS[0]);
  });
});
