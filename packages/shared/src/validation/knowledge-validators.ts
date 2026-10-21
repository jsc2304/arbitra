import { z } from 'zod';

/**
 * Mirrors `VALID_KNOWLEDGE_TYPES` (hand-rolled in both `knowledge/route.ts`
 * and `knowledge/[knowledgeId]/route.ts`). `KnowledgeType` itself widens via
 * `(string & {})` in `types/knowledge.ts`, but both routes already enforce
 * this closed 8-value set at runtime today — mirroring actual behavior, not
 * tightening beyond it.
 */
const knowledgeTypeSchema = z.enum([
  'precedent', 'pattern', 'anti_pattern', 'mock_template',
  'implementation_note', 'review_guideline', 'architecture_decision', 'exception_policy',
]);

const knowledgeScopeTypeSchema = z.enum(['global', 'org', 'team', 'project', 'repo']);

const knowledgeStatusSchema = z.enum(['suggested', 'verified', 'canonical', 'deprecated', 'superseded']);

/**
 * Destined for `POST /api/knowledge` (`knowledge/route.ts:38-159`). Mirrors
 * the hand-rolled checks at `:43-129` field for field. `title`, `summary`,
 * and `body` all use `.trim().min(n)` so a whitespace-padded value can't
 * satisfy the length floor the same way `title.trim() === ''` rejects a
 * whitespace-only title — issue #749 item 3: `summary`/`body` used to check
 * `z.string().min(n)` on the raw value, so N spaces (padding under the 10/50
 * floor with real content, or just whitespace on its own) could pass here
 * even though the pre-Zod route measured `trim().length`. Fixed by trimming
 * before the length check, matching `title`.
 * `scope_ref` stays an unconstrained string (no `.min(1)`): the route only
 * checks `typeof scope_ref === 'string'`, never non-emptiness. `tags` is
 * mildly tightened to `string[]` (route only checks `Array.isArray`, never
 * validates element type) — low-risk, matches the immediate `as string[]`
 * cast in the route. `source_case_refs`/`source_decision_refs` are also
 * tightened: today a non-array value is silently dropped to `undefined`
 * (no rejection); this schema rejects it with a 400 instead — flagged for
 * route wiring to confirm that's acceptable (recommended: a malformed
 * refs list is a caller bug worth surfacing, not silently swallowing).
 */
export const createKnowledgeSchema = z.object({
  title: z.string().trim().min(1),
  type: knowledgeTypeSchema,
  summary: z.string().trim().min(10),
  body: z.string().trim().min(50),
  scope_type: knowledgeScopeTypeSchema,
  scope_ref: z.string(),
  tags: z.array(z.string()).optional(),
  expires_at: z.string().optional(),
  source_case_refs: z.array(z.string()).optional(),
  source_decision_refs: z.array(z.string()).optional(),
});

/**
 * Destined for `PATCH /api/knowledge/:knowledgeId` (`knowledge/[knowledgeId]/route.ts`).
 * `.strict()` mirrors the route's explicit `ALLOWED_PATCH_KEYS` /
 * `FORBIDDEN_PATCH_KEYS` checks — those two sets are exactly this schema's
 * key set plus everything else on `KnowledgeAsset`, so a Zod strict-mode
 * rejection reproduces the route's "unknown/forbidden field" 400 exactly.
 * Field-level constraints mirror `createKnowledgeSchema` (see its doc for
 * the same trim/scope_ref/tags caveats), all made optional. `title` also
 * uses `.trim().min(1)` here: the PATCH route trims and rejects
 * whitespace-only titles the same way the POST route does
 * (`received.title.trim() === ''`). `summary`/`body` trim the same way as
 * `createKnowledgeSchema` (issue #749 item 3).
 */
export const updateKnowledgeSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(10).optional(),
    body: z.string().trim().min(50).optional(),
    type: knowledgeTypeSchema.optional(),
    scope_type: knowledgeScopeTypeSchema.optional(),
    scope_ref: z.string().optional(),
    tags: z.array(z.string()).optional(),
    expires_at: z.string().optional(),
  })
  .strict();

/** Destined for `PATCH /api/knowledge/:knowledgeId/status` (`status/route.ts`). */
export const updateKnowledgeStatusSchema = z.object({
  status: knowledgeStatusSchema,
});

export type CreateKnowledgePayload = z.infer<typeof createKnowledgeSchema>;
export type UpdateKnowledgePayload = z.infer<typeof updateKnowledgeSchema>;
export type UpdateKnowledgeStatusPayload = z.infer<typeof updateKnowledgeStatusSchema>;
