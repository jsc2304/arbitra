import { describe, expect, it } from 'vitest';
import type { Finding, FindingSeverity, FindingStatus } from '@arbitra/shared';
import { countBlockers, isBlocking } from '../finding-selectors';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'f_1',
    case_id: 'case_1',
    category: 'bug',
    severity: 'high',
    confidence: 0.9,
    status: 'open',
    title: 'Example finding',
    description: 'desc',
    origin_type: 'reviewer',
    source_refs: [],
    evidence_refs: [],
    rule_refs: [],
    created_at: '2026-04-16T00:00:00.000Z',
    updated_at: '2026-04-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('isBlocking', () => {
  it('returns true for critical + open', () => {
    expect(isBlocking(makeFinding({ severity: 'critical', status: 'open' }))).toBe(true);
  });

  it('returns true for high + open', () => {
    expect(isBlocking(makeFinding({ severity: 'high', status: 'open' }))).toBe(true);
  });

  it('returns false for medium + open', () => {
    expect(isBlocking(makeFinding({ severity: 'medium', status: 'open' }))).toBe(false);
  });

  it('returns false for low + open', () => {
    expect(isBlocking(makeFinding({ severity: 'low', status: 'open' }))).toBe(false);
  });

  it('returns false for info + open', () => {
    expect(isBlocking(makeFinding({ severity: 'info', status: 'open' }))).toBe(false);
  });

  it.each<[FindingStatus]>([
    ['fixed'],
    ['waived'],
    ['resolved'],
  ])('returns false for critical + %s (resolved/actioned)', (status) => {
    expect(isBlocking(makeFinding({ severity: 'critical', status }))).toBe(false);
  });

  it.each<[FindingStatus]>([
    ['fixed'],
    ['waived'],
    ['resolved'],
  ])('returns false for high + %s (resolved/actioned)', (status) => {
    expect(isBlocking(makeFinding({ severity: 'high', status }))).toBe(false);
  });

  // `accepted` and `contested` are NOT resolved — the server-side guardrail
  // in decision-service.ts treats them as blocking, so the client predicate
  // must match. Previously the client only blocked on `open`, causing a
  // silent 409 (OPEN_FINDINGS_BLOCK_DECISION) when the user clicked Approve.
  it.each<[FindingStatus]>([
    ['accepted'],
    ['contested'],
  ])('returns true for critical + %s (still blocking)', (status) => {
    expect(isBlocking(makeFinding({ severity: 'critical', status }))).toBe(true);
  });

  it.each<[FindingStatus]>([
    ['accepted'],
    ['contested'],
  ])('returns true for high + %s (still blocking)', (status) => {
    expect(isBlocking(makeFinding({ severity: 'high', status }))).toBe(true);
  });

  it('accepts the minimal {severity, status} shape', () => {
    // Exercises the MinimalFinding overload — no full Finding object required.
    const minimal: { severity: FindingSeverity; status: FindingStatus } = {
      severity: 'critical',
      status: 'open',
    };
    expect(isBlocking(minimal)).toBe(true);
  });
});

describe('countBlockers', () => {
  it('returns zero counts for an empty array', () => {
    expect(countBlockers([])).toEqual({ high: 0, critical: 0, total: 0 });
  });

  it('counts high and critical separately and sums total', () => {
    const findings = [
      makeFinding({ severity: 'critical', status: 'open' }),
      makeFinding({ severity: 'critical', status: 'open' }),
      makeFinding({ severity: 'high', status: 'open' }),
    ];
    expect(countBlockers(findings)).toEqual({ high: 1, critical: 2, total: 3 });
  });

  it('ignores low / medium / info severities', () => {
    const findings = [
      makeFinding({ severity: 'low', status: 'open' }),
      makeFinding({ severity: 'medium', status: 'open' }),
      makeFinding({ severity: 'info', status: 'open' }),
    ];
    expect(countBlockers(findings)).toEqual({ high: 0, critical: 0, total: 0 });
  });

  it('ignores resolved statuses (fixed/waived/resolved) even at critical severity', () => {
    const findings = [
      makeFinding({ severity: 'critical', status: 'fixed' }),
      makeFinding({ severity: 'critical', status: 'waived' }),
      makeFinding({ severity: 'critical', status: 'resolved' }),
      makeFinding({ severity: 'high', status: 'fixed' }),
    ];
    expect(countBlockers(findings)).toEqual({ high: 0, critical: 0, total: 0 });
  });

  it('counts accepted and contested as blocking (align with server guardrail)', () => {
    const findings = [
      makeFinding({ severity: 'critical', status: 'accepted' }),
      makeFinding({ severity: 'high', status: 'contested' }),
    ];
    expect(countBlockers(findings)).toEqual({ high: 1, critical: 1, total: 2 });
  });

  it('mixes blocking and non-blocking findings correctly', () => {
    const findings = [
      makeFinding({ severity: 'critical', status: 'open' }), // blocker
      makeFinding({ severity: 'critical', status: 'fixed' }), // not open
      makeFinding({ severity: 'high', status: 'open' }), // blocker
      makeFinding({ severity: 'high', status: 'waived' }), // not open
      makeFinding({ severity: 'medium', status: 'open' }), // too low
      makeFinding({ severity: 'low', status: 'open' }), // too low
    ];
    expect(countBlockers(findings)).toEqual({ high: 1, critical: 1, total: 2 });
  });
});
