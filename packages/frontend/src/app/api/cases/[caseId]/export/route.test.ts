import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { CaseStatus } from '@arbitra/shared';

// ---------------------------------------------------------------------------
// Mocks — wired before importing the route so the module picks them up.
// ---------------------------------------------------------------------------

const {
  gatherCustomerReportData,
  formatCustomerReport,
  gatherAuditData,
  formatAuditExport,
  gatherExportData,
  formatExport,
} = vi.hoisted(() => ({
  gatherCustomerReportData: vi.fn(),
  formatCustomerReport: vi.fn(),
  gatherAuditData: vi.fn(),
  formatAuditExport: vi.fn(),
  gatherExportData: vi.fn(),
  formatExport: vi.fn(),
}));

vi.mock('@arbitra/backend', () => ({
  CaseExportService: vi.fn().mockImplementation(() => ({
    gatherCustomerReportData,
    formatCustomerReport,
    gatherAuditData,
    formatAuditExport,
    gatherExportData,
    formatExport,
  })),
}));

vi.mock('@/lib/api-helpers', async () => {
  const { NextResponse } = await import('next/server');
  return {
    authenticateExport: vi.fn().mockResolvedValue({ userId: 'user_1' }),
    requireCaseAccess: vi.fn().mockResolvedValue(null),
    handleError: vi.fn((err: unknown) => {
      const message = err instanceof Error ? err.message : 'error';
      return NextResponse.json({ error: { message } }, { status: 500 });
    }),
  };
});

import { GET } from './route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(format: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/cases/case_1/export?format=${encodeURIComponent(format)}`,
  );
}

function mockCustomerReportDataForStatus(status: CaseStatus) {
  gatherCustomerReportData.mockResolvedValue({
    case: { case_id: 'case_1', status },
    events: [],
    changedFiles: [],
    repositoryName: null,
    terminalEventAt: null,
  });
}

function mockCustomerReportResult() {
  formatCustomerReport.mockResolvedValue({
    content: '# report',
    content_type: 'text/markdown',
    filename: 'case-1.md',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cases/[caseId]/export — customer-report state gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects in_build + customer-report-markdown with 400', async () => {
    mockCustomerReportDataForStatus('in_build');
    const res = await GET(makeReq('customer-report-markdown'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('Customer report is only available for completed cases.');
    expect(formatCustomerReport).not.toHaveBeenCalled();
  });

  it('rejects in_build + customer-report-html with 400', async () => {
    mockCustomerReportDataForStatus('in_build');
    const res = await GET(makeReq('customer-report-html'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('Customer report is only available for completed cases.');
    expect(formatCustomerReport).not.toHaveBeenCalled();
  });

  it('allows done + customer-report-markdown (200)', async () => {
    mockCustomerReportDataForStatus('done');
    mockCustomerReportResult();
    const res = await GET(makeReq('customer-report-markdown'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    expect(formatCustomerReport).toHaveBeenCalledOnce();
  });

  it('allows approved + customer-report-markdown (200)', async () => {
    mockCustomerReportDataForStatus('approved');
    mockCustomerReportResult();
    const res = await GET(makeReq('customer-report-markdown'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    expect(formatCustomerReport).toHaveBeenCalledOnce();
  });

  it('allows pending_merge + customer-report-markdown (200)', async () => {
    mockCustomerReportDataForStatus('pending_merge');
    mockCustomerReportResult();
    const res = await GET(makeReq('customer-report-markdown'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    expect(formatCustomerReport).toHaveBeenCalledOnce();
  });

  it('gate does not apply to audit format (in_build + audit still works)', async () => {
    gatherAuditData.mockResolvedValue({});
    formatAuditExport.mockResolvedValue({
      content: '{}',
      content_type: 'application/json',
      filename: 'audit.json',
    });
    const res = await GET(makeReq('audit'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    expect(formatAuditExport).toHaveBeenCalledOnce();
    expect(gatherCustomerReportData).not.toHaveBeenCalled();
  });

  it('gate does not apply to markdown format (in_build + markdown still works)', async () => {
    gatherExportData.mockResolvedValue({});
    formatExport.mockResolvedValue({
      content: '# md',
      content_type: 'text/markdown',
      filename: 'case.md',
    });
    const res = await GET(makeReq('markdown'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(200);
    expect(formatExport).toHaveBeenCalledOnce();
    expect(gatherCustomerReportData).not.toHaveBeenCalled();
  });

  it('preserves existing 400 behavior for unknown format', async () => {
    const res = await GET(makeReq('bogus-format'), { params: Promise.resolve({ caseId: 'case_1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Invalid format/);
    expect(gatherCustomerReportData).not.toHaveBeenCalled();
    expect(gatherExportData).not.toHaveBeenCalled();
    expect(gatherAuditData).not.toHaveBeenCalled();
  });
});
