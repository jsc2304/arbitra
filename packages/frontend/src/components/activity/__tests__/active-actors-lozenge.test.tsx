/**
 * @file active-actors-lozenge — pure-derivation tests + render smoke.
 *
 * Derive the set of distinct actors that emitted events in the
 * last 60s and render them as clickable chips, ordered by recency.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEntry } from '@arbitra/shared';
import {
  ActiveActorsLozenge,
  deriveActiveActors,
} from '../active-actors-lozenge';

const NOW = Date.parse('2026-05-06T12:00:00.000Z');

function entry(id: string, ts: string, clientName?: string): ActivityEntry {
  return {
    id,
    kind: 'comment',
    timestamp: ts,
    case_id: 'case_1',
    summary: 'commented',
    href: '/cases/case_1',
    ...(clientName ? { actor_metadata: { client_name: clientName } } : {}),
  };
}

describe('deriveActiveActors', () => {
  it('returns an empty list when no entries carry a client_name', () => {
    expect(
      deriveActiveActors(
        [entry('e1', '2026-05-06T11:59:50.000Z')],
        NOW,
      ),
    ).toEqual([]);
  });

  it('drops entries older than the 60s window', () => {
    const recent = entry('r', '2026-05-06T11:59:30.000Z', 'cursor');
    const old = entry('o', '2026-05-06T11:58:00.000Z', 'old-client');
    const actors = deriveActiveActors([recent, old], NOW);
    expect(actors.map((a) => a.clientName)).toEqual(['cursor']);
  });

  it('sorts by most recent timestamp descending', () => {
    const a = entry('a', '2026-05-06T11:59:30.000Z', 'cursor');
    const b = entry('b', '2026-05-06T11:59:50.000Z', 'claude-code');
    const actors = deriveActiveActors([a, b], NOW);
    expect(actors.map((a) => a.clientName)).toEqual(['claude-code', 'cursor']);
  });

  it('counts repeated events from the same client', () => {
    const e1 = entry('1', '2026-05-06T11:59:50.000Z', 'cursor');
    const e2 = entry('2', '2026-05-06T11:59:55.000Z', 'cursor');
    const e3 = entry('3', '2026-05-06T11:59:58.000Z', 'cursor');
    const actors = deriveActiveActors([e1, e2, e3], NOW);
    expect(actors).toHaveLength(1);
    expect(actors[0]!.count).toBe(3);
  });
});

describe('<ActiveActorsLozenge>', () => {
  it('returns nothing when no actors are active', () => {
    const html = renderToStaticMarkup(
      <ActiveActorsLozenge entries={[]} onActorClick={() => {}} />,
    );
    expect(html).toBe('');
  });

  it('renders one button per active actor with a data-client-name hook for clicks', () => {
    const entries: ActivityEntry[] = [
      entry('1', new Date().toISOString(), 'cursor'),
      entry('2', new Date().toISOString(), 'claude-code'),
    ];
    const html = renderToStaticMarkup(
      <ActiveActorsLozenge entries={entries} onActorClick={() => {}} />,
    );
    expect(html).toContain('data-client-name="cursor"');
    expect(html).toContain('data-client-name="claude-code"');
  });

  it('exposes a polite aria-live region announcing the active set (item 16)', () => {
    const entries: ActivityEntry[] = [entry('1', new Date().toISOString(), 'cursor')];
    const html = renderToStaticMarkup(
      <ActiveActorsLozenge entries={entries} onActorClick={() => {}} />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('sr-only');
  });

  it('derives the tooltip window phrase from a non-default windowMs (item 9)', () => {
    const entries: ActivityEntry[] = [entry('1', new Date().toISOString(), 'cursor')];
    const html = renderToStaticMarkup(
      <ActiveActorsLozenge entries={entries} onActorClick={() => {}} windowMs={5 * 60_000} />,
    );
    expect(html).toContain('in the last 5 minutes');
    expect(html).not.toContain('in last minute');
  });
});
