'use client';

/**
 * `<ChatNotificationsPanel>` — Slice D
 * (`docs/specs/clerk-config-scheduling-chat.md`) requester-scoped Google
 * Chat webhook, rendered in the Settings "Connections" tab next to
 * `<CredentialsPanel>`.
 *
 * Unlike the project-level webhook (`WebhookSection`, one row per project,
 * owner/admin-gated, catalog of per-event toggles), this is a PERSONAL
 * setting with exactly one purpose: each user pastes the incoming webhook
 * of a PRIVATE Google Chat space they own, and Clerk pings that space
 * directly with the outcome of THEIR OWN tasks — never a project's shared
 * space, never anyone else's. There is no event-toggle catalog here because
 * there is only one event family this channel ever carries (Clerk task
 * outcomes).
 *
 * Backend contract (this PR): `PATCH /api/users/me` (`notification_chat_webhook`,
 * `https://chat.googleapis.com/…` or empty/null to clear) and
 * `POST /api/users/me/test-chat-webhook` (mirrors the project test-webhook
 * route, records `users/{id}.notification_chat_delivery`).
 *
 * Also renders the chat DM conversation-window picker (chat DM conversation
 * window feature) in its own `<Card>` below the webhook one. Same home as
 * the webhook setting, and for the same reason: this is a personal Google
 * Chat habit ("how should MY 1:1 conversation with Clerk restart"), not a
 * project policy, so it belongs next to the other personal, PATCH-`/users/me`
 * Chat preference rather than on the Clerk page's Ask/Context/Scheduled tabs
 * (those are per-task/per-project Clerk surfaces, not account settings) or
 * behind a new page.
 */
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { DEFAULT_CHAT_CONVERSATION_WINDOW, type ChatConversationWindow, type User } from '@arbitra/shared';
import { api, ApiError } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { RelativeTime } from '../shared/relative-time';
import { Button } from '../ui/button';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';

/**
 * Plain-language copy for the closed `ChatConversationWindow` set — no
 * internal jargon (`idle_gap` never appears in the UI). Order matches the
 * type's own declaration order in `types/user.ts`.
 */
const CONVERSATION_WINDOW_OPTIONS: { value: ChatConversationWindow; label: string; description: string }[] = [
  {
    value: 'continuous',
    label: 'One ongoing conversation',
    description: 'Never starts over — every message you send builds on the last one.',
  },
  {
    value: 'daily',
    label: 'A new conversation each day',
    description: 'Messages on the same day continue together; the next day starts fresh.',
  },
  {
    value: 'idle_gap',
    label: 'A new conversation after a break',
    description: "Starts fresh after about 4 hours with no message. Today's default.",
  },
  {
    value: 'per_message',
    label: 'Every message on its own',
    description: 'Each message is handled by itself, with no memory of earlier ones.',
  },
];

