import { timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

/**
 * Verifies a Cloud Scheduler OIDC token attached to an inbound request.
 *
 * The check enforces three things:
 *
 * 1. The ID token signature/expiry/issuer pass Google's verification
 *    (delegated to `OAuth2Client.verifyIdToken`).
 * 2. The audience claim equals one of the configured expected audiences —
 *    for our setup that's the full Cloud Run URL of the receiving endpoint
 *    (e.g. `.../api/intelligence/run` or `.../api/blueprints/tick`).
 * 3. The token's `email` claim matches one of the configured SA emails and
 *    `email_verified` is `true`. Cloud Scheduler mints OIDC tokens for the
 *    SAs we configured; nothing else should ever present a valid token with
 *    those emails.
 *
 * Multi-SA / multi-audience configuration:
 *
 *   `SCHEDULER_SA_EMAILS`        — comma-separated allow-list of SA emails
 *   `SCHEDULER_OIDC_AUDIENCES`   — comma-separated allow-list of audiences
 *
 * Backward-compatible singular forms (still honored):
 *
 *   `SCHEDULER_SA_EMAIL`
 *   `SCHEDULER_OIDC_AUDIENCE`
 *
 * Resolution rule: the effective allow-lists are the union of the singular
 * value (if present) and the comma-split plural value (if present). Both may
 * be set during the rollout; values are de-duplicated. If neither form is
 * configured for either var, the verifier returns `oidc_not_configured` so
 * the route can map that to a 500 (server misconfiguration).
 *
 * Verification matches by audience first, then by SA email. Both must hit
 * the configured allow-lists for the call to succeed.
 *
 * Shared-secret alternative: when `ARBITRA_CRON_SECRET` is set, a request
 * carrying `Authorization: Bearer <that secret>` is accepted without OIDC, so
 * any scheduler (cron, a CI schedule, a hosted cron service) can call the
 * job endpoints. Either mechanism may be configured, or both.
 *
 * The `reason` field is for log lines only — never put it in an HTTP response,
 * since it can leak whether OIDC is enabled and which SAs we expect.
 */
export interface OidcVerificationResult {
  ok: boolean;
  reason?: string;
}

const oauthClient = new OAuth2Client();

/**
 * Build a de-duplicated allow-list from a singular env var and a
 * comma-separated plural env var. Empty/whitespace entries are dropped.
 */
function resolveAllowList(singular: string | undefined, plural: string | undefined): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };
  push(singular);
  if (plural) {
    for (const part of plural.split(',')) push(part);
  }
  return out;
}

function matchesCronSecret(request: Request): boolean {
  const secret = process.env['ARBITRA_CRON_SECRET']?.trim();
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const presented = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifySchedulerOidc(
  request: Request,
  client: OAuth2Client = oauthClient,
): Promise<OidcVerificationResult> {
  if (matchesCronSecret(request)) return { ok: true };

  const expectedSas = resolveAllowList(
    process.env['SCHEDULER_SA_EMAIL'],
    process.env['SCHEDULER_SA_EMAILS'],
  );
  const expectedAuds = resolveAllowList(
    process.env['SCHEDULER_OIDC_AUDIENCE'],
    process.env['SCHEDULER_OIDC_AUDIENCES'],
  );
  if (expectedSas.length === 0 || expectedAuds.length === 0) {
    // With a cron secret configured, a wrong or missing secret is a caller
    // error (401), not a server misconfiguration (500).
    return {
      ok: false,
      reason: process.env['ARBITRA_CRON_SECRET']?.trim() ? 'cron_secret_mismatch' : 'oidc_not_configured',
    };
  }

  const authHeader = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!authHeader) {
    return { ok: false, reason: 'no_authorization_header' };
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return { ok: false, reason: 'malformed_bearer' };
  }
  const token = (match[1] ?? '').trim();
  if (!token) {
    return { ok: false, reason: 'empty_bearer_token' };
  }

  // `verifyIdToken`'s `audience` parameter accepts a string or string[] and
  // enforces an exact match against any allowed audience. Pass the full list
  // so a single OIDC token signed for any of our endpoints validates.
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: token, audience: expectedAuds });
    payload = ticket.getPayload();
  } catch (_err) {
    return { ok: false, reason: 'token_verification_failed' };
  }

  if (!payload) {
    return { ok: false, reason: 'token_payload_missing' };
  }
  if (!payload.aud || !expectedAuds.includes(payload.aud)) {
    return { ok: false, reason: 'audience_mismatch' };
  }
  if (!payload.email || !expectedSas.includes(payload.email)) {
    return { ok: false, reason: 'sa_email_mismatch' };
  }
  if (payload.email_verified !== true) {
    return { ok: false, reason: 'email_not_verified' };
  }

  return { ok: true };
}
