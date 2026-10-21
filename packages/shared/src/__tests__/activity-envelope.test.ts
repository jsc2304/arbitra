import { describe, expect, it } from 'vitest';
import type { CaseEvent, Comment, Decision, Evidence, Finding, WorkspaceEvent } from '../types/index.js';
import {
  PREVIEW_MAX_CHARS,
  classifyActor,
  commentMentionsHuman,
  computeCaseGroupKey,
  computePreview,
  computeSignal,
  computeWorkspaceGroupKey,
  envelopeForCaseEvent,
  envelopeForComment,
  envelopeForDecision,
  envelopeForEvidence,
  envelopeForFinding,
  envelopeForWorkspaceEvent,
  isMediumOrAbove,
  resolveOpenedBy,
  severityForCaseEvent,
  severityForDecision,
  severityForFinding,
  tenMinuteBucket,
} from '../utils/activity-envelope.js';

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

describe('computePreview', () => {
  it('returns undefined for empty / nullish input', () => {
    expect(computePreview(undefined)).toBeUndefined();
    expect(computePreview(null)).toBeUndefined();
    expect(computePreview('')).toBeUndefined();
    expect(computePreview('   \n  \t  ')).toBeUndefined();
  });

  it('passes short strings through unchanged after whitespace collapse', () => {
    expect(computePreview('hello world')).toBe('hello world');
    expect(computePreview('  hello\n\nworld  ')).toBe('hello world');
  });

  it('truncates long strings at PREVIEW_MAX_CHARS with an ellipsis', () => {
    const body = 'x'.repeat(500);
    const got = computePreview(body)!;
    expect(got.length).toBe(PREVIEW_MAX_CHARS);
    expect(got.endsWith('…')).toBe(true);
  });

  it('keeps strings exactly at PREVIEW_MAX_CHARS untouched', () => {
    const body = 'a'.repeat(PREVIEW_MAX_CHARS);
    expect(computePreview(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// classifyActor
// ---------------------------------------------------------------------------

describe('classifyActor', () => {
  it('classifies known IDE clients via actor_metadata.client_name', () => {
    expect(classifyActor('usr_1', { client_name: 'cursor' })).toEqual({
      kind: 'agent',
      agent: 'cursor',
    });
    expect(classifyActor('usr_1', { client_name: 'claude-code' })).toEqual({
      kind: 'agent',
      agent: 'claude-code',
    });
  });

  it('treats arbitra-intelligence client_name as system / code-intelligence', () => {
    expect(
      classifyActor('system:arbitra-intelligence', { client_name: 'arbitra-intelligence' }),
    ).toEqual({ kind: 'system', agent: 'code-intelligence' });
  });

  it('classifies unknown client_name as agent / null (still differentiated from human)', () => {
    expect(classifyActor('usr_1', { client_name: 'mystery-cli' })).toEqual({
      kind: 'agent',
      agent: null,
    });
  });

  it('classifies system actor IDs without metadata', () => {
    // Plain webhook bot.
    expect(classifyActor('system', undefined)).toEqual({ kind: 'system', agent: null });
    // Detector / scheduler.
    expect(classifyActor('system:arbitra-intelligence', undefined)).toEqual({
      kind: 'system',
      agent: 'code-intelligence',
    });
    // Future system actor — stays system, no canonical agent label.
    expect(classifyActor('system:future-thing', undefined)).toEqual({
      kind: 'system',
      agent: null,
    });
  });

  it('falls through to human for everything else', () => {
    expect(classifyActor('usr_1', undefined)).toEqual({ kind: 'human', agent: null });
    expect(classifyActor(undefined, undefined)).toEqual({ kind: 'human', agent: null });
  });
});

// ---------------------------------------------------------------------------
// resolveOpenedBy
// ---------------------------------------------------------------------------

describe('resolveOpenedBy', () => {
  it('maps detector / webhook / user actor IDs to the right bucket', () => {
    expect(resolveOpenedBy('system:arbitra-intelligence')).toBe('detector');
    expect(resolveOpenedBy('system')).toBe('webhook');
    expect(resolveOpenedBy('usr_alex')).toBe('user');
    expect(resolveOpenedBy(undefined)).toBe('user');
  });

  it('treats unknown system:* actors as detector-class (so they don\'t render as users)', () => {
    expect(resolveOpenedBy('system:future-detector')).toBe('detector');
  });
});

// ---------------------------------------------------------------------------
// severity
// ---------------------------------------------------------------------------

describe('severityForCaseEvent', () => {
  it('promotes hard fails to high', () => {
    expect(severityForCaseEvent('run_failed')).toBe('high');
    expect(severityForCaseEvent('webhook_rejected')).toBe('high');
    expect(severityForCaseEvent('case_anomaly_merge_on_gated_status')).toBe('high');
  });

  it('flags reviewer-grade events as medium', () => {
    expect(severityForCaseEvent('changes_requested')).toBe('medium');
    expect(severityForCaseEvent('human_decision_requested')).toBe('medium');
    expect(severityForCaseEvent('case_rejected')).toBe('medium');
  });

  it('flags gate_rejected as medium, mirroring severityForDecision', () => {
    expect(severityForCaseEvent('gate_rejected')).toBe('medium');
    expect(severityForCaseEvent('gate_rejected')).toBe(severityForDecision('gate_rejected'));
  });

  it('keeps cosmetic state moves at low', () => {
    expect(severityForCaseEvent('status_changed')).toBe('low');
    expect(severityForCaseEvent('risk_level_changed')).toBe('low');
  });

  it('defaults everything else to info', () => {
    expect(severityForCaseEvent('case_created')).toBe('info');
    expect(severityForCaseEvent('build_started')).toBe('info');
    expect(severityForCaseEvent('exploration_completed')).toBe('info');
    expect(severityForCaseEvent('case_approved')).toBe('info');
  });
});

describe('severityForFinding / severityForDecision', () => {
  it('passes finding severity through verbatim', () => {
    expect(severityForFinding('critical')).toBe('critical');
    expect(severityForFinding('low')).toBe('low');
    expect(severityForFinding(undefined)).toBe('info');
  });

  it('lifts reject / request_changes / escalate decisions above audit-trail level', () => {
    expect(severityForDecision('escalate')).toBe('high');
    expect(severityForDecision('reject')).toBe('medium');
    expect(severityForDecision('request_changes')).toBe('medium');
    expect(severityForDecision('approve')).toBe('low');
    expect(severityForDecision('waive')).toBe('low');
    expect(severityForDecision(undefined)).toBe('low');
  });
});

describe('isMediumOrAbove', () => {
  it('returns true at and above medium', () => {
    expect(isMediumOrAbove('info')).toBe(false);
    expect(isMediumOrAbove('low')).toBe(false);
    expect(isMediumOrAbove('medium')).toBe(true);
    expect(isMediumOrAbove('high')).toBe(true);
    expect(isMediumOrAbove('critical')).toBe(true);
    expect(isMediumOrAbove(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupKey
// ---------------------------------------------------------------------------

describe('tenMinuteBucket / computeCaseGroupKey', () => {
  it('floors to the 10-minute bucket and formats as YYYYMMDDTHHMM', () => {
    expect(tenMinuteBucket('2026-04-19T14:23:45.000Z')).toBe('20260419T1420');
    expect(tenMinuteBucket('2026-04-19T14:20:00.000Z')).toBe('20260419T1420');
    expect(tenMinuteBucket('2026-04-19T14:29:59.999Z')).toBe('20260419T1420');
    expect(tenMinuteBucket('2026-04-19T14:30:00.000Z')).toBe('20260419T1430');
  });

  it('returns "unknown" for malformed timestamps', () => {
    expect(tenMinuteBucket(undefined)).toBe('unknown');
    expect(tenMinuteBucket('not-a-date')).toBe('unknown');
  });

  it('shapes case group keys', () => {
    expect(computeCaseGroupKey('case_42', '2026-04-19T14:23:45.000Z')).toBe(
      'case:case_42:20260419T1420',
    );
  });

  it('shapes workspace group keys as kind:verb:actor', () => {
    expect(computeWorkspaceGroupKey('workspace_event', 'intelligence_run', 'system:arbitra-intelligence')).toBe(
      'kind:intelligence_run:system:arbitra-intelligence',
    );
    expect(computeWorkspaceGroupKey('workspace_event', undefined, undefined)).toBe(
      'kind:unknown:unknown',
    );
  });
});

// ---------------------------------------------------------------------------
// commentMentionsHuman
// ---------------------------------------------------------------------------

describe('commentMentionsHuman', () => {
  it('detects @mentions', () => {
    expect(commentMentionsHuman('hey @alex can you check?')).toBe(true);
    expect(commentMentionsHuman('@alice ping')).toBe(true);
  });

  it('does not false-positive on URLs / emails', () => {
    expect(commentMentionsHuman('see https://example.com/@notamention')).toBe(false);
    // Email-like — `@example.com` after a non-word char would technically match,
    // so we accept this is a soft heuristic. Test the URL case (the most
    // common false-positive) to lock the regex behavior.
  });

  it('returns false for empty / undefined input', () => {
    expect(commentMentionsHuman(undefined)).toBe(false);
    expect(commentMentionsHuman('')).toBe(false);
    expect(commentMentionsHuman('plain text')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeSignal — Signal ruleset
// ---------------------------------------------------------------------------

describe('computeSignal — Signal ruleset', () => {
  it('always Signals findings / decisions / evidence', () => {
    expect(
      computeSignal({ kind: 'finding', severity: 'info', actorKind: 'human' }),
    ).toBe(true);
    expect(
      computeSignal({ kind: 'decision', severity: 'low', actorKind: 'system' }),
    ).toBe(true);
    expect(
      computeSignal({ kind: 'evidence', severity: 'info', actorKind: 'agent' }),
    ).toBe(true);
  });

  it('Signals lifecycle events from human actors regardless of severity', () => {
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'build_started',
        severity: 'info',
        actorKind: 'human',
      }),
    ).toBe(true);
  });

  it('Signals system-actor lifecycle events when severity >= medium', () => {
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'changes_requested',
        severity: 'medium',
        actorKind: 'system',
      }),
    ).toBe(true);
  });

  it('keeps system-actor low-severity lifecycle events out of Signal', () => {
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'build_started',
        severity: 'info',
        actorKind: 'system',
      }),
    ).toBe(false);
  });

  it('Signals lifecycle events on detector-opened cases (the detection itself is the signal)', () => {
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'case_created',
        severity: 'info',
        actorKind: 'system',
        caseDetectorOpened: true,
      }),
    ).toBe(true);
  });

  it('suppresses internal state-machine transitions on cases with no human waiting', () => {
    // case_ready_for_build on a `done` case — nobody's waiting, drop it.
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'case_ready_for_build',
        severity: 'info',
        actorKind: 'system',
        caseStatus: 'done',
      }),
    ).toBe(false);
    // Same row but the case is `in_review` → human waiting, keep it (still
    // requires the regular promotion rules to fire — info+system without
    // detector-opened doesn't qualify).
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'case_ready_for_build',
        severity: 'info',
        actorKind: 'system',
        caseStatus: 'in_review',
      }),
    ).toBe(false); // info + system + no detector → still not Signal
    // Lifted to medium → Signal.
    expect(
      computeSignal({
        kind: 'case_event',
        verb: 'case_ready_for_build',
        severity: 'medium',
        actorKind: 'system',
        caseStatus: 'in_review',
      }),
    ).toBe(true);
  });

  it('keeps workspace events out of Signal unless explicitly off-baseline', () => {
    expect(
      computeSignal({
        kind: 'workspace_event',
        verb: 'intelligence_run',
        severity: 'info',
        actorKind: 'system',
      }),
    ).toBe(false);
    expect(
      computeSignal({
        kind: 'workspace_event',
        verb: 'intelligence_run',
        severity: 'info',
        actorKind: 'system',
        systemEventOffBaseline: true,
      }),
    ).toBe(true);
  });

  it('Signals comments by humans, suppresses bot-on-bot, lifts when human is mentioned', () => {
    expect(
      computeSignal({ kind: 'comment', severity: 'info', actorKind: 'human' }),
    ).toBe(true);
    expect(
      computeSignal({ kind: 'comment', severity: 'info', actorKind: 'agent' }),
    ).toBe(false);
    expect(
      computeSignal({
        kind: 'comment',
        severity: 'info',
        actorKind: 'agent',
        commentMentionsHuman: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// envelopeFor* — integration of the per-source builders
// ---------------------------------------------------------------------------

describe('envelopeForCaseEvent', () => {
  function makeEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
    return {
      event_id: 'evt_1',
      case_id: 'case_1',
      type: 'case_created',
      actor_id: 'usr_alex',
      payload: {},
      created_at: '2026-04-19T14:23:00.000Z',
      ...overrides,
    };
  }

  it('builds an envelope for a human-opened case_created', () => {
    const env = envelopeForCaseEvent(makeEvent());
    expect(env).toEqual({
      severity: 'info',
      signal: true,
      actor_kind: 'human',
      actor_agent: null,
      opened_by: 'user',
      group_key: 'case:case_1:20260419T1420',
    });
  });

  it('routes detector-opened case_created through opened_by=detector and signals it', () => {
    const env = envelopeForCaseEvent(
      makeEvent({ actor_id: 'system:arbitra-intelligence' }),
      { caseDetectorOpened: true },
    );
    expect(env.opened_by).toBe('detector');
    expect(env.actor_kind).toBe('system');
    expect(env.actor_agent).toBe('code-intelligence');
    expect(env.signal).toBe(true);
  });

  it('routes webhook-opened case_created through opened_by=webhook', () => {
    const env = envelopeForCaseEvent(makeEvent({ actor_id: 'system' }));
    expect(env.opened_by).toBe('webhook');
    expect(env.actor_kind).toBe('system');
    expect(env.actor_agent).toBe(null);
    // Webhook ingest of a human PR is NOT promoted to Signal on its own —
    // the case will earn Signal via human comments / findings / decisions.
    expect(env.signal).toBe(false);
  });

  it('omits opened_by on non-creation events', () => {
    const env = envelopeForCaseEvent(makeEvent({ type: 'build_started' }));
    expect(env.opened_by).toBeUndefined();
  });
});

describe('envelopeForComment', () => {
  function makeComment(overrides: Partial<Comment> = {}): Comment {
    return {
      comment_id: 'c_1',
      parent_type: 'case',
      parent_id: 'case_1',
      author_id: 'usr_alex',
      body: 'short comment',
      created_at: '2026-04-19T14:23:00.000Z',
      ...overrides,
    };
  }

  it('Signals human-authored comments and produces a preview', () => {
    const env = envelopeForComment(makeComment(), 'case_1');
    expect(env.signal).toBe(true);
    expect(env.actor_kind).toBe('human');
    expect(env.preview).toBe('short comment');
  });

  it('truncates long bodies in the preview', () => {
    const env = envelopeForComment(
      makeComment({ body: 'x'.repeat(500) }),
      'case_1',
    );
    expect(env.preview!.length).toBe(PREVIEW_MAX_CHARS);
  });

  it('keeps agent comments out of Signal unless they mention a human', () => {
    const botEnv = envelopeForComment(
      makeComment({
        author_id: 'bot',
        actor_metadata: { client_name: 'cursor' },
        body: 'auto-update',
      }),
      'case_1',
    );
    expect(botEnv.actor_kind).toBe('agent');
    expect(botEnv.signal).toBe(false);

    const mentionEnv = envelopeForComment(
      makeComment({
        author_id: 'bot',
        actor_metadata: { client_name: 'cursor' },
        body: 'hey @alex please look',
      }),
      'case_1',
    );
    expect(mentionEnv.signal).toBe(true);
  });
});

describe('envelopeForEvidence / envelopeForFinding / envelopeForDecision', () => {
  it('always-Signals evidence, classifies the actor, and previews summary', () => {
    const ev: Evidence = {
      evidence_id: 'ev_1',
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'agent',
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-04-19T14:23:00.000Z',
      created_by: 'usr_alex',
      actor_metadata: { client_name: 'claude-code' },
      summary: 'ci passed in 12s',
    };
    const env = envelopeForEvidence(ev);
    expect(env.signal).toBe(true);
    expect(env.actor_kind).toBe('agent');
    expect(env.actor_agent).toBe('claude-code');
    expect(env.preview).toBe('ci passed in 12s');
    expect(env.group_key).toBe('case:case_1:20260419T1420');
  });

  it('passes finding severity through and previews description over title', () => {
    const f: Finding = {
      finding_id: 'fnd_1',
      case_id: 'case_1',
      category: 'bug',
      severity: 'high',
      confidence: 0.9,
      status: 'open',
      title: 'short title',
      description: 'long description body',
      origin_type: 'reviewer',
      source_refs: [],
      evidence_refs: [],
      rule_refs: [],
      created_at: '2026-04-19T14:23:00.000Z',
      updated_at: '2026-04-19T14:23:00.000Z',
    };
    const env = envelopeForFinding(f);
    expect(env.severity).toBe('high');
    expect(env.signal).toBe(true);
    expect(env.preview).toBe('long description body');
  });

  it('lifts reject decisions to medium severity', () => {
    const d: Decision = {
      decision_id: 'dec_1',
      case_id: 'case_1',
      type: 'reject',
      actor_id: 'usr_alex',
      rationale: 'no.',
      snapshot: {
        active_rule_set_versions: {},
        evidence_policy_version: 1,
        knowledge_asset_refs: [],
      },
      created_at: '2026-04-19T14:23:00.000Z',
    };
    const env = envelopeForDecision(d);
    expect(env.severity).toBe('medium');
    expect(env.signal).toBe(true);
    expect(env.preview).toBe('no.');
  });
});

describe('envelopeForWorkspaceEvent', () => {
  it('classifies the system actor and stays out of Signal by default', () => {
    const we: WorkspaceEvent = {
      event_id: 'wse_1',
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      timestamp: '2026-04-19T14:23:00.000Z',
      summary: 'Ran 5 detectors',
    };
    const env = envelopeForWorkspaceEvent(we);
    expect(env.actor_kind).toBe('system');
    expect(env.actor_agent).toBe('code-intelligence');
    expect(env.signal).toBe(false);
    expect(env.group_key).toBe('kind:intelligence_run:system:arbitra-intelligence');
  });
});
