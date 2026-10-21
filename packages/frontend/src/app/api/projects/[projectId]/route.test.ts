/**
 * @file `PATCH /api/projects/[projectId]` — notification-config validation
 * (spec Slice C item 3, `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * Pre-fix, this route spread the entire PATCH body onto the Firestore doc
 * with zero validation on `notification_webhook_url`/`notification_events`/
 * `notification_templates` — an unreachable host or a typo'd event key would
 * persist silently. Each 400 test asserts `docUpdate` was never called, so a
 * regression that validates-then-writes-anyway (instead of rejecting before
 * the write) still fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  const { formatValidationIssues, validateBody } = await import('@arbitra/backend');
  return {
    authenticate,
    validate: validateBody,
    validationErrorResponse: (message: string, issues: unknown[]) =>
      NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message, details: { issues: formatValidationIssues(issues as never) } } },
        { status: 400 },
      ),
    handleError: (err: unknown) => {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status });
    },
  };
});

const { projectDocGet, projectDocUpdate, usersDocGet, invalidateProjectConfigCache } = vi.hoisted(() => ({
  projectDocGet: vi.fn(),
  projectDocUpdate: vi.fn(),
  usersDocGet: vi.fn(),
  invalidateProjectConfigCache: vi.fn(),
}));

vi.mock('@arbitra/backend', async (importOriginal) => {
  const original = await importOriginal<typeof import('@arbitra/backend')>();
  return {
    ...original,
    collections: {
      projects: () => ({
        doc: () => ({
          get: projectDocGet,
          update: projectDocUpdate,
        }),
      }),
      users: () => ({
        doc: () => ({ get: usersDocGet }),
      }),
    },
    invalidateProjectConfigCache,
  };
});

import { PATCH } from './route';

const params = { params: Promise.resolve({ projectId: 'proj_1' }) };

function makePatchReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/projects/proj_1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticate.mockResolvedValue({ userId: 'user_owner' });
  projectDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ project_id: 'proj_1', owner_user_id: 'user_owner', name: 'Test Project' }),
  });
  usersDocGet.mockResolvedValue({ exists: true, data: () => ({ roles: [] }) });
  projectDocUpdate.mockResolvedValue(undefined);
});

describe('PATCH /api/projects/[projectId] — notification_webhook_url validation', () => {
  it('400s on a webhook URL pointing at a foreign host', async () => {
    const res = await PATCH(makePatchReq({ notification_webhook_url: 'https://evil.example.com/hook' }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('accepts a valid chat.googleapis.com webhook URL', async () => {
    const res = await PATCH(
      makePatchReq({ notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/x/messages?key=y' }),
      params,
    );

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
  });

  it('accepts an empty string to clear the webhook URL, and actually deletes the field rather than storing "" (issue #1100)', async () => {
    const res = await PATCH(makePatchReq({ notification_webhook_url: '' }), params);

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
    // A literal `''` written through would satisfy a call-count-only check
    // (the old bug's blind spot) while leaving the field present-but-empty,
    // diverging from `Project.notification_webhook_url?: string`.
    const persisted = projectDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.notification_webhook_url).toBe(FieldValue.delete());
  });

  it('accepts null to clear the webhook URL, and actually deletes the field rather than storing null (issue #1100)', async () => {
    const res = await PATCH(makePatchReq({ notification_webhook_url: null }), params);

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
    const persisted = projectDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.notification_webhook_url).toBe(FieldValue.delete());
  });

  it('actually removes a previously-stored webhook URL end to end, not just null-in/200-out (issue #1100)', async () => {
    // Stronger than the two tests above: fakes Firestore's own update()
    // merge contract (a FieldValue.delete() sentinel removes the key from
    // the doc; any other value sets it) so this drives the route's clear
    // decision through to an observable persisted document, instead of only
    // inspecting the call arguments passed to a bare mock.
    const stored: Record<string, unknown> = {
      project_id: 'proj_1',
      owner_user_id: 'user_owner',
      name: 'Test Project',
      notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/old/messages?key=z',
    };
    projectDocGet.mockImplementation(async () => ({ exists: true, data: () => ({ ...stored }) }));
    projectDocUpdate.mockImplementation(async (update: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(update)) {
        if (value === FieldValue.delete()) {
          delete stored[key];
        } else {
          stored[key] = value;
        }
      }
    });

    const res = await PATCH(makePatchReq({ notification_webhook_url: null }), params);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect('notification_webhook_url' in stored).toBe(false);
    expect('notification_webhook_url' in body).toBe(false);
  });
});

describe('PATCH /api/projects/[projectId] — notification_events validation', () => {
  it('400s on a non-catalog event key', async () => {
    const res = await PATCH(makePatchReq({ notification_events: { not_a_real_event: true } }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('400s on a non-boolean value for a real catalog event', async () => {
    const res = await PATCH(makePatchReq({ notification_events: { case_needs_decision: 'yes' } }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('persists a valid override for a real catalog event', async () => {
    const res = await PATCH(makePatchReq({ notification_events: { case_approved: true } }), params);

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
    const persisted = projectDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.notification_events).toEqual({ case_approved: true });
  });
});

describe('PATCH /api/projects/[projectId] — notification_templates validation', () => {
  it('400s on a non-string template value', async () => {
    const res = await PATCH(
      makePatchReq({ notification_templates: { case_needs_decision: 42 } }),
      params,
    );

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('persists valid string templates', async () => {
    const res = await PATCH(
      makePatchReq({ notification_templates: { case_needs_decision: 'Review {{case.title}}' } }),
      params,
    );

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
  });
});

describe('PATCH /api/projects/[projectId] — notification_delivery is server-owned (spec Slice C item 4)', () => {
  it('400s when the client supplies notification_delivery and never writes it', async () => {
    // Reverting the forbidden-field schema entry (or widening it) would let
    // this persist a client-spoofed delivery status.
    const res = await PATCH(
      makePatchReq({ notification_delivery: { last_success_at: '2026-08-01T00:00:00.000Z' } }),
      params,
    );

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('400s on a client-supplied notification_delivery.last_error too', async () => {
    const res = await PATCH(
      makePatchReq({
        notification_delivery: { last_error: { at: '2026-08-01T00:00:00.000Z', code: '500', message: 'spoofed' } },
      }),
      params,
    );

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('a normal PATCH with no notification_delivery key still succeeds', async () => {
    const res = await PATCH(makePatchReq({ notification_webhook_url: '' }), params);

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
  });
});

describe('PATCH /api/projects/[projectId] — updateProjectSchema wiring (issue #1070)', () => {
  it('rejects a whitespace-only name instead of persisting it (superseded scope discipline test above: the route now runs a general shape/strict-key check, not just the three notification fields)', async () => {
    const res = await PATCH(makePatchReq({ name: '  ' }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('persists a valid name change', async () => {
    const res = await PATCH(makePatchReq({ name: 'Renamed' }), params);

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
    expect(projectDocUpdate.mock.calls[0]?.[0]).toMatchObject({ name: 'Renamed' });
  });

  it('400s when reviewer_pool is not an array of strings', async () => {
    const res = await PATCH(makePatchReq({ reviewer_pool: 'not-an-array' }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('400s when tech_leads contains a non-string element', async () => {
    const res = await PATCH(makePatchReq({ tech_leads: [1, 2] }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('400s on an unknown top-level key (schema is .strict())', async () => {
    const res = await PATCH(makePatchReq({ not_a_real_field: 'x' }), params);

    expect(res.status).toBe(400);
    expect(projectDocUpdate).not.toHaveBeenCalled();
  });

  it('persists a valid reviewer_pool/tech_leads/members body', async () => {
    const res = await PATCH(
      makePatchReq({ reviewer_pool: ['user_a'], tech_leads: ['user_b'], members: ['user_c'] }),
      params,
    );

    expect(res.status).toBe(200);
    expect(projectDocUpdate).toHaveBeenCalledOnce();
    const persisted = projectDocUpdate.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.reviewer_pool).toEqual(['user_a']);
    expect(persisted.tech_leads).toEqual(['user_b']);
    expect(persisted.members).toEqual(['user_c']);
  });
});
