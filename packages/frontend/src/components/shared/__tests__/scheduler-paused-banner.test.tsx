/**
 * @file scheduler-paused-banner — renders nothing unless the given feature
 * is paused; when paused, renders the "Paused on this instance" alert with the
 * feature-specific body copy.
 *
 * `usePausedSchedulers` is mocked directly (rather than SWR) so this test
 * exercises only the banner's own render logic — the hook's own
 * data-to-`isPaused` mapping is covered by `use-paused-schedulers.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SchedulerPausedBanner } from '../scheduler-paused-banner';

const { isPausedMock } = vi.hoisted(() => ({
  isPausedMock: vi.fn<(feature: string) => boolean>(),
}));

vi.mock('../../../hooks/use-paused-schedulers', () => ({
  usePausedSchedulers: () => ({ isPaused: isPausedMock }),
}));

describe('SchedulerPausedBanner', () => {
  it('renders nothing when the feature is not paused', () => {
    isPausedMock.mockReturnValue(false);
    const html = renderToStaticMarkup(<SchedulerPausedBanner feature="blueprint_tick" />);
    expect(html).toBe('');
  });

  it('checks isPaused with the given feature', () => {
    isPausedMock.mockReturnValue(false);
    renderToStaticMarkup(<SchedulerPausedBanner feature="run_sweeper" />);
    expect(isPausedMock).toHaveBeenCalledWith('run_sweeper');
  });

  it('renders the alert with role="alert" and the shared heading when paused', () => {
    isPausedMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<SchedulerPausedBanner feature="blueprint_tick" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Paused on this instance');
  });

  it('renders the blueprint_tick-specific body copy', () => {
    isPausedMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<SchedulerPausedBanner feature="blueprint_tick" />);
    expect(html).toContain('Scheduled Clerk tasks do not fire on this environment. Run-now still works.');
  });

  it('renders the intelligence-specific body copy', () => {
    isPausedMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<SchedulerPausedBanner feature="intelligence" />);
    expect(html).toContain(
      'The daily intelligence run does not fire on this environment. A manual run from this page still works.',
    );
  });

  it('renders the run_sweeper-specific body copy', () => {
    isPausedMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<SchedulerPausedBanner feature="run_sweeper" />);
    expect(html).toContain(
      'Stale-run cleanup does not run on this environment; runs that lose their worker stay in their last state until swept manually.',
    );
  });

  it('uses red/rose alert tokens, not the orange interactive accent', () => {
    isPausedMock.mockReturnValue(true);
    const html = renderToStaticMarkup(<SchedulerPausedBanner feature="blueprint_tick" />);
    expect(html).toContain('bg-red-50');
    expect(html).toContain('dark:bg-red-900');
    expect(html).not.toContain('bg-accent');
  });
});
