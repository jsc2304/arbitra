import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  ASSISTANT_TOOL_SELECTION_REASON,
  type AssistantToolPolicyTrace,
} from '@arbitra/shared';

const {
  artifactDocGet,
  runDocGet,
  readContent,
  authenticate,
  requireArtifactCaseAccess,
} = vi.hoisted(() => ({
  artifactDocGet: vi.fn(),
  runDocGet: vi.fn(),
  readContent: vi.fn(),
  authenticate: vi.fn(),
  requireArtifactCaseAccess: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  collections: {
    artifacts: () => ({ doc: () => ({ get: artifactDocGet }) }),
    runs: () => ({ doc: () => ({ get: runDocGet }) }),
  },
  ArtifactService: class {
    readContent = readContent;
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  authenticate,
  requireArtifactCaseAccess,
  handleError: (error: unknown) => NextResponse.json(
    { error: { message: error instanceof Error ? error.message : String(error) } },
    { status: 500 },
  ),
}));

import { GET } from './route';

const policy: AssistantToolPolicyTrace = {
  schema_version: 1,
  task_kind: 'general_question',
  enabled_tools: ['list_cases', 'get_case_context'],
  tool_selection_reason: ASSISTANT_TOOL_SELECTION_REASON,
};

function dataUrl(value: string, contentType = 'application/json'): string {
  return `data:${contentType};base64,${Buffer.from(value).toString('base64')}`;
}

function assistantResult(schema: 'arbitra.assistant_task_result/v1' | 'arbitra.assistant_task_result/v2') {
  return dataUrl(JSON.stringify({
    schema,
    answer: 'Stored answer',
    ...(schema.endsWith('/v2') ? { assistant_tool_policy: policy } : {}),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireArtifactCaseAccess.mockResolvedValue(null);
  artifactDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      artifact_id: 'artifact_1',
      case_id: 'case_1',
      run_id: 'run_1',
      filename: 'result.json',
      storage_path: 'cases/case_1/result.json',
    }),
  });
  runDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      run_id: 'run_1',
      case_id: 'case_1',
      run_type: 'assistant_task_run',
      assistant_policy_state: 'bound',
      assistant_tool_policy: policy,
    }),
  });
});

describe('GET /api/artifacts/:artifactId/content assistant-result integrity', () => {
  it('keeps opaque non-JSON artifacts on the normal authenticated download path', async () => {
    readContent.mockResolvedValue(dataUrl('plain bytes', 'text/plain'));

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('plain bytes');
    expect(requireArtifactCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    expect(runDocGet).not.toHaveBeenCalled();
  });

  it.each([
    ['the JSON null value', 'null'],
    ['a foreign JSON object', '{"schema":"third.party/v1","value":1}'],
  ])('keeps %s on the normal authenticated download path', async (_label, document) => {
    readContent.mockResolvedValue(dataUrl(document));

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(document);
    expect(runDocGet).not.toHaveBeenCalled();
  });

  it('keeps legacy v1 assistant results readable without synthesising a policy', async () => {
    readContent.mockResolvedValue(assistantResult('arbitra.assistant_task_result/v1'));

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(200);
    expect(runDocGet).not.toHaveBeenCalled();
  });

  it('serves v2 only when the stored result matches the linked bound Run', async () => {
    readContent.mockResolvedValue(assistantResult('arbitra.assistant_task_result/v2'));

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(200);
    expect(runDocGet).toHaveBeenCalledOnce();
  });

  it('returns a generic conflict when a v2 snapshot diverges from the linked Run', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    readContent.mockResolvedValue(assistantResult('arbitra.assistant_task_result/v2'));
    runDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        run_id: 'run_1',
        case_id: 'case_1',
        run_type: 'assistant_task_run',
        assistant_policy_state: 'bound',
        assistant_tool_policy: { ...policy, enabled_tools: ['list_cases'] },
      }),
    });

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: 'Assistant result integrity check failed' },
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('artifact_1'),
      expect.any(Error),
    );
    errorLog.mockRestore();
  });
});

/**
 * Issue #811 item 1: the route must call the artifact-specific access gate
 * (`requireArtifactCaseAccess`, backed by `checkArtifactCaseAccess` — see its
 * unit tests in `packages/backend/src/lib/project-access.test.ts` for the
 * actual requester-only policy decision) rather than the generic
 * `requireCaseAccess`, and must pass its response straight through.
 */
describe('GET /api/artifacts/:artifactId/content access gate wiring', () => {
  it('passes through the 403 requester-only denial without reading the artifact', async () => {
    // Reverting the route back to `requireCaseAccess` makes this fail: the
    // mocked generic case-access gate resolves to `null` (allow) regardless
    // of case_type, so the response would be 200, not 403.
    requireArtifactCaseAccess.mockResolvedValue(
      NextResponse.json(
        { error: { code: 'ASSISTANT_ARTIFACT_REQUESTER_ONLY', message: 'Only the Clerk requester can view this answer.' } },
        { status: 403 },
      ),
    );

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'ASSISTANT_ARTIFACT_REQUESTER_ONLY', message: 'Only the Clerk requester can view this answer.' },
    });
    expect(requireArtifactCaseAccess).toHaveBeenCalledWith('case_1', 'user_1');
    expect(readContent).not.toHaveBeenCalled();
  });

  it('serves content when the gate allows access (e.g. the requester)', async () => {
    requireArtifactCaseAccess.mockResolvedValue(null);
    readContent.mockResolvedValue(dataUrl('plain bytes', 'text/plain'));

    const response = await GET(
      new NextRequest('http://localhost/api/artifacts/artifact_1/content'),
      { params: Promise.resolve({ artifactId: 'artifact_1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('plain bytes');
  });
});
