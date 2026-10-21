'use client';

import { useState } from 'react';
import type { EvaluationMode, RuleCategory } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { useToast } from '@/providers/toast-provider';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { Button } from '@/components/ui/button';

interface RuleSetWizardProps {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}

interface RuleDraft {
  id: string; // local temp ID
  name: string;
  description: string;
  rationale: string;
  category: RuleCategory;
  evaluation_mode: EvaluationMode;
  severity_if_failed: string;
  config: Record<string, unknown>;
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
  { value: 'metadata_check', label: 'Metadata Check', description: 'Verify that case metadata fields have expected values' },
  { value: 'diff_pattern', label: 'Diff Pattern', description: 'Flag code changes matching a regex pattern (e.g. console.log, TODO)' },
  { value: 'evidence_check', label: 'Evidence Check', description: 'Require specific evidence types before the case can proceed' },
  { value: 'llm_evaluation', label: 'LLM Evaluation', description: 'AI evaluates the case against your custom criteria' },
  { value: 'human_confirmation', label: 'Human Confirmation', description: 'Require explicit human confirmation for a specific check' },
];

const SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const EVIDENCE_TYPES = [
  'unit_test_result',
  'integration_test_result',
  'ci_result',
  'lint_result',
  'benchmark_result',
  'manual_confirmation',
  'screenshot',
  'log_output',
  'code_review',
  'security_scan',
];

