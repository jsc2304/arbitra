import { describe, expect, it } from 'vitest';
import type { Case, UserRole } from '@arbitra/shared';
import {
  buildReviewSessionQueue,
  getReviewSessionGuidance,
} from '../review-session';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Sample Case',
    description: 'desc',
    source_type: 'manual',
    source_ref: 'ref',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'user_owner',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: false,
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    ...overrides,
  };
}

const reviewerRoles: UserRole[] = ['reviewer'];

describe('buildReviewSessionQueue', () => {
  it('filters by triage view and removes terminal/skipped cases', () => {
    const queue = buildReviewSessionQueue(
      [
        makeCase({ case_id: 'assigned', assigned_reviewer_id: 'user_me', status: 'in_review' }),
        makeCase({ case_id: 'done', assigned_reviewer_id: 'user_me', status: 'done' }),
        makeCase({ case_id: 'skipped', assigned_reviewer_id: 'user_me', status: 'in_review' }),
        makeCase({ case_id: 'other', assigned_reviewer_id: 'someone_else', status: 'in_review' }),
      ],
      'needs-me',
      {
        userId: 'user_me',
        roles: reviewerRoles,
        skippedCaseIds: new Set(['skipped']),
      },
    );

    expect(queue.map((case_) => case_.case_id)).toEqual(['assigned']);
  });

  it('prioritizes pending gates before ordinary review items', () => {
    const queue = buildReviewSessionQueue(
      [
        makeCase({
          case_id: 'decision',
          status: 'needs_human_decision',
          updated_at: '2026-04-20T00:00:00.000Z',
        }),
        makeCase({
          case_id: 'gate',
          owner_user_id: 'someone_else',
          pending_gate: {
            gate_id: 'ready_to_build',
            target_status: 'ready_for_build',
            since: '2026-04-19T00:00:00.000Z',
          },
          updated_at: '2026-04-18T00:00:00.000Z',
        }),
      ],
      'needs-me',
      { userId: 'user_me', roles: reviewerRoles },
    );

    expect(queue.map((case_) => case_.case_id)).toEqual(['gate', 'decision']);
  });
});

describe('getReviewSessionGuidance', () => {
  it('explains gate cases and points to the local agent', () => {
    const guidance = getReviewSessionGuidance(
      makeCase({
        owner_user_id: 'someone_else',
        pending_gate: {
          gate_id: 'ready_to_build',
          target_status: 'ready_for_build',
          since: '2026-04-19T00:00:00.000Z',
        },
      }),
      'needs-me',
      { userId: 'user_me', roles: reviewerRoles },
    );

    expect(guidance.reason).toContain('lifecycle gate');
    expect(guidance.nextStep).toContain('Confirm the gate');
    expect(guidance.localAgentHint).toContain('local agent');
  });

  it('explains findings during human decision', () => {
    const guidance = getReviewSessionGuidance(
      makeCase({ case_id: 'case_findings', status: 'needs_human_decision' }),
      'ready-to-approve',
      {
        userId: 'user_me',
        roles: reviewerRoles,
        findingCounts: { case_findings: 2 },
      },
    );

    expect(guidance.reason).toContain('2 findings');
    expect(guidance.nextStep).toContain('Review blockers');
    expect(guidance.localAgentHint).toContain('inspect the diff');
  });
});
