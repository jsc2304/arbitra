/**
 * EventNotifier — first real test suite for event -> notification mapping
 * (spec `docs/specs/clerk-config-scheduling-chat.md`, slice C item 1/5),
 * extended by slice D for the requester-scoped Google Chat ping. Focused on
 * the events newly wired by slice C: `case_completed`,
 * `assistant_task_completed`/`assistant_task_failed` (requester-scoped, no
 * PROJECT Chat), `run_failed`/`run_retries_exhausted`, and the corrected
 * `rule_results_attached` -> `rule_violation`/`critical_finding` mapping;
 * plus slice D's own describe blocks below for the requester's personal
 * webhook. Pre-fix this suite did not exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Case, Finding, RuleResult, User } from '@arbitra/shared';
// The REAL chat-reply-poster module (Slice F) — not mocked. Its own test
// seam (`setChatReplyPosterForTesting`) is what the completion-hook tests
// below inject through, exactly as intended for any caller that imports the
// real singleton rather than mocking `@arbitra/backend` wholesale (contrast
// `route.test.ts`, which DOES mock the whole package and so fakes
// `getChatReplyPoster` directly on that mock instead).
import { setChatReplyPosterForTesting, CHAT_MESSAGE_MAX_BYTES } from '../chat/chat-reply-poster.js';

const notifyMock = vi.fn().mockResolvedValue(undefined);
const reconcileGateDecisionMock = vi.fn().mockResolvedValue(0);
const reconcileCaseNeedsDecisionMock = vi.fn().mockResolvedValue(0);
vi.mock('./notification-service.js', () => ({
  NotificationService: class {
    notify = notifyMock;
    reconcileGateDecision = reconcileGateDecisionMock;
    reconcileCaseNeedsDecision = reconcileCaseNeedsDecisionMock;
  },
}));

const dispatchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./notification-dispatcher.js', () => ({
  NotificationDispatcher: class {
    dispatch = dispatchMock;
  },
}));

const chatSendMock = vi.fn().mockResolvedValue({ ok: true, status: 200, attempts: 1 });
vi.mock('./google-chat-notifier.js', () => ({
  GoogleChatNotifier: class {
    send = chatSendMock;
  },
}));

const userDocUpdateMock = vi.fn().mockResolvedValue(undefined);

// Slice F: the answer lookup EventNotifier reads the Clerk answer through.
// Mocked at the module level (not constructor-injected) — same pattern as
// every other collaborator in this file.
const answerLookupMock = vi.fn().mockResolvedValue(null);
vi.mock('../assistant/assistant-answer-lookup.js', () => ({
  AssistantAnswerLookup: class {
    getAnswerForCase = answerLookupMock;
  },
}));

// Merge-time enforcement (issue #988): `EventNotifier` calls the commit-status
// publisher inline as its single choke point — mocked here so these tests
// assert WHEN it is called (and with what) without exercising its own GitHub
// fetch logic, which `commit-status-service.test.ts` covers directly.
const publishCommitStatusMock = vi.fn().mockResolvedValue({ published: true, state: 'pending' });
vi.mock('../webhook/commit-status-service.js', () => ({
  publishCaseCommitStatus: (...args: unknown[]) => publishCommitStatusMock(...args),
}));

// Slice F: the fake poster injected via the REAL `setChatReplyPosterForTesting`
// (see the import above), and the case-doc update mock backing the
// double-post guard (`assistant_context.chat_reply_posted_at`). Unlike
// `userDocUpdateMock` above, this one actually MUTATES `state.case` on the
// exact dot-path key `markChatReplyPosted` writes, so a second `getCase`
// read within the same test sees the flag — required for the double-post
// guard test to be meaningful rather than vacuous.
const chatReplyPostMock = vi.fn().mockResolvedValue({ ok: true });
const CHAT_REPLY_POSTED_KEY = 'assistant_context.chat_reply_posted_at';
const caseDocUpdateMock = vi.fn(async (patch: Record<string, unknown>) => {
  if (state.case && CHAT_REPLY_POSTED_KEY in patch) {
    state.case = {
      ...state.case,
      assistant_context: state.case.assistant_context
        ? { ...state.case.assistant_context, chat_reply_posted_at: patch[CHAT_REPLY_POSTED_KEY] as string }
        : state.case.assistant_context,
    };
  }
});

// Mutable per-test fixtures the Firestore double reads from.
const state: {
  case: Case | null;
  project: { exists: boolean; data: Record<string, unknown> };
  ruleResults: RuleResult[];
  findings: Finding[];
  users: { user_id: string; roles: string[] }[];
  /** Doc-id-keyed user documents for `collections.users().doc(id)` (slice D). */
  userDocsById: Record<string, Partial<User>>;
} = {
  case: null,
  project: { exists: false, data: {} },
  ruleResults: [],
  findings: [],
  users: [],
  userDocsById: {},
};

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    cases: () => ({
      doc: () => ({
        get: async () => ({
          exists: state.case !== null,
          data: () => state.case,
        }),
        update: caseDocUpdateMock,
      }),
    }),
    projects: () => ({
      doc: () => ({
        get: async () => ({ exists: state.project.exists, data: () => state.project.data }),
      }),
    }),
    users: () => ({
      get: async () => ({ docs: state.users.map((u) => ({ data: () => u })) }),
      doc: (userId: string) => ({
        get: async () => {
          const data = state.userDocsById[userId];
          return { exists: data !== undefined, data: () => data };
        },
        update: userDocUpdateMock,
      }),
    }),
    ruleResults: () => ({
      where: () => ({
        get: async () => ({ docs: state.ruleResults.map((r) => ({ data: () => r })) }),
      }),
    }),
    findings: () => ({
      where: () => ({
        get: async () => ({ docs: state.findings.map((f) => ({ data: () => f })) }),
      }),
    }),
    decisions: () => ({
      doc: () => ({ get: async () => ({ exists: false }) }),
    }),
  },
}));

