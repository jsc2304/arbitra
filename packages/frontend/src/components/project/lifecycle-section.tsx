'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Project, LifecyclePresetId, GateId, GateBehavior, GateConfig } from '@arbitra/shared';
import { LIFECYCLE_PRESETS, GATE_TRANSITION_MAP, resolveGateBehavior } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';

const GATE_LABELS: Record<GateId, string> = {
  exploration_to_ready:      'Exploration \u2192 Ready',
  ready_to_build:            'Ready \u2192 Build',
  build_to_validation:       'Build \u2192 Validation',
  validation_to_review:      'Validation \u2192 Review',
  review_to_approved:        'Review \u2192 Approved',
  review_to_needs_human:     'Review \u2192 Human Decision',
  review_to_verification:    'Review \u2192 Verification',
  approved_to_pending_merge: 'Approved \u2192 Pending Merge',
  pending_merge_to_done:     'Pending Merge \u2192 Done',
};

const PRESET_INFO: Record<LifecyclePresetId, { label: string; description: string }> = {
  autonomous: {
    label: 'Autonomous',
    description: 'Maximum automation. Build starts automatically. Humans only intervene for critical findings.',
  },
  standard: {
    label: 'Standard',
    description: 'Balanced workflow. Build requires confirmation. Review flows automatically.',
  },
  strict: {
    label: 'Strict',
    description: 'Full oversight. Human confirmation required at every phase boundary.',
  },
};

const PIPELINE_GATE_IDS: GateId[] = [
  'exploration_to_ready',
  'ready_to_build',
  'build_to_validation',
  'validation_to_review',
  'review_to_approved',
  'review_to_needs_human',
  'review_to_verification',
  'approved_to_pending_merge',
  'pending_merge_to_done',
];

const PIPELINE_STAGES = [
  { status: 'open',            label: 'Open' },
  { status: 'exploration',     label: 'Exploring' },
  { status: 'ready_for_build', label: 'Ready' },
  { status: 'in_build',        label: 'Building' },
  { status: 'in_validation',   label: 'Validating' },
  { status: 'in_review',       label: 'Review' },
  { status: 'approved',        label: 'Approved' },
  { status: 'pending_merge',   label: 'Merge' },
  { status: 'done',            label: 'Done' },
];

const GATES_BY_SOURCE: Record<string, GateId[]> = {};
for (const gateId of PIPELINE_GATE_IDS) {
  const mapping = GATE_TRANSITION_MAP[gateId];
  if (!GATES_BY_SOURCE[mapping.from]) GATES_BY_SOURCE[mapping.from] = [];
  GATES_BY_SOURCE[mapping.from]!.push(gateId);
}

