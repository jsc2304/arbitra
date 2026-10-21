import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api-client';
import { getIdToken } from '../firebase-client';

vi.mock('../firebase-client', () => ({
  getIdToken: vi.fn(async () => null),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.artifacts.content', () => {
  it('loads artifact bytes through the API client and returns a data URL', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce('test-token');
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([0, 1, 2, 255]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.artifacts.content('art test/1')).resolves.toBe(
      'data:image/png;base64,AAEC/w==',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/artifacts/art%20test%2F1/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });
});

describe('api.assistant.createTask', () => {
  it('posts the Clerk request only to the assistant intake route', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce('test-token');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        case_id: 'case_new',
        run_id: 'run_new',
        status: 'open',
        replayed: false,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await api.assistant.createTask({
      text: 'Which cases exist?',
      idempotency_key: 'web-abc',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/assistant/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        text: 'Which cases exist?',
        idempotency_key: 'web-abc',
      }),
    });
  });
});

describe('api.assistant.cancelTask', () => {
  it('posts only the exact displayed run id to the encoded Clerk cancellation route', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce('test-token');
    const responseBody = {
      case_id: 'case / one',
      target_run_id: 'run_retry_2',
      cancelled_run_ids: ['run_retry_2'],
      pending_reconciliation_run_ids: ['run_retry_2'],
      status: 'rejected',
      cancel_revision: 1,
      requested_at: '2026-08-05T09:00:00.000Z',
      requested_by: 'user_1',
      replayed: false,
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.assistant.cancelTask('case / one', 'run_retry_2')).resolves.toEqual(
      responseBody,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/assistant/tasks/case%20%2F%20one/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ run_id: 'run_retry_2' }),
    });
  });
});

describe('api.cases.listAll', () => {
  it('walks every page and merges per-case finding counts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cursor=case_100')) {
        return new Response(JSON.stringify({
          cases: [{ case_id: 'case_101' }],
          finding_counts: { case_101: 2 },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        cases: [{ case_id: 'case_001' }],
        cursor: 'case_100',
        finding_counts: { case_001: 1 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.cases.listAll({ project_id: 'proj_x' });

    expect(result.cases.map((case_) => case_.case_id)).toEqual(['case_001', 'case_101']);
    expect(result.finding_counts).toEqual({ case_001: 1, case_101: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/cases?project_id=proj_x&limit=100');
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/api/cases?project_id=proj_x&cursor=case_100&limit=100');
  });
});

// ---------------------------------------------------------------------------
// Non-JSON error guard. Cloud Run answers 429 "Rate exceeded." as PLAIN TEXT
// when all instance slots are saturated — a blind
// `response.json()` on that body surfaced "Unexpected token 'R' ... is not
// valid JSON" to users. The helper must read text first and produce a
// readable status-prefixed message instead.
// ---------------------------------------------------------------------------
describe('fetchApi error handling (via api.activity.list)', () => {
  it('turns a plain-text 429 body into a readable error, not a JSON SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('Rate exceeded.', {
          status: 429,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    );

    await expect(api.activity.list()).rejects.toThrow(
      'Request failed (429): Rate exceeded.',
    );
  });

  it('still surfaces the structured API error message on JSON error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: 'FORBIDDEN', message: 'No project access' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(api.activity.list()).rejects.toThrow('No project access');
  });

  it('falls back to the legacy status-only message when the error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 502 })),
    );

    await expect(api.activity.list()).rejects.toThrow('Request failed: 502');
  });

  // The assistant intake's refusals are only actionable if the machine-readable
  // half of the envelope survives the throw: a 429 `active_per_user` carries the
  // case ids blocking the user, and `CLERK_CORE_NOT_PROVISIONED` is recognised by
  // its code so the caller can provision and retry.
  it('carries the error code and details onto the thrown ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'ASSISTANT_INTAKE_LIMIT',
              message: 'You already have 10 active assistant tasks; the limit is 10.',
              details: { limit: 'active_per_user', active: 10, max: 10, case_ids: ['case_a'] },
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const error = await api.assistant.createTask({ text: 'x' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.code).toBe('ASSISTANT_INTAKE_LIMIT');
    expect(apiError.details).toEqual({
      limit: 'active_per_user',
      active: 10,
      max: 10,
      case_ids: ['case_a'],
    });
  });
});
