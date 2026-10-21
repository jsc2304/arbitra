/**
 * @file `<WebhookSection>` — catalog-driven event toggle list (spec Slice C
 * item 2, `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * SSR render-only (`renderToStaticMarkup`), no jsdom/`fireEvent` — this
 * frontend suite is deliberately node-only (see `tooltip.test.tsx`). The
 * toggle-list render is verified via static markup; the PATCH-payload merge
 * behaviour (the thing a regression would most likely break) is unit-tested
 * directly against the exported pure `nextEventOverrides` helper instead of
 * simulating a click.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '@arbitra/shared';

vi.mock('../../../lib/api-client', () => ({
  api: {
    projects: {
      update: vi.fn().mockResolvedValue({}),
      testWebhook: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'proj_1',
    name: 'Test Project',
    description: '',
    reviewer_pool: [],
    tech_leads: [],
    default_rule_set_refs: [],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Extracts the `<input id="notification-event-{event}" .../>` self-closing
 * tag and reports whether it carries `checked=""`. Scoped to the one input
 * tag (not a substring match on the whole document) so it stays correct
 * regardless of attribute order.
 */
function isEventChecked(html: string, event: string): boolean {
  const match = html.match(new RegExp(`<input id="notification-event-${event}"[^>]*/>`));
  if (!match) throw new Error(`no toggle input rendered for event "${event}"`);
  return / checked=""/.test(match[0]);
}

describe('<WebhookSection /> — catalog-driven toggle list', () => {
  it('renders one row per real catalog event, labeled from the catalog', async () => {
    const { NOTIFICATION_EVENT_DEFAULTS } = await import('@arbitra/shared');
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(<WebhookSection project={makeProject()} onUpdate={vi.fn()} />);

    for (const entry of Object.values(NOTIFICATION_EVENT_DEFAULTS)) {
      expect(html).toContain(entry.label);
    }
    // The stale hardcoded five-event sentence must be gone.
    expect(html).not.toContain('review completed with findings');
  });

  it('checks a toggle when the project has no override and the catalog default is chat:true', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(<WebhookSection project={makeProject()} onUpdate={vi.fn()} />);

    expect(isEventChecked(html, 'case_needs_decision')).toBe(true);
  });

  it('leaves a toggle unchecked when the project has no override and the catalog default is chat:false', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(<WebhookSection project={makeProject()} onUpdate={vi.fn()} />);

    expect(isEventChecked(html, 'case_approved')).toBe(false);
  });

  it('unchecks a toggle when the project explicitly overrides a chat:true default to false', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(
      <WebhookSection
        project={makeProject({ notification_events: { case_needs_decision: false } })}
        onUpdate={vi.fn()}
      />,
    );

    expect(isEventChecked(html, 'case_needs_decision')).toBe(false);
  });

  it('checks a toggle when the project overrides a chat:false default to true', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(
      <WebhookSection
        project={makeProject({ notification_events: { case_approved: true } })}
        onUpdate={vi.fn()}
      />,
    );

    expect(isEventChecked(html, 'case_approved')).toBe(true);
  });

  it('renders a new catalog entry without any change to webhook-section.tsx itself', async () => {
    // Regression guard for "catalog-driven, not hardcoded": mocking the
    // catalog with an extra entry must make a new row appear even though
    // webhook-section.tsx was never told about `mock_event` — proving the
    // component really renders from the imported catalog, not a literal
    // list of event names baked into the component.
    vi.doMock('@arbitra/shared', async (importOriginal) => {
      const original = await importOriginal<typeof import('@arbitra/shared')>();
      return {
        ...original,
        NOTIFICATION_EVENT_DEFAULTS: {
          ...original.NOTIFICATION_EVENT_DEFAULTS,
          mock_event: { chat: true, label: 'Mock Catalog Event' },
        },
        NOTIFICATION_EVENT_ORDER: [...original.NOTIFICATION_EVENT_ORDER, 'mock_event'],
      };
    });
    vi.resetModules();

    const { WebhookSection } = await import('../webhook-section');
    const html = renderToStaticMarkup(<WebhookSection project={makeProject()} onUpdate={vi.fn()} />);

    expect(html).toContain('Mock Catalog Event');
    expect(html).toContain('id="notification-event-mock_event"');

    vi.doUnmock('@arbitra/shared');
    vi.resetModules();
  });
});

describe('nextEventOverrides — toggle merge behaviour', () => {
  it('sets the toggled event without touching other existing overrides', async () => {
    const { nextEventOverrides } = await import('../webhook-section');

    const current = { case_approved: true, case_done: false } as const;
    const next = nextEventOverrides(current, 'run_failed', false);

    expect(next).toEqual({ case_approved: true, case_done: false, run_failed: false });
  });

  it('flips an existing override in place rather than appending a duplicate', async () => {
    const { nextEventOverrides } = await import('../webhook-section');

    const current = { case_needs_decision: true };
    const next = nextEventOverrides(current, 'case_needs_decision', false);

    expect(next).toEqual({ case_needs_decision: false });
  });
});

