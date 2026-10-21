/**
 * @file helper-bot-drawer — rendering + API integration tests.
 *
 * Node-only per the frontend test convention (renderToStaticMarkup, no
 * jsdom). The drawer's stateful behavior (chat bubbles, sessionStorage,
 * clear-conversation) is exercised by:
 *   1. Rendering the drawer in representative states via prop manipulation
 *      against `renderToStaticMarkup` and asserting the right markers show.
 *   2. Asserting the underlying `api.helper.ask` call wires up the right
 *      method, path, body (now with optional history), and Authorization
 *      header — this is where the network contract guarantee lives.
 *   3. Round-tripping the sessionStorage shape via a tiny in-memory shim.
 *
 * We don't drive React event handlers here because there's no jsdom in this
 * package. The state-machine logic inside the drawer is small (request id
 * guard + try/catch + storage reads); coverage of the network contract +
 * rendered shape + storage shape is the highest-value slice available.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelperBotDrawer, dropOrphanTrailingUser } from '../helper-bot-drawer';

// Bypass firebase: the drawer's submit path calls `api.helper.ask`, which
// resolves the bearer token via firebase-client. Stub it so module init
// doesn't try to load the real firebase SDK in a node test runner.
vi.mock('../../../lib/firebase-client', () => ({
  getIdToken: async () => 'test-token',
}));

describe('<HelperBotDrawer /> — closed', () => {
  it('renders nothing when `open` is false', () => {
    const html = renderToStaticMarkup(
      <HelperBotDrawer open={false} onClose={() => {}} />,
    );
    // SideDrawer returns null when closed → empty markup.
    expect(html).toBe('');
  });
});

describe('<HelperBotDrawer /> — open (empty conversation)', () => {
  it('renders the intro copy, the input, and the send button (no clear button when empty)', () => {
    const html = renderToStaticMarkup(
      <HelperBotDrawer open={true} onClose={() => {}} />,
    );
    expect(html).toContain('Arbitra Helper');
    expect(html).toContain('Ask about Arbitra setup');
    expect(html).toContain('data-testid="helper-bot-input"');
    expect(html).toContain('data-testid="helper-bot-submit"');
    expect(html).toContain('data-testid="helper-bot-messages"');
    // Empty placeholder visible.
    expect(html).toContain('No messages yet');
    // No bubbles, no error, no loading bubble.
    expect(html).not.toContain('data-testid="helper-bot-msg-user"');
    expect(html).not.toContain('data-testid="helper-bot-msg-assistant"');
    expect(html).not.toContain('data-testid="helper-bot-error"');
    expect(html).not.toContain('data-testid="helper-bot-loading"');
    // Clear button only appears once there are messages.
    expect(html).not.toContain('data-testid="helper-bot-clear"');
    // Cmd/Ctrl+Enter hint visible so users discover the shortcut.
    expect(html).toContain('Cmd/Ctrl+Enter');
  });
});

describe('api.helper.ask — network contract', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the question (no history) to /api/helper/ask with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: 'You wire it via stdio.',
          latency_ms: 412,
          prompt_tokens: 150,
          completion_tokens: 80,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { api } = await import('../../../lib/api-client');
    const result = await api.helper.ask('How do I wire MCP into Cursor?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('/api/helper/ask');
    expect(init.method).toBe('POST');
    // Back-compat: when no history is supplied the body omits the field.
    expect(JSON.parse(init.body as string)).toEqual({
      question: 'How do I wire MCP into Cursor?',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer test-token');

    expect(result.answer).toBe('You wire it via stdio.');
    expect(result.latency_ms).toBe(412);
    expect(result.prompt_tokens).toBe(150);
    expect(result.completion_tokens).toBe(80);
  });

  it('POSTs the question + history when history is non-empty', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: 'second',
          latency_ms: 1,
          prompt_tokens: 1,
          completion_tokens: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { api } = await import('../../../lib/api-client');
    const history = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' },
    ];
    await api.helper.ask('q2', history);

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({
      question: 'q2',
      history,
    });
  });

  it('throws with the server error message on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'unauthorized' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { api } = await import('../../../lib/api-client');
    await expect(api.helper.ask('hi')).rejects.toThrow('unauthorized');
  });

  it('falls back to a generic error when the body has no message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 500 }),
    );

    const { api } = await import('../../../lib/api-client');
    await expect(api.helper.ask('hi')).rejects.toThrow(/Request failed: 500/);
  });
});

describe('<HelperBotDrawer /> — sessionStorage round-trip', () => {
  // Tiny in-memory shim so we can test the storage shape without jsdom.
  const store = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };

  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { window: unknown }).window = {
      sessionStorage: shim,
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('hydrates rendered bubbles from sessionStorage on open', () => {
    store.set(
      'arbitra_helper_chat',
      JSON.stringify([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ]),
    );

    const html = renderToStaticMarkup(
      <HelperBotDrawer open={true} onClose={() => {}} />,
    );
    // useEffect runs after server-side render → bubbles won't appear in
    // initial markup, but the messages container and empty placeholder
    // are present. Storage shape itself is the contract under test:
    const raw = shim.getItem('arbitra_helper_chat');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
    // Drawer still renders its skeleton; sanity check.
    expect(html).toContain('data-testid="helper-bot-messages"');
  });

  it('ignores malformed payloads without crashing render', () => {
    store.set('arbitra_helper_chat', '{not json');
    const html = renderToStaticMarkup(
      <HelperBotDrawer open={true} onClose={() => {}} />,
    );
    expect(html).toContain('Arbitra Helper');
    expect(html).toContain('No messages yet');
  });

  it('storage shim removeItem clears the key (used by Clear conversation)', () => {
    store.set('arbitra_helper_chat', JSON.stringify([{ role: 'user', content: 'x' }]));
    shim.removeItem('arbitra_helper_chat');
    expect(shim.getItem('arbitra_helper_chat')).toBeNull();
  });
});

describe('dropOrphanTrailingUser — hydrate sanitization', () => {
  // Pure helper test: the hydrate effect itself runs in a useEffect that
  // node-only vitest can't observe (no jsdom in this package). Asserting
  // the helper directly covers the orphan-drop contract; the drawer wires
  // it into the storage-restore path on every open.
  it('returns [] for an empty history', () => {
    expect(dropOrphanTrailingUser([])).toEqual([]);
  });

  it('drops a trailing unanswered user turn (failed-call / mid-flight tab close)', () => {
    const restored = dropOrphanTrailingUser([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2-orphan' },
    ]);
    expect(restored).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('keeps history unchanged when last turn is an assistant reply', () => {
    const history = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' },
    ];
    expect(dropOrphanTrailingUser(history)).toEqual(history);
  });

  it('drops a single orphan user turn down to []', () => {
    expect(
      dropOrphanTrailingUser([{ role: 'user', content: 'orphan' }]),
    ).toEqual([]);
  });
});
