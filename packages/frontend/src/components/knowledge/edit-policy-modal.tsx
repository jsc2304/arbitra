'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  EvidencePolicy,
  EvidencePolicyRule,
  EvidencePolicyRulesMap,
  EvidenceType,
  RiskLevel,
  ValidationTrack,
} from '@arbitra/shared';
import { classifyPolicyCell, isPolicyCellAuthored } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { getEvidenceLabel, getEvidenceDescription } from '@/lib/evidence-labels';
import { useProjectMap } from '@/hooks/use-projects';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { RISK_PILL_COLORS } from '@/lib/risk-colors';
import {
  buildDefaultRulesMap,
  detectProfile,
  PROFILES,
  PROFILE_IDS,
  type EvidencePolicyProfileId,
} from '@/lib/evidence-policy-profiles';
import { Button } from '@/components/ui/button';

const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
const tracks = ['direct', 'manual'] as const;

const ALL_EVIDENCE_TYPES: EvidenceType[] = [
  'ci_result',
  'unit_test_result',
  'integration_test_result',
  'lint_result',
  'runtime_log',
  'screenshot',
  'diff_snapshot',
  'manual_confirmation',
  'benchmark_result',
  'external_reference',
];

const FOUR_EYES_TOOLTIP =
  'At least two distinct reviewers must approve. Off = single approval is enough.';
const SELF_APPROVAL_TOOLTIP =
  'The case owner can approve their own work. Off (default) requires approval from someone else.';

/**
 * Build the per-evidence-type tooltip string. Pattern:
 *   "<plain-English description> Required = case can't progress past
 *    review without it. Optional = welcome but not blocking."
 *
 * Falls back to a generic phrasing if the evidence type isn't in the
 * canonical metadata.
 */
function evidenceTooltip(type: EvidenceType): string {
  const base =
    getEvidenceDescription(type)
    || `${getEvidenceLabel(type)}.`;
  return (
    `${base.endsWith('.') ? base : `${base}.`} `
    + 'Required = case can’t progress past review without it. '
    + 'Optional = welcome but not blocking.'
  );
}

function emptyRule(): EvidencePolicyRule {
  return {
    required_evidence_types: [],
    optional_evidence_types: [],
    four_eyes_required: false,
    allow_self_approval: false,
  };
}

/**
 * Deep-copy a rules map WITHOUT materializing cells the source doesn't have.
 *
 * This is the fix for the no-op-save bug: the previous version substituted
 * `emptyRule()` for every (risk × track) cell a partially-populated policy
 * lacked, so opening the editor and pressing Save with no edits persisted
 * eight fully-populated cells — six of them empty — onto a policy that had
 * only defined two. An absent cell must stay absent through a copy, or
 * "inherits defaults" silently becomes "requires nothing" the moment someone
 * opens the editor (see completeness-evaluator.ts / classifyPolicyCell for
 * why an empty cell is dangerous). A risk key is only added to the result
 * when it has at least one populated track, mirroring the storage shape
 * exactly (e.g. ep_clerk_8a7f43d3de8c06468226c0a8 has only `low.direct` and
 * `medium.direct`; the other six cells, and the `high`/`critical` risk keys
 * themselves, are absent, not empty).
 */
export function deepCopyRules(rules: EvidencePolicyRulesMap): EvidencePolicyRulesMap {
  const copy: EvidencePolicyRulesMap = {};
  for (const risk of riskLevels) {
    const riskRules = rules[risk];
    if (!riskRules) continue;
    const trackCopy: Partial<Record<ValidationTrack, EvidencePolicyRule>> = {};
    for (const track of tracks) {
      const src = riskRules[track];
      // Absent AND legacy-empty cells are both skipped, because the resolver
      // treats them identically — `classifyPolicyCell` buckets an empty cell
      // with no `requires_no_evidence` flag as `inherits_defaults`. Copying
      // such a cell through would round-trip a shape the write boundary now
      // rejects, so a user editing one cell of a policy written before that
      // flag existed would lose the save over cells they never touched.
      if (!src || !isPolicyCellAuthored(src)) continue;
      trackCopy[track] = {
        required_evidence_types: [...src.required_evidence_types],
        optional_evidence_types: [...src.optional_evidence_types],
        four_eyes_required: src.four_eyes_required,
        allow_self_approval: src.allow_self_approval ?? false,
        requires_no_evidence: src.requires_no_evidence,
      };
    }
    if (Object.keys(trackCopy).length > 0) {
      copy[risk] = trackCopy;
    }
  }
  return copy;
}

