/**
 * @file pending-decision-trigger — parent-side regression test for the
 * "stuck pendingDecisionType" bug fixed in PR #502.
 *
 * Repro flow that broke before the fix:
 *   1. User clicks Waive on finding A → parent sets pendingDecisionType = 'waive'.
 *   2. Rationale sheet opens; user dismisses (selectedType -> null inside cluster).
 *   3. Parent state still 'waive'.
 *   4. User clicks Waive on finding B → setPendingDecisionType('waive') is a
 *      no-op (same value), useEffect doesn't refire, sheet stays closed.
 *
 * Fix: the parent now stores `{ type, nonce }` and bumps `nonce` on every
 * trigger so identity changes even when `type` does not. This test locks
 * in the reducer logic the page uses.
 *
 * Tests are node-only (no jsdom), so we exercise the reducer shape — the
 * exact callback the page passes to `setPendingDecisionType` — directly.
 */
import { describe, expect, it } from 'vitest';
import type { DecisionType } from '@arbitra/shared';

type PendingDecisionTrigger = { type: DecisionType; nonce: number } | null;

/**
 * Mirror of the reducer used in
 * `app/cases/[caseId]/courtroom/page.tsx` :: handleWaiveFinding. Kept in
 * sync with the page; the page imports nothing from here, this is a
 * specification check.
 */
function bumpTrigger(
  prev: PendingDecisionTrigger,
  type: DecisionType,
): PendingDecisionTrigger {
  return { type, nonce: (prev?.nonce ?? 0) + 1 };
}

describe('pendingDecisionType — nonce-bump trigger (PR #502 regression)', () => {
  it('starts from null with nonce 1 on first trigger', () => {
    const next = bumpTrigger(null, 'waive');
    expect(next).toEqual({ type: 'waive', nonce: 1 });
  });

  it('produces a NEW object identity even when the decision type repeats (stuck-state regression)', () => {
    const first = bumpTrigger(null, 'waive');
    const second = bumpTrigger(first, 'waive');
    expect(second).not.toBe(first);
    expect(second?.type).toBe('waive');
    expect(second?.nonce).toBe(2);
  });

  it('bumps nonce monotonically across mixed decision types', () => {
    const a = bumpTrigger(null, 'waive');
    const b = bumpTrigger(a, 'reject');
    const c = bumpTrigger(b, 'waive');
    expect(a?.nonce).toBe(1);
    expect(b?.nonce).toBe(2);
    expect(c?.nonce).toBe(3);
    expect(c?.type).toBe('waive');
  });

  it('survives a "dismiss in between" cycle: trigger A → (sheet dismiss does not touch parent) → trigger A again still emits a fresh identity', () => {
    // Click 1: Waive on finding A.
    const t1 = bumpTrigger(null, 'waive');
    // User cancels the rationale sheet. The cluster clears its internal
    // selectedType, but the parent state remains `t1` (this is the whole
    // point of the bug — the parent has no dismiss callback).
    const parentState = t1;
    // Click 2: Waive on finding B. Same decision type, same parent state.
    const t2 = bumpTrigger(parentState, 'waive');
    // The mirror effect's dep array compares by Object.is — t1 !== t2
    // because nonce bumped, so the effect re-fires. THIS is the
    // regression guard: a bare-string trigger would dedupe.
    expect(Object.is(t1, t2)).toBe(false);
    expect(t2?.nonce).toBe((t1?.nonce ?? 0) + 1);
  });
});