function PipelineDiagram({ resolvedGates }: { resolvedGates: Record<GateId, GateBehavior> }) {
  const mainTrack = PIPELINE_STAGES;

  return (
    <div className="rounded-lg border border-gray-100 dark:border-border-subtle bg-surface-base dark:bg-surface-base/50 px-4 py-3">
      <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
        Pipeline Preview
      </p>
      <div className="overflow-x-auto scrollbar-none">
        <div className="flex items-center min-w-max gap-0">
          {mainTrack.map((stage, i) => {
            const isLast = i === mainTrack.length - 1;
            const gatesFromHere = GATES_BY_SOURCE[stage.status] ?? [];
            const nextStage = mainTrack[i + 1];
            const mainGate = nextStage
              ? gatesFromHere.find((g) => GATE_TRANSITION_MAP[g].to === nextStage.status)
              : undefined;
            const mainGateBehavior = mainGate ? resolvedGates[mainGate] : undefined;
            const branchGates = gatesFromHere.filter((g) => g !== mainGate);

            return (
              <div key={stage.status} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div className="w-3 h-3 rounded-full bg-gray-400 dark:bg-gray-500 border-2 border-gray-50 dark:border-border-subtle" />
                  <span className="text-[9px] text-gray-500 dark:text-gray-400 mt-1 whitespace-nowrap">
                    {stage.label}
                  </span>
                  {branchGates.length > 0 && (
                    <div className="flex gap-1 mt-0.5">
                      {branchGates.map((bg) => {
                        const beh = resolvedGates[bg];
                        return (
                          <span
                            key={bg}
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                              beh === 'auto' ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                            title={`${GATE_LABELS[bg]}: ${beh}`}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
                {!isLast && (
                  <div className="flex items-center mx-0.5" style={{ marginTop: branchGates.length > 0 ? '-12px' : '0' }}>
                    <div
                      className={`w-6 h-[3px] rounded-full ${
                        mainGateBehavior === 'confirm'
                          ? 'bg-amber-400 dark:bg-amber-500'
                          : 'bg-emerald-400 dark:bg-emerald-500'
                      }`}
                      title={mainGate ? `${GATE_LABELS[mainGate]}: ${mainGateBehavior}` : undefined}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[9px] text-gray-400 dark:text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Auto
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
          Confirm
        </span>
      </div>
    </div>
  );
}

export function LifecycleSection({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const currentPreset: LifecyclePresetId = project.lifecycle_profile?.preset ?? 'standard';
  const currentOverrides: GateConfig = useMemo(
    () => project.lifecycle_profile?.overrides ?? {},
    [project.lifecycle_profile?.overrides],
  );
  const [saving, setSaving] = useState<LifecyclePresetId | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [localOverrides, setLocalOverrides] = useState<GateConfig>(currentOverrides);
  const [savingOverrides, setSavingOverrides] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    setLocalOverrides(project.lifecycle_profile?.overrides ?? {});
  }, [project.lifecycle_profile?.overrides]);

  const resolvedGates = useMemo(() => {
    const result: Record<string, GateBehavior> = {};
    const profile = { preset: currentPreset, overrides: localOverrides };
    for (const gateId of PIPELINE_GATE_IDS) {
      result[gateId] = resolveGateBehavior(gateId, profile);
    }
    return result as Record<GateId, GateBehavior>;
  }, [currentPreset, localOverrides]);

  const hasOverrides = useMemo(() => {
    return Object.keys(localOverrides).length > 0;
  }, [localOverrides]);

  const overridesDirty = useMemo(() => {
    const savedKeys = Object.keys(currentOverrides);
    const localKeys = Object.keys(localOverrides);
    if (savedKeys.length !== localKeys.length) return true;
    for (const key of localKeys) {
      if (currentOverrides[key as GateId] !== localOverrides[key as GateId]) return true;
    }
    return false;
  }, [currentOverrides, localOverrides]);

  async function handleSelect(preset: LifecyclePresetId) {
    if (preset === currentPreset && !hasOverrides) return;
    setSaving(preset);
    try {
      await api.projects.update(project.project_id, {
        lifecycle_profile: { preset },
      });
      setLocalOverrides({});
      addToast('success', `Lifecycle profile set to ${PRESET_INFO[preset].label}`);
      onUpdate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to update lifecycle profile');
    } finally {
      setSaving(null);
    }
  }

  function handleToggleGate(gateId: GateId) {
    const presetBehavior = LIFECYCLE_PRESETS[currentPreset][gateId] ?? 'auto';
    const currentBehavior = localOverrides[gateId] ?? presetBehavior;
    const newBehavior: GateBehavior = currentBehavior === 'auto' ? 'confirm' : 'auto';

    setLocalOverrides((prev) => {
      const next = { ...prev };
      if (newBehavior === presetBehavior) {
        delete next[gateId];
      } else {
        next[gateId] = newBehavior;
      }
      return next;
    });
  }

  async function handleSaveOverrides() {
    setSavingOverrides(true);
    try {
      await api.projects.update(project.project_id, {
        lifecycle_profile: {
          preset: currentPreset,
          overrides: Object.keys(localOverrides).length > 0 ? localOverrides : undefined,
        },
      });
      addToast('success', 'Gate overrides saved');
      onUpdate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to save gate overrides');
    } finally {
      setSavingOverrides(false);
    }
  }

  function handleResetOverrides() {
    setLocalOverrides({});
  }

  const presetIds: LifecyclePresetId[] = ['autonomous', 'standard', 'strict'];

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Lifecycle Profile
        </h4>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 capitalize">
          {currentPreset}{hasOverrides ? ' (customized)' : ''}
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Controls how much automation vs. human confirmation is required at each phase transition.
          </p>

          <PipelineDiagram resolvedGates={resolvedGates} />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {presetIds.map((presetId) => {
              const info = PRESET_INFO[presetId];
              const gates = LIFECYCLE_PRESETS[presetId];
              const isActive = presetId === currentPreset;
              const isSaving = saving === presetId;
              const confirmCount = Object.values(gates).filter((v) => v === 'confirm').length;

              return (
                <button
                  key={presetId}
                  type="button"
                  onClick={() => handleSelect(presetId)}
                  disabled={saving !== null}
                  className={`text-left rounded-lg border-2 p-4 transition-all ${
                    isActive
                      ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-500/20'
                      : 'border-gray-200 dark:border-border-subtle hover:border-gray-300 dark:hover:border-gray-600'
                  } ${saving !== null && !isSaving ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {info.label}
                    </span>
                    {isActive && (
                      <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50 px-1.5 py-0.5 rounded">
                        Active
                      </span>
                    )}
                    {isSaving && (
                      <span className="text-[10px] text-gray-400">Saving...</span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">
                    {info.description}
                  </p>

                  <div className="space-y-1">
                    {(Object.keys(gates) as GateId[]).map((gateId) => {
                      const behavior = gates[gateId]!;
                      return (
                        <div key={gateId} className="flex items-center gap-1.5">
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              behavior === 'auto'
                                ? 'bg-emerald-500'
                                : 'bg-amber-500'
                            }`}
                          />
                          <span className="text-[10px] text-gray-500 dark:text-gray-400">
                            {GATE_LABELS[gateId]}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-2 pt-2 border-t border-gray-100 dark:border-border-subtle">
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
                      {confirmCount === 0
                        ? 'All gates automatic'
                        : `${confirmCount} gate${confirmCount > 1 ? 's' : ''} require confirmation`}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 text-[10px] text-gray-400 dark:text-gray-500">
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Automatic
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
              Requires confirmation
            </span>
          </div>

          <div className="border-t border-gray-100 dark:border-border-subtle pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex items-center gap-2 w-full text-left group"
            >
              <svg
                className={`h-3.5 w-3.5 text-gray-400 transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
              </svg>
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100 transition-colors">
                Advanced: Per-Gate Overrides
              </span>
              {hasOverrides && (
                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded">
                  {Object.keys(localOverrides).length} override{Object.keys(localOverrides).length !== 1 ? 's' : ''}
                </span>
              )}
            </button>

            {advancedOpen && (
              <div className="mt-3 space-y-3">
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Override individual gates without changing the preset. Overrides take precedence over the selected preset defaults.
                </p>

                <div className="space-y-1">
                  {PIPELINE_GATE_IDS.map((gateId) => {
                    const resolved = resolvedGates[gateId];
                    const isOverridden = gateId in localOverrides;
                    const mapping = GATE_TRANSITION_MAP[gateId];

                    return (
                      <div
                        key={gateId}
                        className={`flex items-center justify-between rounded-md px-3 py-2 transition-colors ${
                          isOverridden
                            ? 'bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800'
                            : 'hover:bg-surface-base dark:hover:bg-border-subtle/50'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                              {GATE_LABELS[gateId]}
                            </span>
                            {isOverridden && (
                              <span className="text-[9px] font-medium text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40 px-1 py-0.5 rounded">
                                Override
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
                            {mapping.from} → {mapping.to}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleToggleGate(gateId)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                            resolved === 'auto'
                              ? 'bg-emerald-500'
                              : 'bg-amber-500'
                          }`}
                          title={`Currently: ${resolved}. Click to toggle.`}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                              resolved === 'auto' ? 'translate-x-1' : 'translate-x-[18px]'
                            }`}
                          />
                          <span className="absolute inset-0 flex items-center justify-center">
                            <span className={`text-[8px] font-bold text-white ${resolved === 'auto' ? 'ml-3.5' : 'mr-3.5'}`}>
                              {resolved === 'auto' ? 'A' : 'C'}
                            </span>
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveOverrides}
                    disabled={savingOverrides || !overridesDirty}
                    className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
                  >
                    {savingOverrides ? 'Saving...' : 'Save Overrides'}
                  </button>
                  {hasOverrides && (
                    <button
                      type="button"
                      onClick={handleResetOverrides}
                      className="rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-surface-base dark:hover:bg-gray-700 transition-colors"
                    >
                      Reset to Preset Defaults
                    </button>
                  )}
                  {!overridesDirty && Object.keys(localOverrides).length > 0 && (
                    <span className="text-[11px] text-gray-400 dark:text-gray-500">No unsaved changes</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
