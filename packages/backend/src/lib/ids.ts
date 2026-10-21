import { nanoid } from 'nanoid';
import { ADJECTIVES, NOUNS } from './words';

const PREFIXES = {
  run: 'run_',
  finding: 'fnd_',
  evidence: 'ev_',
  rule: 'rule_',
  ruleSet: 'rs_',
  ruleResult: 'rr_',
  knowledgeAsset: 'ka_',
  decision: 'dec_',
  comment: 'cmt_',
  artifact: 'art_',
  project: 'proj_',
  repository: 'repo_',
  user: 'usr_',
  token: 'tok_',
  event: 'evt_',
  notification: 'notif_',
  evidencePolicy: 'ep_',
  ruleOverride: 'ro_',
  caseTemplate: 'tmpl_',
  promptTemplate: 'pt_',
  workspaceEvent: 'wse_',
  intelligenceRun: 'irun_',
  helperBotLog: 'hbl_',
  taskBlueprint: 'bp_',
} as const;

type PrefixedEntityType = keyof typeof PREFIXES;
type EntityType = PrefixedEntityType | 'case';

function generateCaseId(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `case-${adj}-${noun}-${nanoid(4)}`;
}

export function generateId(entityType: EntityType): string {
  if (entityType === 'case') return generateCaseId();
  return `${PREFIXES[entityType]}${nanoid(16)}`;
}

/**
 * Deterministic `fnd_`-prefixed Finding id, derived from the finding's own
 * dedup `signature` (already a SHA-256 hex digest — see
 * `computeRuleConflictSignature` / `computeFindingSignature`). Two concurrent
 * writers that compute the same signature therefore derive the SAME
 * `finding_id` and race on a create-only write (`lib/finding-idempotency.ts`)
 * instead of each minting an unrelated random id and duplicating the finding
 * (issue #739). Sliced to 32 hex chars (128 bits) — same convention as
 * `assistantIntakeReceiptId` / `waiverCompletionDecisionId`.
 *
 * Keeps the `PREFIXES.finding` (`fnd_`) prefix so ids remain shape-compatible
 * with `generateId('finding')` for every consumer that treats `finding_id` as
 * an opaque string (routes, waivers, frontend keys) — only the suffix scheme
 * changed. Existing findings persisted with a random nanoid suffix are
 * unaffected and remain readable; only new/reactivated writes get this form.
 */
export function deriveFindingId(signature: string): string {
  return `${PREFIXES.finding}${signature.slice(0, 32)}`;
}
