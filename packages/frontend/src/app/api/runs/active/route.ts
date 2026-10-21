import { NextRequest, NextResponse } from 'next/server';
import { authenticate, handleError } from '@/lib/api-helpers';
import { TERMINAL_CASE_STATUSES } from '@arbitra/shared';
import type { Case, Run, AgentPresence } from '@arbitra/shared';

export const dynamic = 'force-dynamic';

/**
 * Window for considering a presence row "live". Heartbeats older than this
 * cutoff are filtered out. Single-field range query — no Firestore index
 * required.
 */
const PRESENCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * GET /api/runs/active
 * Returns all runs with status 'pending' or 'running' grouped by case_id,
 * plus live agent-presence heartbeats from MCP-driven flows. The pill in
 * the sidebar uses both signals so IDE-agent activity (which writes runs as
 * already-completed) is still surfaced.
 */
export async function GET(request: NextRequest) {
  try {
    const grouped: Record<string, Run[]> = {};
    const presenceByCase: Record<string, AgentPresence[]> = {};

    const auth = await authenticate(request);
    const { checkIsAdmin, collections, getAccessibleProjectIds } = await import('@arbitra/backend');
    const admin = await checkIsAdmin(auth.userId);
    let accessibleCaseIds: Set<string> | null = null;

    if (!admin) {
      const accessibleProjectIds = await getAccessibleProjectIds(auth.userId, false);
      if (accessibleProjectIds !== 'all') {
        const accessibleProjects = new Set(accessibleProjectIds);
        const casesSnap = await collections.activeCases().get();
        accessibleCaseIds = new Set(
          casesSnap.docs
            .map((doc) => doc.data())
            .filter((case_) => accessibleProjects.has(case_.project_id))
            .map((case_) => case_.case_id),
        );
      }
    }

    const cutoffIso = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString();

    const [pendingSnap, runningSnap, presenceSnap] = await Promise.all([
      collections.runs().where('status', '==', 'pending').get(),
      collections.runs().where('status', '==', 'running').get(),
      collections.agentPresence().where('last_seen_at', '>=', cutoffIso).get(),
    ]);

    for (const doc of [...pendingSnap.docs, ...runningSnap.docs]) {
      const run = doc.data() as Run;
      if (accessibleCaseIds && !accessibleCaseIds.has(run.case_id)) continue;
      if (!grouped[run.case_id]) grouped[run.case_id] = [];
      grouped[run.case_id]!.push(run);
    }

    // Pre-scope presence by project access first, then drop any rows whose
    // case is soft-deleted or in a terminal status — heartbeats can linger
    // for up to PRESENCE_WINDOW_MS after a case transitions to done/rejected,
    // which would keep the sidebar pill lit for finished work.
    const scopedPresence: AgentPresence[] = [];
    for (const doc of presenceSnap.docs) {
      const presence = doc.data() as AgentPresence;
      if (accessibleCaseIds && !accessibleCaseIds.has(presence.case_id)) continue;
      scopedPresence.push(presence);
    }

    if (scopedPresence.length > 0) {
      const presenceCaseIds = [...new Set(scopedPresence.map((p) => p.case_id))];
      const refs = presenceCaseIds.map((id) => collections.cases().doc(id));
      // Firestore getAll supports up to 500 docs; presence rows are bounded
      // by the 5-minute liveness window so this stays well below the limit.
      const caseDocs = await collections.cases().firestore.getAll(...refs);
      const liveCaseIds = new Set<string>();
      for (const doc of caseDocs) {
        if (!doc.exists) continue;
        const c = doc.data() as Case;
        if (c.deleted_at) continue;
        if (TERMINAL_CASE_STATUSES.has(c.status)) continue;
        liveCaseIds.add(c.case_id);
      }
      for (const presence of scopedPresence) {
        if (!liveCaseIds.has(presence.case_id)) continue;
        if (!presenceByCase[presence.case_id]) presenceByCase[presence.case_id] = [];
        presenceByCase[presence.case_id]!.push(presence);
      }
    }

    return NextResponse.json({ activeRunsByCase: grouped, presenceByCase });
  } catch (error) {
    return handleError(error);
  }
}
