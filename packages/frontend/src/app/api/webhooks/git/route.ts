import { NextRequest, NextResponse } from 'next/server';
import { WebhookService, verifyGitHubSignature, parseGitHubWebhook, FirestorePipelineAdapter } from '@arbitra/backend';
import { handleError } from '@/lib/api-helpers';

const webhookService = new WebhookService(
  undefined,
  undefined,
  undefined,
  undefined,
  new FirestorePipelineAdapter(),
);

/**
 * Size cap for attacker-controlled rawBody when the HMAC signature failed or
 * hasn't been verified yet. GitHub PR/push payloads are typically < 20 KB;
 * 64 KB leaves headroom for large changesets without letting a spammer
 * amplify rejection writes to Firestore.
 */
const MAX_REJECTION_PARSE_BYTES = 64 * 1024;

/**
 * Per-field cap for every string extracted from an untrusted body and
 * forwarded into `workspace_events`. 512 chars is enough to identify the
 * repo / branch / PR URL while bounding write amplification.
 */
const MAX_REJECTION_FIELD_CHARS = 512;

function capString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > MAX_REJECTION_FIELD_CHARS
    ? value.slice(0, MAX_REJECTION_FIELD_CHARS)
    : value;
}

/**
 * Best-effort observability write for webhook rejections. Stored into
 * workspace_events (or a matching case's event stream) so an IDE agent
 * calling `get_case_context` can see why a webhook didn't land instead
 * of guessing. Failures here are swallowed — the original 4xx still goes
 * back to GitHub.
 *
 * Hardening:
 *   - If `rawBody` is larger than `MAX_REJECTION_PARSE_BYTES`, skip the JSON
 *     parse entirely and record only the size + `oversized: true` flag. This
 *     prevents a spammer with a bad signature from amplifying a huge body
 *     into a huge Firestore write.
 *   - Every string field extracted from the body is truncated to
 *     `MAX_REJECTION_FIELD_CHARS` before being forwarded.
 */
async function logReject(
  reason: string,
  ctx: { event?: string | null; rawBody?: string },
): Promise<void> {
  const bodyLen = ctx.rawBody?.length ?? 0;
  // Cap the event string too — header is attacker-controlled on the bad-sig path.
  const cappedEvent = capString(ctx.event ?? undefined);

  if (bodyLen > MAX_REJECTION_PARSE_BYTES) {
    // Oversized — don't parse, don't extract any fields. Just record the size
    // so an operator can see that a big bad-signature body was seen.
    await webhookService.logWebhookRejection({
      reason: `${reason} (oversized body, skipped parse)`,
      ...(cappedEvent ? { event: cappedEvent } : {}),
    });
    return;
  }

  let repository: string | undefined;
  let repository_id: number | undefined;
  let branch: string | undefined;
  let pr_url: string | undefined;
  let action: string | undefined;

  // Best-effort body parse — the signature may have failed, so treat body
  // as untrusted. Only use it to enrich the rejection record. Every string
  // field is capped at MAX_REJECTION_FIELD_CHARS before forwarding.
  if (ctx.rawBody) {
    try {
      const parsed = JSON.parse(ctx.rawBody) as Record<string, unknown>;
      const repo = parsed['repository'] as Record<string, unknown> | undefined;
      repository = capString(repo?.['full_name']);
      const rid = repo?.['id'];
      repository_id = typeof rid === 'number' ? rid : undefined;
      action = capString(parsed['action']);
      const pr = parsed['pull_request'] as Record<string, unknown> | undefined;
      pr_url = capString(pr?.['html_url']);
      const head = pr?.['head'] as Record<string, unknown> | undefined;
      branch = capString(head?.['ref']);
      if (!branch) {
        const ref = parsed['ref'];
        if (typeof ref === 'string') {
          branch = capString(ref.replace('refs/heads/', ''));
        }
      }
    } catch {
      // untrusted body — ignore
    }
  }

  await webhookService.logWebhookRejection({
    reason,
    ...(cappedEvent ? { event: cappedEvent } : {}),
    ...(action ? { action } : {}),
    ...(repository ? { repository } : {}),
    ...(repository_id !== undefined ? { repository_id } : {}),
    ...(branch ? { branch } : {}),
    ...(pr_url ? { pr_url } : {}),
  });
}

export async function POST(request: NextRequest) {
  const event = request.headers.get('x-github-event');
  let rawBody = '';
  try {
    const signature = request.headers.get('x-hub-signature-256');
    rawBody = await request.text();

    if (!event) {
      await logReject('Missing X-GitHub-Event header (likely not a GitHub webhook)', { rawBody });
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing X-GitHub-Event header' } },
        { status: 401 },
      );
    }

    if (!signature) {
      await logReject('Missing X-Hub-Signature-256 — add a secret to the webhook in GitHub settings', { event, rawBody });
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing X-Hub-Signature-256 header — configure a secret on the GitHub webhook' } },
        { status: 401 },
      );
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      await logReject('Webhook secret not configured on server', { event, rawBody });
      return NextResponse.json(
        { error: { code: 'SERVER_ERROR', message: 'Webhook secret not configured' } },
        { status: 500 },
      );
    }

    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      await logReject('Invalid webhook signature (stale secret or wrong endpoint)', { event, rawBody });
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' } },
        { status: 401 },
      );
    }

    const body = JSON.parse(rawBody) as Record<string, unknown>;
    // Async since issue #987's review follow-up: `pull_request`
    // opened/synchronize events fetch real changed-file paths from the
    // GitHub API before returning (see `parseGitHubWebhook`'s doc-comment).
    const payload = await parseGitHubWebhook(event, body);

    if (!payload) {
      // Not a rejection — arbitra simply doesn't care about this event type
      // (e.g. `star`, `watch`). Don't pollute observability with these.
      return NextResponse.json({ status: 'ignored', event });
    }

    const result = await webhookService.handleGitWebhook(payload);
    return NextResponse.json({ status: 'processed', event, ...result });
  } catch (error) {
    await logReject(
      `Webhook handler threw: ${error instanceof Error ? error.message : String(error)}`,
      { event, rawBody },
    );
    return handleError(error);
  }
}
