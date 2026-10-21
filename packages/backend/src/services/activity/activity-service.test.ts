import { describe, expect, it } from 'vitest';
import type { Case, CaseEvent, Comment, Decision, Evidence, Finding, WorkspaceEvent } from '@arbitra/shared';
import type { ActivityEntry } from '@arbitra/shared';
import {
  aggregateLeaderboard,
  aggregateProjectLeaderboard,
  applyActivityFilters,
  normalizeComment,
  normalizeDecision,
  normalizeEvent,
  normalizeEvidence,
  normalizeFinding,
  normalizeWorkspaceEvent,
} from './activity-service.js';

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Sample Case',
    description: '',
    project_id: 'proj_a',
    owner_user_id: 'usr_owner',
    status: 'open',
    risk_level: 'low',
    validation_track: 'direct',
    case_type: 'bugfix',
    current_branch: 'feat/x',
    evidence_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    created_at: '2026-04-19T00:00:00.000Z',
    updated_at: '2026-04-19T00:00:00.000Z',
    ...overrides,
  } as Case;
}

function makeEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    event_id: 'evt_1',
    case_id: 'case_1',
    type: 'case_created',
    actor_id: 'usr_1',
    payload: {},
    created_at: '2026-04-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('activity normalizers', () => {
  const caseMap = new Map<string, Case>([
    ['case_1', makeCase()],
    ['case_2', makeCase({ case_id: 'case_2', title: 'Other', project_id: 'proj_b' })],
  ]);

  it('normalizes a case event and denormalizes case title + project', () => {
    const row = normalizeEvent(makeEvent(), caseMap);
    expect(row).toMatchObject({
      id: 'event:evt_1',
      kind: 'case_event',
      subkind: 'case_created',
      case_id: 'case_1',
      case_title: 'Sample Case',
      project_id: 'proj_a',
      summary: 'opened',
    });
    expect(row.href).toContain('/cases/case_1');
    // Deep links use query params, not hashes, so the case page routes correctly.
    expect(row.href).toContain('tab=timeline');
    expect(row.href).not.toContain('#');
  });

  it('builds dossier deep links for finding/evidence/decision entries', () => {
    const f: Finding = {
      finding_id: 'fnd_7',
      case_id: 'case_1',
      category: 'bug',
      severity: 'high',
      confidence: 0.9,
      status: 'open',
      title: 'X',
      description: '',
      origin_type: 'reviewer',
      source_refs: [],
      evidence_refs: [],
      rule_refs: [],
      created_at: '',
      updated_at: '',
    };
    const findingRow = normalizeFinding(f, caseMap);
    expect(findingRow.href).toBe('/cases/case_1?tab=dossier&section=findings&finding=fnd_7');
    expect(findingRow.finding_id).toBe('fnd_7');

    const ev: Evidence = {
      evidence_id: 'ev_9',
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'agent',
      machine_readable: true,
      validation_track: 'direct',
      created_at: '',
      created_by: 'u',
    };
    const evRow = normalizeEvidence(ev, caseMap);
    expect(evRow.href).toBe('/cases/case_1?tab=dossier&section=evidence&evidence=ev_9');
    expect(evRow.evidence_id).toBe('ev_9');

    const d: Decision = {
      decision_id: 'dec_9',
      case_id: 'case_1',
      type: 'approve',
      actor_id: 'u',
      rationale: '',
      snapshot: { active_rule_set_versions: {}, evidence_policy_version: 1, knowledge_asset_refs: [] },
      created_at: '',
    };
    const decRow = normalizeDecision(d, caseMap);
    expect(decRow.href).toBe('/cases/case_1?tab=dossier&section=decisions&decision=dec_9');
    expect(decRow.decision_id).toBe('dec_9');
  });

  it('denormalizes project_name when a project map is supplied', () => {
    const row = normalizeEvent(
      makeEvent(),
      caseMap,
      new Map([['proj_a', 'Sample Project']]),
    );
    expect(row.project_name).toBe('Sample Project');
  });

  it('normalizes an evidence row and preserves actor_metadata', () => {
    const ev: Evidence = {
      evidence_id: 'ev_1',
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'agent',
      summary: 'npm build passed',
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-04-19T01:00:00.000Z',
      created_by: 'usr_1',
      actor_metadata: { client_name: 'claude-code', model: 'claude-opus-4-7' },
    };
    const row = normalizeEvidence(ev, caseMap);
    expect(row.id).toBe('evidence:ev_1');
    expect(row.kind).toBe('evidence');
    expect(row.subkind).toBe('ci_result');
    expect(row.actor_metadata).toEqual({ client_name: 'claude-code', model: 'claude-opus-4-7' });
    expect(row.summary).toContain('npm build passed');
  });

  it('normalizes a finding and uses severity as subkind', () => {
    const f: Finding = {
      finding_id: 'fnd_1',
      case_id: 'case_2',
      category: 'bug',
      severity: 'high',
      confidence: 0.9,
      status: 'open',
      title: 'Null pointer',
      description: 'x',
      origin_type: 'reviewer',
      source_refs: [],
      evidence_refs: [],
      rule_refs: [],
      created_at: '2026-04-19T02:00:00.000Z',
      updated_at: '2026-04-19T02:00:00.000Z',
    };
    const row = normalizeFinding(f, caseMap);
    expect(row.kind).toBe('finding');
    expect(row.subkind).toBe('high');
    expect(row.case_title).toBe('Other');
    expect(row.summary).toContain('Null pointer');
  });

  it('normalizes a decision with scope label', () => {
    const d: Decision = {
      decision_id: 'dec_1',
      case_id: 'case_1',
      type: 'approve',
      actor_id: 'usr_reviewer',
      rationale: 'LGTM',
      snapshot: { active_rule_set_versions: {}, evidence_policy_version: 1, knowledge_asset_refs: [] },
      created_at: '2026-04-19T03:00:00.000Z',
    };
    const row = normalizeDecision(d, caseMap);
    expect(row.subkind).toBe('approve');
    // Past-simple verb fragment; the
    // frontend prepends the actor and appends the case title.
    expect(row.summary).toBe('approved');

    const finding: Decision = { ...d, decision_id: 'dec_2', finding_id: 'fnd_1' };
    const scoped = normalizeDecision(finding, caseMap);
    expect(scoped.summary).toBe('approved a finding on');
  });

  it('renders a curated label for waived_on_completion (always finding-scoped)', () => {
    const d: Decision = {
      decision_id: 'dec_woc',
      case_id: 'case_1',
      finding_id: 'fnd_1',
      type: 'waived_on_completion',
      actor_id: 'system:pipeline',
      rationale:
        'The case completed while this waiver proposal was still awaiting human confirmation.',
      snapshot: { active_rule_set_versions: {}, evidence_policy_version: 1, knowledge_asset_refs: [] },
      created_at: '2026-04-19T05:00:00.000Z',
    };
    const row = normalizeDecision(d, caseMap);
    expect(row.subkind).toBe('waived_on_completion');
    // Distinct from `waive` on purpose — this is the system closing an
    // unconfirmed proposal at completion, not a human decision.
    expect(row.summary).toBe('closed an unconfirmed waiver proposal at completion for a finding on');
  });

  it('renders status_changed as a natural-language verb phrase (no arrow syntax)', () => {
    const row = normalizeEvent(
      makeEvent({ event_id: 'evt_status', type: 'status_changed', payload: { to_status: 'in_review' } }),
      caseMap,
    );
    // Grammar — "{Actor} changed status to in review *{title}*",
    // not the old "status → in_review".
    expect(row.summary).toBe('changed status to in review');
    expect(row.summary).not.toContain('→');
  });

  it('falls back to a verb phrase when status_changed has no to_status', () => {
    const row = normalizeEvent(
      makeEvent({ event_id: 'evt_status2', type: 'status_changed', payload: {} }),
      caseMap,
    );
    expect(row.summary).toBe('changed the status of');
  });

  it('emits a decision sub-line preview for decision_created case events', () => {
    const row = normalizeEvent(
      makeEvent({
        event_id: 'evt_dec',
        type: 'decision_created',
        payload: { decision_id: 'dec_9', type: 'request_changes' },
      }),
      caseMap,
    );
    expect(row.summary).toBe('recorded a decision on');
    expect(row.preview).toBe('Decision: request changes');
  });

  it('falls back to a generic decision sub-line when the type is missing', () => {
    const row = normalizeEvent(
      makeEvent({ event_id: 'evt_dec2', type: 'decision_created', payload: { decision_id: 'dec_10' } }),
      caseMap,
    );
    expect(row.preview).toBe('Decision recorded');
  });

  it('normalizes a comment on a case using parent_id as case_id', () => {
    const c: Comment = {
      comment_id: 'cmt_1',
      parent_type: 'case',
      parent_id: 'case_1',
      author_id: 'usr_1',
      body: 'hi',
      created_at: '2026-04-19T04:00:00.000Z',
      actor_metadata: { client_name: 'cursor' },
    };
    const row = normalizeComment(c, caseMap, new Map());
    expect(row).not.toBeNull();
    expect(row!.case_id).toBe('case_1');
    expect(row!.actor_metadata?.client_name).toBe('cursor');
    expect(row!.summary).toBe('commented on');
    expect(row!.comment_id).toBe('cmt_1');
    expect(row!.href).toBe('/cases/case_1?tab=comments&comment=cmt_1');
  });

  it('resolves a finding-scoped comment back to its case via findingToCase map', () => {
    const c: Comment = {
      comment_id: 'cmt_2',
      parent_type: 'finding',
      parent_id: 'fnd_9',
      author_id: 'usr_1',
      body: 'hmm',
      created_at: '2026-04-19T05:00:00.000Z',
    };
    const findingToCase = new Map([['fnd_9', 'case_2']]);
    const row = normalizeComment(c, caseMap, findingToCase);
    expect(row).not.toBeNull();
    expect(row!.case_id).toBe('case_2');
    expect(row!.summary).toBe('commented on a finding on');
  });

  it('drops a finding-scoped comment when the finding is unknown', () => {
    const c: Comment = {
      comment_id: 'cmt_3',
      parent_type: 'finding',
      parent_id: 'fnd_missing',
      author_id: 'usr_1',
      body: 'x',
      created_at: '2026-04-19T05:00:00.000Z',
    };
    expect(normalizeComment(c, caseMap, new Map())).toBeNull();
  });

  // Regression: a persisted evidence row may predate the current schema — a
  // partially-migrated document with `type === undefined` used to crash the
  // entire feed with "Cannot read properties of undefined (reading 'replace')".
  // Normalizer must tolerate the missing field and emit a readable fallback
  // instead of throwing.
  it('normalizes evidence missing optional `type` without throwing', () => {
    const ev = {
      evidence_id: 'ev_legacy',
      case_id: 'case_1',
      // no `type` on a pre-migration doc — cast through unknown to keep the
      // test honest about what we're simulating.
      source_type: 'agent',
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-04-19T06:00:00.000Z',
      created_by: 'usr_1',
    } as unknown as Evidence;

    expect(() => normalizeEvidence(ev, caseMap)).not.toThrow();
    const row = normalizeEvidence(ev, caseMap);
    expect(row.id).toBe('evidence:ev_legacy');
    expect(row.kind).toBe('evidence');
    expect(row.subkind).toBeUndefined();
    expect(typeof row.summary).toBe('string');
    expect(row.summary.length).toBeGreaterThan(0);
    expect(row.href).toContain('/cases/case_1');
  });

  it('normalizes a decision missing optional `type` without throwing', () => {
    const d = {
      decision_id: 'dec_legacy',
      case_id: 'case_1',
      actor_id: 'u',
      rationale: '',
      snapshot: { active_rule_set_versions: {}, evidence_policy_version: 1, knowledge_asset_refs: [] },
      created_at: '2026-04-19T07:00:00.000Z',
    } as unknown as Decision;

    expect(() => normalizeDecision(d, caseMap)).not.toThrow();
    const row = normalizeDecision(d, caseMap);
    expect(row.id).toBe('decision:dec_legacy');
    expect(row.subkind).toBeUndefined();
    expect(typeof row.summary).toBe('string');
    expect(row.summary.length).toBeGreaterThan(0);
  });

  it('normalizes a workspace_event into a non-case-scoped entry', () => {
    const we: WorkspaceEvent = {
      event_id: 'wse_1',
      type: 'intelligence_run',
      actor_user_id: 'system:arbitra-intelligence',
      actor_metadata: { client_name: 'arbitra-intelligence', client_version: '1.0.0' },
      timestamp: '2026-04-19T09:00:00.000Z',
      summary: 'Ran 5 detectors — 0 new nudges, 1 deduped, 0 errors (duration 412ms)',
      evidence: { detectors: [] },
    };
    const row = normalizeWorkspaceEvent(we);
    expect(row).toMatchObject({
      id: 'workspace_event:wse_1',
      kind: 'workspace_event',
      subkind: 'intelligence_run',
      // Key invariant: workspace events carry no case anchor.
      case_id: '',
      href: '',
      actor_user_id: 'system:arbitra-intelligence',
      summary: we.summary,
    });
    expect(row.actor_metadata).toEqual(we.actor_metadata);
  });

  // Regression: evidence produced by the intelligence detector stores the
  // detection payload as a JSON tail on `summary` (`...\n\n---\n{json}`).
  // Without stripping that tail here, the activity feed leaks raw JSON into
  // the UI row body. Normalizer must surface only the human-readable head.
  it('strips the intelligence JSON payload tail from evidence summary', () => {
    const raw =
      "Risk is `high` on case_x — see detector notes.\n\n---\n" +
      JSON.stringify({
        detector_id: 'high-risk-age',
        signature: 'case:case_x',
        severity: 'warning',
        evidence: { risk_level: 'high' },
        client_name: 'arbitra-intelligence',
      });
    const ev: Evidence = {
      evidence_id: 'ev_intel',
      case_id: 'case_1',
      type: 'detection_report',
      source_type: 'agent',
      summary: raw,
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-04-19T09:00:00.000Z',
      created_by: 'system:intelligence',
    };
    const row = normalizeEvidence(ev, caseMap);
    expect(row.summary).toBe(
      'registered evidence — Risk is `high` on case_x — see detector notes.',
    );
    expect(row.summary).not.toContain('"detector_id"');
    expect(row.summary).not.toContain('---');
  });

  // Non-intelligence evidence summaries have no delimiter — normalizer must
  // leave them untouched.
  it('leaves non-intelligence evidence summary untouched when no JSON tail is present', () => {
    const ev: Evidence = {
      evidence_id: 'ev_plain',
      case_id: 'case_1',
      type: 'ci_result',
      source_type: 'agent',
      summary: 'npm build passed cleanly',
      machine_readable: true,
      validation_track: 'direct',
      created_at: '2026-04-19T09:00:00.000Z',
      created_by: 'usr_1',
    };
    const row = normalizeEvidence(ev, caseMap);
    expect(row.summary).toBe('registered evidence — npm build passed cleanly');
  });

  it('normalizes a finding missing optional `severity` / `title` without throwing', () => {
    const f = {
      finding_id: 'fnd_legacy',
      case_id: 'case_1',
      category: 'bug',
      confidence: 0.5,
      status: 'open',
      description: '',
      origin_type: 'reviewer',
      source_refs: [],
      evidence_refs: [],
      rule_refs: [],
      created_at: '2026-04-19T08:00:00.000Z',
      updated_at: '2026-04-19T08:00:00.000Z',
    } as unknown as Finding;

    expect(() => normalizeFinding(f, caseMap)).not.toThrow();
    const row = normalizeFinding(f, caseMap);
    expect(row.subkind).toBeUndefined();
    expect(typeof row.summary).toBe('string');
    expect(row.summary.length).toBeGreaterThan(0);
  });
});

