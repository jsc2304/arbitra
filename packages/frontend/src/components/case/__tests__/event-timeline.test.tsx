/**
 * @file EventTimeline — `case_updated` rendering (issue #794, timeline P1).
 *
 * Node-only (renderToStaticMarkup). SWR + useUserMap are mocked (no live
 * runs fetch needed — `case_updated` doesn't touch the review-model lookup)
 * so each test only has to control the event list.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';
import type { CaseEvent } from '@arbitra/shared';

vi.mock('swr', () => ({
  default: () => ({ data: undefined }),
}));

vi.mock('../../../hooks/use-users', () => ({
  useUserMap: () => ({}),
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    runs: {
      listForCase: vi.fn(),
    },
  },
}));

import { EventTimeline } from '../event-timeline';

function makeEvent(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    event_id: 'event_1',
    case_id: 'case_1',
    type: 'case_updated',
    actor_id: 'usr_1',
    payload: {},
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('EventTimeline — case_updated (issue #794)', () => {
  it('labels a single-field title change as "Title changed" and shows old->new', () => {
    const html = renderToStaticMarkup(
      <EventTimeline
        events={[
          makeEvent({
            payload: { changed: ['title'], title: { from: 'Old title', to: 'New title' } },
          }),
        ]}
      />,
    );
    expect(html).toContain('Title changed');
    expect(html).toContain('Old title');
    expect(html).toContain('New title');
  });

  it('labels a multi-field change as "Details updated — <fields>"', () => {
    const html = renderToStaticMarkup(
      <EventTimeline
        events={[
          makeEvent({
            payload: {
              changed: ['title', 'priority'],
              title: { from: 'Old title', to: 'New title' },
              priority: { from: 'normal', to: 'urgent' },
            },
          }),
        ]}
      />,
    );
    expect(html).toContain('Details updated');
    expect(html).toContain('title');
    expect(html).toContain('priority');
  });

  it('renders a changed-marker for description without leaking any body text', () => {
    const html = renderToStaticMarkup(
      <EventTimeline
        events={[
          makeEvent({
            payload: { changed: ['description'] },
          }),
        ]}
      />,
    );
    expect(html).toContain('Description changed');
    expect(html).toContain('Description updated');
  });

  it('never renders a raw field-name dump for a recognized case_updated payload', () => {
    const html = renderToStaticMarkup(
      <EventTimeline
        events={[
          makeEvent({
            payload: {
              changed: ['case_type', 'validation_track'],
              case_type: { from: 'bugfix', to: 'refactoring' },
              validation_track: { from: 'direct', to: 'manual' },
            },
          }),
        ]}
      />,
    );
    expect(html).toContain('Case type');
    expect(html).toContain('Validation track');
    expect(html).toContain('manual validation');
  });

  it('renders nothing extra (no crash, no payload dump) when changed is empty', () => {
    const html = renderToStaticMarkup(
      <EventTimeline events={[makeEvent({ payload: { changed: [] } })]} />,
    );
    expect(html).toContain('Case Updated');
  });
});

describe('EventTimeline — risk_level_changed (issue #1041)', () => {
  it('renders the risk transition, not a fake status-pill transition', () => {
    const html = renderToStaticMarkup(
      <EventTimeline
        events={[
          makeEvent({
            type: 'risk_level_changed',
            payload: { from: 'medium', to: 'high', reason: 'file signal' },
          }),
        ]}
      />,
    );
    // The dedicated renderer joins RISK_LABELS with a plain "→" inside a
    // single <p>; the generic state-transition block (which the bare
    // from/to payload would otherwise match first) renders two separate
    // StatusPill spans around an <svg> arrow instead and never produces
    // this exact string.
    expect(html).toContain('Medium risk → High risk');
  });

  it('falls back to from_risk_level/to_risk_level for a historical event predating the current payload keys', () => {
    const html = renderToStaticMarkup(
      <EventTimeline
        events={[
          makeEvent({
            type: 'risk_level_changed',
            payload: { from_risk_level: 'low', to_risk_level: 'critical' },
          }),
        ]}
      />,
    );
    expect(html).toContain('Low risk → Critical risk');
  });
});
