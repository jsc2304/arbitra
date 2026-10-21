/**
 * GoogleChatNotifier — Sends formatted messages to a Google Chat space via webhook.
 *
 * Google Chat webhooks accept POST requests with a JSON body containing
 * either a simple `{ "text": "..." }` or a Card v2 payload. We use simple
 * text with basic markdown formatting (bold, links) which Google Chat supports.
 */

export interface ChatMessage {
  title: string;
  body: string;
  caseId?: string;
  caseTitle?: string;
  link?: string;
  /** Human-readable project display name (falls back to bare project_id). */
  projectName?: string;
  /** Human-readable case status, e.g. "Needs Decision". */
  status?: string;
}

/**
 * Structured outcome of one `send()` call (spec Slice C item 4,
 * `docs/specs/clerk-config-scheduling-chat.md`). Replaces the previous bare
 * `boolean` return so callers (`NotificationDispatcher`, the test-webhook
 * route) can persist a delivery record with an actual error code/message
 * instead of just "it failed".
 */
export interface SendResult {
  /** True only when the (last) attempt received a 2xx response. */
  ok: boolean;
  /** HTTP status of the last attempt, when one was made (absent for a rejected webhook URL or a network-level throw). */
  status?: number;
  /** Human-readable failure detail — response body text or the thrown error's message. Absent on success. */
  error?: string;
  /** Number of HTTP attempts actually made (0 when the URL was rejected before any fetch, otherwise 1 or 2). */
  attempts: number;
}

/**
 * Fixed backoff between the first attempt and its single retry (spec Slice C
 * item 4: "one retry ... after a short backoff"). Deliberately a constant,
 * not exponential — this slice retries exactly once, so there is no second
 * backoff step to grow. Exported so tests can assert the exact delay without
 * a magic number, and so the *notifier's own* injectable `sleep` (which
 * substitutes a no-op in tests) is documented as the intended fast-forward
 * seam rather than sprinkling fake timers everywhere.
 */
export const RETRY_BACKOFF_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP statuses worth retrying: rate-limited (429) or server-side (5xx). A 4xx other than 429 means the request itself is bad — retrying it can't help. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class GoogleChatNotifier {
  /**
   * @param sleep Injectable backoff wait, defaulting to a real `setTimeout`.
   *   Tests pass a synchronous stub so the retry-backoff suite runs instantly
   *   while still asserting the delay value it was asked to wait.
   */
  constructor(private readonly sleep: (ms: number) => Promise<void> = defaultSleep) {}

  /**
   * Send a message to a Google Chat space via its webhook URL.
   *
   * Retries exactly once on a 429, a 5xx, or a network-level throw, after
   * waiting `RETRY_BACKOFF_MS`. Any other 4xx does not retry — a bad webhook
   * URL or a malformed payload does not heal by waiting.
   */
  async send(webhookUrl: string, message: ChatMessage): Promise<SendResult> {
    if (!webhookUrl.startsWith('https://chat.googleapis.com/')) {
      console.warn('[GoogleChatNotifier] Rejected non-Google Chat webhook URL');
      return { ok: false, error: 'Rejected non-Google Chat webhook URL', attempts: 0 };
    }

    const text = this.formatMessage(message);
    const body = JSON.stringify({ text });

    return this.attemptSend(webhookUrl, body, 1);
  }

  private async attemptSend(webhookUrl: string, body: string, attempt: number): Promise<SendResult> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body,
      });

      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt };
      }

      const responseText = await response.text().catch(() => '(no body)');
      console.warn(`[GoogleChatNotifier] Webhook returned ${response.status}: ${responseText}`);

      if (attempt === 1 && isRetryableStatus(response.status)) {
        await this.sleep(RETRY_BACKOFF_MS);
        return this.attemptSend(webhookUrl, body, attempt + 1);
      }

      return { ok: false, status: response.status, error: responseText, attempts: attempt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[GoogleChatNotifier] Failed to send webhook:', err);

      if (attempt === 1) {
        await this.sleep(RETRY_BACKOFF_MS);
        return this.attemptSend(webhookUrl, body, attempt + 1);
      }

      return { ok: false, error: message, attempts: attempt };
    }
  }

  /**
   * Send a test message to verify a webhook URL works.
   */
  async sendTest(webhookUrl: string): Promise<SendResult> {
    return this.send(webhookUrl, {
      title: 'Arbitra Test Notification',
      body: 'This is a test message from Arbitra. If you see this, your Google Chat webhook is configured correctly.',
    });
  }

  /**
   * Format a structured plain-text message for Google Chat.
   *
   * Shape:
   *   *<title>*
   *   📁 <projectName> · 🆔 <caseId> · 📍 <status>   (only fields that exist)
   *   🔗 <link>                                      (omitted if link unavailable)
   *
   *   <body>
   *
   *   (Case link unavailable — ARBITRA_URL not configured on the notification service)
   *                                                  (only when link is undefined)
   *
   * The meta line and link line are both skipped if no relevant fields are set,
   * so custom-template callers (which don't populate the extra fields) still
   * get the original `*title*\nbody\nView in Arbitra: <link>` shape.
   */
  formatMessage(message: ChatMessage): string {
    const parts: string[] = [];

    parts.push(`*${message.title}*`);

    const metaSegments: string[] = [];
    if (message.projectName) metaSegments.push(`📁 ${message.projectName}`);
    if (message.caseId) metaSegments.push(`🆔 ${message.caseId}`);
    if (message.status) metaSegments.push(`📍 ${message.status}`);
    if (metaSegments.length > 0) {
      parts.push(metaSegments.join(' · '));
    }

    if (message.link) {
      parts.push(`🔗 ${message.link}`);
    }

    parts.push('');
    parts.push(message.body);

    if (!message.link) {
      parts.push('');
      parts.push(
        '(Case link unavailable — ARBITRA_URL not configured on the notification service)',
      );
    }

    return parts.join('\n');
  }
}
