import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const askMock = vi.fn();
class FakeHelperBotService {
  ask = askMock;
}

vi.mock('@arbitra/backend', () => ({
  HelperBotService: FakeHelperBotService,
}));

const { authenticate, handleError } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  handleError: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    handleError: (err: unknown) => {
      handleError(err);
      const message = err instanceof Error ? err.message : 'error';
      const status = (err as { status?: number })?.status ?? 500;
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

const { applyUserRateLimit } = vi.hoisted(() => ({ applyUserRateLimit: vi.fn() }));
vi.mock('../../../auth/connect/_helpers', () => ({ applyUserRateLimit }));

import { POST } from '../route';

function makeReq(body: unknown, init?: { rawBody?: string }): NextRequest {
  return new NextRequest('http://localhost/api/helper/ask', {
    method: 'POST',
    body: init?.rawBody ?? JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'usr_1', email: 'u@x.com' });
  applyUserRateLimit.mockResolvedValue(true);
});

describe('POST /api/helper/ask — rate limit (#1138)', () => {
  /** Reverts: the applyUserRateLimit guard in route.ts. */
  it('returns 429 and never calls the model once the per-user quota is spent', async () => {
    applyUserRateLimit.mockResolvedValue(false);

    const res = await POST(makeReq({ question: 'how do I set up MCP?' }));

    expect(res.status).toBe(429);
    expect(askMock).not.toHaveBeenCalled();
    expect(applyUserRateLimit).toHaveBeenCalledWith('usr_1', expect.objectContaining({ bucket: 'helper' }));
  });
});

describe('POST /api/helper/ask', () => {
  it('happy path (no history): returns answer + usage from the service, history defaults to []', async () => {
    askMock.mockResolvedValue({
      answer: 'Yes you can.',
      latency_ms: 42,
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    const res = await POST(makeReq({ question: 'how do I set up MCP?' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      answer: 'Yes you can.',
      latency_ms: 42,
      prompt_tokens: 10,
      completion_tokens: 5,
    });
    expect(askMock).toHaveBeenCalledWith('how do I set up MCP?', 'usr_1', []);
  });

  it('multi-turn: forwards history array to the service', async () => {
    askMock.mockResolvedValue({
      answer: 'second',
      latency_ms: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
    });

    const history = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ];
    const res = await POST(makeReq({ question: 'q2', history }));
    expect(res.status).toBe(200);
    expect(askMock).toHaveBeenCalledWith('q2', 'usr_1', history);
  });

  it('caps history at 10 turns server-side (most recent kept)', async () => {
    askMock.mockResolvedValue({
      answer: 'ok',
      latency_ms: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
    });
    const history = Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `t${i}`,
    }));
    const res = await POST(makeReq({ question: 'now', history }));
    expect(res.status).toBe(200);
    const passed = askMock.mock.calls[0]?.[2] as Array<{ content: string }>;
    expect(passed).toHaveLength(10);
    expect(passed[0]?.content).toBe('t4');
    expect(passed[9]?.content).toBe('t13');
  });

  it('rejects history with invalid role', async () => {
    const res = await POST(
      makeReq({
        question: 'hi',
        history: [{ role: 'system', content: 'nope' }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/role/i);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rejects history with empty content', async () => {
    const res = await POST(
      makeReq({
        question: 'hi',
        history: [{ role: 'user', content: '   ' }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/content/i);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rejects non-array history', async () => {
    const res = await POST(makeReq({ question: 'hi', history: 'oops' }));
    expect(res.status).toBe(400);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('requires authentication — auth failure flows through handleError', async () => {
    authenticate.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const res = await POST(makeReq({ question: 'hello' }));
    expect(res.status).toBe(401);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rejects empty question', async () => {
    const res = await POST(makeReq({ question: '   ' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/question/i);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rejects missing question', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rejects question over 2000 chars', async () => {
    const res = await POST(makeReq({ question: 'a'.repeat(2001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/2000/);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON body', async () => {
    const res = await POST(makeReq(undefined, { rawBody: '{not json' }));
    expect(res.status).toBe(400);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('propagates service errors via handleError', async () => {
    askMock.mockRejectedValue(new Error('LLM exploded'));
    const res = await POST(makeReq({ question: 'hi' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe('LLM exploded');
  });
});
