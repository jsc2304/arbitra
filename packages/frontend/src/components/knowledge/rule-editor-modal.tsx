'use client';

import { useState } from 'react';
import type { Rule, EvaluationMode, RuleCategory } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { useToast } from '@/providers/toast-provider';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { Button } from '@/components/ui/button';

interface RuleEditorModalProps {
  rule: Rule;
  onClose: () => void;
  onSaved: () => void;
}

const inputClasses =
  'w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-700 dark:text-gray-200 shadow-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const selectClasses =
  'w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-700 dark:text-gray-200 shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const labelClasses = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

const CATEGORIES: { value: RuleCategory; label: string }[] = [
  { value: 'architecture_rule', label: 'Architecture Rule' },
  { value: 'code_quality_rule', label: 'Code Quality' },
  { value: 'test_rule', label: 'Test Rule' },
  { value: 'integration_rule', label: 'Integration Rule' },
  { value: 'security_rule', label: 'Security Rule' },
  { value: 'project_convention', label: 'Project Convention' },
  { value: 'customer_constraint', label: 'Customer Constraint' },
  { value: 'release_gate', label: 'Release Gate' },
];

const EVALUATION_MODES: { value: EvaluationMode; label: string; description: string }[] = [
  { value: 'metadata_check', label: 'Metadata Check', description: 'Verify case metadata fields' },
  { value: 'diff_pattern', label: 'Diff Pattern', description: 'Flag code changes matching regex' },
  { value: 'evidence_check', label: 'Evidence Check', description: 'Require specific evidence types' },
  { value: 'llm_evaluation', label: 'LLM Evaluation', description: 'AI evaluates against custom criteria' },
  { value: 'human_confirmation', label: 'Human Confirmation', description: 'Require human confirmation' },
];

const SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const EVIDENCE_TYPES = [
  'unit_test_result', 'integration_test_result', 'ci_result', 'lint_result',
  'benchmark_result', 'manual_confirmation', 'screenshot', 'log_output',
  'code_review', 'security_scan',
];

function EvalModeConfig({
  mode,
  config,
  onChange,
}: {
  mode: EvaluationMode;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  switch (mode) {
    case 'metadata_check':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClasses}>Field Name</label>
            <input className={inputClasses} placeholder="e.g. risk_level" value={(config.field_name as string) ?? ''} onChange={(e) => onChange({ ...config, field_name: e.target.value })} />
          </div>
          <div>
            <label className={labelClasses}>Expected Value</label>
            <input className={inputClasses} placeholder="e.g. high" value={(config.expected_value as string) ?? ''} onChange={(e) => onChange({ ...config, expected_value: e.target.value })} />
          </div>
        </div>
      );
    case 'diff_pattern':
      return (
        <div className="space-y-3">
          <div>
            <label className={labelClasses}>Regex Pattern</label>
            <input className={inputClasses} placeholder="e.g. console\\.log|debugger" value={(config.pattern as string) ?? ''} onChange={(e) => onChange({ ...config, pattern: e.target.value })} />
          </div>
          <div>
            <label className={labelClasses}>Description</label>
            <input className={inputClasses} placeholder="e.g. Detects debug statements" value={(config.pattern_description as string) ?? ''} onChange={(e) => onChange({ ...config, pattern_description: e.target.value })} />
          </div>
        </div>
      );
    case 'evidence_check':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClasses}>Evidence Type</label>
            <select className={selectClasses} value={(config.evidence_type as string) ?? 'ci_result'} onChange={(e) => onChange({ ...config, evidence_type: e.target.value })}>
              {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClasses}>Required</label>
            <div className="flex items-center gap-2 pt-2">
              <button type="button" onClick={() => onChange({ ...config, required: !(config.required ?? true) })} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${(config.required ?? true) ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${(config.required ?? true) ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">{(config.required ?? true) ? 'Required' : 'Optional'}</span>
            </div>
          </div>
        </div>
      );
    case 'llm_evaluation':
      return (
        <div>
          <label className={labelClasses}>Evaluation Prompt</label>
          <textarea className={inputClasses} rows={4} placeholder="Describe what the AI should evaluate" value={(config.prompt as string) ?? ''} onChange={(e) => onChange({ ...config, prompt: e.target.value })} />
        </div>
      );
    case 'human_confirmation':
      return (
        <div>
          <label className={labelClasses}>Confirmation Description</label>
          <textarea className={inputClasses} rows={3} placeholder="Describe what needs confirming" value={(config.confirmation_description as string) ?? ''} onChange={(e) => onChange({ ...config, confirmation_description: e.target.value })} />
        </div>
      );
    default:
      return null;
  }
}

export function RuleEditorModal({ rule, onClose, onSaved }: RuleEditorModalProps) {
  const { addToast } = useToast();
  useEscapeKey(onClose);

  const [name, setName] = useState(rule.name);
  const [description, setDescription] = useState(rule.description);
  const [rationale, setRationale] = useState(rule.rationale);
  const [category, setCategory] = useState<RuleCategory>(rule.category);
  const [evaluationMode, setEvaluationMode] = useState<EvaluationMode>(rule.evaluation_mode);
  const [severity, setSeverity] = useState(rule.severity_if_failed);
  const [config, setConfig] = useState<Record<string, unknown>>(rule.config);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.rules.update(rule.rule_id, {
        name: name.trim(),
        description,
        rationale,
        category,
        evaluation_mode: evaluationMode,
        severity_if_failed: severity,
        config,
      });
      addToast('success', `Rule "${name.trim()}" saved.`);
      onSaved();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to update rule');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-raised rounded-xl shadow-xl border border-gray-200 dark:border-border-subtle w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-border-subtle">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Rule</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className={labelClasses}>Name <span className="text-red-500">*</span></label>
            <input className={inputClasses} value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClasses}>Category</label>
              <select className={selectClasses} value={category} onChange={(e) => setCategory(e.target.value as RuleCategory)}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClasses}>Severity if Failed</label>
              <select className={selectClasses} value={severity} onChange={(e) => setSeverity(e.target.value)}>
                {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClasses}>Evaluation Mode</label>
            <select className={selectClasses} value={evaluationMode} onChange={(e) => { setEvaluationMode(e.target.value as EvaluationMode); setConfig({}); }}>
              {EVALUATION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label} -- {m.description}</option>)}
            </select>
          </div>

          <div className="bg-surface-base dark:bg-surface-base/30 rounded-lg p-4">
            <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
              {EVALUATION_MODES.find((m) => m.value === evaluationMode)?.label} Configuration
            </h4>
            <EvalModeConfig mode={evaluationMode} config={config} onChange={setConfig} />
          </div>

          <div>
            <label className={labelClasses}>Description</label>
            <textarea className={inputClasses} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div>
            <label className={labelClasses}>Rationale</label>
            <textarea className={inputClasses} rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-border-subtle">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !name.trim()} loading={saving} onClick={handleSave}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
