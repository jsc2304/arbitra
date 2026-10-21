import type { EvidencePolicyRule, EvidencePolicyRulesMap } from '../types/evidence.js';

/**
 * The three states a (risk × track) policy cell can be in now that "requires
 * nothing" is an explicit, authorable decision (see
 * `EvidencePolicyRule.requires_no_evidence`):
 *
 * - `inherits_defaults` — no authored decision for this cell; the resolver
 *   (`completeness-evaluator.ts::getEffectivePolicy`) falls through to the
 *   built-in default rule for this risk/track.
 * - `requires_nothing`  — an authored, explicit "no evidence needed" cell.
 * - `custom`            — an authored cell with its own required/optional
 *   evidence types.
 *
 * Used by both the resolver (to decide whether a stored cell counts as an
 * authored decision) and the UI (`policy-editor.tsx`, `edit-policy-modal.tsx`)
 * so the two never disagree about what a given cell means.
 */
export type EvidencePolicyCellState = 'inherits_defaults' | 'requires_nothing' | 'custom';

/**
 * Classify a policy cell.
 *
 * LEGACY READ DECISION: a cell with an empty `required_evidence_types` and no
 * `requires_no_evidence` flag classifies as `inherits_defaults`, not
 * `requires_nothing`. Before this field existed, an empty array was the ONLY
 * shape an empty cell could take, and it was indistinguishable from an
 * unfinished edit — every real instance (the policy
 * editor's `deepCopyRules` substituting an empty rule for every cell a
 * partially-populated policy lacked, then persisting the whole grid on any
 * save) was exactly that: an accidental blank, not a deliberate policy
 * choice. Reading that ambiguous legacy shape as "inherits defaults"
 * reproduces the behavior the project actually had before any customization
 * — at worst a case now needs evidence it always should have needed — rather
 * than reproducing the security hole this change closes, where an empty cell
 * silently satisfied the gate. New writes cannot land in this ambiguous state
 * (the write boundary in `evidence-validators.ts` requires the explicit flag
 * for an empty required list), so only pre-existing documents can reach this
 * branch.
 */
export function classifyPolicyCell(
  rule: EvidencePolicyRule | undefined,
): EvidencePolicyCellState {
  if (!rule) return 'inherits_defaults';
  if (rule.required_evidence_types.length === 0) {
    return rule.requires_no_evidence ? 'requires_nothing' : 'inherits_defaults';
  }
  return 'custom';
}

/**
 * Whether a cell represents an authored decision the resolver should return
 * as-is, as opposed to falling through to the built-in default rule. Mirrors
 * `classifyPolicyCell`'s `inherits_defaults` bucket.
 */
export function isPolicyCellAuthored(rule: EvidencePolicyRule | undefined): boolean {
  return classifyPolicyCell(rule) !== 'inherits_defaults';
}

/**
 * Merge an incoming (possibly partial) rules map into the currently stored
 * one. A cell is atomic — the caller either supplies a whole cell (replacing
 * it) or omits it (leaving the stored one untouched) — but risk/track KEYS
 * the caller doesn't mention must survive the merge.
 *
 * Without this, `DocumentReference.update()` treats a top-level field like
 * `rules` as a full replacement: `{ rules: { low: {...} } }` would silently
 * delete `medium`/`high`/`critical` if the caller only meant to touch `low`.
 */
export function mergeEvidencePolicyRules(
  current: EvidencePolicyRulesMap,
  incoming: EvidencePolicyRulesMap,
): EvidencePolicyRulesMap {
  const merged: EvidencePolicyRulesMap = { ...current };
  for (const risk of Object.keys(incoming) as (keyof EvidencePolicyRulesMap)[]) {
    const incomingTrackRules = incoming[risk];
    if (!incomingTrackRules) continue;
    merged[risk] = {
      ...current[risk],
      ...incomingTrackRules,
    };
  }
  return merged;
}
