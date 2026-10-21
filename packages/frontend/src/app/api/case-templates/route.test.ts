import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  getTemplates,
  checkIsAdmin,
  getAccessibleProjectIds,
  createTemplateMock,
  CaseTemplateServiceMock,
  getProjectDoc,
  getUserDoc,
} = vi.hoisted(() => {
  const createTemplateMock = vi.fn();
  class CaseTemplateServiceMock {
    create = createTemplateMock;
  }
  return {
    getTemplates: vi.fn(),
    checkIsAdmin: vi.fn(),
    getAccessibleProjectIds: vi.fn(),
    createTemplateMock,
    CaseTemplateServiceMock,
    getProjectDoc: vi.fn(),
    getUserDoc: vi.fn(),
  };
});

vi.mock('@arbitra/backend', () => {
  // Chainable Firestore query stub: `.where(...)` is only called when a
  // `project_id` filter is present, `.orderBy('name').get()` is always the
  // terminal call.
  const queryChain = {
    where: () => queryChain,
    orderBy: () => ({ get: getTemplates }),
  };
  return {
    collections: {
      caseTemplates: () => queryChain,
      projects: () => ({ doc: () => ({ get: getProjectDoc }) }),
      users: () => ({ doc: () => ({ get: getUserDoc }) }),
    },
    checkIsAdmin,
    getAccessibleProjectIds,
    validateBody: <T>(schema: { parse: (body: unknown) => T }, body: unknown): T => schema.parse(body),
    CaseTemplateService: CaseTemplateServiceMock,
  };
});

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock('@/lib/api-helpers', async () => ({
  authenticate,
  handleError: (error: unknown) => {
    const isValidation = error instanceof Error && 'issues' in error;
    if (isValidation) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request payload',
            details: { issues: (error as Error & { issues: unknown[] }).issues },
          },
        },
        { status: 400 },
      );
    }
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: { message } }, { status });
  },
}));

import { GET, POST } from './route';

function makeGetRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/case-templates${query}`, { method: 'GET' });
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/case-templates', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/case-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({ userId: 'user_1' });
    checkIsAdmin.mockResolvedValue(false);
    getAccessibleProjectIds.mockResolvedValue('all');
  });

  it("filters out templates from projects the caller cannot access (GET had no access check at all)", async () => {
    getAccessibleProjectIds.mockResolvedValueOnce(['proj_1']);
    getTemplates.mockResolvedValueOnce({
      docs: [
        { data: () => ({ template_id: 'tmpl_visible', project_id: 'proj_1' }) },
        { data: () => ({ template_id: 'tmpl_hidden', project_id: 'proj_2' }) },
      ],
    });

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    const ids = body.templates.map((t: { template_id: string }) => t.template_id);
    expect(ids).toEqual(['tmpl_visible']);
  });

  it("denies a non-member even when they explicitly pass ?project_id= for a project they're not on", async () => {
    // Regression for the confirmed hole: passing `project_id` narrowed the
    // Firestore query but was never checked against the caller's membership.
    getAccessibleProjectIds.mockResolvedValueOnce(['proj_1']);
    getTemplates.mockResolvedValueOnce({
      docs: [{ data: () => ({ template_id: 'tmpl_other', project_id: 'proj_2' }) }],
    });

    const response = await GET(makeGetRequest('?project_id=proj_2'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.templates).toEqual([]);
  });

  it("admin sees every project's templates unfiltered", async () => {
    checkIsAdmin.mockResolvedValueOnce(true);
    getTemplates.mockResolvedValueOnce({
      docs: [
        { data: () => ({ template_id: 'tmpl_a', project_id: 'proj_1' }) },
        { data: () => ({ template_id: 'tmpl_b', project_id: 'proj_2' }) },
      ],
    });

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.templates).toHaveLength(2);
    expect(getAccessibleProjectIds).not.toHaveBeenCalled();
  });
});

describe('POST /api/case-templates (pre-existing inline gate, verified — not modified)', () => {
  const validBody = {
    project_id: 'proj_1',
    name: 'Standard risk case',
    defaults: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({ userId: 'user_1' });
    getProjectDoc.mockResolvedValue({
      exists: true,
      data: () => ({ owner_user_id: 'user_1', reviewer_pool: [], tech_leads: [] }),
    });
    getUserDoc.mockResolvedValue({ exists: true, data: () => ({ roles: [] }) });
    createTemplateMock.mockResolvedValue({ template_id: 'tmpl_new', ...validBody });
  });

  it('403s a caller who is neither a project member nor an admin', async () => {
    getProjectDoc.mockResolvedValueOnce({
      exists: true,
      data: () => ({ owner_user_id: 'someone_else', reviewer_pool: [], tech_leads: [] }),
    });

    const response = await POST(makePostRequest(validBody));

    expect(response.status).toBe(403);
    expect(createTemplateMock).not.toHaveBeenCalled();
  });

  it('allows the project owner to create a template', async () => {
    const response = await POST(makePostRequest(validBody));

    expect(response.status).toBe(201);
    expect(createTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj_1', name: 'Standard risk case' }),
      'user_1',
    );
  });

  it('allows a global admin to create a template even without project membership', async () => {
    getProjectDoc.mockResolvedValueOnce({
      exists: true,
      data: () => ({ owner_user_id: 'someone_else', reviewer_pool: [], tech_leads: [] }),
    });
    getUserDoc.mockResolvedValueOnce({ exists: true, data: () => ({ roles: ['admin'] }) });

    const response = await POST(makePostRequest(validBody));

    expect(response.status).toBe(201);
    expect(createTemplateMock).toHaveBeenCalled();
  });
});
