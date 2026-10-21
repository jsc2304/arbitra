/**
 * @file `<ChatNotificationsPanel>` — SSR render-only harness
 * (`renderToStaticMarkup`, no clicks — matches `credentials-panel.test.tsx`'s
 * pattern). Stubs `swr` to return a fixed `User` snapshot regardless of
 * key/fetcher, stubs the toast provider. Did not exist before this PR
 * (spec Slice D, `docs/specs/clerk-config-scheduling-chat.md`).
 *
 * The conversation-window save path is additionally covered without jsdom/
 * `fireEvent` (this suite is deliberately Node-only, same technique
 * `clerk-scheduled-panel.test.tsx` uses): `<Button>` is wrapped to DELEGATE
 * to the real `Button` (renders it unchanged — every existing text/
 * `disabled=""` assertion above still sees identical output) while also
 * stashing each rendered button's props in `mocks.buttonProps`, so the
 * Save button's captured `onClick` closure can be invoked directly to pin
 * exactly what body `api.users.updateMe` is called with — the shape the
 * backend route rejected before this fix.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { User } from '@arbitra/shared';

let swrData: Partial<User> = {};

const mocks = vi.hoisted(() => ({
  updateMe: vi.fn(),
  buttonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('swr', () => ({
  __esModule: true,
  default: (_key: unknown, _fetcher: unknown) => ({
    data: swrData,
    mutate: vi.fn(),
  }),
}));

vi.mock('../../../lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api-client')>('../../../lib/api-client');
  return {
    ...actual,
    api: {
      ...actual.api,
      users: {
        ...actual.api.users,
        updateMe: mocks.updateMe,
      },
    },
  };
});

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../shared/relative-time', () => ({
  RelativeTime: ({ timestamp, prefix, className }: { timestamp: string; prefix?: string; className?: string }) => (
    <span className={className}>{prefix ? `${prefix} ` : ''}{timestamp}</span>
  ),
}));

vi.mock('../../ui/button', async () => {
  const actual = await vi.importActual<typeof import('../../ui/button')>('../../ui/button');
  return {
    ...actual,
    Button: (props: import('../../ui/button').ButtonProps) => {
      mocks.buttonProps.push(props as unknown as Record<string, unknown>);
      return <actual.Button {...props} />;
    },
  };
});

import { ChatNotificationsPanel } from '../chat-notifications-panel';

describe('<ChatNotificationsPanel /> — no webhook configured', () => {
  it('renders an empty input, a disabled Test button, and no delivery rows', () => {
    swrData = {};
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('Chat notifications');
    expect(html).toContain('id="chat-webhook-url"');
    expect(html).toContain('value=""');
    expect(html).toContain('Test');
    // Nothing persisted yet to probe — the Test button renders disabled.
    expect(html).toContain('disabled');
    expect(html).not.toContain('chat-delivery-last-success');
    expect(html).not.toContain('chat-delivery-last-error');
  });

  it('renders the how-to hint text', () => {
    swrData = {};
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('Apps &amp; Integrations');
    expect(html).toContain('Manage webhooks');
  });

  it('renders the one-line explanation of what this channel is for', () => {
    swrData = {};
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('Clerk pings this space when your tasks finish.');
  });
});

describe('<ChatNotificationsPanel /> — webhook configured', () => {
  it('pre-fills the input with the persisted webhook URL', () => {
    swrData = { notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=x' };
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('value="https://chat.googleapis.com/v1/spaces/AAA/messages?key=x"');
  });

  it('renders delivery success observability when notification_chat_delivery.last_success_at is present', () => {
    swrData = {
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages',
      notification_chat_delivery: { last_success_at: '2026-08-01T00:00:00.000Z' },
    };
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('chat-delivery-last-success');
    expect(html).toContain('2026-08-01T00:00:00.000Z');
    expect(html).not.toContain('chat-delivery-last-error');
  });

  it('renders delivery error observability when notification_chat_delivery.last_error is present, alongside a success', () => {
    // Independent fields — a success does not clear a prior error.
    swrData = {
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages',
      notification_chat_delivery: {
        last_success_at: '2026-08-01T00:00:00.000Z',
        last_error: { at: '2026-07-30T00:00:00.000Z', code: '500', message: 'boom' },
      },
    };
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('chat-delivery-last-success');
    expect(html).toContain('chat-delivery-last-error');
    expect(html).toContain('500');
    expect(html).toContain('boom');
  });

  it('renders exactly the persisted webhook value in the input, not a stale or duplicated one', () => {
    swrData = { notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages' };
    const html = renderToStaticMarkup(<ChatNotificationsPanel />);

    expect(html).toContain('value="https://chat.googleapis.com/v1/spaces/AAA/messages"');
    // The input's value renders once — no second, mismatched copy anywhere.
    const valueOccurrences = html.match(/https:\/\/chat\.googleapis\.com\/v1\/spaces\/AAA\/messages/g) ?? [];
    expect(valueOccurrences.length).toBe(1);
  });
});

describe('<ChatNotificationsPanel /> — conversation window save path', () => {
  // Pins the exact request body `handleSaveWindow` sends. The backend
  // route (`app/api/users/me/route.ts`) previously 400'd on precisely this
  // shape — a body carrying `chat_conversation_window` and nothing else —
  // because it only recognized `custom_avatar_url`/`notification_chat_webhook`.
  // This test only proves the FRONTEND sends the right thing; it does not
  // exercise the route itself (see `route.test.ts` for that half).
  it('calls api.users.updateMe with only chat_conversation_window, matching the persisted value', async () => {
    mocks.updateMe.mockClear();
    mocks.buttonProps.length = 0;
    mocks.updateMe.mockResolvedValue({ chat_conversation_window: 'daily' } as Partial<User>);
    swrData = { chat_conversation_window: 'daily' };

    renderToStaticMarkup(<ChatNotificationsPanel />);

    // Two buttons render with the label "Save" — the webhook Card's and the
    // conversation-window Card's, in that render order. Neither disabled
    // state nor any other prop reliably tells them apart (both are
    // `disabled` here, since the seeded value already matches the persisted
    // one), so select by position instead of by a matched predicate.
    const saveButtons = mocks.buttonProps.filter((props) => props.children === 'Save');
    expect(saveButtons).toHaveLength(2);
    const saveWindowProps = saveButtons[1];
    await (saveWindowProps!.onClick as () => Promise<void>)();

    expect(mocks.updateMe).toHaveBeenCalledTimes(1);
    expect(mocks.updateMe).toHaveBeenCalledWith({ chat_conversation_window: 'daily' });
  });

  it('never bundles notification_chat_webhook into the conversation-window save call', async () => {
    mocks.updateMe.mockClear();
    mocks.buttonProps.length = 0;
    mocks.updateMe.mockResolvedValue({ chat_conversation_window: 'idle_gap' } as Partial<User>);
    swrData = {
      chat_conversation_window: 'idle_gap',
      notification_chat_webhook: 'https://chat.googleapis.com/v1/spaces/AAA/messages',
    };

    renderToStaticMarkup(<ChatNotificationsPanel />);

    // Two buttons render with the label "Save" — the webhook Card's and the
    // conversation-window Card's, in that render order. Neither disabled
    // state nor any other prop reliably tells them apart (both are
    // `disabled` here, since the seeded value already matches the persisted
    // one), so select by position instead of by a matched predicate.
    const saveButtons = mocks.buttonProps.filter((props) => props.children === 'Save');
    expect(saveButtons).toHaveLength(2);
    const saveWindowProps = saveButtons[1];
    await (saveWindowProps!.onClick as () => Promise<void>)();

    const call = mocks.updateMe.mock.calls[0]![0] as Record<string, unknown>;
    expect('notification_chat_webhook' in call).toBe(false);
    expect(call).toEqual({ chat_conversation_window: 'idle_gap' });
  });
});
