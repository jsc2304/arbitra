import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const { checkIsAdmin, checkProjectAccess, requireRole } = vi.hoisted(() => ({
  checkIsAdmin: vi.fn(),
  checkProjectAccess: vi.fn(),
  requireRole: vi.fn(),
}));

// api-helpers.ts imports a few things statically from '@arbitra/backend'
// (authenticateFromHeader, formatError, formatValidationIssues, validateBody)
// and the rest via dynamic `await import('@arbitra/backend')` inside each
// helper — both forms resolve through this same mocked module registration.
vi.mock('@arbitra/backend', () => ({
  authenticateFromHeader: vi.fn(),
  formatError: vi.fn(() => ({ body: { error: { message: 'error' } }, status: 500 })),
  formatValidationIssues: vi.fn(() => []),
  validateBody: vi.fn(),
  checkIsAdmin,
  checkProjectAccess,
  requireRole,
}));

import { formatError } from '@arbitra/backend';
import { handleError, requireProjectScopedRole } from '../api-helpers';

const USER_ID = 'usr_1';
const PROJECT_ID = 'proj_1';
const ROLES = ['tech_lead', 'admin'] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireProjectScopedRole', () => {
  it('admin passes always, without consulting project membership or the role list', async () => {
    checkIsAdmin.mockResolvedValue(true);

    const result = await requireProjectScopedRole(USER_ID, PROJECT_ID, [...ROLES]);

    expect(result).toBeNull();
    expect(checkProjectAccess).not.toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
  });

  it('non-admin holding the global role but not a project member is denied (404)', async () => {
    checkIsAdmin.mockResolvedValue(false);
    checkProjectAccess.mockResolvedValue(false);

    const result = await requireProjectScopedRole(USER_ID, PROJECT_ID, [...ROLES]);

    expect(result).toBeInstanceOf(NextResponse);
    expect(result?.status).toBe(404);
    // Project access is checked before the role gate — a non-member never
    // reaches requireRole (mirrors PR #737's ordering).
    expect(requireRole).not.toHaveBeenCalled();
  });

  it('project member holding one of the required roles passes', async () => {
    checkIsAdmin.mockResolvedValue(false);
    checkProjectAccess.mockResolvedValue(true);
    requireRole.mockResolvedValue(['tech_lead']);

    const result = await requireProjectScopedRole(USER_ID, PROJECT_ID, [...ROLES]);

    expect(result).toBeNull();
    expect(checkProjectAccess).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    expect(requireRole).toHaveBeenCalledWith(USER_ID, [...ROLES]);
  });

  it('project member lacking any of the required roles is denied (403, via requireRole throwing)', async () => {
    checkIsAdmin.mockResolvedValue(false);
    checkProjectAccess.mockResolvedValue(true);
    requireRole.mockRejectedValue(
      Object.assign(new Error('Required role: tech_lead or admin'), { statusCode: 403 }),
    );

    await expect(requireProjectScopedRole(USER_ID, PROJECT_ID, [...ROLES]))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('handleError', () => {
  it('forwards retry headers from the backend error formatter', async () => {
    vi.mocked(formatError).mockReturnValueOnce({
      status: 503,
      headers: { 'Retry-After': '30' },
      body: {
        error: {
          code: 'INDEX_BUILDING',
          message: 'A required database index is still building. Retry shortly.',
        },
      },
    });

    const response = handleError(new Error('private Firestore detail'));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INDEX_BUILDING',
        message: 'A required database index is still building. Retry shortly.',
      },
    });
  });
});