interface EditPolicyModalProps {
  policy: EvidencePolicy;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function EditPolicyModal({ policy, open, onClose, onSaved }: EditPolicyModalProps) {
  const [editedRules, setEditedRules] = useState(() => deepCopyRules(policy.rules));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultRulesMap = useMemo(() => buildDefaultRulesMap(), []);
  const [selectedProfile, setSelectedProfile] = useState<EvidencePolicyProfileId>(
    () => detectProfile(policy.rules, defaultRulesMap),
  );
  const projectMap = useProjectMap();
  const projectLabel = projectMap[policy.project_id]
    ? `${projectMap[policy.project_id]} (${policy.project_id})`
    : policy.project_id;

  // When the modal opens (or the underlying policy changes) re-seed the
  // picker from the live policy. Cell edits handle their own picker
  // recomputation in the toggle helpers.
  useEffect(() => {
    if (open) {
      setSelectedProfile(detectProfile(policy.rules, defaultRulesMap));
    }
  }, [open, policy.rules, defaultRulesMap]);

  // Re-sync when policy changes and modal opens
  // We use a key-based approach: parent remounts or we track policy_id
  function resetState() {
    setEditedRules(deepCopyRules(policy.rules));
    setSelectedProfile(detectProfile(policy.rules, defaultRulesMap));
    setError(null);
    setSaving(false);
  }

  useEscapeKey(handleCancel, open);

  if (!open) return null;

  function getRule(risk: RiskLevel, track: ValidationTrack): EvidencePolicyRule {
    return editedRules[risk]?.[track] ?? emptyRule();
  }

  function updateRule(
    risk: RiskLevel,
    track: ValidationTrack,
    updater: (rule: EvidencePolicyRule) => EvidencePolicyRule,
  ) {
    setEditedRules((prev) => {
      const next: EvidencePolicyRulesMap = { ...prev };
      next[risk] = { ...next[risk] };
      next[risk]![track] = updater({ ...(next[risk]![track] ?? emptyRule()) });
      // Live-recompute the picker label so edits that drift away from a
      // preset switch the dropdown to "Custom" without the user re-opening
      // the modal.
      setSelectedProfile(detectProfile(next, defaultRulesMap));
      return next;
    });
  }

  function applyProfile(profileId: EvidencePolicyProfileId) {
    if (profileId === 'custom') {
      // Selecting "Custom" is a no-op — it's a sentinel state, not a preset.
      setSelectedProfile('custom');
      return;
    }
    const profile = PROFILES[profileId];
    const apply = () => {
      // Deep-clone so further edits don't mutate the static profile shape.
      // Profiles are fully materialized (every cell populated), so this is
      // the one path where the copy legitimately ends up with all 8 cells.
      const next = deepCopyRules(profile.rules);
      setEditedRules(next);
      setSelectedProfile(profileId);
    };
    // Confirm if there's anything to lose — i.e. the user has already
    // diverged from a preset.
    const currentDetected = detectProfile(editedRules, defaultRulesMap);
    if (currentDetected === 'custom') {
      const confirmed = typeof window !== 'undefined'
        ? window.confirm('Switching profile will replace all current cell values. Continue?')
        : true;
      if (!confirmed) return;
    }
    apply();
  }

  function toggleRequired(risk: RiskLevel, track: ValidationTrack, evidenceType: EvidenceType) {
    updateRule(risk, track, (rule) => {
      const isRequired = rule.required_evidence_types.includes(evidenceType);
      if (isRequired) {
        // Remove from required
        return {
          ...rule,
          required_evidence_types: rule.required_evidence_types.filter((t) => t !== evidenceType),
        };
      } else {
        // Add to required, remove from optional. Adding a required type
        // contradicts an explicit "requires nothing" (rejected server-side
        // if left set) — resolve it here instead of failing on Save.
        return {
          ...rule,
          required_evidence_types: [...rule.required_evidence_types, evidenceType],
          optional_evidence_types: rule.optional_evidence_types.filter((t) => t !== evidenceType),
          requires_no_evidence: false,
        };
      }
    });
  }

  function toggleOptional(risk: RiskLevel, track: ValidationTrack, evidenceType: EvidenceType) {
    updateRule(risk, track, (rule) => {
      const isOptional = rule.optional_evidence_types.includes(evidenceType);
      if (isOptional) {
        // Remove from optional
        return {
          ...rule,
          optional_evidence_types: rule.optional_evidence_types.filter((t) => t !== evidenceType),
        };
      } else {
        // Add to optional, remove from required
        return {
          ...rule,
          optional_evidence_types: [...rule.optional_evidence_types, evidenceType],
          required_evidence_types: rule.required_evidence_types.filter((t) => t !== evidenceType),
        };
      }
    });
  }

  function toggleFourEyes(risk: RiskLevel, track: ValidationTrack) {
    updateRule(risk, track, (rule) => ({
      ...rule,
      four_eyes_required: !rule.four_eyes_required,
    }));
  }

  /**
   * Toggle the explicit "requires no evidence" intent for a cell. The two
   * are mutually exclusive with a non-empty required list (see
   * evidence-validators.ts's contradiction check), so turning it on clears
   * `required_evidence_types`. Turning it off just clears the flag — the
   * cell is then an empty custom draft until the user adds a required type,
   * or the write boundary will reject the save.
   */
  function toggleRequiresNoEvidence(risk: RiskLevel, track: ValidationTrack) {
    updateRule(risk, track, (rule) => {
      if (rule.requires_no_evidence) {
        return { ...rule, requires_no_evidence: false };
      }
      return { ...rule, requires_no_evidence: true, required_evidence_types: [] };
    });
  }

  function toggleAllowSelfApproval(risk: RiskLevel, track: ValidationTrack) {
    updateRule(risk, track, (rule) => ({
      ...rule,
      allow_self_approval: !rule.allow_self_approval,
    }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.evidencePolicies.update(policy.policy_id, { rules: editedRules });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  }

  async function handleResetToDefaults() {
    const confirmed = typeof window !== 'undefined'
      ? window.confirm('Reset all cells in this policy to system defaults? Custom overrides will be lost.')
      : true;
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await api.evidencePolicies.delete(policy.policy_id);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset policy');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    resetState();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={handleCancel} />

      {/* Modal */}
      <div className="relative w-full max-w-4xl mx-4 bg-surface-raised rounded-lg shadow-xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-border-subtle flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Edit Evidence Policy
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Project: {projectLabel}
              {policy.repository_id ? ` / ${policy.repository_id}` : ''} — v{policy.version}
            </p>
          </div>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {error && (
            <div className="mb-4 rounded-md bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Starting profile picker — auto-detects the active profile and
              lets the user swap to a different preset. Picking "Custom" is
              a no-op; cell edits flip the picker to "Custom" automatically. */}
          <div className="mb-5 rounded-lg border border-gray-200 dark:border-border-subtle bg-surface-base/40 dark:bg-surface-base/30 p-3">
            <label
              htmlFor="evidence-policy-profile"
              className="block text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-1.5"
            >
              Starting profile
            </label>
            <select
              id="evidence-policy-profile"
              value={selectedProfile}
              onChange={(e) => applyProfile(e.target.value as EvidencePolicyProfileId)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
            >
              {PROFILE_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROFILES[id].display_name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              {PROFILES[selectedProfile].one_liner}
            </p>
          </div>

          {tracks.map((track) => (
            <div key={track} className="mb-6 last:mb-0">
              <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3 px-1">
                {track} track
              </h4>

              <div className="space-y-3">
                {riskLevels.map((risk) => {
                  const rule = getRule(risk, track);
                  // Three distinguishable states — see classifyPolicyCell's
                  // doc-comment (packages/shared) for what each one means and
                  // how a legacy empty-no-flag cell is read.
                  const cellState = classifyPolicyCell(editedRules[risk]?.[track]);
                  return (
                    <div
                      key={`${track}-${risk}`}
                      className="border border-gray-200 dark:border-border-subtle rounded-lg p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${RISK_PILL_COLORS[risk].pill}`}
                          >
                            {risk}
                          </span>
                          {cellState === 'inherits_defaults' && (
                            <span
                              className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                              title="No custom rule for this cell yet — the built-in default evidence requirements apply until you edit it."
                            >
                              Inherits defaults
                            </span>
                          )}
                          {cellState === 'requires_nothing' && (
                            <span
                              className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-teal-100 dark:bg-teal-950/50 text-teal-700 dark:text-teal-400"
                              title="Explicitly configured to require no evidence — the case can pass this gate with none."
                            >
                              Requires no evidence
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <label
                            className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer"
                            title="This cell deliberately requires no evidence at all — the gate passes with none. Independent of four-eyes / self-approval."
                            aria-describedby={`requires-none-tip-${risk}-${track}`}
                          >
                            <input
                              type="checkbox"
                              checked={cellState === 'requires_nothing'}
                              onChange={() => toggleRequiresNoEvidence(risk, track)}
                              className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
                            />
                            Requires no evidence
                            <span id={`requires-none-tip-${risk}-${track}`} className="sr-only">
                              This cell deliberately requires no evidence at all — the gate passes with none.
                            </span>
                          </label>
                          <label
                            className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer"
                            title={FOUR_EYES_TOOLTIP}
                            aria-describedby={`four-eyes-tip-${risk}-${track}`}
                          >
                            <input
                              type="checkbox"
                              checked={rule.four_eyes_required}
                              onChange={() => toggleFourEyes(risk, track)}
                              className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
                            />
                            Four-eyes required
                            <span id={`four-eyes-tip-${risk}-${track}`} className="sr-only">
                              {FOUR_EYES_TOOLTIP}
                            </span>
                          </label>
                          <label
                            className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer"
                            title={SELF_APPROVAL_TOOLTIP}
                            aria-describedby={`self-approval-tip-${risk}-${track}`}
                          >
                            <input
                              type="checkbox"
                              checked={rule.allow_self_approval}
                              onChange={() => toggleAllowSelfApproval(risk, track)}
                              className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
                            />
                            Allow self-approval
                            <span id={`self-approval-tip-${risk}-${track}`} className="sr-only">
                              {SELF_APPROVAL_TOOLTIP}
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Required column */}
                        <div>
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400 block mb-1.5">
                            Required
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {ALL_EVIDENCE_TYPES.map((et) => {
                              const isRequired = rule.required_evidence_types.includes(et);
                              return (
                                <button
                                  key={et}
                                  type="button"
                                  onClick={() => toggleRequired(risk, track, et)}
                                  title={evidenceTooltip(et)}
                                  aria-label={`${getEvidenceLabel(et)} — ${evidenceTooltip(et)}`}
                                  className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium border transition-colors ${
                                    isRequired
                                      ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400 border-red-300 dark:border-red-700'
                                      : 'bg-surface-base dark:bg-surface-base text-gray-400 dark:text-gray-500 border-gray-200 dark:border-border-subtle hover:border-red-300 dark:hover:border-red-700 hover:text-red-600 dark:hover:text-red-400'
                                  }`}
                                >
                                  {getEvidenceLabel(et)}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Optional column */}
                        <div>
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 block mb-1.5">
                            Optional
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {ALL_EVIDENCE_TYPES.map((et) => {
                              const isOptional = rule.optional_evidence_types.includes(et);
                              return (
                                <button
                                  key={et}
                                  type="button"
                                  onClick={() => toggleOptional(risk, track, et)}
                                  title={evidenceTooltip(et)}
                                  aria-label={`${getEvidenceLabel(et)} — ${evidenceTooltip(et)}`}
                                  className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium border transition-colors ${
                                    isOptional
                                      ? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600'
                                      : 'bg-surface-base dark:bg-surface-base text-gray-400 dark:text-gray-500 border-gray-200 dark:border-border-subtle hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-600 dark:hover:text-gray-400'
                                  }`}
                                >
                                  {getEvidenceLabel(et)}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-border-subtle flex justify-between items-center gap-3 flex-shrink-0">
          {/* Reset uses the secondary look but with a muted gray label + the
              `xs`-style horizontal padding (`px-3`) of the original. */}
          <Button
            variant="secondary"
            data-testid="reset-to-defaults-button"
            className="px-3 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            onClick={handleResetToDefaults}
            disabled={saving}
            title="Delete all custom cells; the policy falls back to system defaults."
          >
            Reset to system defaults
          </Button>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving} loading={saving}>
              {saving ? 'Saving...' : 'Save Policy'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
