import { describe, it, expect } from 'vitest';
import { caseShareUrl } from '../utils/case-share-url.js';
import type { CaseStatus } from '../types/case.js';

describe('caseShareUrl', () => {
  const baseUrl = 'https://arbitra.example.com';
  const caseId = 'case-bright-pine-_TOD';

  it('routes needs_human_decision to /courtroom', () => {
    expect(caseShareUrl({ baseUrl, caseId, status: 'needs_human_decision' }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD/courtroom');
  });

  it('routes done to the case detail page (no /decision route exists)', () => {
    expect(caseShareUrl({ baseUrl, caseId, status: 'done' }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD');
  });

  it('routes rejected to the case detail page', () => {
    expect(caseShareUrl({ baseUrl, caseId, status: 'rejected' }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD');
  });

  it.each<CaseStatus>([
    'open',
    'exploration',
    'ready_for_build',
    'in_build',
    'in_validation',
    'in_review',
    'verification_pending',
    'approved',
    'pending_merge',
  ])('routes %s to the case detail page', (status) => {
    expect(caseShareUrl({ baseUrl, caseId, status }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD');
  });

  it('strips a single trailing slash from baseUrl', () => {
    expect(caseShareUrl({ baseUrl: 'https://arbitra.example.com/', caseId, status: 'open' }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD');
  });

  it('strips multiple trailing slashes from baseUrl', () => {
    expect(caseShareUrl({ baseUrl: 'https://arbitra.example.com///', caseId, status: 'open' }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD');
  });

  it('falls back to the case detail page for an unknown status (defensive)', () => {
    // Cast through unknown — runtime may receive a status the enum doesn't know
    // about (e.g. forward-compat with a newer backend deploy).
    const status = 'some_future_status' as unknown as CaseStatus;
    expect(caseShareUrl({ baseUrl, caseId, status }))
      .toBe('https://arbitra.example.com/cases/case-bright-pine-_TOD');
  });
});
