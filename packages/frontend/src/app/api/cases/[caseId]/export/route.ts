import { NextRequest, NextResponse } from 'next/server';
import { CaseExportService } from '@arbitra/backend';
import type { CaseExportFormat } from '@arbitra/shared';
import { authenticateExport, handleError, requireCaseAccess } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const exportService = new CaseExportService();
const VALID_FORMATS: CaseExportFormat[] = [
  'markdown',
  'json',
  'html',
  'audit',
  'audit-markdown',
  'customer-report-markdown',
  'customer-report-html',
];

export async function GET(request: NextRequest, props: { params: Promise<{ caseId: string }> }) {
  const params = await props.params;
  const formatParam = request.nextUrl.searchParams.get('format') ?? 'markdown';
  if (!VALID_FORMATS.includes(formatParam as CaseExportFormat)) {
    return NextResponse.json(
      { error: { message: `Invalid format. Supported: ${VALID_FORMATS.join(', ')}` } },
      { status: 400 },
    );
  }
  const format = formatParam as CaseExportFormat;
  const isAuditFormat = format === 'audit' || format === 'audit-markdown';
  const isCustomerReport =
    format === 'customer-report-markdown' || format === 'customer-report-html';

  try {
    // Support token via query param for window.open() (mobile Safari compatibility)
    const queryToken = request.nextUrl.searchParams.get('token');
    const auth = await authenticateExport(request, queryToken);
    const denied = await requireCaseAccess(params.caseId, auth.userId);
    if (denied) return denied;

    if (isCustomerReport) {
      const data = await exportService.gatherCustomerReportData(params.caseId, auth.userId);
      // Customer reports are release notes — only meaningful for cases that
      // have reached a done-ish state.
      const allowedStatuses = ['done', 'approved', 'pending_merge'];
      if (!allowedStatuses.includes(data.case.status)) {
        return NextResponse.json(
          { error: { message: 'Customer report is only available for completed cases.' } },
          { status: 400 },
        );
      }
      const result = await exportService.formatCustomerReport(
        data,
        format as 'customer-report-markdown' | 'customer-report-html',
      );
      return new NextResponse(result.content, {
        headers: {
          'Content-Type': result.content_type,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        },
      });
    }

    if (isAuditFormat) {
      const auditData = await exportService.gatherAuditData(params.caseId, auth.userId);
      const result = await exportService.formatAuditExport(auditData, format as 'audit' | 'audit-markdown');
      return new NextResponse(result.content, {
        headers: {
          'Content-Type': result.content_type,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        },
      });
    }

    const data = await exportService.gatherExportData(params.caseId, auth.userId);
    const result = await exportService.formatExport(data, format);

    return new NextResponse(result.content, {
      headers: {
        'Content-Type': result.content_type,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
