import { describe, it, expect } from 'vitest';
import {
  createCaseSchema,
  updateCaseSchema,
  caseFiltersSchema,
} from '../validation/case-validators.js';
import {
  inlineAttachmentSchema,
  gitContextSchema,
  createArtifactSchema,
} from '../validation/artifact-validators.js';
import { transitionRequestSchema } from '../validation/transition-validators.js';
import {
  canonicalEvidenceTypeSchema,
  createEvidenceSchema,
  evidencePolicyRuleSchema,
} from '../validation/evidence-validators.js';
import { CANONICAL_EVIDENCE_TYPES } from '../types/evidence.js';
import {
  CLIENT_DECISION_TYPES,
  createDecisionSchema,
  decisionSchema,
} from '../validation/decision-validators.js';
import { DECISION_TYPES, SYSTEM_DECISION_TYPES } from '../types/decision.js';
import { createCommentSchema } from '../validation/comment-validators.js';

// ── createCaseSchema ────────────────────────────────────────────────

describe('createCaseSchema', () => {
  const validCase = {
    title: 'Implement user auth',
    description: 'Add OAuth2 login flow',
    source_type: 'jira' as const,
    project_id: 'proj-1',
    repository_id: 'repo-1',
    validation_track: 'direct' as const,
    risk_level: 'medium' as const,
    priority: 'normal' as const,
  };

  it('accepts a valid minimal case', () => {
    const result = createCaseSchema.safeParse(validCase);
    expect(result.success).toBe(true);
  });

  it('accepts a case with all optional fields', () => {
    const full = {
      ...validCase,
      source_ref: 'JIRA-123',
      case_type: 'ticket_implementation',
      current_branch: 'feature/auth',
      current_pr_ref: 'https://github.com/org/repo/pull/42',
      jira_refs: ['JIRA-123', 'JIRA-124'],
      assigned_reviewer_id: 'user-42',
      active_rule_set_refs: ['rs-1'],
      knowledge_context_refs: ['kc-1'],
      attachments: [
        { filename: 'screenshot.png', content_type: 'image/png', data: 'aGVsbG8=' },
      ],
      git_context: {
        branch: 'feature/auth',
        remote_url: 'https://github.com/org/repo.git',
        commit_sha: 'abc123',
      },
    };
    const result = createCaseSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  // ── Required field validation ──

  it('rejects when title is missing', () => {
    const { title, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts when description is missing (defaults to empty string)', () => {
    const { description, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('');
    }
  });

  it('rejects when source_type is missing', () => {
    const { source_type, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when project_id is missing', () => {
    const { project_id, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when repository_id is missing', () => {
    const { repository_id, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts when validation_track is missing (defaults to project setting)', () => {
    const { validation_track, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('rejects when risk_level is missing', () => {
    const { risk_level, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when priority is missing', () => {
    const { priority, ...rest } = validCase;
    const result = createCaseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  // ── Field constraints ──

  it('rejects empty title', () => {
    const result = createCaseSchema.safeParse({ ...validCase, title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects title exceeding 500 characters', () => {
    const result = createCaseSchema.safeParse({ ...validCase, title: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('accepts title at exactly 500 characters', () => {
    const result = createCaseSchema.safeParse({ ...validCase, title: 'x'.repeat(500) });
    expect(result.success).toBe(true);
  });

  it('accepts empty description (default behavior)', () => {
    const result = createCaseSchema.safeParse({ ...validCase, description: '' });
    expect(result.success).toBe(true);
  });

  it('rejects description exceeding 10000 characters', () => {
    const result = createCaseSchema.safeParse({ ...validCase, description: 'x'.repeat(10001) });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source_type', () => {
    const result = createCaseSchema.safeParse({ ...validCase, source_type: 'slack' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid source_type values', () => {
    for (const st of ['jira', 'manual', 'git', 'other']) {
      const result = createCaseSchema.safeParse({ ...validCase, source_type: st });
      expect(result.success, `source_type "${st}" should be valid`).toBe(true);
    }
  });

  it('rejects invalid validation_track', () => {
    const result = createCaseSchema.safeParse({ ...validCase, validation_track: 'auto' });
    expect(result.success).toBe(false);
  });

  it('accepts both valid validation_track values', () => {
    for (const vt of ['direct', 'manual']) {
      const result = createCaseSchema.safeParse({ ...validCase, validation_track: vt });
      expect(result.success, `validation_track "${vt}" should be valid`).toBe(true);
    }
  });

  it('rejects invalid risk_level', () => {
    const result = createCaseSchema.safeParse({ ...validCase, risk_level: 'extreme' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid risk_level values', () => {
    for (const rl of ['low', 'medium', 'high', 'critical']) {
      const result = createCaseSchema.safeParse({ ...validCase, risk_level: rl });
      expect(result.success, `risk_level "${rl}" should be valid`).toBe(true);
    }
  });

  it('rejects invalid priority', () => {
    const result = createCaseSchema.safeParse({ ...validCase, priority: 'critical' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid priority values', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) {
      const result = createCaseSchema.safeParse({ ...validCase, priority: p });
      expect(result.success, `priority "${p}" should be valid`).toBe(true);
    }
  });

  it('rejects invalid case_type', () => {
    const result = createCaseSchema.safeParse({ ...validCase, case_type: 'deployment' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid case_type values', () => {
    for (const ct of ['ticket_implementation', 'bugfix', 'refactoring', 'pr_review', 'manual_verification', 'other']) {
      const result = createCaseSchema.safeParse({ ...validCase, case_type: ct });
      expect(result.success, `case_type "${ct}" should be valid`).toBe(true);
    }
  });

  it('rejects empty project_id', () => {
    const result = createCaseSchema.safeParse({ ...validCase, project_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty repository_id', () => {
    const result = createCaseSchema.safeParse({ ...validCase, repository_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects attachments exceeding max count of 20', () => {
    const attachments = Array.from({ length: 21 }, (_, i) => ({
      filename: `file-${i}.txt`,
      content_type: 'text/plain',
      data: 'dGVzdA==',
    }));
    const result = createCaseSchema.safeParse({ ...validCase, attachments });
    expect(result.success).toBe(false);
  });

  it('accepts attachments at exactly 20', () => {
    const attachments = Array.from({ length: 20 }, (_, i) => ({
      filename: `file-${i}.txt`,
      content_type: 'text/plain',
      data: 'dGVzdA==',
    }));
    const result = createCaseSchema.safeParse({ ...validCase, attachments });
    expect(result.success).toBe(true);
  });

  it('rejects jira_refs with empty strings', () => {
    const result = createCaseSchema.safeParse({ ...validCase, jira_refs: [''] });
    expect(result.success).toBe(false);
  });

  it('rejects jira_refs exceeding 50 characters', () => {
    const result = createCaseSchema.safeParse({ ...validCase, jira_refs: ['x'.repeat(51)] });
    expect(result.success).toBe(false);
  });
});

// ── updateCaseSchema ────────────────────────────────────────────────

describe('updateCaseSchema', () => {
  it('accepts empty object (no fields to update)', () => {
    const result = updateCaseSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts partial update with title only', () => {
    const result = updateCaseSchema.safeParse({ title: 'Updated title' });
    expect(result.success).toBe(true);
  });

  it('rejects empty title when provided', () => {
    const result = updateCaseSchema.safeParse({ title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects title exceeding 500 chars when provided', () => {
    const result = updateCaseSchema.safeParse({ title: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('rejects invalid risk_level', () => {
    const result = updateCaseSchema.safeParse({ risk_level: 'extreme' });
    expect(result.success).toBe(false);
  });

  it('accepts valid risk_level', () => {
    const result = updateCaseSchema.safeParse({ risk_level: 'high' });
    expect(result.success).toBe(true);
  });

  it('accepts multiple optional fields at once', () => {
    const result = updateCaseSchema.safeParse({
      title: 'New title',
      description: 'New description',
      risk_level: 'critical',
      priority: 'urgent',
      case_type: 'bugfix',
    });
    expect(result.success).toBe(true);
  });

  // ── assistant_context hold fields ──
  //
  // `failed_permanently` is only satisfiable as a terminal verdict attributed to
  // a specific run: `assistant_hold_documented` excludes the reason outright and
  // `assistant_terminal_failure_documented` compares `wait_run_id` against the
  // case's latest assistant run. Accepting the unattributed combination here
  // would let PATCH /api/cases (and MCP `update_case`) leave a case in `in_build`
  // with no auto edge at all and no run marker for the sweep to find it by.

  const assistantContext = {
    channel: 'google_chat',
    conversation_visibility: 'direct' as const,
    requester_user_id: 'usr_requester',
    risk_level: 'low',
    policy_version: 'assistant-policy:v1',
    prompt_version: 'assistant-system:v1',
  };

  it("rejects wait_reason 'failed_permanently' without wait_run_id", () => {
    const result = updateCaseSchema.safeParse({
      assistant_context: { ...assistantContext, wait_reason: 'failed_permanently' },
    });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join('.')))
      .toContain('assistant_context.wait_run_id');
  });

  it("accepts wait_reason 'failed_permanently' with wait_run_id", () => {
    const result = updateCaseSchema.safeParse({
      assistant_context: {
        ...assistantContext,
        wait_reason: 'failed_permanently',
        wait_run_id: 'run_a1',
        wait_attempt: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('still accepts an unscoped clarification or retry_exhausted hold', () => {
    // Holds written before the run scope existed are honoured unscoped, so a
    // client round-tripping one must not be rejected.
    for (const wait_reason of ['clarification', 'retry_exhausted'] as const) {
      const result = updateCaseSchema.safeParse({
        assistant_context: { ...assistantContext, wait_reason },
      });
      expect(result.success, wait_reason).toBe(true);
    }
  });

  it('rejects an unattributed terminal verdict on case creation too', () => {
    const result = createCaseSchema.safeParse({
      title: 'Summarise the audit findings',
      source_type: 'google_chat' as const,
      project_id: 'proj-1',
      repository_id: 'repo-1',
      risk_level: 'low' as const,
      priority: 'normal' as const,
      case_type: 'assistant_task' as const,
      assistant_context: { ...assistantContext, wait_reason: 'failed_permanently' },
    });
    expect(result.success).toBe(false);
  });
});

// ── caseFiltersSchema ───────────────────────────────────────────────

describe('caseFiltersSchema', () => {
  it('accepts empty object (defaults apply)', () => {
    const result = caseFiltersSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it('accepts valid status filter', () => {
    const result = caseFiltersSchema.safeParse({ status: 'open' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status filter', () => {
    const result = caseFiltersSchema.safeParse({ status: 'pending' });
    expect(result.success).toBe(false);
  });

  it('coerces limit from string to number', () => {
    const result = caseFiltersSchema.safeParse({ limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects limit below 1', () => {
    const result = caseFiltersSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects limit above 100', () => {
    const result = caseFiltersSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('accepts all valid filter combinations', () => {
    const result = caseFiltersSchema.safeParse({
      status: 'in_review',
      project_id: 'proj-1',
      repository_id: 'repo-1',
      owner_user_id: 'user-1',
      validation_track: 'manual',
      risk_level: 'high',
      priority: 'urgent',
      cursor: 'abc123',
      limit: 50,
    });
    expect(result.success).toBe(true);
  });
});

// ── transitionRequestSchema ─────────────────────────────────────────

describe('transitionRequestSchema', () => {
  it('accepts valid target_status', () => {
    const result = transitionRequestSchema.safeParse({ target_status: 'exploration' });
    expect(result.success).toBe(true);
  });

  it('rejects missing target_status', () => {
    const result = transitionRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects invalid target_status', () => {
    const result = transitionRequestSchema.safeParse({ target_status: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid case statuses as target', () => {
    const statuses = [
      'open', 'exploration', 'ready_for_build', 'in_build', 'in_validation',
      'in_review', 'needs_human_decision', 'verification_pending',
      'approved', 'done', 'rejected',
    ];
    for (const s of statuses) {
      const result = transitionRequestSchema.safeParse({ target_status: s });
      expect(result.success, `target_status "${s}" should be valid`).toBe(true);
    }
  });
});

// ── Artifact validators ─────────────────────────────────────────────

describe('inlineAttachmentSchema', () => {
  it('accepts a valid attachment', () => {
    const result = inlineAttachmentSchema.safeParse({
      filename: 'test.png',
      content_type: 'image/png',
      data: 'aGVsbG8=',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty filename', () => {
    const result = inlineAttachmentSchema.safeParse({
      filename: '',
      content_type: 'image/png',
      data: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
  });

  it('rejects filename exceeding 255 chars', () => {
    const result = inlineAttachmentSchema.safeParse({
      filename: 'x'.repeat(256),
      content_type: 'image/png',
      data: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty content_type', () => {
    const result = inlineAttachmentSchema.safeParse({
      filename: 'test.png',
      content_type: '',
      data: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty data', () => {
    const result = inlineAttachmentSchema.safeParse({
      filename: 'test.png',
      content_type: 'image/png',
      data: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(inlineAttachmentSchema.safeParse({}).success).toBe(false);
    expect(inlineAttachmentSchema.safeParse({ filename: 'x' }).success).toBe(false);
  });
});

describe('gitContextSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = gitContextSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a full git context', () => {
    const result = gitContextSchema.safeParse({
      branch: 'feature/auth',
      remote_url: 'https://github.com/org/repo.git',
      commit_sha: 'abc123def456',
      pr_ref: 'https://github.com/org/repo/pull/42',
      repo_root: '/home/user/projects/repo',
    });
    expect(result.success).toBe(true);
  });

  it('rejects branch exceeding 255 chars', () => {
    const result = gitContextSchema.safeParse({ branch: 'x'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('rejects commit_sha exceeding 40 chars', () => {
    const result = gitContextSchema.safeParse({ commit_sha: 'x'.repeat(41) });
    expect(result.success).toBe(false);
  });
});

describe('createArtifactSchema', () => {
  it('accepts a valid artifact', () => {
    const result = createArtifactSchema.safeParse({
      filename: 'report.pdf',
      content_type: 'application/pdf',
      data: 'aGVsbG8=',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing data', () => {
    const result = createArtifactSchema.safeParse({
      filename: 'report.pdf',
      content_type: 'application/pdf',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty filename', () => {
    const result = createArtifactSchema.safeParse({
      filename: '',
      content_type: 'application/pdf',
      data: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
  });
});

// ── Evidence validators ─────────────────────────────────────────────

describe('createEvidenceSchema', () => {
  it('accepts valid evidence', () => {
    const result = createEvidenceSchema.safeParse({
      case_id: 'case-1',
      type: 'ci_result',
      source_type: 'automated',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing case_id', () => {
    const result = createEvidenceSchema.safeParse({
      type: 'ci_result',
      source_type: 'automated',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty case_id', () => {
    const result = createEvidenceSchema.safeParse({
      case_id: '',
      type: 'ci_result',
      source_type: 'automated',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source_type', () => {
    const result = createEvidenceSchema.safeParse({
      case_id: 'case-1',
      type: 'ci_result',
      source_type: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid source_type values', () => {
    for (const st of ['automated', 'manual', 'webhook', 'agent']) {
      const result = createEvidenceSchema.safeParse({
        case_id: 'case-1',
        type: 'ci_result',
        source_type: st,
      });
      expect(result.success, `source_type "${st}" should be valid`).toBe(true);
    }
  });

  it('defaults machine_readable to false', () => {
    const result = createEvidenceSchema.safeParse({
      case_id: 'case-1',
      type: 'ci_result',
      source_type: 'automated',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.machine_readable).toBe(false);
    }
  });

  // createEvidenceSchema stays permissive on `type` (webhooks / policy custom
  // types). The strict canonical gate lives in canonicalEvidenceTypeSchema and
  // is wired only at the agent build-complete boundary.
  it('still accepts a non-canonical type (permissive base schema)', () => {
    const result = createEvidenceSchema.safeParse({
      case_id: 'case-1',
      type: 'manual_verification',
      source_type: 'manual',
    });
    expect(result.success).toBe(true);
  });
});

describe('canonicalEvidenceTypeSchema', () => {
  it('accepts every canonical evidence type', () => {
    for (const t of CANONICAL_EVIDENCE_TYPES) {
      expect(canonicalEvidenceTypeSchema.safeParse(t).success, t).toBe(true);
    }
  });

  it('rejects a non-canonical type', () => {
    const result = canonicalEvidenceTypeSchema.safeParse('manual_verification');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(canonicalEvidenceTypeSchema.safeParse('').success).toBe(false);
  });
});

// ── Decision validators ─────────────────────────────────────────────

describe('createDecisionSchema', () => {
  it('accepts a valid decision', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: 'All checks passed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing rationale', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty rationale', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects rationale exceeding 5000 chars', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: 'x'.repeat(5001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid decision type', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'maybe',
      rationale: 'Not sure',
    });
    expect(result.success).toBe(false);
  });

  it('accepts every client-submittable decision type', () => {
    for (const t of CLIENT_DECISION_TYPES) {
      const result = createDecisionSchema.safeParse({
        case_id: 'case-1',
        type: t,
        rationale: 'Because reasons',
      });
      expect(result.success, `decision type "${t}" should be valid`).toBe(true);
    }
  });

  it('rejects every system-only decision type at the intake boundary', () => {
    // `auto_approve` and `waived_on_completion` are written by the pipeline with
    // actor `system:pipeline`. A client must not be able to forge either through
    // POST /api/cases/:caseId/decisions (issue #751).
    for (const t of SYSTEM_DECISION_TYPES) {
      const result = createDecisionSchema.safeParse({
        case_id: 'case-1',
        type: t,
        rationale: 'Because reasons',
      });
      expect(result.success, `system decision type "${t}" must be rejected`).toBe(false);
    }
  });

  it('splits DECISION_TYPES into exactly client + system with no overlap or gap', () => {
    expect([...CLIENT_DECISION_TYPES, ...SYSTEM_DECISION_TYPES].sort()).toEqual(
      [...DECISION_TYPES].sort(),
    );
    for (const t of SYSTEM_DECISION_TYPES) {
      expect(CLIENT_DECISION_TYPES).not.toContain(t);
    }
  });

  it('still accepts every decision type on the persisted-record schema', () => {
    // The restriction is on intake only — a system decision read back from
    // Firestore must validate, otherwise the audit trail fails to parse.
    for (const t of DECISION_TYPES) {
      const result = decisionSchema.safeParse({
        decision_id: 'dec_1',
        case_id: 'case-1',
        type: t,
        actor_id: 'system:pipeline',
        rationale: 'Because reasons',
        snapshot: {
          active_rule_set_versions: {},
          evidence_policy_version: 1,
          knowledge_asset_refs: [],
        },
        created_at: '2026-01-01T00:00:00Z',
      });
      expect(result.success, `persisted decision type "${t}" should be valid`).toBe(true);
    }
  });

  it('accepts gate_confirmed (regression: PR #223 bug)', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'gate_confirmed',
      rationale: 'Gate confirmed by reviewer',
    });
    expect(result.success).toBe(true);
  });

  it('accepts gate_rejected (regression: PR #223 bug)', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'gate_rejected',
      rationale: 'Gate declined by reviewer',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional finding_id', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      finding_id: 'finding-1',
      type: 'waive',
      rationale: 'Known issue',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional actor_metadata with all fields', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: 'ok',
      actor_metadata: {
        client_name: 'cursor',
        client_version: '0.42.1',
        model: 'claude-opus-4-7',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts partial actor_metadata (single field)', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: 'ok',
      actor_metadata: { client_name: 'claude-code' },
    });
    expect(result.success).toBe(true);
  });

  it('omits actor_metadata entirely (back-compat)', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: 'ok',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys inside actor_metadata (strict)', () => {
    const result = createDecisionSchema.safeParse({
      case_id: 'case-1',
      type: 'approve',
      rationale: 'ok',
      actor_metadata: {
        client_name: 'cursor',
        unknown_field: 'nope',
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── Persisted Decision validator (self_approved audit) ──────────────

describe('decisionSchema (persisted record)', () => {
  const baseDecision = {
    decision_id: 'dec_1',
    case_id: 'case_1',
    type: 'approve' as const,
    actor_id: 'usr_1',
    rationale: 'ok',
    snapshot: {
      active_rule_set_versions: {},
      evidence_policy_version: 1,
      knowledge_asset_refs: [],
    },
    created_at: '2026-01-01T00:00:00Z',
  };

  it('accepts a decision without self_approved (non-owner path)', () => {
    const result = decisionSchema.safeParse(baseDecision);
    expect(result.success).toBe(true);
  });

  it('accepts a decision with self_approved: true', () => {
    const result = decisionSchema.safeParse({ ...baseDecision, self_approved: true });
    expect(result.success).toBe(true);
  });

  it('accepts a decision with self_approved: false (boolean still permitted)', () => {
    // The type is optional but boolean — the server never writes false, but the
    // validator should still tolerate a stored false value without rejecting.
    const result = decisionSchema.safeParse({ ...baseDecision, self_approved: false });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean self_approved', () => {
    const result = decisionSchema.safeParse({ ...baseDecision, self_approved: 'yes' });
    expect(result.success).toBe(false);
  });

  it('accepts a persisted decision with actor_metadata', () => {
    const result = decisionSchema.safeParse({
      ...baseDecision,
      actor_metadata: {
        client_name: 'cursor',
        client_version: '0.42.1',
        model: 'claude-opus-4-7',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a persisted decision without actor_metadata (back-compat)', () => {
    const result = decisionSchema.safeParse(baseDecision);
    expect(result.success).toBe(true);
  });

  it('preserves exact snapshot fidelity and evidence-policy identity', () => {
    const result = decisionSchema.parse({
      ...baseDecision,
      snapshot: {
        ...baseDecision.snapshot,
        evidence_policy_id: 'policy_governance',
        snapshot_fidelity: 'exact',
      },
    });

    expect(result.snapshot.evidence_policy_id).toBe('policy_governance');
    expect(result.snapshot.snapshot_fidelity).toBe('exact');
  });

  it('rejects an unknown snapshot fidelity value', () => {
    const result = decisionSchema.safeParse({
      ...baseDecision,
      snapshot: {
        ...baseDecision.snapshot,
        snapshot_fidelity: 'approximate',
      },
    });

    expect(result.success).toBe(false);
  });
});

// ── EvidencePolicyRule validator ────────────────────────────────────

describe('evidencePolicyRuleSchema', () => {
  const validRule = {
    required_evidence_types: ['ci_result'],
    optional_evidence_types: ['lint_result'],
    four_eyes_required: false,
    allow_self_approval: false,
  };

  it('accepts a valid rule with allow_self_approval=false', () => {
    const result = evidencePolicyRuleSchema.safeParse(validRule);
    expect(result.success).toBe(true);
  });

  it('accepts a valid rule with allow_self_approval=true', () => {
    const result = evidencePolicyRuleSchema.safeParse({ ...validRule, allow_self_approval: true });
    expect(result.success).toBe(true);
  });

  it('rejects a rule missing allow_self_approval', () => {
    const { allow_self_approval, ...rest } = validRule;
    const result = evidencePolicyRuleSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a rule where allow_self_approval is not a boolean', () => {
    const result = evidencePolicyRuleSchema.safeParse({
      ...validRule,
      allow_self_approval: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rule missing four_eyes_required', () => {
    const { four_eyes_required, ...rest } = validRule;
    const result = evidencePolicyRuleSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ── Comment validators ──────────────────────────────────────────────

describe('createCommentSchema', () => {
  it('accepts a valid comment', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'case',
      parent_id: 'case-1',
      body: 'Looks good to me',
    });
    expect(result.success).toBe(true);
  });

  it('accepts comment on a finding', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'finding',
      parent_id: 'finding-1',
      body: 'This is a false positive',
    });
    expect(result.success).toBe(true);
  });

  it('accepts comment attachments', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'case',
      parent_id: 'case-1',
      body: 'See attached screenshot',
      attachments: [
        {
          filename: 'screenshot.png',
          content_type: 'image/png',
          data: 'aGVsbG8=',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects comments with more than 20 attachments', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'case',
      parent_id: 'case-1',
      body: 'Too many files',
      attachments: Array.from({ length: 21 }, (_, i) => ({
        filename: `file-${i}.txt`,
        content_type: 'text/plain',
        data: 'aGVsbG8=',
      })),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid parent_type', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'decision',
      parent_id: 'dec-1',
      body: 'Not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty body', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'case',
      parent_id: 'case-1',
      body: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects body exceeding 10000 chars', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'case',
      parent_id: 'case-1',
      body: 'x'.repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty parent_id', () => {
    const result = createCommentSchema.safeParse({
      parent_type: 'case',
      parent_id: '',
      body: 'Hello',
    });
    expect(result.success).toBe(false);
  });
});
