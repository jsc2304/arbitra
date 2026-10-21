'use client';

import { useState, useEffect, useRef } from 'react';
import type { CaseExportFormat } from '@arbitra/shared';
import { exportCase, getToken } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { Tooltip } from '../shared/tooltip';

const exportFormats: { id: CaseExportFormat; label: string; description: string }[] = [
  { id: 'markdown', label: 'Markdown', description: 'For Teams, Mail, Jira' },
  { id: 'html', label: 'HTML', description: 'Styled email or archive' },
  { id: 'json', label: 'JSON', description: 'API / structured data' },
];

export function ExportDropdown({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { addToast } = useToast();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  async function handleExport(format: CaseExportFormat) {
    setExporting(true);
    try {
      // Build direct URL — mobile Safari doesn't support Blob + <a download>
      const token = await getToken();
      const url = new URL(`/api/cases/${caseId}/export`, window.location.origin);
      url.searchParams.set('format', format);
      if (token) url.searchParams.set('token', token);

      // Open in new tab — browser handles Content-Disposition: attachment natively
      window.open(url.toString(), '_blank');
      addToast('success', 'Case exported successfully');
    } catch {
      addToast('error', 'Failed to export case');
    } finally {
      setExporting(false);
      setOpen(false);
    }
  }

  async function handleCopyMarkdown() {
    setExporting(true);
    try {
      const res = await exportCase(caseId, 'markdown');
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      addToast('success', 'Markdown copied to clipboard');
      setOpen(false);
    } catch {
      addToast('error', 'Failed to copy to clipboard');
    } finally {
      setExporting(false);
    }
  }

  async function handleCopyAuditMarkdown() {
    setExporting(true);
    try {
      const res = await exportCase(caseId, 'audit-markdown' as CaseExportFormat);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      addToast('success', 'Audit report copied to clipboard');
      setOpen(false);
    } catch {
      addToast('error', 'Failed to copy audit report');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <Tooltip label="Export case for handover (Jira, Teams, Mail)">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={exporting}
        aria-label="Export case for handover (Jira, Teams, Mail)"
        className="inline-flex items-center gap-1.5 rounded-md bg-gray-100 dark:bg-gray-800 px-3 py-1.5 text-xs sm:text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        <span className="hidden sm:inline">{exporting ? 'Exporting...' : 'Export'}</span>
      </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-overlay shadow-lg py-1">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Download as
          </div>
          {exportFormats.map((fmt) => (
            <button
              key={fmt.id}
              type="button"
              onClick={() => handleExport(fmt.id)}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">{fmt.label}</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{fmt.description}</span>
            </button>
          ))}
          <div className="border-t border-gray-100 dark:border-border-subtle mt-1 pt-1">
            <button
              type="button"
              onClick={handleCopyMarkdown}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">Copy to clipboard</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">Markdown</span>
            </button>
          </div>
          <div className="border-t border-gray-100 dark:border-border-subtle mt-1 pt-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              Customer-facing
            </div>
            <button
              type="button"
              onClick={() => handleExport('customer-report-markdown' as CaseExportFormat)}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">Customer Report (Markdown)</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">Share with stakeholders</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('customer-report-html' as CaseExportFormat)}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">Customer Report (HTML)</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">Print to PDF</span>
            </button>
          </div>
          <div className="border-t border-gray-100 dark:border-border-subtle mt-1 pt-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              Audit Trail
            </div>
            <button
              type="button"
              onClick={() => handleExport('audit' as CaseExportFormat)}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">Download JSON</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">Full audit bundle</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('audit-markdown' as CaseExportFormat)}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">Download Markdown</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">Audit report</span>
            </button>
            <button
              type="button"
              onClick={handleCopyAuditMarkdown}
              disabled={exporting}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-base dark:hover:bg-border-subtle transition-colors disabled:opacity-50"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100">Copy as Markdown</span>
              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">Audit report</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
