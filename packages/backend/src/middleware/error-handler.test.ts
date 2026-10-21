import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArbitraError } from '@arbitra/shared';
import { formatError } from './error-handler.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatError', () => {
  /**
   * Any `ArbitraError`'s own `statusCode` passes straight through, so a
   * service can fail closed with a 503 and its own code without any route
   * needing its own mapping code. Reverting `formatError`'s
   * `error instanceof ArbitraError` branch to ignore `error.statusCode` (e.g.
   * hardcoding 400 or 500) makes this fail.
   */
  it('maps an ArbitraError straight through to its own status and code', () => {
    const error = new ArbitraError('dependency is not configured', 'DEPENDENCY_UNAVAILABLE', 503);

    const response = formatError(error);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('returns a retryable response only while a required Firestore index is building', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = Object.assign(
      new Error(
        '9 FAILED_PRECONDITION: The query requires an index. '
        + 'That index is currently building and cannot be used yet. '
        + 'https://console.firebase.google.com/private-index-definition',
      ),
      { code: 9 },
    );

    expect(formatError(error)).toEqual({
      status: 503,
      headers: { 'Retry-After': '30' },
      body: {
        error: {
          code: 'INDEX_BUILDING',
          message: 'A required database index is still building. Retry shortly.',
        },
      },
    });
    expect(log).toHaveBeenCalledWith(
      'Firestore index is still building; returning a retryable response:',
      error.message,
      error.stack,
    );
  });

  it('keeps a missing index loud and does not expose its driver message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message = '9 FAILED_PRECONDITION: The query requires an index. Create it at https://private.example';
    const error = Object.assign(new Error(message), { code: 9 });

    expect(formatError(error)).toEqual({
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
        },
      },
    });
    expect(log).toHaveBeenCalledWith('Unhandled error:', message, error.stack);
  });

  it('logs an arbitrary unhandled error but returns only a fixed public message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('secret dependency detail');

    const response = formatError(error);

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(response)).not.toContain('secret dependency detail');
    expect(log).toHaveBeenCalledWith('Unhandled error:', error.message, error.stack);
  });
});