describe('applyActivityFilters', () => {
  function makeEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
    return {
      id: overrides.id ?? 'x',
      kind: 'comment',
      timestamp: '2026-04-19T00:00:00.000Z',
      case_id: 'case_1',
      summary: 's',
      href: '/cases/case_1',
      ...overrides,
    };
  }

  it('matches clientName case-insensitively (regression for ingest not normalizing)', () => {
    const entries = [
      makeEntry({ id: 'a', actor_metadata: { client_name: 'Claude-Code' } }),
      makeEntry({ id: 'b', actor_metadata: { client_name: 'claude-code' } }),
      makeEntry({ id: 'c', actor_metadata: { client_name: 'cursor' } }),
      makeEntry({ id: 'd' }),
    ];
    const filtered = applyActivityFilters(entries, { clientName: 'claude-code' });
    expect(filtered.map((e) => e.id).sort()).toEqual(['a', 'b']);
    // Same needle in mixed case must still match both variants.
    const upper = applyActivityFilters(entries, { clientName: 'CLAUDE-code' });
    expect(upper.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('applies `before` as a strict-less-than timestamp cutoff', () => {
    const entries = [
      makeEntry({ id: 'old', timestamp: '2026-04-18T00:00:00.000Z' }),
      makeEntry({ id: 'edge', timestamp: '2026-04-19T00:00:00.000Z' }),
      makeEntry({ id: 'new', timestamp: '2026-04-20T00:00:00.000Z' }),
    ];
    const filtered = applyActivityFilters(entries, { before: '2026-04-19T00:00:00.000Z' });
    expect(filtered.map((e) => e.id)).toEqual(['old']);
  });

  it('combines since + before (exclusive on both ends)', () => {
    const entries = [
      makeEntry({ id: 'a', timestamp: '2026-04-18T00:00:00.000Z' }),
      makeEntry({ id: 'b', timestamp: '2026-04-18T12:00:00.000Z' }),
      makeEntry({ id: 'c', timestamp: '2026-04-19T00:00:00.000Z' }),
    ];
    const filtered = applyActivityFilters(entries, {
      since: '2026-04-18T00:00:00.000Z',
      before: '2026-04-19T00:00:00.000Z',
    });
    expect(filtered.map((e) => e.id)).toEqual(['b']);
  });

  it('agentsOnly drops rows without client_name', () => {
    const entries = [
      makeEntry({ id: 'a', actor_metadata: { client_name: 'cursor' } }),
      makeEntry({ id: 'b' }),
    ];
    expect(applyActivityFilters(entries, { agentsOnly: true }).map((e) => e.id)).toEqual(['a']);
  });
});

describe('aggregateLeaderboard', () => {
  it('groups rows by client_name + version + model and sorts desc by total', () => {
    const rows = aggregateLeaderboard([
      { kind: 'comment', timestamp: '', case_id: '1', actor_meta: { client_name: 'claude-code', model: 'opus' } },
      { kind: 'evidence', timestamp: '', case_id: '1', actor_meta: { client_name: 'claude-code', model: 'opus' } },
      { kind: 'comment', timestamp: '', case_id: '2', actor_meta: { client_name: 'cursor', model: 'gpt-5' } },
      // case_event that ISN'T case_created does not count toward totals.
      { kind: 'case_event', timestamp: '', case_id: '3', actor_meta: { client_name: 'cursor' } },
      // case_created counts under cases_created + total.
      { kind: 'case_event', timestamp: '', case_id: '4', actor_meta: { client_name: 'cursor', model: 'gpt-5' }, is_case_created: true },
      // Row without actor_meta falls into the "human" bucket.
      { kind: 'decision', timestamp: '', case_id: '5' },
      { kind: 'decision', timestamp: '', case_id: '6' },
    ]);

    expect(rows).toHaveLength(3);

    const byName = new Map(rows.map((r) => [`${r.client_name}|${r.model ?? ''}`, r]));
    const claude = byName.get('claude-code|opus')!;
    const cursor = byName.get('cursor|gpt-5')!;
    const human = byName.get('human|')!;

    expect(claude).toMatchObject({
      source_kind: 'client',
      counts: { comments: 1, evidence: 1, total: 2 },
    });
    expect(cursor).toMatchObject({
      source_kind: 'client',
      counts: { comments: 1, cases_created: 1, total: 2 },
    });
    expect(human).toMatchObject({
      source_kind: 'human',
      counts: { decisions: 2, total: 2 },
    });

    // Sort is deterministic desc by total; ties ok but totals must be non-increasing.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.counts.total).toBeLessThanOrEqual(rows[i - 1]!.counts.total);
    }
  });

  it('empty input yields empty rows', () => {
    expect(aggregateLeaderboard([])).toEqual([]);
  });

  // Bug regression: evidence rows without actor_metadata were
  // all dumped into the synthetic "human" bucket, producing the misleading
  // "Humans: 909 evidence" line in the UI. These were actually CI / webhook
  // writes that simply never set actor_metadata. Bucketing MUST split by
  // `evidence_source_type` so automated/webhook rows get their own buckets.
  it('splits actor-less evidence by source_type into automated/webhook/human buckets', () => {
    const rows = aggregateLeaderboard([
      {
        kind: 'evidence',
        timestamp: '',
        case_id: 'c1',
        evidence_source_type: 'automated',
      },
      {
        kind: 'evidence',
        timestamp: '',
        case_id: 'c2',
        evidence_source_type: 'automated',
      },
      {
        kind: 'evidence',
        timestamp: '',
        case_id: 'c3',
        evidence_source_type: 'webhook',
      },
      {
        kind: 'evidence',
        timestamp: '',
        case_id: 'c4',
        evidence_source_type: 'manual',
      },
    ]);
    const byName = new Map(rows.map((r) => [r.client_name, r]));
    expect(byName.get('automated')?.counts.evidence).toBe(2);
    expect(byName.get('webhook')?.counts.evidence).toBe(1);
    expect(byName.get('human')?.counts.evidence).toBe(1);
    expect(byName.get('automated')?.source_kind).toBe('automated');
    expect(byName.get('webhook')?.source_kind).toBe('webhook');
    expect(byName.get('human')?.source_kind).toBe('human');
    // Critical invariant: "human" must not absorb CI / webhook writes.
    expect(byName.get('human')?.counts.evidence).not.toBe(4);
  });

  it('routes decisions with actor_user_id="system:*" into the system bucket', () => {
    const rows = aggregateLeaderboard([
      {
        kind: 'decision',
        timestamp: '',
        case_id: 'c1',
        actor_user_id: 'system:arbitra-intelligence',
      },
      {
        kind: 'decision',
        timestamp: '',
        case_id: 'c2',
        actor_user_id: 'system',
      },
      // A real human reviewer — stays in the human bucket.
      {
        kind: 'decision',
        timestamp: '',
        case_id: 'c3',
        actor_user_id: 'usr_alice',
      },
    ]);
    const byName = new Map(rows.map((r) => [r.client_name, r]));
    expect(byName.get('system')?.counts.decisions).toBe(2);
    expect(byName.get('system')?.source_kind).toBe('system');
    expect(byName.get('human')?.counts.decisions).toBe(1);
    // And the system bucket must not be polluted by the human row.
    expect(byName.get('system')?.counts.decisions).not.toBe(3);
  });

  it('preserves existing behavior: rows WITH actor_metadata still bucket by client_name', () => {
    // Regression guard for the bucketing refactor — the `actor_metadata` path
    // must take precedence over any synthetic sentinel resolution, so the
    // intelligence scheduler's evidence (written as `system:intelligence` but
    // tagged with `client_name: arbitra-intelligence`) still lands in the
    // "arbitra-intelligence" bucket, NOT "system".
    const rows = aggregateLeaderboard([
      {
        kind: 'evidence',
        timestamp: '',
        case_id: 'c1',
        evidence_source_type: 'agent',
        actor_user_id: 'system:intelligence',
        actor_meta: { client_name: 'arbitra-intelligence', client_version: '1.0.0' },
      },
      {
        kind: 'decision',
        timestamp: '',
        case_id: 'c2',
        actor_user_id: 'system:intelligence',
        actor_meta: { client_name: 'arbitra-intelligence', client_version: '1.0.0' },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_name).toBe('arbitra-intelligence');
    expect(rows[0]!.source_kind).toBe('client');
    expect(rows[0]!.counts).toMatchObject({ evidence: 1, decisions: 1, total: 2 });
  });

  // Bug regression: on a manual-track approve,
  // `decision-service.ts` writes two decisions sharing case_id + actor_id +
  // actor_metadata (the auto-attached `manual_validation_confirmed` plus the
  // user-driven `approve`). Both inherit the parent click's actor_metadata,
  // so post-PR #490 they bucket under the same per-client name and one click
  // counts twice. The leaderboard aggregation must collapse the pair and only
  // count the user-driven `approve`.
  it('collapses the manual-track approve auto-attach pair (one click != two)', () => {
    const rows = aggregateLeaderboard([
      {
        kind: 'decision',
        timestamp: '2026-04-30T12:00:00.000Z',
        case_id: 'case_1',
        actor_user_id: 'usr_alice',
        decision_type: 'manual_validation_confirmed',
        actor_meta: { client_name: 'cursor', client_version: '0.42.1' },
      },
      {
        kind: 'decision',
        timestamp: '2026-04-30T12:00:00.020Z',
        case_id: 'case_1',
        actor_user_id: 'usr_alice',
        decision_type: 'approve',
        actor_meta: { client_name: 'cursor', client_version: '0.42.1' },
      },
    ]);
    expect(rows).toHaveLength(1);
    const cursor = rows[0]!;
    expect(cursor.client_name).toBe('cursor');
    // One click = one decision, NOT two.
    expect(cursor.counts.decisions).toBe(1);
    expect(cursor.counts.total).toBe(1);
  });

  it('does not collapse a non-paired direct-track approve (no manual_validation_confirmed sibling)', () => {
    const rows = aggregateLeaderboard([
      {
        kind: 'decision',
        timestamp: '2026-04-30T12:00:00.000Z',
        case_id: 'case_1',
        actor_user_id: 'usr_alice',
        decision_type: 'approve',
        actor_meta: { client_name: 'cursor' },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counts.decisions).toBe(1);
    expect(rows[0]!.counts.total).toBe(1);
  });

  it('does not over-collapse two genuine separate approves by the same actor-client at distinct timestamps', () => {
    // Two real approves on different cases, well outside the pair tolerance.
    // No manual_validation_confirmed mate exists, so neither is dropped — and
    // even if a mate existed, the > tolerance gap would prevent collapse.
    const rows = aggregateLeaderboard([
      {
        kind: 'decision',
        timestamp: '2026-04-30T12:00:00.000Z',
        case_id: 'case_1',
        actor_user_id: 'usr_alice',
        decision_type: 'approve',
        actor_meta: { client_name: 'cursor' },
      },
      {
        kind: 'decision',
        timestamp: '2026-04-30T12:05:00.000Z',
        case_id: 'case_2',
        actor_user_id: 'usr_alice',
        decision_type: 'approve',
        actor_meta: { client_name: 'cursor' },
      },
      // Sanity guard: a stale manual_validation_confirmed from 10 minutes
      // earlier on case_1 must NOT collapse into the fresh approve — outside
      // the 5s pair-tolerance.
      {
        kind: 'decision',
        timestamp: '2026-04-30T11:50:00.000Z',
        case_id: 'case_1',
        actor_user_id: 'usr_alice',
        decision_type: 'manual_validation_confirmed',
        actor_meta: { client_name: 'cursor' },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_name).toBe('cursor');
    // Two genuine approves + one stale confirmation = 3 decisions, NOT 2.
    expect(rows[0]!.counts.decisions).toBe(3);
    expect(rows[0]!.counts.total).toBe(3);
  });

  it('counts workspace_events toward a dedicated bucket AND the total', () => {
    const rows = aggregateLeaderboard([
      {
        kind: 'workspace_event',
        timestamp: '',
        case_id: '',
        actor_meta: { client_name: 'arbitra-intelligence', client_version: '1.0.0' },
      },
      {
        kind: 'workspace_event',
        timestamp: '',
        case_id: '',
        actor_meta: { client_name: 'arbitra-intelligence', client_version: '1.0.0' },
      },
      // Different intelligence-authored action — same actor bucket.
      {
        kind: 'case_event',
        timestamp: '',
        case_id: 'c1',
        actor_meta: { client_name: 'arbitra-intelligence', client_version: '1.0.0' },
        is_case_created: true,
      },
    ]);
    expect(rows).toHaveLength(1);
    const intel = rows[0]!;
    expect(intel.client_name).toBe('arbitra-intelligence');
    expect(intel.counts).toMatchObject({
      workspace_events: 2,
      cases_created: 1,
      total: 3,
    });
  });
});

describe('aggregateProjectLeaderboard', () => {
  it('groups case-scoped activity by project and counts active cases', () => {
    const caseMap = new Map([
      ['case_1', makeCase({ case_id: 'case_1', project_id: 'proj_a' })],
      ['case_2', makeCase({ case_id: 'case_2', project_id: 'proj_a' })],
      ['case_3', makeCase({ case_id: 'case_3', project_id: 'proj_b' })],
    ]);
    const projectMap = new Map([
      ['proj_a', 'Alpha'],
      ['proj_b', 'Beta'],
    ]);

    const rows = aggregateProjectLeaderboard(
      [
        { kind: 'comment', timestamp: '', case_id: 'case_1' },
        { kind: 'decision', timestamp: '', case_id: 'case_1' },
        { kind: 'evidence', timestamp: '', case_id: 'case_2' },
        { kind: 'case_event', timestamp: '', case_id: 'case_3', is_case_created: true },
        { kind: 'workspace_event', timestamp: '', case_id: '' },
      ],
      caseMap,
      projectMap,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        project_id: 'proj_a',
        project_name: 'Alpha',
        active_cases: 2,
        counts: expect.objectContaining({
          comments: 1,
          decisions: 1,
          evidence: 1,
          total: 3,
        }),
      }),
      expect.objectContaining({
        project_id: 'proj_b',
        project_name: 'Beta',
        active_cases: 1,
        counts: expect.objectContaining({
          cases_created: 1,
          total: 1,
        }),
      }),
    ]);
  });
});
