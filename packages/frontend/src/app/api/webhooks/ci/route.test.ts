/**
 * Tests the hardening on `POST /api/webhooks/ci`: HMAC signature
 * verification (mirrors the git webhook's `x-hub-signature-256` +
 * `crypto.timingSafeEqual` check) gates every request BEFORE any parse or
 * Firestore work, and the request body is validated through `ciWebhookSchema`
 * instead of the old hand-rolled `parseCIWebhook`.
 *
 * `WebhookService` is mocked (no Firestore in a route test), but
 * `validateBody` / `verifyCIWebhookSignature` / `handleError` are left real
 * so the actual HMAC comparison and schema rejection are exercised, not just
 * the route's wiring around mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

const { handleCIWebhook } = vi.hoisted(() => ({
  handleCIWebhook: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...actual,
    WebhookService: class {
      handleCIWebhook = handleCIWebhook;
    },
  };
});

// Import AFTER mocks so the route picks them up.
import { POST } from './route';

const SECRET = 'test-ci-secret';

function sign(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  return `sha256=${hmac.update(body).digest('hex')}`;
}

function makeReq(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/ci', {
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
  process.env['CI_WEBHOOK_SECRET'] = SECRET;
});

describe('POST /api/webhooks/ci', () => {
  it('rejects an unsigned request with 401 and never calls the service', async () => {
    const body = JSON.stringify({ build_id: 'b1', status: 'success', case_id: 'case_1' });
    const res = await POST(makeReq(body));

    expect(res.status).toBe(401);
    expect(handleCIWebhook).not.toHaveBeenCalled();
  });

  it('rejects a wrong signature with 401 and never calls the service', async () => {
    const body = JSON.stringify({ build_id: 'b1', status: 'success', case_id: 'case_1' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, 'not-the-right-secret') });
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(handleCIWebhook).not.toHaveBeenCalled();
  });

  it('fails closed with 500 when CI_WEBHOOK_SECRET is not configured', async () => {
    delete process.env['CI_WEBHOOK_SECRET'];
    const body = JSON.stringify({ build_id: 'b1', status: 'success', case_id: 'case_1' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, SECRET) });
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(handleCIWebhook).not.toHaveBeenCalled();
  });

  it('rejects a schema-invalid payload with 400 even with a valid signature', async () => {
    // Missing required `status`.
    const body = JSON.stringify({ build_id: 'b1', case_id: 'case_1' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, SECRET) });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(handleCIWebhook).not.toHaveBeenCalled();
  });

  it('rejects an unknown status string with 400 (strict enum, no more silent coercion to failure)', async () => {
    // KNOWN BEHAVIOR CHANGE: the old `parseCIWebhook` coerced any
    // non-'success' status to 'failure'; `ciWebhookSchema` rejects it.
    const body = JSON.stringify({ build_id: 'b1', status: 'pending', case_id: 'case_1' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, SECRET) });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(handleCIWebhook).not.toHaveBeenCalled();
  });

  it('returns 404 for a valid signature + unknown case_id, without registering evidence', async () => {
    handleCIWebhook.mockResolvedValue({ ok: false, reason: 'case_not_found' });
    const body = JSON.stringify({ build_id: 'b1', status: 'success', case_id: 'case_missing' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, SECRET) });
    const res = await POST(req);

    expect(res.status).toBe(404);
    expect(handleCIWebhook).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when the service reports a missing case_id', async () => {
    handleCIWebhook.mockResolvedValue({ ok: false, reason: 'missing_case_id' });
    const body = JSON.stringify({ build_id: 'b1', status: 'success' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, SECRET) });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const responseBody = await res.json() as { error: string };
    expect(responseBody.error).toBe('case_id is required');
  });

  it('registers evidence on a valid signature + valid payload (happy path)', async () => {
    handleCIWebhook.mockResolvedValue({ ok: true, action: 'evidence_registered' });
    const body = JSON.stringify({ build_id: 'b2', status: 'success', case_id: 'case_1' });
    const req = makeReq(body, { 'x-hub-signature-256': sign(body, SECRET) });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const responseBody = await res.json() as { status: string; build_id: string };
    expect(responseBody.status).toBe('processed');
    expect(responseBody.build_id).toBe('b2');
    expect(handleCIWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ build_id: 'b2', status: 'success', case_id: 'case_1' }),
    );
  });
});
