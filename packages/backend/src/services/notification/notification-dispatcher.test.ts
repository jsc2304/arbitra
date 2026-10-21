/**
 * NotificationDispatcher test suite. Pre-fix this file did not exist: zero
 * tests covered dispatch/event mapping, so a dropped call site or a
 * mis-gated event went unnoticed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Case, Project } from '@arbitra/shared';

// Default: a first-attempt success, matching `GoogleChatNotifier.send`'s
// structured `SendResult` shape rather than the old bare `boolean`.
const sendMock = vi.fn().mockResolvedValue({ ok: true, status: 200, attempts: 1 });
vi.mock('./google-chat-notifier.js', () => ({
  GoogleChatNotifier: class {
    send = sendMock;
  },
}));

// Controls `collections.projects().doc(id).get()`.
const projectDocState: { exists: boolean; data: Partial<Project> } = {
  exists: false,
  data: {},
};

// Shared across every `.doc(id)` call so `recordDeliveryOutcome`'s
// `collections.projects().doc(projectId).update(...)` writes land on the
// same spy the test asserts against.
const projectDocUpdateMock = vi.fn(async () => undefined);

vi.mock('../../lib/firestore.js', () => ({
  collections: {
    projects: () => ({
      doc: () => ({
        get: vi.fn(async () => ({
          exists: projectDocState.exists,
          data: () => projectDocState.data,
        })),
        update: projectDocUpdateMock,
      }),
    }),
    users: () => ({
      doc: () => ({
        get: vi.fn(async () => ({ exists: false })),
      }),
    }),
  },
}));

const { NotificationDispatcher, NOTIFICATION_EVENT_DEFAULTS, resolveEventChatEnabled } = await import(
  './notification-dispatcher.js'
);

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
    status: 'open',
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

function configureProject(overrides: Partial<Project> = {}): void {
  projectDocState.exists = true;
  projectDocState.data = {
    name: 'Test Project',
    notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/x/messages?key=y',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectDocState.exists = false;
  projectDocState.data = {};
});

describe('NOTIFICATION_EVENT_DEFAULTS — catalog completeness', () => {
  it('never includes a Clerk/assistant outcome event (slice D territory, in-app only for now)', () => {
    // `Record<NotificationEvent, ...>` already makes this a compile error if
    // someone widens the union to include an assistant event without adding
    // routing for it deliberately — this pins the RUNTIME shape too, so a
    // refactor that keeps the type honest but re-adds the key by accident
    // (e.g. a merge) still fails here.
    const keys = Object.keys(NOTIFICATION_EVENT_DEFAULTS);
    expect(keys.some((k) => k.startsWith('assistant_task'))).toBe(false);
  });

  it('defaults decision-type events to chat:true and informational events to chat:false', () => {
    expect(NOTIFICATION_EVENT_DEFAULTS.case_needs_decision.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.changes_requested.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.gate_pending.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.gate_rejected.chat).toBe(true);

    expect(NOTIFICATION_EVENT_DEFAULTS.case_approved.chat).toBe(false);
    expect(NOTIFICATION_EVENT_DEFAULTS.case_done.chat).toBe(false);
  });

  it('defaults findings/violations and run-failure events to chat:true — their templates exist to fire', () => {
    expect(NOTIFICATION_EVENT_DEFAULTS.critical_finding.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.rule_violation.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.evidence_missing.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.run_failed.chat).toBe(true);
    expect(NOTIFICATION_EVENT_DEFAULTS.run_retries_exhausted.chat).toBe(true);
  });
});

describe('resolveEventChatEnabled — per-project override precedence (slice C2)', () => {
  it('an explicit override:true wins over a chat:false catalog default', () => {
    // Reverting the override branch (making the function always return the
    // catalog default) would make this return false.
    expect(resolveEventChatEnabled('case_approved', { case_approved: true })).toBe(true);
  });

  it('an explicit override:false wins over a chat:true catalog default', () => {
    // Reverting the `override !== undefined` check to a truthy check would
    // make this fall through to the catalog default (true) instead.
    expect(resolveEventChatEnabled('case_needs_decision', { case_needs_decision: false })).toBe(false);
  });

  it('falls back to the catalog default when the event key is absent from the override map', () => {
    // Deleting the fallback `return NOTIFICATION_EVENT_DEFAULTS[event].chat`
    // line would make this throw or return undefined instead of true.
    expect(resolveEventChatEnabled('case_needs_decision', {})).toBe(true);
    expect(resolveEventChatEnabled('case_approved', {})).toBe(false);
  });

  it('falls back to the catalog default when no override map is supplied at all', () => {
    expect(resolveEventChatEnabled('case_needs_decision', undefined)).toBe(true);
    expect(resolveEventChatEnabled('run_failed')).toBe(true);
  });
});

describe('NotificationDispatcher.dispatch — per-project override (slice C2)', () => {
  it('sends a default-off event when the project overrides it to true', async () => {
    // Reverting `dispatch()`'s gate to read only `NOTIFICATION_EVENT_DEFAULTS`
    // (ignoring `config.notificationEvents`) would make this never send.
    configureProject({ notification_events: { case_approved: true } });
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_approved', case_: makeCase() });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('mutes a default-on event when the project overrides it to false', async () => {
    configureProject({ notification_events: { case_needs_decision: false } });
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('an override for a different event does not affect the event being dispatched', async () => {
    configureProject({ notification_events: { case_done: true } });
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_approved', case_: makeCase() });

    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('NotificationDispatcher.dispatch — defaults-map gating', () => {
  it('never sends for an event whose default is chat:false, even with a webhook configured', async () => {
    // Reverting the gate check in `dispatch()` (or deleting it) would send
    // this — `case_approved` is deliberately muted by default.
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_approved', case_: makeCase() });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends for a chat:true event when a webhook is configured', async () => {
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationDispatcher.dispatch — project-webhook lookup', () => {
  it('does nothing when the project has no webhook configured', async () => {
    projectDocState.exists = true;
    projectDocState.data = { name: 'No Webhook Project' };
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when the project does not exist', async () => {
    projectDocState.exists = false;
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a missing webhook records nothing to notification_delivery (config gap, not a delivery failure)', async () => {
    // Reverting the "config gap, don't record" scope in `dispatch()` (e.g. by
    // moving the delivery-outcome write above the `!config.webhookUrl`
    // return) would make this call `update` even with no webhook to have
    // failed sending to.
    projectDocState.exists = true;
    projectDocState.data = { name: 'No Webhook Project' };
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(projectDocUpdateMock).not.toHaveBeenCalled();
  });

  it('a project-lookup failure records nothing to notification_delivery', async () => {
    projectDocState.exists = false;
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(projectDocUpdateMock).not.toHaveBeenCalled();
  });
});

/**
 * Delivery-outcome recording. Pre-fix, `send`'s result was discarded
 * entirely — a permanently dead webhook produced no visible signal anywhere.
 */
