import { NextRequest, NextResponse } from 'next/server';
import { detectCaseFields } from '@arbitra/backend';
import type { DetectionInput } from '@arbitra/backend';

/**
 * POST /api/cases/detect
 *
 * Accepts git context and returns auto-detected case field suggestions.
 * IDE agents call this before creating a case to show a proposal to the user.
 *
 * Request body: DetectionInput (git_context, changed_files, pr_title, etc.)
 *   + optional `project_id` to look up the project's default_validation_track
 * Response: DetectionResult (case_type, risk_level, priority, jira_refs, etc.)
 */
export async function POST(request: NextRequest) {
  try {
    const body: DetectionInput & { project_id?: string } = await request.json();
    const result = detectCaseFields(body);

    // Override validation_track with project default when detection used the generic fallback
    if (body.project_id) {
      let projectTrack: 'direct' | 'manual' | undefined;
      try {
        const { collections } = await import('@arbitra/backend');
        const projDoc = await collections.projects().doc(body.project_id).get();
        if (projDoc.exists) {
          projectTrack = projDoc.data()?.default_validation_track;
        }
      } catch {
        // Project lookup failed — keep detected value
      }
      if (projectTrack) {
        result.validation_track = projectTrack;
        result.validation_track_reason = `project default (${projectTrack})`;
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Detection failed' } },
      { status: 400 },
    );
  }
}
