import crypto from 'node:crypto';
import type { CIWebhookPayload } from './webhook-service.js';

/**
 * Verifies the `x-hub-signature-256` HMAC-SHA256 signature on a CI webhook
 * request body. Mirrors `verifyGitHubSignature` (`github-adapter.ts`) —
 * identical header convention and comparison algorithm — but checked against
 * `CI_WEBHOOK_SECRET`, a distinct secret from `GITHUB_WEBHOOK_SECRET` so a CI
 * system never needs the GitHub signing key.
 */
export function verifyCIWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  const digest = `sha256=${hmac.update(payload).digest('hex')}`;
  // timingSafeEqual throws on length mismatch; short-circuit so a malformed
  // signature header returns `false` instead of crashing the handler.
  const sigBuf = Buffer.from(signature);
  const digBuf = Buffer.from(digest);
  if (sigBuf.length !== digBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, digBuf);
}

/**
 * Parses a generic CI webhook payload.
 * In practice, each CI system (GitHub Actions, GitLab CI, etc.) would have its own adapter.
 *
 * Superseded by `ciWebhookSchema` (`@arbitra/shared`) for the `/api/webhooks/ci`
 * route — kept here only because it remains a public export of
 * `@arbitra/backend`; no other caller uses it.
 */
export function parseCIWebhook(body: Record<string, unknown>): CIWebhookPayload | null {
  // Generic adapter that expects a normalized payload
  const buildId = body['build_id'] as string | undefined;
  const status = body['status'] as string | undefined;

  if (!buildId || !status) return null;

  return {
    build_id: buildId,
    status: status === 'success' ? 'success' : 'failure',
    branch: body['branch'] as string | undefined,
    pr_ref: body['pr_ref'] as string | undefined,
    report_url: body['report_url'] as string | undefined,
    case_id: body['case_id'] as string | undefined,
  };
}
