import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { matchesAllWordPrefixes } from '@/lib/docs-search-index';
import type { SearchResult } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = request.nextUrl.searchParams.get('q')?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ query: q ?? '', results: [], total: 0 });
  }

  try {
    const auth = await authenticate(request);
    const { collections, checkIsAdmin, getAccessibleProjectIds } = await import('@arbitra/backend');
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    if (words.length === 0) {
      return NextResponse.json({ query: q, results: [], total: 0 });
    }
    const results: SearchResult[] = [];

    // Build accessible project set for non-admins
    const admin = await checkIsAdmin(auth.userId);
    let accessibleProjectIds: Set<string> | null = null;
    if (!admin) {
      const ids = await getAccessibleProjectIds(auth.userId, false);
      if (ids !== 'all') accessibleProjectIds = new Set(ids);
    }

    // Build accessible case IDs (needed for filtering findings/comments)
    const casesSnap = await collections.activeCases().limit(500).get();
    const accessibleCaseIds = new Set<string>();
    for (const doc of casesSnap.docs) {
      const c = doc.data();
      if (accessibleProjectIds && !accessibleProjectIds.has(c.project_id)) continue;
      accessibleCaseIds.add(c.case_id);
      if (matchesAllWordPrefixes(`${c.title} ${c.description}`, words)) {
        results.push({
          type: 'case',
          id: c.case_id,
          case_id: c.case_id,
          title: c.title,
          snippet: c.description.slice(0, 150),
          meta: { status: c.status, risk_level: c.risk_level },
        });
      }
    }

    // Search findings (filtered by accessible cases)
    const findingsSnap = await collections.findings().limit(500).get();
    for (const doc of findingsSnap.docs) {
      const f = doc.data();
      if (!accessibleCaseIds.has(f.case_id)) continue;
      if (matchesAllWordPrefixes(`${f.title} ${f.description}`, words)) {
        results.push({
          type: 'finding',
          id: f.finding_id,
          case_id: f.case_id,
          title: f.title,
          snippet: f.description.slice(0, 150),
          meta: { severity: f.severity, status: f.status },
        });
      }
    }

    // Search comments (filtered by accessible cases)
    const commentsSnap = await collections.comments().limit(500).get();
    for (const doc of commentsSnap.docs) {
      const cm = doc.data();
      const caseId = cm.parent_type === 'case' ? cm.parent_id : '';
      if (caseId && !accessibleCaseIds.has(caseId)) continue;
      if (matchesAllWordPrefixes(cm.body, words)) {
        results.push({
          type: 'comment',
          id: cm.comment_id,
          case_id: caseId,
          title: cm.body.slice(0, 80),
          snippet: cm.body.slice(0, 150),
        });
      }
    }

    return NextResponse.json({ query: q, results: results.slice(0, 20), total: results.length });
  } catch (error) {
    return handleError(error);
  }
}
