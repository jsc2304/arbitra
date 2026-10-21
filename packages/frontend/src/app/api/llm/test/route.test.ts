import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { resolveModel, requireRole, generateText } = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  requireRole: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  resolveModel,
  requireRole,
}));

vi.mock('ai', () => ({
  generateText,
}));

const { authenticate, requireProjectAccess, handleError } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  requireProjectAccess: vi.fn(),
  handleError: vi.fn(),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticate,
    requireProjectAccess,
    handleError: (err: unknown) => {
      handleError(err);
      const message = err instanceof Error ? err.message : 'error';
      const status = (err as { status?: number })?.status ?? 500;
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

import { POST } from './route';
import { __resetRateLimit } from './rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/llm/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetRateLimit();
  authenticate.mockResolvedValue({ userId: 'user_1' });
  requireProjectAccess.mockResolvedValue(null);
  requireRole.mockResolvedValue(['admin']);
  resolveModel.mockResolvedValue({} as unknown);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/llm/test', () => {
  it('success path: ok=true, latency_ms set', async () => {
    generateText.mockResolvedValue({ text: 'ok' });
    const res = await POST(
      // Uses 'anthropic' (still enabled) rather than 'google' — #1068 flipped
      // google to `enabled: false`, so a google ping is now skipped without
      // ever reaching generateText (see "disabled provider" test below).
      makeReq({ provider: 'anthropic', models: { low: 'claude-haiku-4-5-20251001' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.low.ok).toBe(true);
    expect(body.results.low.model).toBe('claude-haiku-4-5-20251001');
    expect(typeof body.results.low.latency_ms).toBe('number');
    expect(body.results.low.error).toBeUndefined();
  });

  it('failure path: ok=false with error string, no key leak', async () => {
    generateText.mockRejectedValue(new Error('Invalid API key: sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. stack: at foo\nat bar'));
    const res = await POST(
      makeReq({ provider: 'anthropic', models: { low: 'claude-haiku-4-5-20251001' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.low.ok).toBe(false);
    expect(body.results.low.error).toBeTruthy();
    expect(body.results.low.error).not.toContain('sk-AAAA');
    expect(body.results.low.error).not.toContain('at bar');
  });

  it('timeout path: per-call timeout fires and produces Timed out error', async () => {
    generateText.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      return await new Promise((_resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('AbortError: aborted'));
          return;
        }
        abortSignal?.addEventListener('abort', () => {
          reject(new Error('AbortError: aborted'));
        });
      });
    });

    vi.useFakeTimers();
    const promise = POST(
      makeReq({ provider: 'anthropic', models: { low: 'claude-haiku-4-5-20251001' } }),
    );
    // Let the async route reach the pending mock before advancing its timers.
    // Otherwise POST can time out first and call generateText after this test ends.
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    // Advance past the 30s per-call timeout, then past the 35s total timeout (belt + suspenders).
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await promise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.low.ok).toBe(false);
    expect(body.results.low.error).toMatch(/Timed out/);
  }, 20000);

  it('google is disabled (#1068, un-reverified since the structured-output fixes) and returns skipped without calling the model', async () => {
    const res = await POST(
      makeReq({ provider: 'google', models: { low: 'gemini-2.5-flash' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.low.ok).toBe(false);
    expect(body.results.low.skipped).toBe(true);
    expect(body.results.low.reason).toBe('provider not enabled');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('anthropic is enabled and gets pinged', async () => {
    generateText.mockResolvedValue({ text: 'ok' });
    const res = await POST(
      makeReq({ provider: 'anthropic', models: { low: 'claude-haiku-4-5-20251001' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.low.ok).toBe(true);
    expect(body.results.low.skipped).toBeUndefined();
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('missing risk levels are skipped (only populated pairs pinged)', async () => {
    generateText.mockResolvedValue({ text: 'ok' });
    const res = await POST(
      makeReq({ provider: 'anthropic', models: { low: 'claude-haiku-4-5-20251001', high: '' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.low.ok).toBe(true);
    expect(body.results.medium).toBeUndefined();
    expect(body.results.high).toBeUndefined();
    expect(body.results.critical).toBeUndefined();
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('rate limit: 6th call returns 429', async () => {
    generateText.mockResolvedValue({ text: 'ok' });
    const body = { provider: 'google', models: { low: 'gemini-2.5-flash' } };
    for (let i = 0; i < 5; i++) {
      const res = await POST(makeReq(body));
      expect(res.status).toBe(200);
    }
    const res6 = await POST(makeReq(body));
    expect(res6.status).toBe(429);
    const errBody = await res6.json();
    expect(errBody.error.message).toMatch(/Rate limit/i);
  });

  it('no project_id requires admin role', async () => {
    generateText.mockResolvedValue({ text: 'ok' });
    await POST(makeReq({ provider: 'google', models: { low: 'gemini-2.5-flash' } }));
    expect(requireRole).toHaveBeenCalledWith('user_1', ['admin']);
    expect(requireProjectAccess).not.toHaveBeenCalled();
  });

  it('with project_id requires project access, not admin', async () => {
    generateText.mockResolvedValue({ text: 'ok' });
    await POST(
      makeReq({ provider: 'google', models: { low: 'gemini-2.5-flash' }, project_id: 'proj_1' }),
    );
    expect(requireProjectAccess).toHaveBeenCalledWith('proj_1', 'user_1');
    expect(requireRole).not.toHaveBeenCalled();
  });
});
