import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateFromHeader,
  formatError,
  formatValidationIssues,
  validateBody,
} from '@arbitra/backend';
import type { AuthenticatedRequest } from '@arbitra/backend';
import { UnauthorizedError } from '@arbitra/shared';
import type { UserRole } from '@arbitra/shared';
import type { ZodSchema, ZodIssue } from 'zod';

export async function authenticate(request: NextRequest): Promise<AuthenticatedRequest> {
  const authHeader = request.headers.get('authorization');
  return authenticateFromHeader(authHeader);
}

/**
 * Authenticate for export endpoints — accepts token via query param
 * (needed for mobile Safari where window.open() can't set Authorization headers).
 */
export async function authenticateExport(
  request: NextRequest,
  queryToken: string | null,
): Promise<AuthenticatedRequest> {
  // Prefer Authorization header, fall back to a query-param token for
  // EventSource and download links, which cannot set headers. Only short-lived
  // Firebase ID tokens are accepted there: a long-lived `arb_` access token in
  // a URL would end up in proxy logs and browser history.
  const header = request.headers.get('authorization');
  if (!header && queryToken?.startsWith('arb_')) {
    throw new UnauthorizedError('Access tokens must be sent in the Authorization header');
  }
  const authHeader = header ?? (queryToken ? `Bearer ${queryToken}` : null);
  return authenticateFromHeader(authHeader);
}

export function handleError(error: unknown): NextResponse {
  const formatted = formatError(error);
  return NextResponse.json(formatted.body, {
    status: formatted.status,
    headers: formatted.headers,
  });
}

export function validate<T>(schema: ZodSchema<T>, body: unknown): T {
  return validateBody(schema, body);
}

export function validationErrorResponse(message: string, issues: readonly ZodIssue[]): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message,
        details: {
          issues: formatValidationIssues(issues),
        },
      },
    },
    { status: 400 },
  );
}

export function invalidJsonResponse(message = 'Request body must be valid JSON'): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'INVALID_JSON',
        message,
      },
    },
    { status: 400 },
  );
}

function notFound() {
  return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
}

/** Returns a 404 response if the user cannot access the case's project. */
export async function requireCaseAccess(caseId: string, userId: string): Promise<NextResponse | null> {
  const { checkCaseAccess } = await import('@arbitra/backend');
  return (await checkCaseAccess(caseId, userId)) ? null : notFound();
}

/**
 * Returns a response if the caller may not read an artifact's decoded
 * content, `null` if they may. HTTP shape for `checkArtifactCaseAccess`
 * (`@arbitra/backend`, `lib/project-access.ts`) — see that function for the
 * requester-only policy this enforces on `assistant_task` cases. A denial for
 * that reason is a 403 with a distinct code (the caller already knows the
 * case exists and is a Clerk task, so there is nothing to hide behind a 404);
 * every other denial keeps the generic case-access 404.
 */
export async function requireArtifactCaseAccess(caseId: string, userId: string): Promise<NextResponse | null> {
  const { checkArtifactCaseAccess } = await import('@arbitra/backend');
  const decision = await checkArtifactCaseAccess(caseId, userId);
  if (decision === 'allowed') return null;
  if (decision === 'requester_only') {
    return NextResponse.json(
      {
        error: {
          code: 'ASSISTANT_ARTIFACT_REQUESTER_ONLY',
          message: 'Only the Clerk requester can view this answer.',
        },
      },
      { status: 403 },
    );
  }
  return notFound();
}

/** Returns a 404 response if the user cannot access the project. */
export async function requireProjectAccess(projectId: string, userId: string): Promise<NextResponse | null> {
  const { checkProjectAccess } = await import('@arbitra/backend');
  return (await checkProjectAccess(projectId, userId)) ? null : notFound();
}

/**
 * Layered project-scoped role check for the governance routes (rules / rule-sets,
 * evidence-policies): a caller must either be an admin, or
 * hold one of `roles` globally AND be an effective member / tech_lead of
 * `projectId`. Generalizes the inline pattern `api/rules/overrides/route.ts`
 * (PR #737) uses for its project-scoped branch — project access is checked
 * before the role gate so a non-member gets the same 404 (not 403) a
 * project-scoped `requireProjectAccess` call would give, avoiding leaking
 * whether the project exists to a caller who isn't on it.
 *
 * Admins short-circuit before either check (matches `checkProjectAccess`'s
 * own internal admin bypass, made explicit here so admin access doesn't
 * depend on `roles` happening to include `'admin'`).
 *
 * Returns a `NextResponse` (404) or `null`, matching `requireProjectAccess`'s
 * style. Note: like `requireRole` itself, this can also *throw*
 * `ForbiddenError` (403) when the caller fails the role check — callers
 * already wrap route handlers in try/catch → `handleError`, so no new
 * catch is needed at call sites (mirrors how `requireRole` is used today
 * alongside `requireProjectAccess` in `rules/overrides/route.ts`).
 */
export async function requireProjectScopedRole(
  userId: string,
  projectId: string,
  roles: UserRole[],
): Promise<NextResponse | null> {
  const { checkIsAdmin, requireRole } = await import('@arbitra/backend');

  if (await checkIsAdmin(userId)) return null;

  const denied = await requireProjectAccess(projectId, userId);
  if (denied) return denied;

  await requireRole(userId, roles);

  return null;
}