const { EventNotifier } = await import('./event-notifier.js');

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    case_id: 'case_1',
    title: 'Test Case',
    description: '',
    source_type: 'manual',
    source_ref: '',
    project_id: 'proj_1',
    repository_id: 'repo_1',
    owner_user_id: 'usr_owner',
    status: 'in_build',
    validation_track: 'direct',
    risk_level: 'medium',
    priority: 'normal',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    decision_ready: true,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.case = null;
  state.project = { exists: false, data: {} };
  state.ruleResults = [];
  state.findings = [];
  state.users = [];
  state.userDocsById = {};
  // `clearAllMocks` clears call history but NOT a previously-set
  // `mockResolvedValue` implementation — reassert the happy-path default
  // every test so a prior test's override (e.g. a failure response) can
  // never leak into the next one.
  chatSendMock.mockResolvedValue({ ok: true, status: 200, attempts: 1 });
  userDocUpdateMock.mockResolvedValue(undefined);
  answerLookupMock.mockResolvedValue(null);
  chatReplyPostMock.mockResolvedValue({ ok: true });
  publishCommitStatusMock.mockResolvedValue({ published: true, state: 'pending' });
  // Real singleton (Slice F) — injected fresh every test so a prior test's
  // fake poster can never leak into the next one.
  setChatReplyPosterForTesting({ post: chatReplyPostMock });
});

afterEach(() => {
  // Restore the real production singleton — see that function's own doc for
  // why `null` means "reset", not "no poster".
  setChatReplyPosterForTesting(null);
});

describe('EventNotifier — case_completed', () => {
  it('notifies the case owner in-app and dispatches case_done for a non-assistant case', async () => {
    state.case = makeCase({ case_type: 'bugfix', owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_completed', {}, 'system:pipeline');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner', type: 'case_done', case_id: 'case_1' }),
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'case_done' }),
    );
  });

  it('does NOT double-notify for an assistant_task case — assistant_task_completed already covers it', async () => {
    // Reverting the `case_.case_type === 'assistant_task'` guard in
    // `notifyCaseCompleted` would notify the case owner a second time for
    // the exact same in_build -> done transition that also emits
    // `assistant_task_completed`.
    state.case = makeCase({
      case_type: 'assistant_task',
      owner_user_id: 'usr_owner',
      assistant_context: {
        channel: 'google_chat',
        conversation_visibility: 'direct',
        requester_user_id: 'usr_owner',
        risk_level: 'low',
        policy_version: 'v1',
        prompt_version: 'v1',
      } as Case['assistant_context'],
    });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_completed', {}, 'system:clerk');

    expect(notifyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('EventNotifier — Clerk outcomes (requester-scoped, no Chat)', () => {
  it('notifies the REQUESTER (not just the owner) on assistant_task_completed', async () => {
    state.case = makeCase({
      case_type: 'assistant_task',
      owner_user_id: 'usr_owner',
      assistant_context: {
        channel: 'google_chat',
        conversation_visibility: 'direct',
        requester_user_id: 'usr_requester',
        risk_level: 'low',
        policy_version: 'v1',
        prompt_version: 'v1',
      } as Case['assistant_context'],
    });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', {}, 'system:clerk');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_requester', type: 'assistant_task_completed' }),
    );
    // No Google Chat dispatch for a Clerk outcome, ever — a private Clerk
    // case posted to the project's shared Chat webhook would leak
    // requester-only content. Reverting `notifyAssistantOutcome` to add a
    // `this.dispatcher.dispatch(...)` call would fail this assertion.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('falls back to owner_user_id when assistant_context.requester_user_id is absent', async () => {
    state.case = makeCase({ case_type: 'assistant_task', owner_user_id: 'usr_owner', assistant_context: undefined });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', {}, 'system:clerk');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner' }),
    );
  });

  it('notifies the requester with the failure reason on assistant_task_failed, and never dispatches to Chat', async () => {
    state.case = makeCase({
      case_type: 'assistant_task',
      owner_user_id: 'usr_owner',
      assistant_context: {
        channel: 'google_chat',
        conversation_visibility: 'direct',
        requester_user_id: 'usr_requester',
        risk_level: 'low',
        policy_version: 'v1',
        prompt_version: 'v1',
      } as Case['assistant_context'],
    });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_failed', { reason: 'bound:max_steps' }, 'system:clerk');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'usr_requester',
        type: 'assistant_task_failed',
        body: expect.stringContaining('bound:max_steps'),
      }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('EventNotifier — run_failed / run_retries_exhausted', () => {
  it('notifies the case owner and dispatches run_failed', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'run_failed',
      { run_type: 'review_run', attempt: 2, error: 'ETIMEDOUT' },
      'system:run-executor',
    );

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner', type: 'run_failed', case_id: 'case_1' }),
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run_failed' }),
    );
  });

  it('notifies the case owner and dispatches run_retries_exhausted — the roadmap-promised notification', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'run_retries_exhausted',
      { run_type: 'review_run', attempts: 3 },
      'system:pipeline',
    );

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner', type: 'run_retries_exhausted' }),
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'run_retries_exhausted' }),
    );
  });
});

describe('EventNotifier — rule_results_attached (fixed fail-count + real critical-finding check)', () => {
  it('notifies rule_violation from real RuleResult fail counts, not the always-absent payload.fail_count', async () => {
    // Pre-fix this read `payload.fail_count`, a field `rule-service.ts` never
    // emits — so this branch was permanently a no-op. Reverting to that read
    // would make this assertion fail even though rule results ARE failing.
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    state.ruleResults = [
      { rule_result_id: 'rr1', rule_id: 'r1', case_id: 'case_1', run_id: 'run_1', result_status: 'fail', message: '', evidence_refs: [], evaluated_at: '' },
      { rule_result_id: 'rr2', rule_id: 'r2', case_id: 'case_1', run_id: 'run_1', result_status: 'pass', message: '', evidence_refs: [], evaluated_at: '' },
    ];
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'rule_results_attached', { run_id: 'run_1', rule_count: 2 }, 'system:rule-service');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner', type: 'rule_violation', body: expect.stringContaining('1 rule') }),
    );
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'rule_violation' }));
  });

  it('does not notify rule_violation when no rule result failed', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    state.ruleResults = [
      { rule_result_id: 'rr1', rule_id: 'r1', case_id: 'case_1', run_id: 'run_1', result_status: 'pass', message: '', evidence_refs: [], evaluated_at: '' },
    ];
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'rule_results_attached', { run_id: 'run_1' }, 'system:rule-service');

    expect(notifyMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rule_violation' }));
  });

  it('notifies critical_finding for a still-blocking high/critical finding, naming the most severe one', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    state.findings = [
      { finding_id: 'f1', case_id: 'case_1', category: 'bug', severity: 'high', confidence: 0.9, status: 'open', title: 'High finding', description: '', origin_type: 'llm_review', source_refs: [], evidence_refs: [], rule_refs: [] },
      { finding_id: 'f2', case_id: 'case_1', category: 'bug', severity: 'critical', confidence: 0.9, status: 'open', title: 'Critical finding', description: '', origin_type: 'llm_review', source_refs: [], evidence_refs: [], rule_refs: [] },
    ];
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'rule_results_attached', { run_id: 'run_1' }, 'system:rule-service');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'usr_owner',
        type: 'critical_finding',
        body: expect.stringContaining('Critical finding'),
      }),
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'critical_finding', findingSeverity: 'critical' }),
    );
  });

  it('ignores a high/critical finding that is already resolved (not blocking)', async () => {
    // Mirrors `isBlockingFindingStatus` — same helper the transition
    // preconditions use, so "notified" tracks "still blocking" exactly.
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    state.findings = [
      { finding_id: 'f1', case_id: 'case_1', category: 'bug', severity: 'critical', confidence: 0.9, status: 'resolved', title: 'Fixed already', description: '', origin_type: 'llm_review', source_refs: [], evidence_refs: [], rule_refs: [] },
    ];
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'rule_results_attached', { run_id: 'run_1' }, 'system:rule-service');

    expect(notifyMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'critical_finding' }));
  });
});

