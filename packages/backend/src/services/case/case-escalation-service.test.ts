import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, RiskLevel } from '@arbitra/shared';
import { evaluateObservedCaseEscalation } from './case-escalation-service.js';

/**
 * Unit tests for `evaluateObservedCaseEscalation` at the service seam
 * (issue #987 / ADR-0001). All Firestore-touching dependencies
 * (CaseRepository, EventService, CompletenessEvaluator) are injected as
 * fakes so this suite exercises exactly the escalation DECISION logic:
 * detect risk from PR signal → compare to the resolved threshold →
 * escalate (flip case_type, emit `case_escalated`) or stay observed
 * (optionally emit `risk_level_changed`).
 */

function makeObservedCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Observed: feat/widgets',
    description: 'Auto-created from agent activity',
    source_type: 'git',
    source_ref: 'feat/widgets',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'system:observed-case',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    case_type: 'observed',
    status: 'in_build',
    decision_ready: false,
    current_branch: 'feat/widgets',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Case;
}

function makeDeps(threshold: RiskLevel = 'high') {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const updates: Array<Partial<Case>> = [];

  const caseRepo = {
    update: vi.fn(async (_id: string, patch: Partial<Case>) => {
      updates.push(patch);
      return patch as Case;
    }),
  } as never;

  const eventService = {
    emit: vi.fn(async (_caseId: string, type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return { event_id: 'ev_1', case_id: _caseId, type, actor_id: 'system', payload, created_at: '' };
    }),
  } as never;

  const completenessEvaluator = {
    getEscalationThreshold: vi.fn(async () => threshold),
  } as never;

  return { caseRepo, eventService, completenessEvaluator, events, updates };
}

