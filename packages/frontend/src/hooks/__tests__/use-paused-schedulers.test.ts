/**
 * @file use-paused-schedulers — smoke tests for the scheduler-pause hook.
 *
 * The hook wraps a SWR call to `/api/version` and exposes `isPaused`.
 * We stub SWR to control `data`, then assert `isPaused` against the
 * `paused_schedulers` array `GET /api/version` returns. This guards the
 * hook's own parsing/lookup logic (`packages/shared/src/utils/paused-schedulers.ts`
 * already guards the server-side parse) — a regression here would show
 * every "Paused on this instance" banner as always-hidden or always-shown
 * regardless of what the API actually reports.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

type SwrState = {
  data?: { paused_schedulers?: string[] } | undefined;
};

const { swrState } = vi.hoisted(() => ({
  swrState: { data: undefined } as SwrState,
}));

vi.mock('swr', () => ({
  default: () => swrState,
}));

import { usePausedSchedulers } from '../use-paused-schedulers';

beforeEach(() => {
  swrState.data = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePausedSchedulers', () => {
  it('isPaused returns false for every feature while /api/version has not resolved', () => {
    swrState.data = undefined;
    const { isPaused } = usePausedSchedulers();
    expect(isPaused('run_sweeper')).toBe(false);
    expect(isPaused('blueprint_tick')).toBe(false);
  });

  it('isPaused returns false for every feature when paused_schedulers is empty (nothing paused)', () => {
    swrState.data = { paused_schedulers: [] };
    const { isPaused } = usePausedSchedulers();
    expect(isPaused('run_sweeper')).toBe(false);
    expect(isPaused('intelligence')).toBe(false);
  });

  it('isPaused returns true only for features present in paused_schedulers', () => {
    swrState.data = { paused_schedulers: ['blueprint_tick', 'intelligence'] };
    const { isPaused } = usePausedSchedulers();
    expect(isPaused('blueprint_tick')).toBe(true);
    expect(isPaused('intelligence')).toBe(true);
    expect(isPaused('run_sweeper')).toBe(false);
  });
});