export function ChatNotificationsPanel() {
  // Same SWR key as `<ProfilePanel>` (`api.users.me()`) so both panels share
  // one cache entry for the same underlying document — a save in either
  // panel is reflected in the other without a second network round trip.
  const { data, mutate } = useSWR<User>('me-profile', () => api.users.me());
  const { addToast } = useToast();

  const persisted = data?.notification_chat_webhook ?? '';
  // Seeded from `data` at initial render (not only via the effect below) so
  // a cache hit — e.g. `<ProfilePanel>` already populated the shared
  // `'me-profile'` SWR key this session — shows the persisted value on the
  // very first paint, server-rendered included, instead of one tick late.
  const [webhookUrl, setWebhookUrl] = useState(persisted);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  // Re-sync whenever the fetched profile's webhook changes after mount
  // (first load resolving, or a save landing) — mirrors `<ProfilePanel>`'s
  // pattern for `custom_avatar_url`.
  useEffect(() => {
    setWebhookUrl(data?.notification_chat_webhook ?? '');
    setInlineError(null);
  }, [data?.notification_chat_webhook]);

  const dirty = webhookUrl.trim() !== persisted;

  // Conversation window: independent editable field, own dirty/save state,
  // same PATCH endpoint. Persisted-but-absent means "never chosen" — the
  // select still needs a concrete value to render as selected, so absence
  // is normalized to the same default the backend itself falls back to
  // (`DEFAULT_CHAT_CONVERSATION_WINDOW`) rather than leaving nothing checked.
  const persistedWindow = data?.chat_conversation_window ?? DEFAULT_CHAT_CONVERSATION_WINDOW;
  const [conversationWindow, setConversationWindow] = useState<ChatConversationWindow>(persistedWindow);
  const [savingWindow, setSavingWindow] = useState(false);

  useEffect(() => {
    setConversationWindow(data?.chat_conversation_window ?? DEFAULT_CHAT_CONVERSATION_WINDOW);
  }, [data?.chat_conversation_window]);

  const windowDirty = conversationWindow !== persistedWindow;

  async function handleSaveWindow() {
    setSavingWindow(true);
    try {
      const updated = await api.users.updateMe({ chat_conversation_window: conversationWindow });
      await mutate(updated, { revalidate: false });
      addToast('success', 'Conversation window saved');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to save conversation window');
    } finally {
      setSavingWindow(false);
    }
  }

  async function handleSave() {
    setInlineError(null);
    setSaving(true);
    const trimmed = webhookUrl.trim();
    try {
      const updated = await api.users.updateMe({
        notification_chat_webhook: trimmed === '' ? null : trimmed,
      });
      await mutate(updated, { revalidate: false });
      setTestResult(null);
      addToast('success', trimmed === '' ? 'Chat webhook cleared' : 'Chat webhook saved');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
        setInlineError(err.message);
      } else {
        addToast('error', err instanceof Error ? err.message : 'Failed to save chat webhook');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      await api.users.testChatWebhook();
      setTestResult('success');
      addToast('success', 'Test message sent');
    } catch {
      setTestResult('error');
      addToast('error', 'Failed to send test message. Check the webhook URL.');
    } finally {
      setTesting(false);
      // A Test click is itself a recorded send attempt (backend writes
      // notification_chat_delivery either way) — refetch so the delivery
      // status below reflects the attempt that just happened.
      await mutate();
    }
  }

  return (
    <div className="max-w-3xl mt-8" data-testid="chat-notifications-panel">
      <SectionHeader
        eyebrow
        title="Chat notifications"
        description="Clerk pings this space when your tasks finish."
        className="mb-4"
      />

      <Card as="section" padding="compact">
        <label
          htmlFor="chat-webhook-url"
          className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Google Chat webhook URL
        </label>
        <div className="flex gap-2">
          <input
            id="chat-webhook-url"
            type="url"
            value={webhookUrl}
            onChange={(e) => {
              setWebhookUrl(e.target.value);
              setInlineError(null);
              setTestResult(null);
            }}
            placeholder="https://chat.googleapis.com/v1/spaces/..."
            autoComplete="off"
            className="flex-1 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100 focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-gray-400 dark:placeholder:text-gray-500"
          />
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleTest} disabled={testing || !persisted}>
            {testing ? 'Sending…' : 'Test'}
          </Button>
        </div>

        {inlineError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="chat-webhook-error">
            {inlineError}
          </p>
        )}
        {testResult === 'success' && (
          <p className="mt-2 text-xs text-green-600 dark:text-green-400">Test message sent successfully.</p>
        )}
        {testResult === 'error' && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
            Failed to send test message. Check the webhook URL.
          </p>
        )}

        <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
          In Google Chat: open a private space you own → <strong>Apps &amp; Integrations</strong> →{' '}
          <strong>Manage webhooks</strong> → Add webhook. Paste the generated URL here.
        </p>

        {/*
          Delivery observability (spec Slice D, same shape as the project
          Integrations tab's Slice C item 4 rendering): shows whichever of
          `last_success_at`/`last_error` are present — the two are
          independent (a success does not clear a prior error).
        */}
        {data?.notification_chat_delivery?.last_success_at && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="chat-delivery-last-success">
            <RelativeTime timestamp={data.notification_chat_delivery.last_success_at} prefix="Last delivered" />
          </p>
        )}
        {data?.notification_chat_delivery?.last_error && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="chat-delivery-last-error">
            Last error ({data.notification_chat_delivery.last_error.code}):{' '}
            {data.notification_chat_delivery.last_error.message}{' '}
            (<RelativeTime timestamp={data.notification_chat_delivery.last_error.at} />)
          </p>
        )}
      </Card>

      <SectionHeader
        eyebrow
        title="Conversation window"
        description="Choose when a direct message to Clerk should start a new conversation."
        className="mb-4 mt-8"
      />

      <Card as="section" padding="compact">
        <fieldset>
          <legend className="sr-only">Conversation window</legend>
          <div
            role="radiogroup"
            aria-label="Conversation window"
            data-testid="conversation-window-options"
            className="space-y-3"
          >
            {CONVERSATION_WINDOW_OPTIONS.map((option) => {
              const inputId = `conversation-window-${option.value}`;
              return (
                <label
                  key={option.value}
                  htmlFor={inputId}
                  className="flex items-start gap-3 cursor-pointer"
                >
                  <input
                    id={inputId}
                    type="radio"
                    name="conversation-window"
                    value={option.value}
                    checked={conversationWindow === option.value}
                    onChange={() => setConversationWindow(option.value)}
                    className="mt-0.5 h-3.5 w-3.5 border-gray-300 text-accent focus:ring-accent"
                  />
                  <span>
                    <span className="block text-sm text-gray-900 dark:text-gray-100">{option.label}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <p className="mt-4 text-[11px] text-gray-400 dark:text-gray-500">
          Only affects direct messages to Clerk. A conversation inside a group space always follows its own
          Chat thread.
        </p>

        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="sm" onClick={handleSaveWindow} disabled={savingWindow || !windowDirty}>
            {savingWindow ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