describe('EventNotifier — case_approved / evidence_missing now also dispatch to Chat', () => {
  it('dispatches case_approved on top of the existing in-app notification', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_approved', {}, 'system:pipeline');

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'case_approved' }));
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'case_approved' }));
  });

  it('dispatches evidence_missing on top of the existing in-app notification', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'evidence_missing_detected', { missing_types: ['diff'] }, 'system:evidence');

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'evidence_missing' }));
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'evidence_missing' }));
  });
});

function makeAssistantCase(overrides: Partial<Case> = {}): Case {
  return makeCase({
    case_type: 'assistant_task',
    owner_user_id: 'usr_owner',
    status: 'done',
    assistant_context: {
      channel: 'google_chat',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_requester',
      risk_level: 'low',
      policy_version: 'v1',
      prompt_version: 'v1',
    } as Case['assistant_context'],
    ...overrides,
  });
}

describe('EventNotifier — Slice D: requester Chat webhook, routing matrix', () => {
  it('does not touch the Chat notifier when the requester has no notification_chat_webhook configured — exactly today\'s behavior', async () => {
    // Reverting this isolation (e.g. sending regardless of the field) would
    // fail this: the fixture user doc exists but sets no webhook at all.
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = { user_id: 'usr_requester', notification_chat_webhook: undefined } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatSendMock).not.toHaveBeenCalled();
    expect(userDocUpdateMock).not.toHaveBeenCalled();
  });

  it('does not touch the Chat notifier when notification_chat_webhook is explicitly null (cleared)', async () => {
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = { user_id: 'usr_requester', notification_chat_webhook: null } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it('does not touch the Chat notifier when the requester user doc cannot be found', async () => {
    state.case = makeAssistantCase();
    // No entry in state.userDocsById['usr_requester'] — doc().get() resolves { exists: false }.
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it('completed + reads_withheld=false -> sends "completed" to the webhook, title = case title, and records last_success_at', async () => {
    // Reverting the `payload.reads_withheld === true` check to something
    // looser (e.g. just `payload.reads_withheld`) would still pass this one,
    // but the sibling reads_withheld=true test below would then wrongly say
    // "completed" too — see that test's own comment.
    state.case = makeAssistantCase({ title: 'Summarize Q3 cases' });
    state.userDocsById['usr_requester'] = {
      user_id: 'usr_requester',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatSendMock).toHaveBeenCalledWith(
      'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
      expect.objectContaining({ title: 'Summarize Q3 cases', body: 'completed' }),
    );
    expect(userDocUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ 'notification_chat_delivery.last_success_at': expect.any(String) }),
    );
  });

  it('completed + reads_withheld=true -> sends the read-budget limitation outcome line, not plain "completed"', async () => {
    // Pins that `assistant_task_completed`'s OWN payload (stamped by the
    // `done` transition's `extraEventPayload`, not a re-derived value) is
    // what decides this line — no executor change was needed because the
    // field is already there (see `notifyRequesterChat`'s doc comment).
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = {
      user_id: 'usr_requester',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: true }, 'system:clerk');

    expect(chatSendMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: 'completed with limitation: read budget spent' }),
    );
  });

  it('failed -> sends "failed: <failure class>" using payload.reason', async () => {
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = {
      user_id: 'usr_requester',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_failed', { reason: 'bound:max_steps' }, 'system:clerk');

    expect(chatSendMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: 'failed: bound:max_steps' }),
    );
  });

  it('includes a case deep link (via the shared caseShareUrl helper) when ARBITRA_URL is configured', async () => {
    const original = process.env['ARBITRA_URL'];
    process.env['ARBITRA_URL'] = 'https://arbitra.example.com';
    try {
      state.case = makeAssistantCase({ case_id: 'case_xyz', status: 'done' });
      state.userDocsById['usr_requester'] = {
        user_id: 'usr_requester',
        notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
      } as User;
      const notifier = new EventNotifier();

      await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

      expect(chatSendMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ link: 'https://arbitra.example.com/cases/case_xyz' }),
      );
    } finally {
      if (original === undefined) delete process.env['ARBITRA_URL'];
      else process.env['ARBITRA_URL'] = original;
    }
  });

  it('a webhook send failure records last_error and does not throw out of onCaseEvent', async () => {
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = {
      user_id: 'usr_requester',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    chatSendMock.mockResolvedValueOnce({ ok: false, status: 500, error: 'boom', attempts: 2 });
    const notifier = new EventNotifier();

    await expect(
      notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk'),
    ).resolves.toBeUndefined();

    expect(userDocUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        'notification_chat_delivery.last_error': expect.objectContaining({ code: '500', message: 'boom' }),
      }),
    );
    // The in-app notification still went out despite the Chat failure.
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistant_task_completed' }));
  });

  it('a delivery-outcome recording failure never breaks onCaseEvent (fire-and-forget on the RECORDING write, not the send)', async () => {
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = {
      user_id: 'usr_requester',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    userDocUpdateMock.mockRejectedValueOnce(new Error('Firestore unavailable'));
    const notifier = new EventNotifier();

    await expect(
      notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk'),
    ).resolves.toBeUndefined();
  });
});

