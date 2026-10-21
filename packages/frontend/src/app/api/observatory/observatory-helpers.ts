import type {
  Case,
  Decision,
  Finding,
  KnowledgeAsset,
  KnowledgeStatus,
  KnowledgeType,
  Project,
  Repository,
  Run,
  User,
} from '@arbitra/shared';

export interface TopReferencedAsset {
  knowledge_id: string;
  title: string;
  type: KnowledgeType;
  status: KnowledgeStatus;
  reference_count: number;
}

/**
 * Aggregate knowledge asset references across decisions with per-case dedup.
 *
 * Why per-case dedup: Decision.snapshot.knowledge_asset_refs is copied from
 * Case.knowledge_context_refs at decision creation (see
 * decision-service.ts:47), so every decision in a given case inherits the
 * same set of refs. Counting raw refs would inflate counts by the number of
 * decisions per case. Instead, for each (case_id, asset_id) pair we increment
 * the asset counter by at most +1, producing an honest "N cases attached
 * this asset" metric.
 *
 * Orphan refs — asset IDs found in decision snapshots but no longer present
 * in `knowledgeAssets` (e.g. asset was deleted) — are silently excluded.
 *
 * @param decisions        Raw Decision[] from Firestore
 * @param knowledgeAssets  Raw KnowledgeAsset[] from Firestore (for lookup + orphan filter)
 * @param validDays        Time window in days. `null` = all time. Decisions older than
 *                         `now - validDays * 86_400_000` are excluded.
 * @returns                Top 5 assets sorted desc by reference_count, tiebreak asc by title.
 */
export function getTopReferencedAssets(
  decisions: Decision[],
  knowledgeAssets: KnowledgeAsset[],
  validDays: number | null,
): TopReferencedAsset[] {
  // 1. Filter decisions by time window
  let inWindow = decisions;
  if (validDays !== null) {
    const cutoff = new Date(Date.now() - validDays * 24 * 60 * 60 * 1000).toISOString();
    inWindow = decisions.filter((d) => d.created_at >= cutoff);
  }

  // 2. Build asset lookup (also the orphan-ref filter)
  const assetById = new Map<string, KnowledgeAsset>(
    knowledgeAssets.map((a) => [a.knowledge_id, a]),
  );

  // 3. Group by case: for each case, collect the unique set of asset IDs it references
  const caseAssets = new Map<string, Set<string>>();
  for (const d of inWindow) {
    // `snapshot` and `knowledge_asset_refs` are type-required, but raw Firestore
    // docs may be legacy/partial (written before the snapshot field existed), so
    // we chain defensively and fall back to an empty ref set rather than throw.
    const refs = d.snapshot?.knowledge_asset_refs ?? [];
    if (refs.length === 0) continue;
    let set = caseAssets.get(d.case_id);
    if (!set) {
      set = new Set<string>();
      caseAssets.set(d.case_id, set);
    }
    for (const ref of refs) {
      set.add(ref);
    }
  }

  // 4. Count references: each case contributes at most +1 per asset
  const counts = new Map<string, number>();
  for (const assetIds of caseAssets.values()) {
    for (const assetId of assetIds) {
      // Orphan refs (asset no longer exists) are silently excluded
      if (!assetById.has(assetId)) continue;
      counts.set(assetId, (counts.get(assetId) ?? 0) + 1);
    }
  }

  // 5. Materialize, sort, and slice
  const result: TopReferencedAsset[] = [];
  for (const [assetId, count] of counts.entries()) {
    const asset = assetById.get(assetId);
    // Unreachable in practice: every key in `counts` already passed the
    // `assetById.has` orphan filter above, so the lookup always hits. Kept only
    // to narrow Map.get's `T | undefined` return without a non-null assertion.
    if (!asset) continue;
    result.push({
      knowledge_id: asset.knowledge_id,
      title: asset.title,
      type: asset.type,
      status: asset.status,
      reference_count: count,
    });
  }

  result.sort((a, b) => {
    if (b.reference_count !== a.reference_count) {
      return b.reference_count - a.reference_count;
    }
    return a.title.localeCompare(b.title);
  });

  return result.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Observatory aggregate
//
// Extracted from app/api/observatory/route.ts so other server routes
// (e.g. /api/dashboard) can reuse the exact same composition without a
// second HTTP round-trip.
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['approved', 'done', 'rejected']);

