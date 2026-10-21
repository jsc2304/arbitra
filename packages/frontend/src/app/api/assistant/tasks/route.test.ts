import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { intake, listCases } = vi.hoisted(() => ({ intake: vi.fn(), listCases: vi.fn() }));

vi.mock('@arbitra/backend', () => ({
  AssistantIntakeService: class {
    intake = intake;
  },
  CaseService: class {
    listCases = listCases;
  },
  clerkCoreIds: (userId: string) => ({
    projectId: `proj_clerk_${userId}`,
    repositoryId: `repo_clerk_${userId}`,
    policyId: `ep_clerk_${userId}`,
  }),
  validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T => schema.parse(body),
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  handleError: (error: unknown) => {
    const isValidation = error instanceof Error && 'issues' in error;
    return NextResponse.json(
      { error: { code: isValidation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' } },
      { status: isValidation ? 400 : 500 },
    );
  },
}));

vi.mock('@/lib/public-base-url', () => ({ resolveCaseShareUrl: vi.fn(() => null) }));

import { GET, POST } from './route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/assistant/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeListRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/assistant/tasks${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_web' });
  listCases.mockResolvedValue({ cases: [] });
  intake.mockResolvedValue({
    case: { case_id: 'case_web', status: 'open' },
    run: null,
    run_id: 'run_web',
    event_id: 'event_web',
    replayed: false,
  });
});

describe('POST /api/assistant/tasks', () => {
  it('refuses a body claiming Google Chat provenance', async () => {
    const response = await POST(
      makeRequest({
        text: 'Please do this',
        channel: 'google_chat',
        chat: { space_name: 'spaces/forged', source_message_name: 'spaces/forged/messages/1' },
      }),
    );

    expect(response.status).toBe(400);
    expect(intake).not.toHaveBeenCalled();
  });

  it('always records web provenance for a case created by this route', async () => {
    const response = await POST(makeRequest({ text: 'Please do this', idempotency_key: 'web-1' }));

    expect(response.status).toBe(201);
    expect(intake).toHaveBeenCalledWith(
      { text: 'Please do this', idempotency_key: 'web-1', channel: 'web' },
      'usr_web',
    );
  });
});

