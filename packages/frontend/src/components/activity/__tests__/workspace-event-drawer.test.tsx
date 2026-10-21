/**
 * @file workspace-event-drawer — rendering tests.
 *
 * Node-only per the frontend test convention (renderToStaticMarkup, no
 * jsdom). SWR is mocked so each test controls the loading / error / success
 * state explicitly. We assert that the right block is chosen per event type
 * by checking for a block-specific marker in the markup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceEvent } from '@arbitra/shared';

type SWRState<T> = {
  data?: T;
  error?: unknown;
  isLoading: boolean;
};

// Shared, mutable state the hoisted mock reads from. Tests set this before
// rendering to control what `useSWR` returns.
const swrState: SWRState<WorkspaceEvent> = { isLoading: false };

vi.mock('swr', () => ({
  default: () => swrState,
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

// Drawer now consults `useCanResolveWorkspaceEvent` to decide whether to
// render the "Mark resolved" button. A mutable fixture lets each test
// toggle admin/tech_lead vs. regular-user behavior.
const roleState: { canResolve: boolean; isLoading: boolean } = {
  canResolve: false,
  isLoading: false,
};
vi.mock('../../../hooks/use-can-resolve-workspace-event', () => ({
  useCanResolveWorkspaceEvent: () => roleState,
}));

// The resolved banner resolves the actor display name via `useUserMap`.
// Stub it out so the banner test can assert a predictable label without
// touching the real users endpoint.
vi.mock('../../../hooks/use-users', () => ({
  useUserMap: (ids: string[]) => {
    const map: Record<string, { user_id: string; display_name: string; email: string }> = {};
    for (const id of ids) {
      map[id] = { user_id: id, display_name: `Admin ${id}`, email: `${id}@x` };
    }
    return map;
  },
}));

// The drawer imports the api client (to supply SWR's fetcher). We never call
// that fetcher in these tests — the hook is mocked — but stub the module so
// the `firebase-client` import chain doesn't blow up at module init time.
vi.mock('../../../lib/api-client', () => ({
  api: {
    workspaceEvents: {
      get: vi.fn(),
      resolve: vi.fn(),
      dismiss: vi.fn(),
    },
  },
}));

import { WorkspaceEventDrawer } from '../workspace-event-drawer';

function setSwr(state: SWRState<WorkspaceEvent>) {
  swrState.data = state.data;
  swrState.error = state.error;
  swrState.isLoading = state.isLoading;
}

afterEach(() => {
  setSwr({ isLoading: false });
  roleState.canResolve = false;
  roleState.isLoading = false;
});

describe('WorkspaceEventDrawer', () => {
  it('renders nothing when eventId is null (drawer closed)', () => {
    setSwr({ isLoading: false });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId={null} onClose={() => {}} />,
    );
    expect(html).toBe('');
  });

  it('shows a loading state while SWR is fetching', () => {
    setSwr({ isLoading: true });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="workspaceEvent_1" onClose={() => {}} />,
    );
    expect(html).toContain('Loading event');
  });

  it('shows an error state when the fetch failed', () => {
    setSwr({ isLoading: false, error: new Error('Request failed: 500') });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="workspaceEvent_1" onClose={() => {}} />,
    );
    expect(html).toContain('Could not load this event');
    expect(html).toContain('Request failed: 500');
  });

  it('picks the webhook-misconfigured block for that event type', () => {
    setSwr({
      isLoading: false,
      data: {
        event_id: 'workspaceEvent_1',
        type: 'webhook_misconfigured',
        actor_user_id: 'system:arbitra-webhook',
        timestamp: '2026-04-20T10:00:00.000Z',
        summary: 'Webhook for acme/widgets is missing pull_request',
        evidence: { github_full_name: 'acme/widgets', project_id: 'proj_1' },
      },
    });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="workspaceEvent_1" onClose={() => {}} />,
    );
    // Title matches the `webhook_misconfigured` branch in titleFor().
    expect(html).toContain('Webhook subscription missing pull_request');
    // WebhookMisconfiguredBlock-specific marker: UI-steps list references the
    // GitHub hooks settings page URL built from github_full_name.
    expect(html).toContain('https://github.com/acme/widgets/settings/hooks');
  });

  it('picks the intelligence-run block for that event type', () => {
    setSwr({
      isLoading: false,
      data: {
        event_id: 'workspaceEvent_2',
        type: 'intelligence_run',
        actor_user_id: 'system:arbitra-intelligence',
        timestamp: '2026-04-20T10:00:00.000Z',
        summary: 'Ran 1 detector — 0 new nudges',
        evidence: {
          duration_ms: 120,
          detectors: [{ detector: 'stale_pr', duration_ms: 120, cases_created: 0 }],
        },
      },
    });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="workspaceEvent_2" onClose={() => {}} />,
    );
    expect(html).toContain('Intelligence run');
    // Intelligence-block-specific marker: the detector id is rendered in the
    // table, and durations appear with the " ms" suffix.
    expect(html).toContain('stale_pr');
    expect(html).toContain('120 ms');
  });

  it('always renders the "Dismiss for me" button for authenticated viewers', () => {
    roleState.canResolve = false;
    setSwr({
      isLoading: false,
      data: {
        event_id: 'we_actions_1',
        type: 'intelligence_run',
        actor_user_id: 'system:arbitra-intelligence',
        timestamp: '2026-04-20T10:00:00.000Z',
        summary: 's',
      },
    });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="we_actions_1" onClose={() => {}} />,
    );
    expect(html).toContain('Dismiss for me');
    // Non-privileged user: no resolve button.
    expect(html).not.toContain('Mark resolved');
  });

  it('shows the "Mark resolved" button for admin / tech_lead viewers', () => {
    roleState.canResolve = true;
    setSwr({
      isLoading: false,
      data: {
        event_id: 'we_actions_2',
        type: 'intelligence_run',
        actor_user_id: 'system:arbitra-intelligence',
        timestamp: '2026-04-20T10:00:00.000Z',
        summary: 's',
      },
    });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="we_actions_2" onClose={() => {}} />,
    );
    expect(html).toContain('Mark resolved');
    expect(html).toContain('Dismiss for me');
  });

  it('renders the resolved banner and hides action buttons when resolved', () => {
    roleState.canResolve = true;
    setSwr({
      isLoading: false,
      data: {
        event_id: 'we_resolved',
        type: 'intelligence_run',
        actor_user_id: 'system:arbitra-intelligence',
        timestamp: '2026-04-20T10:00:00.000Z',
        summary: 's',
        resolved_at: '2026-04-22T00:00:00.000Z',
        resolved_by: 'usr_admin',
      },
    });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="we_resolved" onClose={() => {}} />,
    );
    expect(html).toContain('Resolved');
    // Resolver display name is picked up from the stubbed useUserMap.
    expect(html).toContain('Admin usr_admin');
    // Action buttons are hidden once the event is resolved.
    expect(html).not.toContain('Mark resolved');
    expect(html).not.toContain('Dismiss for me');
  });

  it('falls back to the default JSON block for unknown event types', () => {
    setSwr({
      isLoading: false,
      data: {
        event_id: 'workspaceEvent_3',
        type: 'some_future_type',
        actor_user_id: 'system:unknown',
        timestamp: '2026-04-20T10:00:00.000Z',
        summary: 'Future event',
        evidence: { some_field: 'some_value' },
      },
    });
    const html = renderToStaticMarkup(
      <WorkspaceEventDrawer eventId="workspaceEvent_3" onClose={() => {}} />,
    );
    // Humanized title for unknown types.
    expect(html).toContain('Some Future Type');
    // DefaultBlock dumps the evidence JSON.
    expect(html).toContain('some_field');
    expect(html).toContain('some_value');
  });
});