function calcApprovalRate(cases: Case[]): number {
  const finished = cases.filter((c) => TERMINAL.has(c.status));
  const approved = cases.filter((c) => c.status === 'approved' || c.status === 'done').length;
  return finished.length > 0 ? Math.round((approved / finished.length) * 100) : 0;
}

function filterByDateRange<T extends { created_at: string }>(items: T[], days: number | null): T[] {
  if (!days) return items;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return items.filter((item) => item.created_at >= cutoff);
}

export interface ObservatoryAggregate {
  summary: {
    total_cases: number;
    pending_reviews: number;
    approval_rate: number;
    avg_findings_per_case: number;
    total_findings: number;
    open_findings: number;
    total_knowledge_assets: number;
  };
  cases_by_status: Record<string, number>;
  risk_distribution: Record<string, number>;
  track_distribution: Record<string, number>;
  findings_by_severity: Record<string, number>;
  recent_activity: Array<{
    case_id: string;
    case_title: string;
    type: string;
    summary: string;
    created_at: string;
  }>;
  top_contributors: Array<{
    user_id: string;
    display_name: string;
    total_cases: number;
    approved_cases: number;
    approval_rate: number;
  }>;
  top_reviewers: Array<{
    user_id: string;
    display_name: string;
    cases_reviewed: number;
  }>;
  top_repositories: Array<{
    repository_id: string;
    name: string;
    project_name: string;
    total_cases: number;
    /** Terminal cases (approved + rejected + done) — denominator behind `approval_rate`. See #676. */
    decided_count: number;
    approval_rate: number;
  }>;
  top_projects: Array<{
    project_id: string;
    name: string;
    total_cases: number;
    team_size: number;
    /** Terminal cases (approved + rejected + done) — denominator behind `approval_rate`. See #676. */
    decided_count: number;
    approval_rate: number;
  }>;
  throughput_leaderboard: Array<{
    case_id: string;
    title: string;
    status: string;
    risk_level: string;
    duration_ms: number;
    is_completed: boolean;
  }>;
  top_referenced_assets: TopReferencedAsset[];
}