describe('evaluateObservedCaseEscalation', () => {
  it('escalates a high-risk Observed Case on PR enrichment and carries the detected case_type/risk', async () => {
    // Revert the `meetsEscalationThreshold` check (or the case_type flip
    // below it) and this assertion on `escalated`/`case_type` fails — the
    // case would stay `observed` with its original `low` risk_level.
    const deps = makeDeps('high');
    const case_ = makeObservedCase({ current_branch: 'fix/auth-bypass' });

    const result = await evaluateObservedCaseEscalation(
      case_,
      { changedFiles: ['packages/backend/src/lib/auth.ts'] },
      deps,
    );

    expect(result.escalated).toBe(true);
    expect(result.case.case_type).toBe('bugfix');
    expect(result.case.risk_level).toBe('high');
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ case_type: 'bugfix', risk_level: 'high' });

    const escalatedEvent = deps.events.find((e) => e.type === 'case_escalated');
    expect(escalatedEvent).toBeDefined();
    expect(escalatedEvent?.payload).toMatchObject({
      from_case_type: 'observed',
      to_case_type: 'bugfix',
      from_risk_level: 'low',
      risk_level: 'high',
      threshold: 'high',
    });
    expect(typeof escalatedEvent?.payload['rule']).toBe('string');
  });

  it('carries the pre-escalation risk_level so the transition is reconstructable from the event alone (issue #1029)', async () => {
    // The case starts at `medium` (not the `low` default), and the PR
    // signal pushes risk to `critical` (past the `high` threshold). Without
    // `from_risk_level` on `case_escalated`, only the destination `critical`
    // would be readable from this one event — the fact it moved FROM
    // `medium` would be lost.
    const deps = makeDeps('high');
    const case_ = makeObservedCase({
      current_branch: 'fix/prod-outage',
      risk_level: 'medium',
    });

    const result = await evaluateObservedCaseEscalation(
      case_,
      {
        changedFiles: ['packages/backend/src/lib/auth.ts'],
        prTitle: 'fix: critical production outage in auth',
      },
      deps,
    );

    expect(result.escalated).toBe(true);
    const escalatedEvent = deps.events.find((e) => e.type === 'case_escalated');
    expect(escalatedEvent).toBeDefined();
    // The transition (medium -> new risk_level) must be readable from this
    // single event's payload, not from a diff against case state.
    expect(escalatedEvent?.payload['from_risk_level']).toBe('medium');
    expect(escalatedEvent?.payload['risk_level']).not.toBe('medium');
    expect(escalatedEvent?.payload['from_risk_level']).not.toBe(escalatedEvent?.payload['risk_level']);
  });

  it('a low-risk Observed Case completes without ever escalating', async () => {
    // Revert the `!shouldEscalate` short-circuit and this would flip
    // case_type even though the detected risk (low, doc-only change) never
    // meets the threshold.
    const deps = makeDeps('high');
    const case_ = makeObservedCase({ current_branch: 'chore/readme' });

    const result = await evaluateObservedCaseEscalation(
      case_,
      { changedFiles: ['README.md'] },
      deps,
    );

    expect(result.escalated).toBe(false);
    expect(result.case.case_type).toBe('observed');
    expect(deps.events.find((e) => e.type === 'case_escalated')).toBeUndefined();
    expect(deps.updates).toHaveLength(0);
  });

  it('re-evaluating an already-escalated case is a no-op', async () => {
    // Revert the `case_.case_type !== 'observed'` guard at the top and this
    // would escalate a second time (double `case_escalated` event / a
    // spurious caseRepo.update) on a case that already left the observed
    // lifecycle.
    const deps = makeDeps('high');
    const alreadyEscalated = makeObservedCase({ case_type: 'bugfix', risk_level: 'high' });

    const result = await evaluateObservedCaseEscalation(
      alreadyEscalated,
      { changedFiles: ['packages/backend/src/lib/auth.ts'] },
      deps,
    );

    expect(result.escalated).toBe(false);
    expect(result.case).toBe(alreadyEscalated);
    expect(deps.eventService.emit).not.toHaveBeenCalled();
    expect(deps.caseRepo.update).not.toHaveBeenCalled();
  });

  it('never runs on a manually created case (case_type not observed from the start)', async () => {
    // Same guard as above, exercised for a case that was never auto-created —
    // manual cases must never be touched by this function at all.
    const deps = makeDeps('high');
    const manualCase = makeObservedCase({ case_type: 'ticket_implementation', risk_level: 'low', owner_user_id: 'usr_1' });

    const result = await evaluateObservedCaseEscalation(
      manualCase,
      { changedFiles: ['packages/backend/src/lib/auth.ts'] },
      deps,
    );

    expect(result.escalated).toBe(false);
    expect(deps.eventService.emit).not.toHaveBeenCalled();
    expect(deps.caseRepo.update).not.toHaveBeenCalled();
  });

  it('re-assesses risk level on repeated enrichment even when it does not cross the threshold', async () => {
    // Revert the `riskChanged` branch and a case whose detected risk moved
    // from low to medium (still below the 'high' threshold) would silently
    // keep its stale `risk_level`, with no `risk_level_changed` audit event.
    const deps = makeDeps('high');
    const case_ = makeObservedCase({ current_branch: 'refactor/services-cleanup', risk_level: 'low' });

    const result = await evaluateObservedCaseEscalation(
      case_,
      { changedFiles: ['packages/backend/src/services/foo.ts'] },
      deps,
    );

    expect(result.escalated).toBe(false);
    expect(result.riskChanged).toBe(true);
    expect(result.case.risk_level).toBe('medium');
    const riskEvent = deps.events.find((e) => e.type === 'risk_level_changed');
    expect(riskEvent).toBeDefined();
    expect(riskEvent?.payload).toMatchObject({ from: 'low', to: 'medium' });
  });

  it('never persists the medium default when no changed-file signal is available (issue #1020)', async () => {
    // Revert the `hasFileSignal` guard and this would silently rewrite a
    // human/detection-set `low` risk_level to the ungrounded `medium`
    // default the moment a push/PR event without `changed_files` (e.g. a
    // GitHub `push` payload) enriches the case — even though nothing about
    // the case's actual risk was ever assessed.
    const deps = makeDeps('high');
    const case_ = makeObservedCase({ current_branch: 'feat/widgets', risk_level: 'low' });

    const result = await evaluateObservedCaseEscalation(case_, {}, deps);

    expect(result.escalated).toBe(false);
    expect(result.riskChanged).toBe(false);
    expect(result.case.risk_level).toBe('low');
    expect(result.case).toBe(case_);
    expect(deps.updates).toHaveLength(0);
    expect(deps.events).toHaveLength(0);
  });

  it('never persists the medium default when changed_files is an empty array', async () => {
    const deps = makeDeps('high');
    const case_ = makeObservedCase({ current_branch: 'feat/widgets', risk_level: 'low' });

    const result = await evaluateObservedCaseEscalation(case_, { changedFiles: [] }, deps);

    expect(result.riskChanged).toBe(false);
    expect(result.case.risk_level).toBe('low');
    expect(deps.updates).toHaveLength(0);
    expect(deps.events).toHaveLength(0);
  });

  it('escalates at critical risk too (threshold is >=, not ==)', async () => {
    const deps = makeDeps('high');
    const case_ = makeObservedCase({ current_branch: 'feat/deploy-pipeline' });

    const result = await evaluateObservedCaseEscalation(
      case_,
      { changedFiles: ['.github/workflows/deploy.yml'] },
      deps,
    );

    expect(result.escalated).toBe(true);
    expect(result.case.risk_level).toBe('critical');
  });

  it('honors a project-specific escalation threshold looser than the default', async () => {
    // Project configured escalation.risk_threshold: 'critical' — a 'high'-risk
    // change must NOT escalate even though it would under the built-in default.
    const deps = makeDeps('critical');
    const case_ = makeObservedCase({ current_branch: 'fix/auth-bypass' });

    const result = await evaluateObservedCaseEscalation(
      case_,
      { changedFiles: ['packages/backend/src/lib/auth.ts'] },
      deps,
    );

    expect(result.escalated).toBe(false);
    expect(result.case.risk_level).toBe('high');
  });
});