describe('EventNotifier — Slice D: engineering-case isolation', () => {
  it('never reads a user doc or calls the Chat notifier for case_approved (engineering case path)', async () => {
    // Engineering cases route ONLY through `this.dispatcher` (the
    // project-wide webhook) — `notifyRequesterChat`/`chatSendMock` must
    // never be reachable from any non-assistant-outcome event.
    state.case = makeCase({ case_type: 'bugfix', owner_user_id: 'usr_owner' });
    state.userDocsById['usr_owner'] = {
      user_id: 'usr_owner',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_approved', {}, 'system:pipeline');

    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it('never reads a user doc or calls the Chat notifier for run_failed (engineering case path)', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    state.userDocsById['usr_owner'] = {
      user_id: 'usr_owner',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'run_failed', { run_type: 'review_run', attempt: 1 }, 'system:run-executor');

    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it('a Clerk outcome never dispatches to the PROJECT webhook (this.dispatcher stays untouched)', async () => {
    state.case = makeAssistantCase();
    state.userDocsById['usr_requester'] = {
      user_id: 'usr_requester',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatSendMock).toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('EventNotifier — Slice D: blueprint occurrences are ordinary assistant tasks', () => {
  it('notifies the blueprint owner (via requester_user_id, stamped at intake) exactly like a manual Clerk task — no special-casing needed', async () => {
    // `AssistantIntakeService.intake` stamps `requester_user_id = actorId`
    // for a blueprint occurrence too (`actorId = blueprint.owner_user_id`,
    // spec Slice B) — the exact same field `notifyAssistantOutcome` already
    // reads for a manually-asked task. This test pins that a blueprint
    // occurrence case needs no extra branch in `EventNotifier` to route
    // correctly: reverting to code that special-cased `blueprint_context`
    // presence would be unnecessary, and removing `requester_user_id`
    // resolution entirely would fail this test.
    state.case = makeAssistantCase({
      owner_user_id: 'usr_blueprint_owner',
      assistant_context: {
        channel: 'blueprint',
        conversation_visibility: 'direct',
        requester_user_id: 'usr_blueprint_owner',
        risk_level: 'low',
        policy_version: 'v1',
        prompt_version: 'v1',
        blueprint_id: 'bp_1',
        blueprint_context: {
          blueprint_id: 'bp_1',
          blueprint_version: 3,
          prompt_text: 'Summarize last week\'s cases',
        },
      } as Case['assistant_context'],
    });
    state.userDocsById['usr_blueprint_owner'] = {
      user_id: 'usr_blueprint_owner',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/BBB/messages?key=y',
    } as User;
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_blueprint_owner', type: 'assistant_task_completed' }),
    );
    expect(chatSendMock).toHaveBeenCalledWith(
      'https://chat.googleapis.com/v1/spaces/BBB/messages?key=y',
      expect.objectContaining({ body: 'completed' }),
    );
  });
});

describe('EventNotifier — case_updated (issue #794, deliberately timeline-only)', () => {
  it('falls into the default branch and never notifies in-app, dispatches to Chat, or reads a user doc', async () => {
    // `case_updated` (packages/shared/src/types/event.ts) has no `case` in
    // this class's `switch` — it falls to `default`, which only reacts to
    // `payload.to_status` (a key `case_updated`'s payload never sets). It is
    // also absent from the separate, closed `NotificationEvent` type
    // (`packages/shared/src/types/notification.ts`) that
    // `NOTIFICATION_EVENT_DEFAULTS` is keyed on — so it cannot even be added
    // to the Chat catalog without a type error, let alone picked up by
    // accident. This test pins the runtime half of that decision: a
    // case_updated event produces zero notifications of any kind.
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'case_updated',
      { changed: ['title'], title: { from: 'Old title', to: 'New title' } },
      'usr_1',
    );

    expect(notifyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(chatSendMock).not.toHaveBeenCalled();
  });

  it('is a no-op even when the payload happens to carry to_status-shaped keys it never actually sets', async () => {
    // Defense-in-depth: confirms the default branch's `payload.to_status`
    // check is the only thing that could ever fire a notification for an
    // unhandled event type, and case_updated's real payload shape never
    // trips it.
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'case_updated',
      { changed: ['description'] },
      'usr_1',
    );

    expect(notifyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('EventNotifier — gate_confirmed / gate_rejected reconcile stale gate_pending (issue #794 P0)', () => {
  it('reconciles gate_pending for the case on gate_confirmed, even when the actor is the owner', async () => {
    // Reconciliation must run for every OTHER reviewer's unread gate_pending
    // copy even when the confirming actor is the case owner themselves (the
    // owner-notify path short-circuits right after on that condition).
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'gate_confirmed', { to_status: 'done' }, 'usr_owner');

    expect(reconcileGateDecisionMock).toHaveBeenCalledWith('case_1');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('reconciles gate_pending for the case on gate_rejected, even when the actor is the owner', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'gate_rejected', {}, 'usr_owner');

    expect(reconcileGateDecisionMock).toHaveBeenCalledWith('case_1');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('still notifies the owner on gate_confirmed by a different actor, on top of reconciling', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'gate_confirmed', { to_status: 'done' }, 'usr_reviewer');

    expect(reconcileGateDecisionMock).toHaveBeenCalledWith('case_1');
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner', type: 'gate_confirmed', case_id: 'case_1' }),
    );
  });

  // `gate_confirmed`/`gate_rejected` are also emitted by
  // `DecisionService.resolveHumanConfirmationGate` for a RULE-level
  // `human_confirmation` RuleResult gate — tagged
  // `gate_kind: 'human_confirmation_rule'` + `rule_id` — which is
  // architecturally independent of the case-level lifecycle `pending_gate`
  // that a `gate_pending` notification represents. Resolving the rule-level
  // gate must NOT mark a still-live lifecycle `gate_pending` notification
  // read for every other reviewer.
  it('does NOT reconcile gate_pending when gate_confirmed resolves the rule-level human_confirmation gate', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'gate_confirmed',
      { gate_kind: 'human_confirmation_rule', rule_id: 'rule_1' },
      'usr_reviewer',
    );

    expect(reconcileGateDecisionMock).not.toHaveBeenCalled();
    // The owner still gets their `gate_confirmed` in-app notification —
    // only the lifecycle gate_pending reconciliation is skipped.
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_owner', type: 'gate_confirmed', case_id: 'case_1' }),
    );
  });

  it('does NOT reconcile gate_pending when gate_rejected resolves the rule-level human_confirmation gate', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'gate_rejected',
      { gate_kind: 'human_confirmation_rule', rule_id: 'rule_1' },
      'usr_reviewer',
    );

    expect(reconcileGateDecisionMock).not.toHaveBeenCalled();
  });

  it('still reconciles gate_pending on a lifecycle gate_confirmed decision (no gate_kind on payload)', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'gate_confirmed',
      { gate_id: 'review_to_approved', from_status: 'in_review', to_status: 'approved' },
      'usr_reviewer',
    );

    expect(reconcileGateDecisionMock).toHaveBeenCalledWith('case_1');
  });
});

describe('EventNotifier — reconcile stale case_needs_decision on every exit from needs_human_decision (issue #1073)', () => {
  it('reconciles case_needs_decision on case_approved, even when the case has no owner_user_id', async () => {
    // `notifyCaseOutcome` returns early right after this when there is no
    // owner — reconciliation must run BEFORE that return so the OTHER
    // reviewers' stale `case_needs_decision` copies still clear.
    state.case = makeCase({ owner_user_id: undefined });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_approved', {}, 'system:pipeline');

    expect(reconcileCaseNeedsDecisionMock).toHaveBeenCalledWith('case_1');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('reconciles case_needs_decision on case_rejected', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_rejected', {}, 'usr_reviewer');

    expect(reconcileCaseNeedsDecisionMock).toHaveBeenCalledWith('case_1');
  });

  it('reconciles case_needs_decision on a request_changes decision, even when the actor is the owner', async () => {
    // `notifyChangesRequested` returns early when the owner is missing OR is
    // the actor themselves — reconciliation must run BEFORE that return, same
    // trap as `notifyCaseOutcome` above.
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'decision_created',
      { type: 'request_changes', decision_id: 'dec_1' },
      'usr_owner',
    );

    expect(reconcileCaseNeedsDecisionMock).toHaveBeenCalledWith('case_1');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does NOT reconcile case_needs_decision for a decision_created event of a different type', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'decision_created',
      { type: 'approve', decision_id: 'dec_1' },
      'usr_reviewer',
    );

    expect(reconcileCaseNeedsDecisionMock).not.toHaveBeenCalled();
  });

  it('reconciles case_needs_decision on manual_validation_confirmed transitioning to verification_pending (the needs_human_decision exit)', async () => {
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'manual_validation_confirmed',
      { to_status: 'verification_pending' },
      'usr_reviewer',
    );

    expect(reconcileCaseNeedsDecisionMock).toHaveBeenCalledWith('case_1');
  });

  it('reconciles case_needs_decision via the default-branch verification_pending check too', async () => {
    // `human_decision_recorded` is not itself a named switch case — it falls
    // to the default branch, which is what actually fires on the
    // needs_human_decision -> verification_pending transition edge.
    state.case = makeCase({ owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'human_decision_recorded',
      { to_status: 'verification_pending' },
      'usr_reviewer',
    );

    expect(reconcileCaseNeedsDecisionMock).toHaveBeenCalledWith('case_1');
  });
});

/** A Chat-originated Clerk case, with the space/thread `assistant_context` stamps at intake. */
function makeChatAssistantCase(overrides: Partial<Case> = {}): Case {
  return makeAssistantCase({
    assistant_context: {
      channel: 'google_chat',
      conversation_visibility: 'direct',
      requester_user_id: 'usr_requester',
      risk_level: 'low',
      policy_version: 'v1',
      prompt_version: 'v1',
      space_name: 'spaces/AAAA',
      thread_name: 'spaces/AAAA/threads/T1',
    } as Case['assistant_context'],
    ...overrides,
  });
}

describe('EventNotifier — Slice F: completion hook posts into the originating Chat thread', () => {
  const ORIGINAL_ARBITRA_URL = process.env['ARBITRA_URL'];

  beforeEach(() => {
    process.env['ARBITRA_URL'] = 'https://arbitra.example.com';
  });

  afterEach(() => {
    if (ORIGINAL_ARBITRA_URL === undefined) delete process.env['ARBITRA_URL'];
    else process.env['ARBITRA_URL'] = ORIGINAL_ARBITRA_URL;
  });

  it('a completed google_chat case posts once, to the case\'s stored space/thread, with the deep link', async () => {
    // Reverting the `ctx.channel !== 'google_chat'` guard, or the
    // `{ spaceName: ctx.space_name, threadName: ctx.thread_name }` target
    // construction, in `notifyChatThreadOutcome` breaks this.
    state.case = makeChatAssistantCase({ case_id: 'case_chat_1' });
    answerLookupMock.mockResolvedValue('The answer to your question is 42.');
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_chat_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    expect(chatReplyPostMock).toHaveBeenCalledWith(
      { spaceName: 'spaces/AAAA', threadName: 'spaces/AAAA/threads/T1' },
      expect.stringContaining('https://arbitra.example.com/cases/case_chat_1'),
    );
    // The full answer text never appears — only a bounded lead plus the link.
    expect(chatReplyPostMock.mock.calls[0]?.[1]).toContain('The answer to your question is 42.');
  });

  /**
   * A follow-up case (one with an `assistant_thread`
   * link to a parent) must post its completion to ITS OWN
   * `space_name`/`thread_name`, never the parent's — `notifyChatThreadOutcome`
   * reads only `case_.assistant_context`, so this proves a follow-up case
   * whose `intakeFollowUp` call persisted its own chat block (the
   * `assistant-intake-service.ts` fix) actually gets its completion posted,
   * to the right thread, distinct from the parent's. Before that fix, a
   * follow-up case's `assistant_context` had no `space_name` at all, so the
   * `if (!ctx.space_name) return;` guard a few lines above this call site
   * silently dropped the reply — reverting either that persistence fix or
   * this test's own fixture back to `space_name: undefined` reproduces
   * exactly that silent drop (`chatReplyPostMock` would never be called).
   */
  it('posts a follow-up case\'s completion to ITS OWN thread, not the parent case\'s', async () => {
    state.case = makeChatAssistantCase({
      case_id: 'case_followup_1',
      assistant_context: {
        channel: 'google_chat',
        conversation_visibility: 'direct',
        requester_user_id: 'usr_requester',
        risk_level: 'low',
        policy_version: 'v1',
        prompt_version: 'v1',
        // This follow-up's OWN reply target — deliberately different from
        // the parent's `spaces/AAAA` / `.../T1` fixture values, so this test
        // fails if `notifyChatThreadOutcome` (or the persistence upstream of
        // it) ever mixes the two up.
        space_name: 'spaces/BBBB',
        thread_name: 'spaces/BBBB/threads/T9',
      } as Case['assistant_context'],
      assistant_thread: {
        schema_version: 1,
        root_case_id: 'case_root_1',
        parent_case_id: 'case_root_1',
        prior_run_id: 'run_root_1',
        prior_result_evidence_id: 'evidence_root_1',
        prior_result_artifact_id: 'artifact_root_1',
        depth: 1,
      },
    });
    answerLookupMock.mockResolvedValue('Yes, that one is urgent.');
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_followup_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    expect(chatReplyPostMock).toHaveBeenCalledWith(
      { spaceName: 'spaces/BBBB', threadName: 'spaces/BBBB/threads/T9' },
      expect.stringContaining('https://arbitra.example.com/cases/case_followup_1'),
    );
  });

  it('does NOT post for a non-Chat (web) Clerk case — no regression to the web intake path', async () => {
    // Reverting the `ctx.channel !== 'google_chat'` guard to something
    // looser (e.g. dropping it, or accepting any truthy channel) would fail
    // this. `space_name` is stamped here too — unrealistic for a real `web`
    // case, but deliberate: it isolates the CHANNEL check specifically,
    // since without a `space_name` the sibling guard right below it would
    // mask a broken channel check and pass either way.
    state.case = makeAssistantCase({
      assistant_context: {
        channel: 'web',
        conversation_visibility: 'direct',
        requester_user_id: 'usr_requester',
        risk_level: 'low',
        policy_version: 'v1',
        prompt_version: 'v1',
        space_name: 'spaces/AAAA',
      } as Case['assistant_context'],
    });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatReplyPostMock).not.toHaveBeenCalled();
  });

  it('posts a graceful fallback — never an empty message — when the answer lookup returns null', async () => {
    // Reverting the `lead ? ... : \`${CHAT_MARKER_FAILED} ${caseRef}\`` fallback branch in
    // `notifyChatThreadOutcome` to always use `lead` (e.g.
    // `` `${lead}\n\n${caseRef}` `` unconditionally) would post "undefined"
    // or an empty lead here instead of the generic fallback.
    state.case = makeChatAssistantCase();
    answerLookupMock.mockResolvedValue(null);
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
    expect(text.length).toBeGreaterThan(0);
    // No-lead fallback carries no English sentence — Clerk answers in the
    // requester's own language, so a hardcoded English frame is removed rather
    // than language-detected — just a neutral marker plus the bare link.
    expect(text).toBe('⚠️ https://arbitra.example.com/cases/case_1');
  });

  it('a terminally-rejected Chat case posts a neutral marker with the link, no English sentence', async () => {
    // This is the `case_rejected` terminal-failure edge
    // (`assistant_terminal_failure_documented` in `status-transitions.ts`),
    // NOT the per-attempt `assistant_task_failed` event — that one fires per
    // retry attempt and is not a case-terminal signal (see
    // `notifyCaseOutcome`'s doc comment on the `case_rejected` branch).
    // Reverting the rejected branch back to the old hardcoded
    // "Your Clerk task could not be completed..." English sentence would
    // fail the `not.toMatch(/[a-zA-Z]{4,}/)` assertion below (the only
    // remaining word-like run would be inside the https:// url itself,
    // which the regex is scoped to exclude).
    state.case = makeChatAssistantCase({ status: 'rejected' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_rejected', {}, 'system:pipeline');

    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
    expect(text).toBe('⚠️ https://arbitra.example.com/cases/case_1');
    expect(text.replace(/https?:\/\/\S+/g, '')).not.toMatch(/[a-zA-Z]{4,}/);
    // Never touches the answer for a failure note.
    expect(answerLookupMock).not.toHaveBeenCalled();
  });

  it('drops the "Full answer:" label from a completed reply — bare link on its own line after the lead', async () => {
    // Reverting `` `${lead}\n\n${caseRef}` `` back to
    // `` `${lead}\n\nFull answer: ${caseRef}` `` reintroduces a
    // hardcoded English label that reads wrong in a non-English exchange.
    state.case = makeChatAssistantCase();
    answerLookupMock.mockResolvedValue('The answer is 42.');
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
    expect(text).toBe('✅ The answer is 42.\n\nhttps://arbitra.example.com/cases/case_1');
    expect(text).not.toContain('Full answer');
    expect(text).toContain('https://arbitra.example.com/cases/case_1');
  });

  it('marks answered, failed and acknowledged outcomes distinguishably without any prose', async () => {
    // Dropping the English frames also dropped the only cue separating
    // "tracking", "answered" and "failed" — every branch
    // collapsed to an identical bare link, so a reader could not tell a
    // finished answer from a failed run without opening the case. Reverting
    // either marker back to the shared `🔗` makes this fail.
    state.case = makeChatAssistantCase();
    answerLookupMock.mockResolvedValue('The answer is 42.');
    const notifier = new EventNotifier();
    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');
    const answered = chatReplyPostMock.mock.calls[0]?.[1] as string;

    chatReplyPostMock.mockClear();
    state.case = makeChatAssistantCase();
    answerLookupMock.mockResolvedValue(null);
    const notifier2 = new EventNotifier();
    await notifier2.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');
    const failed = chatReplyPostMock.mock.calls[0]?.[1] as string;

    // Distinct leading markers, and neither is the ack's 🔗.
    expect(answered.startsWith('✅')).toBe(true);
    expect(failed.startsWith('⚠️')).toBe(true);
    expect(answered[0]).not.toBe(failed[0]);
    // Still no language-bearing prose in the marker-only branch.
    expect(failed).toBe('⚠️ https://arbitra.example.com/cases/case_1');
  });

  it('converts Markdown in the Clerk answer to Chat syntax BEFORE truncation applies the byte budget', async () => {
    // Reverting the `markdownToChatText(text)` call in
    // `notifyChatThreadOutcome` (or reordering it after `truncateForChat`)
    // would leave the delivered message with literal `**...**` instead of
    // Chat's `*...*`.
    state.case = makeChatAssistantCase();
    // Long enough that `deriveChatCompletionLead`'s own 220-char lead cap
    // does the cutting — well under `truncateForChat`'s 32,000-byte
    // ceiling, so this exercises the conversion step itself, not the byte
    // truncation path (that combination is covered by the poster's own
    // `truncateForChat` unit tests).
    const longBoldAnswer = `**Important:** ${'x'.repeat(300)}`;
    answerLookupMock.mockResolvedValue(longBoldAnswer);
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
    // Note: `text.includes('*Important:*')` alone would be a false-positive
    // assertion here — "**Important:**" already contains "*Important:*" as a
    // literal substring (one asterisk in from each side) even completely
    // unconverted. The real discriminator is the absence of any remaining
    // "**" pair anywhere in the message.
    expect(text).not.toContain('**');
    expect(text).toContain('*Important:*');
  });

  it('does NOT post to Chat for an engineering case rejection (case_type isolation)', async () => {
    // Reverting the `case_.case_type === 'assistant_task'` guard around the
    // `notifyChatThreadOutcome` call in `notifyCaseOutcome` would fail this
    // — an ordinary engineering case has no `assistant_context` at all.
    state.case = makeCase({ case_type: 'bugfix', owner_user_id: 'usr_owner', status: 'rejected' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_rejected', {}, 'system:pipeline');

    expect(chatReplyPostMock).not.toHaveBeenCalled();
  });

  it('posts only once when onCaseEvent fires twice for the same case (double-post guard)', async () => {
    // Reverting the `if (ctx.chat_reply_posted_at) return;` guard, or
    // `markChatReplyPosted`'s write, in `notifyChatThreadOutcome` would post
    // a second time here — `caseDocUpdateMock` mutates `state.case` in place
    // so the second `onCaseEvent` call's own `getCase` read sees the flag.
    state.case = makeChatAssistantCase({ case_id: 'case_1' });
    answerLookupMock.mockResolvedValue('First answer.');
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');
    await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

    expect(chatReplyPostMock).toHaveBeenCalledTimes(1);
    expect(caseDocUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('logs and does not throw when the Chat API call fails — the in-app notification is still delivered', async () => {
    // Reverting the try/catch around `getChatReplyPoster().post(...)` in
    // `notifyChatThreadOutcome` to an unguarded call would still resolve
    // here (the poster itself never throws, only returns `{ok: false}`),
    // but reverting the `if (!result.ok) { console.warn(...) }` branch would
    // fail the log assertion below.
    state.case = makeChatAssistantCase();
    chatReplyPostMock.mockResolvedValueOnce({ ok: false, reason: 'http_500' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notifier = new EventNotifier();

    await expect(
      notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk'),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Chat thread reply not delivered'),
      'http_500',
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'usr_requester', type: 'assistant_task_completed' }),
    );
    // The double-post guard still stamps on a failed attempt — it is not
    // retried on the next notification either.
    expect(caseDocUpdateMock).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  describe('deriveChatCompletionLead — issue #949: list-introducing lead folds in items', () => {
    it('an intro-plus-list answer posts the intro AND at least the first list items, not just the count', async () => {
      // Reverting `deriveChatCompletionLead` to its pre-#949 "first
      // paragraph only" form (packages/backend/src/services/notification/
      // event-notifier.ts, the `blocks.length > 1 ? splitChatLeadListItems(nextBlock) : []`
      // line replaced back with the old `trimmed.split(/\n\s*\n/).find(...)`)
      // reproduces the defect: this test's second and third
      // `expect(...).toContain(...)` calls on real names fail because the
      // lead stops at the intro's colon.
      state.case = makeChatAssistantCase();
      answerLookupMock.mockResolvedValue(
        'The **North team** (source: knowledge asset "North roster", as of 2026-08-06) has 10 members:\n\n' +
          '- Anna Muster\n- Ben Beispiel\n- Clara Test\n- Dirk Example\n- Erik Sample\n' +
          '- Frida Demo\n- Georg Placeholder\n- Hanna Fixture\n- Ivo Stub\n- Julia Mock',
      );
      const notifier = new EventNotifier();

      await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

      const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
      expect(text).toContain('North team');
      expect(text).toContain('has 10 members');
      // At least the first names made it in — the whole point of the fix.
      expect(text).toContain('Anna Muster');
      expect(text).toContain('Ben Beispiel');
    });

    it('a list too long for the lead budget is signalled as partial, not posted as if complete', async () => {
      // Reverting the packing loop's early `break` (or removing the
      // `included.length < listItems.length` marker append) would silently
      // drop the tail names with no sign anything is missing — the same
      // "looks complete, isn't" shape as the original bug, one level down.
      state.case = makeChatAssistantCase();
      const items = Array.from({ length: 20 }, (_, i) => `- Team member number ${i + 1} of the North roster`);
      answerLookupMock.mockResolvedValue(`The North team has 20 members:\n\n${items.join('\n')}`);
      const notifier = new EventNotifier();

      await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

      const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
      // Not every item fit — the 220-char lead cap guarantees that for 20
      // ~50-char lines. The partial marker (ellipsis + remaining count,
      // numerals only — no added-language prose) must show up instead of
      // silently truncating the list.
      expect(text).toContain('…');
      expect(text).toMatch(/…\s\(\+\d+\)/);
      expect(text).not.toContain('Team member number 20 of the North roster');
    });

    it('a plain prose answer with no list is unaffected — same lead as before the fix', async () => {
      // Regression guard: folding logic must never activate for an answer
      // that has neither a trailing colon nor a following list block.
      state.case = makeChatAssistantCase();
      answerLookupMock.mockResolvedValue('The answer is 42.');
      const notifier = new EventNotifier();

      await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

      const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
      expect(text).toBe('✅ The answer is 42.\n\nhttps://arbitra.example.com/cases/case_1');
    });

    it('a lead ending in a colon with no list after it drops the colon instead of dangling it', async () => {
      // Reverting the `leadEndsWithColon ? leadNormalized.replace(/:$/, '') :
      // leadNormalized` branch back to always returning `leadNormalized`
      // reproduces a colon immediately followed by the blank line and case
      // link — the exact visual defect the issue reports, just without a
      // list to blame it on.
      state.case = makeChatAssistantCase();
      answerLookupMock.mockResolvedValue(
        'The status was finally settled:\n\nFor further questions please open the case.',
      );
      const notifier = new EventNotifier();

      await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

      const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
      expect(text).toBe('✅ The status was finally settled\n\nhttps://arbitra.example.com/cases/case_1');
      expect(text).not.toContain(':\n\n');
    });

    it('a pathologically long list still respects the lead\'s char cap and truncateForChat\'s byte ceiling', async () => {
      // Defense in depth: even if the char-budget packing above had an
      // off-by-one that let the composed lead run long, `truncateForChat`
      // downstream (NOT reimplemented here — called, per scope) is the real
      // hard ceiling the Chat API enforces. Reverting `notifyChatThreadOutcome`
      // to skip that call for the completed branch would fail the byte-length
      // assertion below once the list is this large.
      state.case = makeChatAssistantCase();
      const hugeList = Array.from(
        { length: 5000 },
        (_, i) => `- North team roster entry number ${i + 1} with a realistically long display name`,
      );
      answerLookupMock.mockResolvedValue(`The North team has 5000 members:\n\n${hugeList.join('\n')}`);
      const notifier = new EventNotifier();

      await notifier.onCaseEvent('case_1', 'assistant_task_completed', { reads_withheld: false }, 'system:clerk');

      const text = chatReplyPostMock.mock.calls[0]?.[1] as string;
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_BYTES);
      // The lead itself never grows past its own cosmetic cap either — this
      // is `deriveChatCompletionLead`'s own budget doing the work, not
      // `truncateForChat` stepping in (it never needs to for a lead this
      // short relative to its 32,000-byte ceiling).
      expect(text).toContain('… (+');
      expect(text).not.toContain('entry number 5000');
    });
  });
});

describe('EventNotifier — merge-time enforcement commit status (issue #988)', () => {
  it('publishes on a status-transition event (payload carries to_status)', async () => {
    // Revert line: the `payload['to_status'] !== undefined` disjunct in the
    // publish guard — reverting it to only check `pr_opened`/`pr_updated`
    // would make this assertion fail.
    state.case = makeCase({ case_type: 'bugfix', status: 'approved' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'case_approved',
      { from_status: 'needs_human_decision', to_status: 'approved' },
      'system:pipeline',
    );

    expect(publishCommitStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: 'case_1', status: 'approved' }),
      {},
      { headSha: undefined },
    );
  });

  it('publishes on pr_opened, passing the payload commit_sha through as headSha', async () => {
    // Revert line: `eventType === 'pr_opened'` removed from the guard's
    // disjunction — publish would never fire for the branch-name/PR-text
    // link path.
    state.case = makeCase({ case_type: 'bugfix', status: 'in_build' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'pr_opened',
      { pr_url: 'https://github.com/acme/demo/pull/9', commit_sha: 'sha_pr_opened', linked_via: 'branch_name_case_id' },
      'system',
    );

    expect(publishCommitStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: 'case_1' }),
      {},
      { headSha: 'sha_pr_opened' },
    );
  });

  it('publishes on pr_updated (webhook synchronize re-link), passing the new commit_sha', async () => {
    // Revert line: `eventType === 'pr_updated'` removed from the guard —
    // a `synchronize` webhook's new head sha would never get republished.
    state.case = makeCase({ case_type: 'bugfix', status: 'in_build' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'pr_updated',
      { pr_url: 'https://github.com/acme/demo/pull/9', commit_sha: 'sha_synchronize_2' },
      'system',
    );

    expect(publishCommitStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: 'case_1' }),
      {},
      { headSha: 'sha_synchronize_2' },
    );
  });

  // ── The publish hook is READ-ONLY (issue #1045/#1046) ─────────

  it('never asks publishCaseCommitStatus to write anything — the pin is transactional', async () => {
    // Revert line: reintroducing a `recordApprovalPin`-style write option
    // here. The pin must be stamped by `applyTransitionInTransaction`, not
    // by this hook: `onCaseEvent` is invoked through `.catch()` and never
    // awaited (`event-service.ts`), so a pin written here is lost whenever a
    // notification is dropped — and out of `approved` the matrix has only
    // `→ done` / `→ pending_merge`, leaving no way back to a pinnable state.
    // It would also race the second publish the auto `approved →
    // pending_merge` edge fires.
    state.case = makeCase({ case_type: 'bugfix', status: 'approved' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent(
      'case_1',
      'case_approved',
      { from_status: 'in_review', to_status: 'approved' },
      'usr_reviewer',
    );

    expect(publishCommitStatusMock).toHaveBeenCalledTimes(1);
    // Third argument carries publish options only — no write flags.
    expect(publishCommitStatusMock.mock.calls[0]![2]).toEqual({ headSha: undefined });
    // And the hook itself writes nothing to the case document.
    expect(caseDocUpdateMock).not.toHaveBeenCalled();
  });

  it('does NOT publish for an event that is neither a status transition nor a PR link/enrich', async () => {
    // e.g. `comment_added` carries no `to_status` and is not `pr_opened`/`pr_updated`.
    state.case = makeCase({ case_type: 'bugfix', status: 'in_build' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'comment_added', { body: 'hi' }, 'system');

    expect(publishCommitStatusMock).not.toHaveBeenCalled();
  });

  it('a publish failure never breaks the rest of onCaseEvent processing', async () => {
    // Revert line: dropping this method's own outer try/catch (or awaiting
    // publish without one) would let a rejected publish call propagate and
    // stop `case_approved`'s own notification from firing.
    publishCommitStatusMock.mockRejectedValue(new Error('github down'));
    state.case = makeCase({ case_type: 'bugfix', status: 'approved', owner_user_id: 'usr_owner' });
    const notifier = new EventNotifier();

    await notifier.onCaseEvent('case_1', 'case_approved', { to_status: 'approved' }, 'system:pipeline');

    // publishCaseCommitStatus is documented fail-soft and never throws in
    // production; this only proves EventNotifier survives a mock that
    // violates that contract, so a real regression there can't take the rest
    // of notification processing down with it.
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'case_approved' }));
  });
});
