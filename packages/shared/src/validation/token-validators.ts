import { z } from 'zod';

/**
 * Mirrors the route's own coercion for optional device/client metadata
 * fields (`tokens/route.ts:49-60`):
 * `typeof v === 'string' && v.trim() ? v.trim() : undefined`. Any
 * non-string, empty, or whitespace-only value is silently coerced to
 * `undefined` rather than rejected — the route never 400s on these, and
 * the arbitra-mcp unified-connect flow posts them, so a strict
 * `z.string().min(1)` here would break token creation for payloads the
 * route happily accepts today.
 */
const optionalTrimmedMetadataField = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}, z.string().optional());

/**
 * Destined for `POST /api/tokens` (`tokens/route.ts`). `name` mirrors the
 * route's `!body.name?.trim()` check exactly — `.trim().min(1)` rejects
 * whitespace-only values the same way the route's truthiness check on the
 * trimmed result does. `client_name`/`client_version`/`device_id`/
 * `device_label` use `optionalTrimmedMetadataField` (see its doc) —
 * coerced to `undefined`, never rejected. `created_via` is intentionally
 * kept as a permissive optional string, not narrowed to the two public
 * literals: strings pass through unchanged, while any non-string
 * value (including `null`) is coerced to `undefined`, matching the route's
 * prior hand-rolled `typeof` check. The route then silently clamps any
 * value other than the two public literals (including the reserved
 * `'unified_connect'`) to `'manual'` rather than rejecting it
 * (`tokens/route.ts:61-72`) — a strict enum or strict optional string here
 * would turn today's 201 (silently downgraded) into a 400 for the same
 * payload.
 * Flagged for the wiring PR: if tightening this is desired, it should be a
 * deliberate decision made there, not a side effect of adding this schema.
 */
export const createTokenSchema = z.object({
  name: z.string().trim().min(1),
  client_name: optionalTrimmedMetadataField,
  client_version: optionalTrimmedMetadataField,
  device_id: optionalTrimmedMetadataField,
  device_label: optionalTrimmedMetadataField,
  created_via: z.preprocess(
    (value) => typeof value === 'string' ? value : undefined,
    z.string().optional(),
  ),
});

export type CreateTokenPayload = z.infer<typeof createTokenSchema>;
