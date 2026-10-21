import { describe, it, expect } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { approvalPinPatch, approvalPinMirror } from './approval-pin.js';

// Unit coverage for the pure pin-decision functions, independent of the
// precondition gate (issue #1054). Before #1054, a case with no observed
// head SHA could still reach `approved` autonomously — this file's
// "clears a stale pin when no SHA is observed" case was previously proven
// end-to-end through the full pipeline (pipeline.test.ts). After #1054 that
// route is blocked before it ever reaches this logic (a case with no
// `current_head_sha` can no longer satisfy `review_run_completed` /
// `auto_approve_criteria_met`), so the pin's own clearing behavior needs
// this direct unit test to stay covered.

describe('approvalPinPatch', () => {
  it('stamps approved_head_sha from current_head_sha when entering approved', () => {
    const patch = approvalPinPatch('approved', { current_head_sha: 'SHA_REVIEWED' });
    expect(patch).toEqual({ approved_head_sha: 'SHA_REVIEWED' });
  });

  it('clears the pin (Firestore delete sentinel) when entering approved with no observed head SHA', () => {
    const patch = approvalPinPatch('approved', { current_head_sha: undefined });
    expect(patch.approved_head_sha).toBeInstanceOf(FieldValue);
  });

  it('is a no-op for a target status other than approved (does not re-pin pending_merge/done)', () => {
    expect(approvalPinPatch('pending_merge', { current_head_sha: 'SHA_X' })).toEqual({});
    expect(approvalPinPatch('done', { current_head_sha: 'SHA_X' })).toEqual({});
    expect(approvalPinPatch('in_review', { current_head_sha: 'SHA_X' })).toEqual({});
  });
});

describe('approvalPinMirror', () => {
  it('stamps approved_head_sha from current_head_sha when entering approved', () => {
    const mirror = approvalPinMirror('approved', { current_head_sha: 'SHA_REVIEWED' });
    expect(mirror).toEqual({ approved_head_sha: 'SHA_REVIEWED' });
  });

  it('clears the pin as plain undefined (never the Firestore delete sentinel) when no head SHA is observed', () => {
    const mirror = approvalPinMirror('approved', { current_head_sha: undefined });
    expect(mirror).toEqual({ approved_head_sha: undefined });
    expect(mirror.approved_head_sha).not.toBeInstanceOf(FieldValue);
  });

  it('is a no-op for a target status other than approved', () => {
    expect(approvalPinMirror('pending_merge', { current_head_sha: 'SHA_X' })).toEqual({});
  });
});
