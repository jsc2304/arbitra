/**
 * GET /api/projects/match?repo_url=… — find projects whose registered
 * repositories match a canonicalized git remote URL.
 *
 * Used by the `/connect` page to pre-select the right project when the IDE
 * has handed us the user's `git remote get-url origin`. Cheap path uses the
 * `repositories.github_full_name` field (set by the webhook pipeline); the
 * fallback substring scan handles legacy / self-hosted git hosts. Both are
 * bounded by membership: we only return projects the caller can access.
 *
 * See `docs/specs/device-flow-and-per-tool-tokens.md` §B.3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import type { Project, Repository } from '@arbitra/shared';
import { canonicalizeRepoUrl } from '../../auth/connect/_helpers';

export const dynamic = 'force-dynamic';

/** Cap on the substring fallback scan — protects against runaway reads. */
const FALLBACK_SCAN_LIMIT = 500;

interface MatchEntry {
  project_id: string;
  project_name: string;
  repositories: Array<{ repository_id: string; url: string; name: string }>;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authenticate(request);
    const { searchParams } = new URL(request.url);
    const rawRepoUrl = searchParams.get('repo_url');
    if (!rawRepoUrl?.trim()) {
      return NextResponse.json(
        { error: { message: 'repo_url query parameter is required' } },
        { status: 400 },
      );
    }

    const canonical = canonicalizeRepoUrl(rawRepoUrl);

    const { collections, checkIsAdmin, isEffectiveMember } = await import('@arbitra/backend');

    // Resolve membership upfront so we can filter every candidate row
    // without repeated project lookups.
    const isAdmin = await checkIsAdmin(auth.userId);
    const projectsSnap = await collections.projects().get();
    const allProjects = projectsSnap.docs.map((d) => d.data());
    const visibleProjectIds = new Set<string>(
      isAdmin
        ? allProjects.map((p) => p.project_id)
        : allProjects.filter((p) => isEffectiveMember(p, auth.userId)).map((p) => p.project_id),
    );
    const projectsById = new Map<string, Project>(allProjects.map((p) => [p.project_id, p]));

    // Pass 1: cheap indexed match by github_full_name. We try a few
    // case-variants (lowercase + as-given) because `github_full_name` is
    // stored as the GitHub-display-case slug. A future migration adds a
    // canonical lowercased mirror; until then we fan out.
    let matches: Repository[] = [];
    if (canonical && canonical.host === 'github.com') {
      const candidates = new Set<string>([canonical.slug]);
      // Common GitHub-display variants: lowercase slug + as-typed slug from
      // the original input (if differs).
      const parts = canonical.slug.split('/');
      if (parts.length === 2) {
        // No-op — slug already lowercased; we keep this in case we widen later.
      }

      for (const candidate of candidates) {
        const snap = await collections.repositories()
          .where('github_full_name', '==', candidate)
          .limit(50)
          .get();
        if (!snap.empty) {
          for (const d of snap.docs) matches.push(d.data());
        }
      }

      // Some legacy rows have `github_full_name` in display case rather than
      // lowercase. Do a case-insensitive client-side rescue (bounded) when
      // the indexed lookup returned nothing.
      if (matches.length === 0) {
        const allReposSnap = await collections.repositories()
          .limit(FALLBACK_SCAN_LIMIT)
          .get();
        for (const d of allReposSnap.docs) {
          const data = d.data();
          if (data.github_full_name && data.github_full_name.toLowerCase() === canonical.slug) {
            matches.push(data);
          }
        }
      }
    }

    // Pass 2: substring fallback for self-hosted / GitLab / Bitbucket.
    if (matches.length === 0) {
      const fallbackSnap = await collections.repositories()
        .limit(FALLBACK_SCAN_LIMIT)
        .get();
      const needle = canonical ? `${canonical.host}/${canonical.slug}` : rawRepoUrl.toLowerCase();
      for (const d of fallbackSnap.docs) {
        const data = d.data();
        const url = (data.url ?? '').toLowerCase();
        if (!url) continue;
        if (url.includes(needle)) {
          matches.push(data);
          continue;
        }
        // Try canonicalizing the stored URL and comparing slug equality.
        if (canonical) {
          const storedCanonical = canonicalizeRepoUrl(data.url);
          if (
            storedCanonical
            && storedCanonical.host === canonical.host
            && storedCanonical.slug === canonical.slug
          ) {
            matches.push(data);
          }
        }
      }
    }

    // Deduplicate repositories then group by project. A user can register
    // the same repo under multiple projects (rare); the response lists each
    // matching project with the repository rows that hit.
    const grouped = new Map<string, MatchEntry>();
    const seenRepoIds = new Set<string>();
    for (const repo of matches) {
      if (seenRepoIds.has(repo.repository_id)) continue;
      seenRepoIds.add(repo.repository_id);
      if (!visibleProjectIds.has(repo.project_id)) continue;
      const project = projectsById.get(repo.project_id);
      if (!project) continue;
      let entry = grouped.get(repo.project_id);
      if (!entry) {
        entry = {
          project_id: project.project_id,
          project_name: project.name,
          repositories: [],
        };
        grouped.set(repo.project_id, entry);
      }
      entry.repositories.push({
        repository_id: repo.repository_id,
        url: repo.url,
        name: repo.name,
      });
    }

    return NextResponse.json({ matches: [...grouped.values()] });
  } catch (error) {
    return handleError(error);
  }
}
