import { NextRequest, NextResponse } from 'next/server';
import type { Repository } from '@arbitra/shared';
import { authenticate, handleError, requireProjectAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * Strip or mask sensitive fields before returning repository data. The stored
 * token is encrypted (see `sealSecret`), so the mask only signals presence.
 */
function sanitizeRepo(repo: Repository): Repository {
  const { github_token, ...rest } = repo;
  return {
    ...rest,
    ...(github_token ? { github_token: '••••' } : {}),
  };
}

/**
 * Row-count bound of the uniqueness scan below (issue #1059 item 2). Kept as
 * a named constant (not just the literal `200`) so the "did we hit the cap"
 * check reads as the SAME number the query is bounded by, not a coincidence.
 */
const REPOSITORY_SCAN_LIMIT = 200;

/**
 * Registration-time format guard (issue #1059 item 3). `url` used to be
 * stored after `.trim()` only, with no check that it could ever match a
 * GitHub webhook delivery — a typo (`guthub.com/owner/repo`) or a
 * non-GitHub host was silently accepted, then produced a silent no-match at
 * webhook time. EVERY no-match
 * exit in the webhook publishes `arbitra/case: success` — so this was not a
 * visible error, it was a governance bypass wearing a green checkmark.
 *
 * Reuses the exact `parseRepoRef` + `GITHUB_HOST` the webhook step-3
 * resolver applies, so "this registers" and "this can ever resolve" can
 * never disagree. Returns an error message, or `null` when the url is fine.
 */
async function validateRepositoryUrlFormat(url: string): Promise<string | null> {
  const { parseRepoRef, GITHUB_HOST } = await import('@arbitra/backend');
  const parsed = parseRepoRef(url);
  if (!parsed) {
    return `url '${url}' does not resolve to a github.com owner/repo — `
      + `use e.g. https://github.com/<owner>/<repo>`;
  }
  if (parsed.host !== GITHUB_HOST) {
    return `url '${url}' resolves to host '${parsed.host}', but the webhook only ever `
      + `delivers for ${GITHUB_HOST} — this repository could never receive a webhook match`;
  }
  return null;
}

/**
 * Finds an existing Arbitra repository row whose `url` resolves (via
 * `parseRepoRef`) to the same repository as `candidateUrl` — the
 * registration-time counterpart to the uniqueness the webhook-side step-3
 * resolver now depends on (issue #1048 follow-up F2). Before this, only
 * `github_repository_id` was enforced unique at registration; `url` was
 * not, so registering the same repo twice created two rows that step 3
 * could only ever treat as ambiguous — reachable through ordinary use, not
 * an edge case. Scoped globally, not per-project: step 3 scans ALL
 * repositories without a project filter, so a duplicate in a DIFFERENT
 * project creates exactly the same routing ambiguity as one in the same
 * project. `excludeRepositoryId` lets PATCH check a url change without the
 * row being edited matching against itself.
 *
 * `scanBoundExceeded` (issue #1059 item 2): the scan reads at most
 * `REPOSITORY_SCAN_LIMIT` rows. When the collection has AT LEAST that many
 * rows, rows past the cap are never read, so `conflict === null` no longer
 * means "verified unique" — it means "no conflict found among the rows we
 * looked at". Previously nothing signalled this: the guard silently stopped
 * guaranteeing what it claimed. The caller must treat `scanBoundExceeded`
 * as "cannot verify" and fail closed, not as a pass.
 */
async function findConflictingRepositoryByUrl(
  candidateUrl: string,
  excludeRepositoryId?: string,
): Promise<{ conflict: Repository | null; scanBoundExceeded: boolean }> {
  const { collections, parseRepoRef, sameRepoRef } = await import('@arbitra/backend');
  const candidateRef = parseRepoRef(candidateUrl);
  if (!candidateRef) return { conflict: null, scanBoundExceeded: false }; // Unparseable url: nothing to compare against, same as the webhook matcher.

  const snapshot = await collections.repositories().limit(REPOSITORY_SCAN_LIMIT).get();
  const scanBoundExceeded = snapshot.docs.length >= REPOSITORY_SCAN_LIMIT;
  const conflict = snapshot.docs.find((doc) => {
    const data = doc.data();
    if (excludeRepositoryId && data.repository_id === excludeRepositoryId) return false;
    return sameRepoRef(parseRepoRef(data.url), candidateRef);
  });
  return { conflict: conflict ? conflict.data() : null, scanBoundExceeded };
}

export async function GET(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireProjectAccess(params.projectId, auth.userId);
    if (denied) return denied;
    const { collections } = await import('@arbitra/backend');
    const snapshot = await collections.repositories()
      .where('project_id', '==', params.projectId)
      .get();
    const repositories = snapshot.docs.map((doc) => sanitizeRepo(doc.data()));
    return NextResponse.json({ repositories });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireProjectAccess(params.projectId, auth.userId);
    if (denied) return denied;
    const body = await request.json();
    if (!body.name?.trim()) {
      return NextResponse.json(
        { error: { message: 'Repository name is required' } },
        { status: 400 },
      );
    }

    // Optional immutable GitHub numeric id. Must map to at most one Arbitra
    // repository — two rows sharing it would both match (and double-process)
    // every webhook event from that GitHub repo (see issue #628).
    const githubRepositoryId =
      body.github_repository_id === undefined || body.github_repository_id === null
        ? undefined
        : Number(body.github_repository_id);
    if (githubRepositoryId !== undefined && !Number.isInteger(githubRepositoryId)) {
      return NextResponse.json(
        { error: { message: 'github_repository_id must be an integer' } },
        { status: 400 },
      );
    }

    const { collections, generateId, sealSecret } = await import('@arbitra/backend');

    if (githubRepositoryId !== undefined) {
      const existing = await collections.repositories()
        .where('github_repository_id', '==', githubRepositoryId)
        .limit(1)
        .get();
      if (!existing.empty) {
        const existingRepoId = existing.docs[0]!.data().repository_id;
        return NextResponse.json(
          {
            error: {
              message:
                `github_repository_id ${githubRepositoryId} is already attached to `
                + `Arbitra repository ${existingRepoId}`,
              existing_repository_id: existingRepoId,
              github_repository_id: githubRepositoryId,
            },
          },
          { status: 409 },
        );
      }
    }

    // `url` format (issue #1059 item 3) — reject a url that can never
    // resolve to a GitHub webhook delivery BEFORE checking uniqueness,
    // rather than storing it and letting it fail silently at webhook time.
    const urlValue = body.url?.trim() ?? '';
    if (urlValue) {
      const formatError = await validateRepositoryUrlFormat(urlValue);
      if (formatError) {
        return NextResponse.json({ error: { message: formatError } }, { status: 400 });
      }
    }

    // `url` uniqueness (issue #1048 follow-up F2) — same discipline as
    // `github_repository_id` above, so a duplicate registration can never
    // reach the webhook's step-3 ambiguity path in the first place.
    if (urlValue) {
      const { conflict: conflictingRepo, scanBoundExceeded } = await findConflictingRepositoryByUrl(urlValue);
      // Fail closed (issue #1059 item 2): past the scan bound the guard can
      // no longer prove uniqueness, so refuse rather than silently register
      // a row that might duplicate one outside the scanned page.
      if (scanBoundExceeded) {
        return NextResponse.json(
          {
            error: {
              message:
                `Cannot verify this url is unique: the repository-uniqueness scan reached its `
                + `${REPOSITORY_SCAN_LIMIT}-row bound, so rows beyond it were never checked. `
                + `Registration is refused until this is resolved (deduplicate existing rows or `
                + `raise the scan bound) — a silent pass here would be a governance bypass, not a fix.`,
              code: 'repository_scan_bound_exceeded',
            },
          },
          { status: 503 },
        );
      }
      if (conflictingRepo) {
        return NextResponse.json(
          {
            error: {
              message:
                `url resolves to the same repository as the already-registered `
                + `Arbitra repository ${conflictingRepo.repository_id}`,
              existing_repository_id: conflictingRepo.repository_id,
              url: urlValue,
            },
          },
          { status: 409 },
        );
      }
    }

    const now = new Date().toISOString();
    const repo: Repository = {
      repository_id: generateId('repository'),
      project_id: params.projectId,
      name: body.name.trim(),
      url: urlValue,
      provider: body.provider ?? 'github',
      ...(body.github_token?.trim() ? { github_token: sealSecret(body.github_token.trim()) } : {}),
      ...(githubRepositoryId !== undefined ? { github_repository_id: githubRepositoryId } : {}),
      created_at: now,
      updated_at: now,
    };

    await collections.repositories().doc(repo.repository_id).set(repo);
    return NextResponse.json(sanitizeRepo(repo), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  const { searchParams } = new URL(request.url);
  const repoId = searchParams.get('repoId');
  if (!repoId) {
    return NextResponse.json(
      { error: { message: 'repoId query parameter is required' } },
      { status: 400 },
    );
  }

  try {
    const auth = await authenticate(request);
    const denied = await requireProjectAccess(params.projectId, auth.userId);
    if (denied) return denied;
    const body = await request.json();

    const { collections } = await import('@arbitra/backend');
    const ref = collections.repositories().doc(repoId);
    const doc = await ref.get();
    // `repoId` comes from a query param, not the
    // path — without this check a member of ANY project could pass another
    // project's repoId here and PATCH a `github_token`-bearing resource they
    // have no access to (IDOR). `requireProjectAccess` above only proves
    // membership of `params.projectId`, not that the repo actually belongs
    // to it.
    if (!doc.exists || doc.data()!.project_id !== params.projectId) {
      return NextResponse.json({ error: { message: 'Repository not found' } }, { status: 404 });
    }

    // `url` format + uniqueness (issue #1059 item 3 / #1048 follow-up F2) —
    // same checks as POST, applied here too: without them, PATCH is a
    // trivial bypass of the POST guards (register normally, then edit the
    // url to a malformed or colliding one).
    if (body.url !== undefined) {
      const urlValue = typeof body.url === 'string' ? body.url.trim() : '';
      if (urlValue) {
        const formatError = await validateRepositoryUrlFormat(urlValue);
        if (formatError) {
          return NextResponse.json({ error: { message: formatError } }, { status: 400 });
        }

        const { conflict: conflictingRepo, scanBoundExceeded } = await findConflictingRepositoryByUrl(urlValue, repoId);
        // Fail closed (issue #1059 item 2) — see POST for the full rationale.
        if (scanBoundExceeded) {
          return NextResponse.json(
            {
              error: {
                message:
                  `Cannot verify this url is unique: the repository-uniqueness scan reached its `
                  + `${REPOSITORY_SCAN_LIMIT}-row bound, so rows beyond it were never checked. `
                  + `This update is refused until this is resolved (deduplicate existing rows or `
                  + `raise the scan bound) — a silent pass here would be a governance bypass, not a fix.`,
                code: 'repository_scan_bound_exceeded',
              },
            },
            { status: 503 },
          );
        }
        if (conflictingRepo) {
          return NextResponse.json(
            {
              error: {
                message:
                  `url resolves to the same repository as the already-registered `
                  + `Arbitra repository ${conflictingRepo.repository_id}`,
                existing_repository_id: conflictingRepo.repository_id,
                url: urlValue,
              },
            },
            { status: 409 },
          );
        }
      }
    }

    // Only allow updating safe fields
    const safeFields: Record<string, unknown> = {};
    if (body.name !== undefined) safeFields.name = body.name;
    if (body.url !== undefined) safeFields.url = body.url;
    if (body.provider !== undefined) safeFields.provider = body.provider;
    if (body.github_token !== undefined) {
      if (typeof body.github_token !== 'string' || body.github_token.trim() === '••••') {
        return NextResponse.json(
          { error: { message: 'github_token must be a token string, or empty to clear it' } },
          { status: 400 },
        );
      }
      if (body.github_token.trim()) {
        const { sealSecret } = await import('@arbitra/backend');
        safeFields.github_token = sealSecret(body.github_token.trim());
      } else {
        // Empty string clears the token
        const { FieldValue } = await import('firebase-admin/firestore');
        safeFields.github_token = FieldValue.delete();
      }
    }
    safeFields.updated_at = new Date().toISOString();

    await ref.update(safeFields);
    const updated = await ref.get();
    return NextResponse.json(sanitizeRepo(updated.data()!));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params;
  try {
    const auth = await authenticate(request);
    const denied = await requireProjectAccess(params.projectId, auth.userId);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const repoId = searchParams.get('repoId');
    if (!repoId) {
      return NextResponse.json(
        { error: { message: 'repoId query parameter is required' } },
        { status: 400 },
      );
    }

    const { collections } = await import('@arbitra/backend');
    const ref = collections.repositories().doc(repoId);
    const doc = await ref.get();
    // Same IDOR as PATCH above — verify the repo
    // actually belongs to `params.projectId` before deleting it, not just
    // that the caller has access to *some* project.
    if (!doc.exists || doc.data()!.project_id !== params.projectId) {
      return NextResponse.json({ error: { message: 'Repository not found' } }, { status: 404 });
    }
    await ref.delete();
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleError(error);
  }
}
