/**
 * Tests the hardening added to the webhook POST handler on the bad-signature
 * path: oversized-body early-out, per-field truncation, and defence-in-depth
 * caps even when the signature is valid. We mock `@arbitra/backend` so the
 * route under test runs in isolation from Firestore.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

interface LoggedRejection {
  reason: string;
  event?: string;
  action?: string;
  repository?: string;
  repository_id?: number;
  branch?: string;
  pr_url?: string;
}

const { logWebhookRejection, handleGitWebhook, verifyGitHubSignature, parseGitHubWebhook } = vi.hoisted(() => {
  const logged: LoggedRejection[] = [];
  return {
    logWebhookRejection: vi.fn(async (args: LoggedRejection) => {
      logged.push(args);
    }),
    handleGitWebhook: vi.fn(async () => ({ action: 'ignored' })),
    verifyGitHubSignature: vi.fn(),
    parseGitHubWebhook: vi.fn(),
    // exposed for assertions via a getter on the mock module
    _logged: logged,
  };
});

vi.mock('@arbitra/backend', () => ({
  WebhookService: class {
    logWebhookRejection = logWebhookRejection;
    handleGitWebhook = handleGitWebhook;
  },
  verifyGitHubSignature,
  parseGitHubWebhook,
  FirestorePipelineAdapter: class {},
}));

vi.mock('@/lib/api-helpers', () => ({
  handleError: (error: unknown) => {
    return new Response(
      JSON.stringify({
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  },
}));

// Import AFTER mocks so the route picks them up.
import { POST } from './route';

function sign(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  return `sha256=${hmac.update(body).digest('hex')}`;
}

function makeReq(body: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/git', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['GITHUB_WEBHOOK_SECRET'] = 'test-secret';
  verifyGitHubSignature.mockReturnValue(false); // default: bad sig
});

describe('POST /api/webhooks/git — bad-signature hardening', () => {
  it('caps forwarded fields on a normal-sized bad-signature request (no full body written)', async () => {
    const longFullName = 'acme/' + 'a'.repeat(2000);
    const body = JSON.stringify({
      repository: { full_name: longFullName, id: 4242 },
      action: 'opened',
      pull_request: {
        html_url: 'https://github.com/acme/x/pull/' + '1'.repeat(2000),
        head: { ref: 'feat/' + 'y'.repeat(2000) },
      },
    });
    const req = makeReq(body, {
      'x-hub-signature-256': 'sha256=deadbeef',
      'x-github-event': 'pull_request',
    });

    const res = await POST(req);
    expect(res.status).toBe(401);

    expect(logWebhookRejection).toHaveBeenCalledTimes(1);
    const call = logWebhookRejection.mock.calls[0]![0] as LoggedRejection;
    expect(call.reason).toContain('Invalid webhook signature');
    // Every forwarded string must be truncated to <= 512 chars.
    expect(call.repository!.length).toBeLessThanOrEqual(512);
    expect(call.pr_url!.length).toBeLessThanOrEqual(512);
    expect(call.branch!.length).toBeLessThanOrEqual(512);
    // Numeric id passes through unchanged.
    expect(call.repository_id).toBe(4242);
  });

  it('skips the structured parse entirely when the body is larger than 64 KB', async () => {
    // 100 KB of attacker-controlled JSON — parse would succeed but the route
    // must short-circuit before extracting any fields.
    const filler = 'x'.repeat(100 * 1024);
    const body = JSON.stringify({
      repository: { full_name: 'acme/huge', id: 7777 },
      action: 'opened',
      filler,
    });
    expect(body.length).toBeGreaterThan(64 * 1024);

    const req = makeReq(body, {
      'x-hub-signature-256': 'sha256=deadbeef',
      'x-github-event': 'pull_request',
    });

    const res = await POST(req);
    expect(res.status).toBe(401);

    expect(logWebhookRejection).toHaveBeenCalledTimes(1);
    const call = logWebhookRejection.mock.calls[0]![0] as LoggedRejection;
    expect(call.reason).toContain('oversized body, skipped parse');
    // Crucially: no extracted fields from the untrusted body.
    expect(call.repository).toBeUndefined();
    expect(call.repository_id).toBeUndefined();
    expect(call.branch).toBeUndefined();
    expect(call.pr_url).toBeUndefined();
    expect(call.action).toBeUndefined();
    // Event header still recorded (capped).
    expect(call.event).toBe('pull_request');
  });

  it('accepts a valid-signature request and routes to handleGitWebhook', async () => {
    verifyGitHubSignature.mockReturnValue(true);
    parseGitHubWebhook.mockReturnValue({
      action: 'opened',
      event: 'pull_request',
      pr_url: 'https://github.com/acme/ok/pull/1',
      branch: 'feat/ok',
      repository: 'acme/ok',
      repository_id: 1234,
    });
    const body = JSON.stringify({ repository: { full_name: 'acme/ok', id: 1234 } });
    const req = makeReq(body, {
      'x-hub-signature-256': sign(body, 'test-secret'),
      'x-github-event': 'pull_request',
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(handleGitWebhook).toHaveBeenCalledTimes(1);
    expect(logWebhookRejection).not.toHaveBeenCalled();
  });
});
