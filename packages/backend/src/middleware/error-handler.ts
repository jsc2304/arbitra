import { ArbitraError } from '@arbitra/shared';
import { ZodError } from 'zod';
import { formatValidationIssues } from './validation-issues.js';

export interface ErrorResponse {
  status: number;
  headers?: Record<string, string>;
  body: {
    error: {
      code: string;
      message: string;
      details?: unknown;
    };
  };
}

const FIRESTORE_FAILED_PRECONDITION = 9;
const BUILDING_INDEX_RETRY_AFTER_SECONDS = 30;

/**
 * Firestore uses the same FAILED_PRECONDITION status for a missing index and
 * for an index that already exists but is still building. Only the latter can
 * heal without a deploy, so keep this deliberately narrower than a generic
 * code-9 check.
 */
function isBuildingFirestoreIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const isFailedPrecondition = code === FIRESTORE_FAILED_PRECONDITION
    || /^9 FAILED_PRECONDITION\b/i.test(message);

  return isFailedPrecondition
    && /requires an index/i.test(message)
    && /currently building/i.test(message);
}

export function formatError(error: unknown): ErrorResponse {
  if (error instanceof ArbitraError) {
    return {
      status: error.statusCode,
      body: error.toJSON() as ErrorResponse['body'],
    };
  }

  // Duck-type check for ZodError (instanceof can fail across bundle boundaries)
  if (error instanceof ZodError || (error instanceof Error && 'issues' in error && Array.isArray((error as ZodError).issues))) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request payload',
          details: { issues: formatValidationIssues((error as ZodError).issues) },
        },
      },
    };
  }

  if (isBuildingFirestoreIndexError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.warn(
      'Firestore index is still building; returning a retryable response:',
      message,
      stack,
    );
    return {
      status: 503,
      headers: {
        'Retry-After': String(BUILDING_INDEX_RETRY_AFTER_SECONDS),
      },
      body: {
        error: {
          code: 'INDEX_BUILDING',
          message: 'A required database index is still building. Retry shortly.',
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error('Unhandled error:', message, stack);

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    },
  };
}