function newRuleDraft(): RuleDraft {
  return {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    description: '',
    rationale: '',
    category: 'code_quality_rule',
    evaluation_mode: 'metadata_check',
    severity_if_failed: 'medium',
    config: {},
  };
}

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
            <input
              className={inputClasses}
              placeholder="e.g. risk_level"
              value={(config.field_name as string) ?? ''}
              onChange={(e) => onChange({ ...config, field_name: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClasses}>Expected Value</label>
            <input
              className={inputClasses}
              placeholder="e.g. high"
              value={(config.expected_value as string) ?? ''}
              onChange={(e) => onChange({ ...config, expected_value: e.target.value })}
            />
          </div>
        </div>
      );

    case 'diff_pattern':
      return (
        <div className="space-y-3">
          <div>
            <label className={labelClasses}>Regex Pattern</label>
            <input
              className={inputClasses}
              placeholder="e.g. console\\.log|debugger"
              value={(config.pattern as string) ?? ''}
              onChange={(e) => onChange({ ...config, pattern: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Regular expression to match against the code diff
            </p>
          </div>
          <div>
            <label className={labelClasses}>Description</label>
            <input
              className={inputClasses}
              placeholder="e.g. Detects debug statements left in code"
              value={(config.pattern_description as string) ?? ''}
              onChange={(e) => onChange({ ...config, pattern_description: e.target.value })}
            />
          </div>
        </div>
      );

    case 'evidence_check':
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClasses}>Evidence Type</label>
            <select
              className={selectClasses}
              value={(config.evidence_type as string) ?? 'ci_result'}
              onChange={(e) => onChange({ ...config, evidence_type: e.target.value })}
            >
              {EVIDENCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClasses}>Required</label>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => onChange({ ...config, required: !(config.required ?? true) })}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent ${
                  (config.required ?? true) ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    (config.required ?? true) ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {(config.required ?? true) ? 'Required' : 'Optional'}
              </span>
            </div>
          </div>
        </div>
      );

    case 'llm_evaluation':
      return (
        <div>
          <label className={labelClasses}>Evaluation Prompt</label>
          <textarea
            className={inputClasses}
            rows={4}
            placeholder="Describe what the AI should evaluate. E.g.: Check that the implementation follows SOLID principles and has no obvious security vulnerabilities."
            value={(config.prompt as string) ?? ''}
            onChange={(e) => onChange({ ...config, prompt: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            The LLM will evaluate each case against this prompt during validation
          </p>
        </div>
      );

    case 'human_confirmation':
      return (
        <div>
          <label className={labelClasses}>Confirmation Description</label>
          <textarea
            className={inputClasses}
            rows={3}
            placeholder="Describe what the human reviewer needs to confirm. E.g.: Verify that the UI changes match the design mockup."
            value={(config.confirmation_description as string) ?? ''}
            onChange={(e) => onChange({ ...config, confirmation_description: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            A reviewer will be asked to explicitly confirm this check
          </p>
        </div>
      );

    default:
      return null;
  }
}

function RuleForm({
  rule,
  onChange,
  onRemove,
  index,
}: {
  rule: RuleDraft;
  onChange: (updated: RuleDraft) => void;
  onRemove: () => void;
  index: number;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 bg-surface-base dark:bg-surface-base/50 rounded-t-lg">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100"
        >
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
          Rule {index + 1}{rule.name ? `: ${rule.name}` : ''}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
        >
          Remove
        </button>
      </div>

      {expanded && (
        <div className="px-4 py-4 space-y-4">
          <div>
            <label className={labelClasses}>
              Name <span className="text-red-500">*</span>
            </label>
            <input
              className={inputClasses}
              placeholder="e.g. No console.log in production code"
              value={rule.name}
              onChange={(e) => onChange({ ...rule, name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClasses}>Category</label>
              <select
                className={selectClasses}
                value={rule.category}
                onChange={(e) => onChange({ ...rule, category: e.target.value as RuleCategory })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClasses}>Severity if Failed</label>
              <select
                className={selectClasses}
                value={rule.severity_if_failed}
                onChange={(e) => onChange({ ...rule, severity_if_failed: e.target.value })}
              >
                {SEVERITIES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClasses}>Evaluation Mode</label>
            <select
              className={selectClasses}
              value={rule.evaluation_mode}
              onChange={(e) => onChange({ ...rule, evaluation_mode: e.target.value as EvaluationMode, config: {} })}
            >
              {EVALUATION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} -- {m.description}
                </option>
              ))}
            </select>
          </div>

          <div className="bg-surface-base dark:bg-surface-base/30 rounded-lg p-4">
            <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
              {EVALUATION_MODES.find((m) => m.value === rule.evaluation_mode)?.label} Configuration
            </h4>
            <EvalModeConfig
              mode={rule.evaluation_mode}
              config={rule.config}
              onChange={(config) => onChange({ ...rule, config })}
            />
          </div>

          <div>
            <label className={labelClasses}>Description</label>
            <textarea
              className={inputClasses}
              rows={2}
              placeholder="Describe what this rule checks"
              value={rule.description}
              onChange={(e) => onChange({ ...rule, description: e.target.value })}
            />
          </div>

          <div>
            <label className={labelClasses}>
              Rationale{' '}
              <span className="text-xs font-normal text-gray-400">(recommended)</span>
            </label>
            <textarea
              className={inputClasses}
              rows={2}
              placeholder="Why does this rule exist? What problem does it prevent?"
              value={rule.rationale}
              onChange={(e) => onChange({ ...rule, rationale: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const TOTAL_STEPS = 3;
const STEP_LABELS = ['Rule Set Basics', 'Add Rules', 'Review & Create'];

export function RuleSetWizard({ projectId, onClose, onCreated }: RuleSetWizardProps) {
  const { addToast } = useToast();
  useEscapeKey(onClose);

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  // Step 1
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Step 2
  const [rules, setRules] = useState<RuleDraft[]>([newRuleDraft()]);

  function canProceed(): boolean {
    if (step === 1) return name.trim().length > 0;
    if (step === 2) return rules.length > 0 && rules.every((r) => r.name.trim().length > 0);
    return true;
  }

  function updateRule(index: number, updated: RuleDraft) {
    setRules((prev) => prev.map((r, i) => (i === index ? updated : r)));
  }

  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave(activate: boolean) {
    setSaving(true);
    try {
      // Create all rules first
      const createdRuleIds: string[] = [];
      for (const draft of rules) {
        const created = await api.rules.create({
          name: draft.name.trim(),
          description: draft.description,
          rationale: draft.rationale,
          category: draft.category,
          evaluation_mode: draft.evaluation_mode,
          severity_if_failed: draft.severity_if_failed,
          config: draft.config,
          scope: { layer: 'project', ref: projectId },
          status: activate ? 'active' : 'draft',
        });
        createdRuleIds.push(created.rule_id);
      }

      // Create the rule set
      const ruleSet = await api.ruleSets.create({
        name: name.trim(),
        description,
        project_id: projectId,
        rule_refs: createdRuleIds,
        status: activate ? 'active' : 'draft',
      });

      addToast('success', `"${ruleSet.name}" with ${createdRuleIds.length} rule${createdRuleIds.length !== 1 ? 's' : ''} created${activate ? ' and activated' : ' as draft'}.`);
      onCreated();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to create rule set');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-raised rounded-xl shadow-xl border border-gray-200 dark:border-border-subtle w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-border-subtle">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Create Rule Set
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-6 pt-4">
          <div className="flex items-center gap-2">
            {STEP_LABELS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={`flex items-center justify-center h-7 w-7 rounded-full text-xs font-semibold ${
                    i + 1 === step
                      ? 'bg-accent-700 text-white'
                      : i + 1 < step
                        ? 'bg-green-500 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {i + 1 < step ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={`text-xs font-medium ${
                    i + 1 === step
                      ? 'text-accent-700 dark:text-accent-300'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {label}
                </span>
                {i < TOTAL_STEPS - 1 && (
                  <div className={`w-8 h-px ${i + 1 < step ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && (
            <div className="space-y-5">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                A rule set groups related rules that are evaluated together. Start by giving it a name and description.
              </p>
              <div>
                <label className={labelClasses}>
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  className={inputClasses}
                  placeholder="e.g. Code Quality Essentials"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className={labelClasses}>Description</label>
                <textarea
                  className={inputClasses}
                  rows={3}
                  placeholder="Describe the purpose of this rule set"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="bg-surface-base dark:bg-surface-base/50 rounded-lg px-4 py-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  <strong>Scope:</strong> This rule set will be scoped to the current project. It will be created as a draft and can be activated later.
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Add rules to this rule set. Each rule defines an automated check that runs during case validation.
                </p>
                <button
                  type="button"
                  onClick={() => setRules((prev) => [...prev, newRuleDraft()])}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  Add Rule
                </button>
              </div>

              {rules.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base/50 px-6 py-8">
                  <p className="text-sm text-gray-500 dark:text-gray-400">No rules added yet.</p>
                  <button
                    type="button"
                    onClick={() => setRules([newRuleDraft()])}
                    className="text-sm text-accent-700 dark:text-accent-300 hover:underline"
                  >
                    Add your first rule
                  </button>
                </div>
              )}

              <div className="space-y-3">
                {rules.map((rule, i) => (
                  <RuleForm
                    key={rule.id}
                    rule={rule}
                    index={i}
                    onChange={(updated) => updateRule(i, updated)}
                    onRemove={() => removeRule(i)}
                  />
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Review your rule set before creating it.
              </p>

              <div className="bg-surface-base dark:bg-surface-base/50 rounded-lg p-4 space-y-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</h3>
                {description && (
                  <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {rules.length} rule{rules.length !== 1 ? 's' : ''} &middot; Project scope
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Rules</h4>
                {rules.map((rule, i) => {
                  const modeInfo = EVALUATION_MODES.find((m) => m.value === rule.evaluation_mode);
                  const catInfo = CATEGORIES.find((c) => c.value === rule.category);
                  return (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between gap-3 bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {i + 1}. {rule.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {catInfo?.label ?? rule.category} &middot; {modeInfo?.label ?? rule.evaluation_mode}
                        </p>
                      </div>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${
                        rule.severity_if_failed === 'critical' ? 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400' :
                        rule.severity_if_failed === 'high' ? 'bg-orange-100 dark:bg-orange-950/50 text-orange-700 dark:text-orange-400' :
                        rule.severity_if_failed === 'medium' ? 'bg-yellow-100 dark:bg-yellow-950/50 text-yellow-700 dark:text-yellow-400' :
                        'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                      }`}>
                        {rule.severity_if_failed}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-border-subtle">
          <div>
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {step < TOTAL_STEPS ? (
              <Button disabled={!canProceed()} onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={saving}
                  loading={saving}
                  onClick={() => handleSave(false)}
                >
                  {saving ? 'Saving...' : 'Save as Draft'}
                </Button>
                <Button disabled={saving} loading={saving} onClick={() => handleSave(true)}>
                  {saving ? 'Saving...' : 'Save & Activate'}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
