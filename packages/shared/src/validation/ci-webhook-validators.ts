import { z } from 'zod';

/**
 * Destined for `POST /api/webhooks/ci` (`webhooks/ci/route.ts`), replacing
 * the hand-rolled `parseCIWebhook` (`ci-adapter.ts`). Mirrors
 * `CIWebhookPayload` (`webhook-service.ts:118-125`): `build_id` required
 * non-empty (mirrors `if (!buildId || !status) return null`); `branch`/
 * `pr_ref`/`report_url`/`case_id` optional strings, unchanged.
 *
 * DISAGREEMENT WITH TODAY'S PARSER (flag for the wiring PR, most
 * consequential item in this file): `parseCIWebhook` today COERCES any
 * `status` value other than the exact literal `'success'` into `'failure'`
 * (`status === 'success' ? 'success' : 'failure'`) — e.g. a CI system
 * posting `status: 'pending'` or a typo'd value is silently treated as a
 * failed build, never rejected. This schema instead REJECTS any `status`
 * that isn't exactly `'success'` or `'failure'` with a 400. This is the
 * intended fix, but it is a genuine behavior
 * change for any external CI integration currently sending a different
 * status string and relying on the silent-failure fallback — the wiring
 * PR must account for this when wiring the route (or when documenting the
 * `CI_WEBHOOK_SECRET` migration for existing integrations).
 */
export const ciWebhookSchema = z.object({
  build_id: z.string().min(1),
  status: z.enum(['success', 'failure']),
  branch: z.string().optional(),
  pr_ref: z.string().optional(),
  report_url: z.string().optional(),
  case_id: z.string().optional(),
});

export type CIWebhookPayload = z.infer<typeof ciWebhookSchema>;
