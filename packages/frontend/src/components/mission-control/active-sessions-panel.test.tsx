/**
 * @file ActiveSessionsPanel (issue #990): renders the 24h/7d/30d stat tiles
 * with session + distinct-user counts. Node-only per the frontend
 * convention (renderToStaticMarkup, no jsdom).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActiveSessionsPanel as ActiveSessionsPanelData } from '@arbitra/shared';
import { ActiveSessionsPanel } from './active-sessions-panel';

function panel(overrides: Partial<ActiveSessionsPanelData> = {}): ActiveSessionsPanelData {
  return {
    window_24h: { sessions: 3, distinct_users: 2 },
    window_7d: { sessions: 10, distinct_users: 4 },
    window_30d: { sessions: 25, distinct_users: 6 },
    ...overrides,
  };
}

describe('ActiveSessionsPanel', () => {
  it('renders a tile per window with its own session and distinct-user counts', () => {
    // Reverting the `TILES.map` render (or hardcoding one window's stats
    // across all three tiles) would make one of these counts vanish or
    // duplicate, failing these assertions.
    const html = renderToStaticMarkup(<ActiveSessionsPanel panel={panel()} />);

    expect(html).toContain('Last 24 hours');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('Last 30 days');
    expect(html).toContain('>3<');
    expect(html).toContain('2 distinct user');
    expect(html).toContain('>10<');
    expect(html).toContain('4 distinct users');
    expect(html).toContain('>25<');
    expect(html).toContain('6 distinct users');
  });

  it('renders zero counts for an all-zero panel instead of omitting the tiles', () => {
    // Reverting to a falsy-count early return (e.g. `stats.sessions &&
    // <Tile/>`) would drop the tiles entirely for an all-zero panel,
    // failing this assertion.
    const html = renderToStaticMarkup(
      <ActiveSessionsPanel
        panel={panel({
          window_24h: { sessions: 0, distinct_users: 0 },
          window_7d: { sessions: 0, distinct_users: 0 },
          window_30d: { sessions: 0, distinct_users: 0 },
        })}
      />,
    );

    expect(html).toContain('data-testid="active-sessions-panel"');
    expect(html).toContain('0 distinct user');
  });

  it('uses singular "session"/"user" for a count of exactly one', () => {
    // Reverting the `=== 1` pluralization check (always rendering the
    // plural form) would leave "1 sessions"/"1 distinct users" here instead,
    // failing these assertions.
    const html = renderToStaticMarkup(
      <ActiveSessionsPanel
        panel={panel({ window_24h: { sessions: 1, distinct_users: 1 } })}
      />,
    );

    expect(html).toContain('>1<span');
    expect(html).toContain('>session</span>');
    expect(html).toContain('1 distinct user<');
  });
});
