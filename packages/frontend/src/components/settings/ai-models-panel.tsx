'use client';

import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { api } from '../../lib/api-client';
import type { LlmProviderName, RiskLevel } from '@arbitra/shared';
import { LLM_PROVIDERS, isPreviewModel, modelsForProvider } from '@arbitra/shared';
import Card from '../shared/card';
import SectionHeader from '../shared/section-header';
import { PreviewBadge } from '../ui/preview-badge';

const ENABLED_PROVIDERS = LLM_PROVIDERS.filter((p) => p.enabled);

const RISK_LEVELS: { key: RiskLevel; label: string; description: string }[] = [
  { key: 'low', label: 'Low Risk', description: 'Fast, cost-effective model for low-risk reviews' },
  { key: 'medium', label: 'Medium Risk', description: 'Balanced model for standard reviews' },
  { key: 'high', label: 'High Risk', description: 'Capable model for complex, high-risk reviews' },
  { key: 'critical', label: 'Critical Risk', description: 'Most capable model for critical reviews' },
];

export function AiModelsPanel() {
  const { data, mutate } = useSWR('settings-llm', () => api.settings.llm.get());

  const [provider, setProvider] = useState<string>(ENABLED_PROVIDERS[0]?.id ?? 'google');
  const [models, setModels] = useState<Record<RiskLevel, string>>({
    low: '',
    medium: '',
    high: '',
    critical: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Partial<Record<RiskLevel, { ok: boolean; latency_ms: number; error?: string; model: string; skipped?: boolean; reason?: string }>> | null>(null);
  const [testSnapshot, setTestSnapshot] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Clear stale test results when any input changes.
  const currentSnapshot = JSON.stringify({ provider, models });
  const resultsStale = testSnapshot !== null && testSnapshot !== currentSnapshot;
  const effectiveResults = resultsStale ? null : testResults;

  // Sync form state with fetched data
  useEffect(() => {
    if (data) {
      setProvider(data.settings.provider);
      setModels(data.settings.models);
      setDirty(false);
    }
  }, [data]);

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

  function handleProviderChange(newProvider: string) {
    setProvider(newProvider);
    // Default each risk level to the catalog model recommended for it,
    // falling back to the provider's first catalog entry.
    const nextModels = modelsForProvider(newProvider);
    const first = nextModels[0]?.id ?? '';
    const forLevel = (level: RiskLevel) =>
      nextModels.find((m) => m.recommended_for?.includes(level))?.id ?? first;
    setModels({
      low: forLevel('low'),
      medium: forLevel('medium'),
      high: forLevel('high'),
      critical: forLevel('critical'),
    });
    setDirty(true);
  }

  function handleModelChange(riskLevel: RiskLevel, value: string) {
    setModels((prev) => ({ ...prev, [riskLevel]: value }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    setSaveResult(null);
    try {
      await api.settings.llm.update(provider as LlmProviderName, models);
      await mutate();
      setDirty(false);
      setSaveResult({ type: 'success', message: 'LLM settings saved. Changes take effect within 5 minutes.' });
      setTimeout(() => setSaveResult(null), 5000);
    } catch (error) {
      setSaveResult({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to save settings',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    try {
      const resp = await api.llm.test({
        provider: provider as LlmProviderName,
        models,
      });
      setTestResults(resp.results);
      setTestSnapshot(JSON.stringify({ provider, models }));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Test failed');
      setTestResults(null);
      setTestSnapshot(null);
    } finally {
      setTesting(false);
    }
  }

  function handleReset() {
    if (data) {
      setProvider(data.settings.provider);
      setModels(data.settings.models);
      setDirty(false);
      setSaveResult(null);
    }
  }

  const source = data?.source;
  const providerIsLegacy = provider && !ENABLED_PROVIDERS.some((p) => p.id === provider);

  return (
    <div className="max-w-3xl">
      <section className="mb-8">
        <SectionHeader eyebrow title="AI Model Configuration" className="mb-1" />
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          Configure which LLM models are used for AI-powered reviews at each risk level.
          {source === 'firestore' && (
            <span className="ml-1 inline-flex items-center rounded-full bg-green-50 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
              Custom settings active
            </span>
          )}
          {source === 'env' && (
            <span className="ml-1 inline-flex items-center rounded-full bg-yellow-50 dark:bg-yellow-900/30 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:text-yellow-400">
              Using environment variables
            </span>
          )}
          {source === 'default' && (
            <span className="ml-1 inline-flex items-center rounded-full bg-surface-base dark:bg-surface-base px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">
              Using defaults
            </span>
          )}
        </p>

        <Card padding="none" className="divide-y divide-gray-100 dark:divide-gray-800">
          {/* Provider selection */}
          <div className="px-4 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Provider</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                The LLM provider used for all AI reviews.
              </p>
            </div>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-72 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200"
            >
              {ENABLED_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {/* Preserve a legacy provider value so it survives a save cycle. */}
              {providerIsLegacy && (
                <option value={provider}>{provider} (legacy)</option>
              )}
            </select>
          </div>

          {/* Model per risk level */}
          {RISK_LEVELS.map((level) => {
            const options = optionsForRow(level.key);
            const result = effectiveResults?.[level.key];
            return (
              <div key={level.key} className="px-4 py-4">
                <div className="flex items-center justify-between">
                  <div className="mr-4">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{level.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {level.description}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <select
                      value={models[level.key]}
                      onChange={(e) => handleModelChange(level.key, e.target.value)}
                      className="w-72 rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                    >
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {isPreviewModel(models[level.key]) && <PreviewBadge />}
                    {result && <TestRowIndicator result={result} />}
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      </section>

      {/* Save / Test / Reset */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            saving || !dirty
              ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed'
              : 'bg-accent-700 text-white hover:bg-accent-800 dark:bg-accent-700 dark:hover:bg-accent-800'
          }`}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors border ${
            testing
              ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-border-default cursor-not-allowed'
              : 'bg-transparent text-gray-700 dark:text-gray-200 border-gray-300 dark:border-border-default hover:bg-surface-base dark:hover:bg-surface-base'
          }`}
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
        {dirty && (
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            Reset
          </button>
        )}
        {testError && (
          <p className="text-sm text-red-600 dark:text-red-400" title={testError}>
            {testError.length > 60 ? testError.slice(0, 60) + '…' : testError}
          </p>
        )}
        {saveResult && (
          <p
            className={`text-sm ${
              saveResult.type === 'success'
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {saveResult.message}
          </p>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base/50 p-4">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <strong>Priority chain:</strong> Admin settings (this page) take highest priority, then environment variables, then built-in defaults.
          Changes are cached for up to 5 minutes on the server.
          Requires admin role to save.
        </p>
      </div>
    </div>
  );
}

export function TestRowIndicator({ result }: { result: { ok: boolean; latency_ms: number; error?: string; skipped?: boolean; reason?: string } }) {
  if (result.skipped) {
    return (
      <span className="text-xs text-gray-500 dark:text-gray-400" title={result.reason}>
        skipped ({result.reason ?? 'not enabled'})
      </span>
    );
  }
  if (result.ok) {
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        ✓ ({result.latency_ms}ms)
      </span>
    );
  }
  const err = result.error ?? 'failed';
  const truncated = err.length > 60 ? err.slice(0, 60) + '…' : err;
  return (
    <span className="text-xs text-red-600 dark:text-red-400" title={err}>
      ✗ {truncated}
    </span>
  );
}