describe('isToggleDisabled — serializes concurrent event toggles (lost-update race guard)', () => {
  it('disables every toggle, not just the one saving, while any save is in flight', async () => {
    // Reverting to a per-toggle check (`savingEvent === event`) would let a
    // second toggle on a DIFFERENT event start before the first PATCH
    // resolves — both merge from the same stale pre-save state and whichever
    // PATCH's response lands last silently drops the other's change.
    // Disabling ALL toggles while ANY save is pending closes that race by
    // serializing saves; this pins that it's a blanket check, not per-event.
    const { isToggleDisabled } = await import('../webhook-section');

    expect(isToggleDisabled('case_approved')).toBe(true);
    expect(isToggleDisabled('case_done')).toBe(true);
  });

  it('leaves toggles enabled when no save is in flight', async () => {
    const { isToggleDisabled } = await import('../webhook-section');

    expect(isToggleDisabled(null)).toBe(false);
  });
});

/**
 * Delivery status rendering (spec Slice C item 4). `last_success_at` and
 * `last_error` are independent fields — both, either, or neither can be
 * present — so each is asserted in isolation and in combination.
 */
describe('<WebhookSection /> — delivery status next to Test', () => {
  it('renders nothing when notification_delivery is absent (never sent yet)', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(<WebhookSection project={makeProject()} onUpdate={vi.fn()} />);

    expect(html).not.toContain('data-testid="delivery-last-success"');
    expect(html).not.toContain('data-testid="delivery-last-error"');
  });

  it('renders a relative "last delivered" time when last_success_at is present', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(
      <WebhookSection
        project={makeProject({
          notification_delivery: { last_success_at: '2026-08-01T00:00:00.000Z' },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="delivery-last-success"');
    expect(html).toContain('Last delivered');
    expect(html).not.toContain('data-testid="delivery-last-error"');
  });

  it('renders the last error (code + message) when present, muted with a timestamp', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(
      <WebhookSection
        project={makeProject({
          notification_delivery: {
            last_error: { at: '2026-08-01T00:00:00.000Z', code: '500', message: 'Internal Server Error' },
          },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="delivery-last-error"');
    expect(html).toContain('500');
    expect(html).toContain('Internal Server Error');
    expect(html).not.toContain('data-testid="delivery-last-success"');
  });

  it('renders both last_success_at and last_error at once (success does not clear a prior error)', async () => {
    const { WebhookSection } = await import('../webhook-section');

    const html = renderToStaticMarkup(
      <WebhookSection
        project={makeProject({
          notification_delivery: {
            last_success_at: '2026-08-01T00:00:00.000Z',
            last_error: { at: '2026-07-31T00:00:00.000Z', code: '429', message: 'Rate limited' },
          },
        })}
        onUpdate={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="delivery-last-success"');
    expect(html).toContain('data-testid="delivery-last-error"');
  });
});

describe('commitWebhookSave — clear sends an explicit null, never undefined (issue #1100)', () => {
  it('sends notification_webhook_url: null (not undefined) when the trimmed URL is empty', async () => {
    // Reverted line this pins: `webhook-section.tsx`'s old `handleSave` sent
    // `notification_webhook_url: webhookUrl.trim() || undefined`.
    // `JSON.stringify` drops keys whose value is `undefined`, so the PATCH
    // body carried no key at all and the server never cleared the stored
    // URL — while `addToast('success', ...)` still fired. Asserting the
    // exact value (not just that `update` was called) is what catches that.
    const { api } = await import('../../../lib/api-client');
    const { commitWebhookSave } = await import('../webhook-section');

    await commitWebhookSave('proj_1', '');

    expect(api.projects.update).toHaveBeenCalledWith('proj_1', { notification_webhook_url: null });
  });

  it('sends the trimmed URL string unchanged when it is non-empty', async () => {
    const { api } = await import('../../../lib/api-client');
    const { commitWebhookSave } = await import('../webhook-section');

    await commitWebhookSave('proj_1', 'https://chat.googleapis.com/v1/spaces/x/messages?key=y');

    expect(api.projects.update).toHaveBeenCalledWith('proj_1', {
      notification_webhook_url: 'https://chat.googleapis.com/v1/spaces/x/messages?key=y',
    });
  });
});

describe('commitEventToggle — PATCH payload (undefined-next regression guard)', () => {
  it('sends the computed merge object to the PATCH call, never undefined', async () => {
    // Reverted line this pins: an earlier version did
    //   let next; setEventOverrides((prev) => (next = nextEventOverrides(prev, event, checked)));
    //   await api.projects.update(projectId, { notification_events: next });
    // React does not invoke `setState` updater callbacks synchronously, so
    // `next` was still `undefined` on the very next line — every toggle
    // PATCHed `{ notification_events: undefined }` and never persisted.
    // Asserting the exact call arguments (not just "was called") is what
    // catches that; a call-count-only assertion would have passed on the
    // broken code too.
    const { api } = await import('../../../lib/api-client');
    const { commitEventToggle } = await import('../webhook-section');
    const onNext = vi.fn();

    await commitEventToggle('proj_1', { case_done: false }, 'case_approved', true, onNext);

    expect(api.projects.update).toHaveBeenCalledWith('proj_1', {
      notification_events: { case_done: false, case_approved: true },
    });
    expect(onNext).toHaveBeenCalledWith({ case_done: false, case_approved: true });
  });

  it('calls onNext (optimistic state update) before awaiting the PATCH resolves', async () => {
    const { api } = await import('../../../lib/api-client');
    const order: string[] = [];
    (api.projects.update as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      order.push('patch-resolved');
      return {};
    });
    const onNext = vi.fn(() => order.push('onNext-called'));

    const { commitEventToggle } = await import('../webhook-section');
    await commitEventToggle('proj_1', {}, 'case_approved', true, onNext);

    expect(order).toEqual(['onNext-called', 'patch-resolved']);
  });
});
