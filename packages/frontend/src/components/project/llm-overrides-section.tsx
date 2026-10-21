'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LlmProviderName, Project, RiskLevel } from '@arbitra/shared';
import { LLM_PROVIDERS, isPreviewModel, modelsForProvider } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';
import { TestRowIndicator } from '../settings/ai-models-panel';
import { Input } from '../ui/input';
import { PreviewBadge } from '../ui/preview-badge';

const ENABLED_PROVIDERS = LLM_PROVIDERS.filter((p) => p.enabled);

const RISK_LEVELS: { key: RiskLevel; label: string }[] = [
  { key: 'low', label: 'Low Risk' },
  { key: 'medium', label: 'Medium Risk' },
  { key: 'high', label: 'High Risk' },
  { key: 'critical', label: 'Critical Risk' },
];

export function LlmOverridesSection({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const hasOverrides = !!project.llm_overrides;
  const [enabled, setEnabled] = useState(hasOverrides);
  const initialProvider = project.llm_overrides?.provider ?? (ENABLED_PROVIDERS[0]?.id ?? '');
  const [provider, setProvider] = useState<string>(initialProvider);
  const [models, setModels] = useState<Record<RiskLevel, string>>({
    low: project.llm_overrides?.models?.low ?? '',
    medium: project.llm_overrides?.models?.medium ?? '',
    high: project.llm_overrides?.models?.high ?? '',
    critical: project.llm_overrides?.models?.critical ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Partial<Record<RiskLevel, { ok: boolean; latency_ms: number; error?: string; model: string; skipped?: boolean; reason?: string }>> | null>(null);
  const [testSnapshot, setTestSnapshot] = useState<string | null>(null);
  const { addToast } = useToast();

  const currentSnapshot = JSON.stringify({ enabled, provider, models });
  const resultsStale = testSnapshot !== null && testSnapshot !== currentSnapshot;
  const effectiveResults = resultsStale ? null : testResults;

  // Sync state when project changes
  useEffect(() => {
    const has = !!project.llm_overrides;
    setEnabled(has);
    setProvider(project.llm_overrides?.provider ?? (ENABLED_PROVIDERS[0]?.id ?? ''));
    setModels({
      low: project.llm_overrides?.models?.low ?? '',
      medium: project.llm_overrides?.models?.medium ?? '',
      high: project.llm_overrides?.models?.high ?? '',
      critical: project.llm_overrides?.models?.critical ?? '',
    });
  }, [project.llm_overrides]);

  // Options per risk row: catalog entries for the selected provider +
  // any legacy saved value not in the catalog (preserved so saved state
  // never silently disappears).
  const providerModels = useMemo(() => modelsForProvider(provider), [provider]);

  function optionsForRow(level: RiskLevel): Array<{ id: string; label: string }> {
    const base: Array<{ id: string; label: string }> = providerModels.map((m) => ({
      id: m.id,
      label: `${m.label}${m.preview ? ' [Preview]' : ''}${m.notes ? ` — ${m.notes}` : ''}`,
    }));
    const current = models[level];
    if (current && !base.some((o) => o.id === current)) {
      base.push({ id: current, label: `${current} (legacy)` });
    }
    return base;
  }

  function handleProviderChange(next: string) {
    setProvider(next);
    // Default each risk level to the catalog model recommended for it,
    // falling back to the provider's first catalog entry.
    const nextModels = modelsForProvider(next);
    const first = nextModels[0]?.id ?? '';
    const forLevel = (level: RiskLevel) =>
      nextModels.find((m) => m.recommended_for?.includes(level))?.id ?? first;
    setModels({
      low: forLevel('low'),
      medium: forLevel('medium'),
      high: forLevel('high'),
      critical: forLevel('critical'),
    });
  }

  // Check if current state differs from saved project
  const isDirty = useMemo(() => {
    if (enabled !== hasOverrides) return true;
    if (!enabled) return false;
    if ((provider || undefined) !== (project.llm_overrides?.provider ?? undefined)) return true;
    for (const level of RISK_LEVELS) {
      if ((models[level.key] || undefined) !== (project.llm_overrides?.models?.[level.key] ?? undefined)) return true;
    }
    return false;
  }, [enabled, hasOverrides, provider, models, project.llm_overrides]);

  async function handleTest() {
    setTesting(true);
    try {
      // Build only populated model entries — unset rows should not be pinged.
      const populated: Partial<Record<RiskLevel, string>> = {};
      for (const level of RISK_LEVELS) {
        const v = models[level.key]?.trim();
        if (v) populated[level.key] = v;
      }
      if (Object.keys(populated).length === 0) {
        addToast('error', 'No models configured to test');
        setTesting(false);
        return;
      }
      const resp = await api.llm.test({
        provider: (provider || 'google') as LlmProviderName,
        models: populated,
        project_id: project.project_id,
      });
      setTestResults(resp.results);
      setTestSnapshot(JSON.stringify({ enabled, provider, models }));
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Test failed');
      setTestResults(null);
      setTestSnapshot(null);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      if (!enabled) {
        // Clear overrides
        await api.projects.update(project.project_id, { llm_overrides: null });
        addToast('success', 'AI model overrides cleared');
      } else {
        // Build overrides, only including set fields
        const overrides: Record<string, unknown> = {};
        if (provider) overrides.provider = provider;
        const modelOverrides: Record<string, string> = {};
        for (const level of RISK_LEVELS) {
          if (models[level.key].trim()) {
            modelOverrides[level.key] = models[level.key].trim();
          }
        }
        if (Object.keys(modelOverrides).length > 0) overrides.models = modelOverrides;
        await api.projects.update(project.project_id, { llm_overrides: Object.keys(overrides).length > 0 ? overrides as Project['llm_overrides'] : {} });
        addToast('success', 'AI model overrides saved');
      }
      onUpdate();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to save AI model overrides');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg p-5">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
        AI Model Overrides
      </h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Override global AI model settings for this project. Unset fields inherit from global configuration.
      </p>

      <label className="flex items-center gap-2 cursor-pointer mb-4">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">Override global AI model settings</span>
      </label>

      {enabled && (
        <div className="space-y-4">
          {/* Provider */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
            <Input
              as="select"
              size="sm"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              {ENABLED_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              {/* Preserve a legacy provider value (e.g. 'openrouter') so it survives a save cycle. */}
              {provider && !ENABLED_PROVIDERS.some((p) => p.id === provider) && (
                <option value={provider}>{provider} (legacy)</option>
              )}
            </Input>
          </div>

          {/* Models per risk level */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Models per Risk Level</label>
            <div className="space-y-2">
              {RISK_LEVELS.map((level) => {
                const options = optionsForRow(level.key);
                const result = effectiveResults?.[level.key];
                return (
                  <div key={level.key} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 dark:text-gray-400 w-20 flex-shrink-0">{level.label}</span>
                    <div className="flex-1 flex flex-col gap-1">
                      <Input
                        as="select"
                        size="sm"
                        value={models[level.key]}
                        onChange={(e) => setModels((prev) => ({ ...prev, [level.key]: e.target.value }))}
                      >
                        <option value="">Inherited from global</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </Input>
                      {isPreviewModel(models[level.key]) && <PreviewBadge />}
                      {result && <TestRowIndicator result={result} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {enabled && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="rounded-md border border-gray-300 dark:border-border-default bg-transparent px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-surface-base dark:hover:bg-surface-base disabled:opacity-50 transition-colors"
          >
            {testing ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" aria-hidden />
                Testing…
              </span>
            ) : (
              'Test'
            )}
          </button>
        )}
        {!isDirty && enabled && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500">No unsaved changes</span>
        )}
      </div>

      <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
        Project overrides take highest priority, then global admin settings, then environment variables, then defaults.
      </p>
    </div>
  );
}