describe('NotificationDispatcher.dispatch — delivery-outcome recording', () => {
  it('records last_success_at on a successful send', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, status: 200, attempts: 1 });
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase({ project_id: 'proj_1' }) });

    expect(projectDocUpdateMock).toHaveBeenCalledTimes(1);
    const written = projectDocUpdateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof written['notification_delivery.last_success_at']).toBe('string');
    expect(written['notification_delivery.last_error']).toBeUndefined();
  });

  it('records last_error (with code and message) on a send that fails after retries', async () => {
    // Reverting the precedence rule (writing last_error under the
    // last_success_at key, or vice versa) would make this assertion on the
    // exact written key fail even though *some* write happened.
    sendMock.mockResolvedValueOnce({ ok: false, status: 500, error: 'still failing', attempts: 2 });
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    expect(projectDocUpdateMock).toHaveBeenCalledTimes(1);
    const written = projectDocUpdateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written['notification_delivery.last_success_at']).toBeUndefined();
    expect(written['notification_delivery.last_error']).toMatchObject({
      code: '500',
      message: 'still failing',
    });
    expect(typeof (written['notification_delivery.last_error'] as { at: string }).at).toBe('string');
  });

  it('records a "network_error" code (not a numeric status) when the failure was a network-level throw', async () => {
    sendMock.mockResolvedValueOnce({ ok: false, error: 'fetch failed', attempts: 2 });
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() });

    const written = projectDocUpdateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written['notification_delivery.last_error']).toMatchObject({
      code: 'network_error',
      message: 'fetch failed',
    });
  });

  it('a delivery-outcome write failure never throws out of dispatch() (fire-and-forget)', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, status: 200, attempts: 1 });
    projectDocUpdateMock.mockRejectedValueOnce(new Error('Firestore unavailable'));
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await expect(
      dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase() }),
    ).resolves.toBeUndefined();
  });
});

describe('NotificationDispatcher.dispatch — template resolution', () => {
  it('uses the built-in builder when no custom template is configured', async () => {
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'case_needs_decision', case_: makeCase({ title: 'Fix login bug' }) });

    const [, message] = sendMock.mock.calls[0]!;
    expect(message.title).toBe('Decision Required');
    expect(message.body).toContain("Fix login bug");
  });

  it('resolves a project custom template over the built-in builder', async () => {
    configureProject({
      notification_templates: {
        case_needs_decision: "Review needed for {{case.title}} ({{case.case_id}})",
      },
    });
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({
      event: 'case_needs_decision',
      case_: makeCase({ case_id: 'case_42', title: 'Fix login bug' }),
    });

    const [, message] = sendMock.mock.calls[0]!;
    expect(message.body).toBe('Review needed for Fix login bug (case_42)');
    // Custom-template callers opt out of the meta/status lines.
    expect(message.projectName).toBeUndefined();
    expect(message.status).toBeUndefined();
  });

  it('builds the run_failed message with the failure rationale', async () => {
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({
      event: 'run_failed',
      case_: makeCase({ title: 'Nightly sync' }),
      rationale: 'ETIMEDOUT',
    });

    const [, message] = sendMock.mock.calls[0]!;
    expect(message.title).toBe('Pipeline Task Failed');
    expect(message.body).toContain('Nightly sync');
    expect(message.body).toContain('ETIMEDOUT');
  });

  it('builds the run_retries_exhausted message', async () => {
    configureProject();
    const dispatcher = new NotificationDispatcher();

    await dispatcher.dispatch({ event: 'run_retries_exhausted', case_: makeCase({ title: 'Nightly sync' }) });

    const [, message] = sendMock.mock.calls[0]!;
    expect(message.title).toBe('Pipeline Task Failed After Retries');
    expect(message.body).toContain('Nightly sync');
  });
});
