import { describe, it, expect } from 'vitest';
import {
  isBlockingFindingStatus,
  effectiveFindingOrigin,
  isAuthorBlockingOrigin,
  BLOCKING_FINDING_STATUSES,
  NON_AUTHOR_BLOCKING_ORIGINS,
  RESOLVED_FINDING_STATUSES,
} from './finding-statuses.js';

describe('isBlockingFindingStatus', () => {
  it('treats open/accepted/contested as blocking', () => {
    expect(isBlockingFindingStatus('open')).toBe(true);
    expect(isBlockingFindingStatus('accepted')).toBe(true);
    expect(isBlockingFindingStatus('contested')).toBe(true);
  });
  it('treats an agent-proposed waiver (waiver_proposed) as still blocking', () => {
    // Human-in-the-loop: an agent proposal must NOT clear the approval gate on
    // its own — a human confirms with a terminal waive/approve first.
    expect(isBlockingFindingStatus('waiver_proposed')).toBe(true);
  });
  it('treats fixed/waived/resolved as non-blocking', () => {
    expect(isBlockingFindingStatus('fixed')).toBe(false);
    expect(isBlockingFindingStatus('waived')).toBe(false);
    expect(isBlockingFindingStatus('resolved')).toBe(false);
  });
  it('treats waived_on_completion as resolved and non-blocking', () => {
    // Administratively closed at case completion (#751): the case is `done`, so
    // no surface can confirm/reject the proposal anymore — keeping it blocking
    // would park an unactionable decision in the audit trail forever.
    expect(isBlockingFindingStatus('waived_on_completion')).toBe(false);
    expect(RESOLVED_FINDING_STATUSES).toContain('waived_on_completion');
    expect(BLOCKING_FINDING_STATUSES).not.toContain('waived_on_completion');
  });
});

describe('effectiveFindingOrigin', () => {
  it('defaults a missing origin to authored (back-compat)', () => {
    expect(effectiveFindingOrigin(undefined)).toBe('authored');
  });
  it('passes through an explicit origin', () => {
    expect(effectiveFindingOrigin('submodule')).toBe('submodule');
    expect(effectiveFindingOrigin('vendored')).toBe('vendored');
    expect(effectiveFindingOrigin('authored')).toBe('authored');
  });
});

describe('isAuthorBlockingOrigin', () => {
  it('authored (and missing) origins block the author gate', () => {
    expect(isAuthorBlockingOrigin('authored')).toBe(true);
    expect(isAuthorBlockingOrigin(undefined)).toBe(true);
  });
  it('submodule and vendored origins do NOT block the author gate', () => {
    expect(isAuthorBlockingOrigin('submodule')).toBe(false);
    expect(isAuthorBlockingOrigin('vendored')).toBe(false);
  });
  it('NON_AUTHOR_BLOCKING_ORIGINS lists exactly submodule and vendored', () => {
    expect([...NON_AUTHOR_BLOCKING_ORIGINS].sort()).toEqual(['submodule', 'vendored']);
  });
});