export function aggregateObservatory(
  cases: Case[],
  findings: Finding[],
  runs: Run[],
  knowledgeAssets: KnowledgeAsset[],
  decisions: Decision[],
  users: User[],
  projects: Project[],
  repositories: Repository[],
  days: number | null = null,
): ObservatoryAggregate {
  cases = filterByDateRange(cases, days);
  findings = filterByDateRange(findings, days);
  runs = filterByDateRange(runs, days);
  const top_referenced_assets = getTopReferencedAssets(decisions, knowledgeAssets, days);

  const cases_by_status: Record<string, number> = {};
  const risk_distribution: Record<string, number> = {};
  const track_distribution: Record<string, number> = {};
  for (const c of cases) {
    cases_by_status[c.status] = (cases_by_status[c.status] ?? 0) + 1;
    risk_distribution[c.risk_level] = (risk_distribution[c.risk_level] ?? 0) + 1;
    track_distribution[c.validation_track] = (track_distribution[c.validation_track] ?? 0) + 1;
  }

  const findings_by_severity: Record<string, number> = {};
  for (const f of findings) {
    findings_by_severity[f.severity] = (findings_by_severity[f.severity] ?? 0) + 1;
  }

  const pending_reviews = cases.filter((c) => c.status === 'in_review').length;
  const approval_rate = calcApprovalRate(cases);
  const open_findings = findings.filter((f) => f.status === 'open').length;
  const avg_findings_per_case =
    cases.length > 0 ? Math.round((findings.length / cases.length) * 10) / 10 : 0;

  type ActivityItem = {
    case_id: string;
    case_title: string;
    type: string;
    summary: string;
    created_at: string;
  };
  const activity: ActivityItem[] = [];
  const caseLookup = new Map(cases.map((c) => [c.case_id, c]));

  for (const run of runs) {
    const caseObj = caseLookup.get(run.case_id);
    activity.push({
      case_id: run.case_id,
      case_title: caseObj?.title ?? run.case_id,
      type: run.run_type,
      summary: run.summary ?? `${run.run_type} ${run.status}`,
      created_at: run.created_at,
    });
  }
  for (const c of cases) {
    activity.push({
      case_id: c.case_id,
      case_title: c.title,
      type: 'case_created',
      summary: `Case created with status ${c.status}`,
      created_at: c.created_at,
    });
  }
  activity.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const userMap = new Map(users.map((u) => [u.user_id, u.display_name]));
  const projectMap = new Map(projects.map((p) => [p.project_id, p.name]));
  const repoMap = new Map(repositories.map((r) => [r.repository_id, r]));

  const casesByOwner = new Map<string, Case[]>();
  for (const c of cases) {
    const list = casesByOwner.get(c.owner_user_id) ?? [];
    list.push(c);
    casesByOwner.set(c.owner_user_id, list);
  }
  const top_contributors = [...casesByOwner.entries()]
    .map(([userId, userCases]) => {
      const approvedCases = userCases.filter(
        (c) => c.status === 'approved' || c.status === 'done',
      ).length;
      return {
        user_id: userId,
        display_name: userMap.get(userId) ?? userId,
        total_cases: userCases.length,
        approved_cases: approvedCases,
        approval_rate: calcApprovalRate(userCases),
      };
    })
    .sort((a, b) => b.total_cases - a.total_cases)
    .slice(0, 5);

  const casesByReviewer = new Map<string, number>();
  for (const c of cases) {
    if (c.assigned_reviewer_id) {
      casesByReviewer.set(
        c.assigned_reviewer_id,
        (casesByReviewer.get(c.assigned_reviewer_id) ?? 0) + 1,
      );
    }
  }
  const top_reviewers = [...casesByReviewer.entries()]
    .map(([userId, count]) => ({
      user_id: userId,
      display_name: userMap.get(userId) ?? userId,
      cases_reviewed: count,
    }))
    .sort((a, b) => b.cases_reviewed - a.cases_reviewed)
    .slice(0, 5);

  const casesByRepo = new Map<string, Case[]>();
  for (const c of cases) {
    if (c.repository_id) {
      const list = casesByRepo.get(c.repository_id) ?? [];
      list.push(c);
      casesByRepo.set(c.repository_id, list);
    }
  }
  const top_repositories = [...casesByRepo.entries()]
    .map(([repoId, repoCases]) => {
      const repo = repoMap.get(repoId);
      return {
        repository_id: repoId,
        name: repo?.name ?? repoId,
        project_name: repo ? (projectMap.get(repo.project_id) ?? '') : '',
        total_cases: repoCases.length,
        decided_count: repoCases.filter((c) => TERMINAL.has(c.status)).length,
        approval_rate: calcApprovalRate(repoCases),
      };
    })
    .sort((a, b) => b.total_cases - a.total_cases)
    .slice(0, 5);

  const casesByProject = new Map<string, Case[]>();
  for (const c of cases) {
    if (c.project_id) {
      const list = casesByProject.get(c.project_id) ?? [];
      list.push(c);
      casesByProject.set(c.project_id, list);
    }
  }
  const top_projects = [...casesByProject.entries()]
    .map(([projectId, projCases]) => {
      const teamSize = new Set(projCases.map((c) => c.owner_user_id)).size;
      return {
        project_id: projectId,
        name: projectMap.get(projectId) ?? projectId,
        total_cases: projCases.length,
        team_size: teamSize,
        decided_count: projCases.filter((c) => TERMINAL.has(c.status)).length,
        approval_rate: calcApprovalRate(projCases),
      };
    })
    .sort((a, b) => b.total_cases - a.total_cases);

  const now = Date.now();
  const casesThroughput = cases.map((c) => {
    const isCompleted = TERMINAL.has(c.status);
    const endMs = isCompleted ? new Date(c.updated_at).getTime() : now;
    const duration_ms = Math.max(0, endMs - new Date(c.created_at).getTime());
    return {
      case_id: c.case_id,
      title: c.title,
      status: c.status,
      risk_level: c.risk_level,
      duration_ms,
      is_completed: isCompleted,
    };
  });
  const throughput_leaderboard = [
    ...casesThroughput.filter((c) => c.is_completed).sort((a, b) => a.duration_ms - b.duration_ms),
    ...casesThroughput.filter((c) => !c.is_completed).sort((a, b) => a.duration_ms - b.duration_ms),
  ].slice(0, 10);

  return {
    summary: {
      total_cases: cases.length,
      pending_reviews,
      approval_rate,
      avg_findings_per_case,
      total_findings: findings.length,
      open_findings,
      total_knowledge_assets: knowledgeAssets.length,
    },
    cases_by_status,
    risk_distribution,
    track_distribution,
    findings_by_severity,
    recent_activity: activity.slice(0, 10),
    top_contributors,
    top_reviewers,
    top_repositories,
    top_projects,
    throughput_leaderboard,
    top_referenced_assets,
  };
}

