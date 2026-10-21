import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleChatNotifier, RETRY_BACKOFF_MS, type ChatMessage } from './google-chat-notifier.js';

describe('GoogleChatNotifier.formatMessage', () => {
  const notifier = new GoogleChatNotifier();

  it('renders a fully enriched message with project, case id, status and link', () => {
    const msg: ChatMessage = {
      title: 'Decision Required',
      body: "Case 'Do the thing' needs a decision.",
      caseId: 'case-abc-123',
      caseTitle: 'Do the thing',
      link: 'https://arbitra.example.com/cases/case-abc-123',
      projectName: 'Arbitra Core',
      status: 'Needs Decision',
    };

    const text = notifier.formatMessage(msg);

    expect(text).toContain('*Decision Required*');
    expect(text).toContain('Arbitra Core');
    expect(text).toContain('case-abc-123');
    expect(text).toContain('Needs Decision');
    expect(text).toContain('https://arbitra.example.com/cases/case-abc-123');
    expect(text).toContain("Case 'Do the thing'");
    // Meta line precedes body.
    expect(text.indexOf('📁 Arbitra Core')).toBeLessThan(text.indexOf("Case 'Do the thing'"));
    // No fallback note when link is present.
    expect(text).not.toContain('Case link unavailable');
  });

  it('renders the fallback note when link is absent and omits the link line', () => {
    const msg: ChatMessage = {
      title: 'Decision Required',
      body: "Case 'Do the thing' needs a decision.",
      caseId: 'case-abc-123',
      projectName: 'Arbitra Core',
      status: 'Needs Decision',
    };

    const text = notifier.formatMessage(msg);

    expect(text).not.toMatch(/🔗/);
    expect(text).toContain(
      '(Case link unavailable — ARBITRA_URL not configured on the notification service)',
    );
  });

  it('omits the meta line entirely when no optional fields are populated (legacy/custom-template shape)', () => {
    const msg: ChatMessage = {
      title: 'Decision Required',
      body: 'Custom template body.',
      link: 'https://arbitra.example.com/cases/case-xyz',
    };

    const text = notifier.formatMessage(msg);

    // No emoji meta segments at all.
    expect(text).not.toMatch(/📁|🆔|📍/);
    // Link still renders via the emoji line.
    expect(text).toContain('🔗 https://arbitra.example.com/cases/case-xyz');
    expect(text).toContain('Custom template body.');
  });

  it('builds the meta line from whichever subset of fields are present', () => {
    const msg: ChatMessage = {
      title: 'Notice',
      body: 'Body',
      caseId: 'case-1',
      status: 'Building',
      link: 'https://x/y',
    };

    const text = notifier.formatMessage(msg);

    expect(text).toContain('🆔 case-1 · 📍 Building');
    expect(text).not.toContain('📁');
  });

  it('title and body still come through even when all optional fields are missing (legacy shape + link fallback)', () => {
    const msg: ChatMessage = {
      title: 'Hello',
      body: 'World',
    };

    const text = notifier.formatMessage(msg);

    expect(text.startsWith('*Hello*\n')).toBe(true);
    expect(text).toContain('World');
    expect(text).toContain('(Case link unavailable');
  });
});

/**
 * `GoogleChatNotifier.send` — first send-path suite (spec Slice C item 4,
 * `docs/specs/clerk-config-scheduling-chat.md`). Pre-fix, `send` was a single
 * un-retried fetch returning a bare boolean, with zero test coverage on the
 * send path itself (only `formatMessage` above was tested) — a dropped retry
 * branch or a retry-on-a-permanent-4xx regression would have shipped
 * unnoticed.
 */
describe('GoogleChatNotifier.send — retry policy', () => {
  const WEBHOOK = 'https://chat.googleapis.com/v1/spaces/x/messages?key=y';
  const MESSAGE: ChatMessage = { title: 'Hi', body: 'Body' };

  let fetchMock: ReturnType<typeof vi.fn>;
  let sleepMock: ReturnType<typeof vi.fn>;

  function jsonResponse(status: number, ok: boolean, text = ''): Response {
    return {
      ok,
      status,
      text: () => Promise.resolve(text),
    } as unknown as Response;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    sleepMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('succeeds on the first attempt with no retry and no backoff wait', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, true));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: true, status: 200, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('retries exactly once on 429 and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, false, 'rate limited'))
      .mockResolvedValueOnce(jsonResponse(200, true));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries exactly once on a 5xx and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, false, 'unavailable'))
      .mockResolvedValueOnce(jsonResponse(200, true));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries exactly once on a network-level throw and succeeds on the second attempt', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, true));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits the fixed backoff via the injectable sleep before retrying (reverting the await would make this resolve without ever calling sleep)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, false))
      .mockResolvedValueOnce(jsonResponse(200, true));
    const notifier = new GoogleChatNotifier(sleepMock);

    await notifier.send(WEBHOOK, MESSAGE);

    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(RETRY_BACKOFF_MS);
  });

  it('does NOT retry on 400 — a bad request does not heal by waiting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, false, 'bad request'));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: false, status: 400, error: 'bad request', attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('does NOT retry on 403 — a bad webhook URL does not heal by waiting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, false, 'forbidden'));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: false, status: 403, error: 'forbidden', attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a structured failure after the retry is also exhausted (attempts: 2)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, false, 'first failure'))
      .mockResolvedValueOnce(jsonResponse(502, false, 'second failure'));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: false, status: 502, error: 'second failure', attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a structured failure when the retry also throws (network error on both attempts)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed again'));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send(WEBHOOK, MESSAGE);

    expect(result).toEqual({ ok: false, error: 'fetch failed again', attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-Google-Chat webhook URL before any fetch attempt (attempts: 0)', async () => {
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.send('https://evil.example.com/hook', MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendTest delegates through send and surfaces the same structured result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, false, 'down')).mockResolvedValueOnce(jsonResponse(500, false, 'still down'));
    const notifier = new GoogleChatNotifier(sleepMock);

    const result = await notifier.sendTest(WEBHOOK);

    expect(result).toEqual({ ok: false, status: 500, error: 'still down', attempts: 2 });
  });
});