describe('GET /api/assistant/tasks', () => {
  it('lists only the project derived from the caller', async () => {
    await GET(makeListRequest());

    expect(listCases).toHaveBeenCalledWith({ project_id: 'proj_clerk_usr_web', limit: 10 });
  });

  it('returns assistant tasks only, with just the fields the list needs', async () => {
    listCases.mockResolvedValue({
      cases: [
        {
          case_id: 'case_a',
          title: 'Which cases exist?',
          status: 'done',
          case_type: 'assistant_task',
          created_at: '2026-08-01T10:00:00.000Z',
          updated_at: '2026-08-01T10:00:14.000Z',
          description: 'Which cases exist?',
        },
        {
          case_id: 'case_b',
          title: 'Not a task',
          status: 'open',
          case_type: 'bugfix',
          created_at: '2026-08-01T09:00:00.000Z',
          updated_at: '2026-08-01T09:00:00.000Z',
        },
      ],
    });

    const body = await (await GET(makeListRequest())).json();

    expect(body.tasks).toEqual([
      {
        case_id: 'case_a',
        title: 'Which cases exist?',
        status: 'done',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:14.000Z',
      },
    ]);
  });

  it('passes assistant_thread through for a follow-up, unchanged for a root', async () => {
    listCases.mockResolvedValue({
      cases: [
        {
          case_id: 'case_root',
          title: 'Root task',
          status: 'done',
          case_type: 'assistant_task',
          created_at: '2026-08-01T09:00:00.000Z',
          updated_at: '2026-08-01T09:00:14.000Z',
        },
        {
          case_id: 'case_followup',
          title: 'Follow-up task',
          status: 'done',
          case_type: 'assistant_task',
          created_at: '2026-08-01T10:00:00.000Z',
          updated_at: '2026-08-01T10:00:14.000Z',
          assistant_thread: {
            schema_version: 1,
            root_case_id: 'case_root',
            parent_case_id: 'case_root',
            prior_run_id: 'run_1',
            prior_result_evidence_id: 'evi_1',
            prior_result_artifact_id: 'art_1',
            depth: 1,
          },
        },
      ],
    });

    const body = await (await GET(makeListRequest())).json();

    expect(body.tasks).toEqual([
      {
        case_id: 'case_root',
        title: 'Root task',
        status: 'done',
        created_at: '2026-08-01T09:00:00.000Z',
        updated_at: '2026-08-01T09:00:14.000Z',
      },
      {
        case_id: 'case_followup',
        title: 'Follow-up task',
        status: 'done',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:14.000Z',
        assistant_thread: { root_case_id: 'case_root' },
      },
    ]);
  });

  it('caps and sanitises the requested limit', async () => {
    await GET(makeListRequest('?limit=500'));
    expect(listCases).toHaveBeenLastCalledWith({ project_id: 'proj_clerk_usr_web', limit: 50 });

    await GET(makeListRequest('?limit=abc'));
    expect(listCases).toHaveBeenLastCalledWith({ project_id: 'proj_clerk_usr_web', limit: 10 });

    await GET(makeListRequest('?limit=-3'));
    expect(listCases).toHaveBeenLastCalledWith({ project_id: 'proj_clerk_usr_web', limit: 10 });
  });

  it('#858: projects blueprint_id, blueprint_version, and reads_withheld for a blueprint-created case', async () => {
    listCases.mockResolvedValue({
      cases: [
        {
          case_id: 'case_occurrence',
          title: "Every Monday at 9, summarize my team's open cases",
          status: 'done',
          case_type: 'assistant_task',
          created_at: '2026-08-01T09:00:00.000Z',
          updated_at: '2026-08-01T09:00:14.000Z',
          assistant_context: {
            channel: 'blueprint',
            conversation_visibility: 'direct',
            risk_level: 'low',
            policy_version: 'assistant_policy:v1',
            prompt_version: 'assistant_task:v1',
            blueprint_id: 'taskBlueprint_roster_check',
            blueprint_context: {
              blueprint_id: 'taskBlueprint_roster_check',
              blueprint_version: 3,
              prompt_text: "Every Monday at 9, summarize my team's open cases",
            },
            reads_withheld: true,
            reads_withheld_reason: 'step_budget',
          },
        },
      ],
    });

    const body = await (await GET(makeListRequest())).json();

    expect(body.tasks).toEqual([
      {
        case_id: 'case_occurrence',
        title: "Every Monday at 9, summarize my team's open cases",
        status: 'done',
        created_at: '2026-08-01T09:00:00.000Z',
        updated_at: '2026-08-01T09:00:14.000Z',
        blueprint_id: 'taskBlueprint_roster_check',
        blueprint_version: 3,
        reads_withheld: true,
      },
    ]);
  });

  it('#858: omits blueprint_id, blueprint_version, and reads_withheld for a case with none of them (Ask-tab / still-running)', async () => {
    listCases.mockResolvedValue({
      cases: [
        {
          case_id: 'case_ask',
          title: 'Which cases exist?',
          status: 'open',
          case_type: 'assistant_task',
          created_at: '2026-08-01T09:00:00.000Z',
          updated_at: '2026-08-01T09:00:14.000Z',
          assistant_context: {
            channel: 'web',
            conversation_visibility: 'direct',
            risk_level: 'low',
            policy_version: 'assistant_policy:v1',
            prompt_version: 'assistant_task:v1',
          },
        },
      ],
    });

    const body = await (await GET(makeListRequest())).json();

    // Reverting the `?? []`/optional-spread guards to unconditionally include
    // these keys (e.g. `blueprint_id: undefined`) would still serialize as
    // absent through `NextResponse.json`, so this test specifically checks
    // the KEYS are missing, not merely that the values are falsy.
    expect(body.tasks).toEqual([
      {
        case_id: 'case_ask',
        title: 'Which cases exist?',
        status: 'open',
        created_at: '2026-08-01T09:00:00.000Z',
        updated_at: '2026-08-01T09:00:14.000Z',
      },
    ]);
    expect(Object.keys(body.tasks[0])).not.toContain('blueprint_id');
    expect(Object.keys(body.tasks[0])).not.toContain('blueprint_version');
    expect(Object.keys(body.tasks[0])).not.toContain('reads_withheld');
  });
});