/**
 * Load raw Firestore data for the observatory aggregate, apply the same
 * project-access filtering used by `GET /api/observatory`, then compose the
 * aggregate. Reused from both the observatory route and the dashboard
 * fan-in route so access-control semantics stay in one place.
 */
export async function buildObservatoryAggregate(
  userId: string,
  admin: boolean,
  validDays: number | null,
): Promise<ObservatoryAggregate> {
  const { collections, isEffectiveMember } = await import('@arbitra/backend');

  const [
    casesSnap,
    findingsSnap,
    runsSnap,
    knowledgeSnap,
    decisionsSnap,
    usersSnap,
    projectsSnap,
    reposSnap,
  ] = await Promise.all([
    collections.activeCases().get(),
    collections.findings().get(),
    collections.runs().get(),
    collections.knowledgeAssets().get(),
    collections.decisions().get(),
    collections.users().get(),
    collections.projects().get(),
    collections.repositories().get(),
  ]);

  let cases = casesSnap.docs.map((d) => d.data());
  let findings = findingsSnap.docs.map((d) => d.data());
  let runs = runsSnap.docs.map((d) => d.data());
  const knowledgeAssets = knowledgeSnap.docs.map((d) => d.data());
  let decisions = decisionsSnap.docs.map((d) => d.data());
  const users = usersSnap.docs.map((d) => d.data());
  let projects = projectsSnap.docs.map((d) => d.data());
  let repositories = reposSnap.docs.map((d) => d.data());

  if (!admin) {
    projects = projects.filter((p) => isEffectiveMember(p, userId));
    const accessibleProjectIds = new Set(projects.map((p) => p.project_id));

    cases = cases.filter((c) => accessibleProjectIds.has(c.project_id));
    const accessibleCaseIds = new Set(cases.map((c) => c.case_id));

    findings = findings.filter((f) => accessibleCaseIds.has(f.case_id));
    runs = runs.filter((r) => accessibleCaseIds.has(r.case_id));
    decisions = decisions.filter((d) => accessibleCaseIds.has(d.case_id));

    repositories = repositories.filter((r) => accessibleProjectIds.has(r.project_id));
  }

  return aggregateObservatory(
    cases,
    findings,
    runs,
    knowledgeAssets,
    decisions,
    users,
    projects,
    repositories,
    validDays,
  );
}
