'use client';

import { useState } from 'react';
import type { Rule, RuleSet } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { useToast } from '@/providers/toast-provider';
import { useEscapeKey } from '@/hooks/use-escape-key';
import { Button } from '@/components/ui/button';

interface RuleSetEditorModalProps {
  ruleSet: RuleSet;
  rules: Rule[]; // rules currently in this set
  allRules: Rule[]; // all available rules
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}

const inputClasses =
  'w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-3 py-2 text-sm text-gray-700 dark:text-gray-200 shadow-sm placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';

const labelClasses = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

const evaluationModeLabels: Record<string, string> = {
  metadata_check: 'Metadata Check',
  diff_pattern: 'Diff Pattern',
  evidence_check: 'Evidence Check',
  llm_evaluation: 'LLM Evaluation',
  human_confirmation: 'Human Confirmation',
};

const evaluationModeColors: Record<string, string> = {
  metadata_check: 'bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400',
  diff_pattern: 'bg-purple-100 dark:bg-purple-950/50 text-purple-700 dark:text-purple-400',
  evidence_check: 'bg-teal-100 dark:bg-teal-950/50 text-teal-700 dark:text-teal-400',
  llm_evaluation: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400',
  human_confirmation: 'bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400',
};

export function RuleSetEditorModal({ ruleSet, rules, allRules, onClose, onSaved }: RuleSetEditorModalProps) {
  const { addToast } = useToast();
  useEscapeKey(onClose);

  const [name, setName] = useState(ruleSet.name);
  const [description, setDescription] = useState(ruleSet.description);
  const [ruleRefs, setRuleRefs] = useState<string[]>(ruleSet.rule_refs);
  const [saving, setSaving] = useState(false);

  // Rules not currently in this set
  const availableRules = allRules.filter((r) => !ruleRefs.includes(r.rule_id));

  function addRule(ruleId: string) {
    setRuleRefs((prev) => [...prev, ruleId]);
  }

  function removeRule(ruleId: string) {
    setRuleRefs((prev) => prev.filter((id) => id !== ruleId));
  }

  function moveRule(index: number, direction: -1 | 1) {
    const newRefs = [...ruleRefs];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newRefs.length) return;
    [newRefs[index], newRefs[targetIndex]] = [newRefs[targetIndex]!, newRefs[index]!];
    setRuleRefs(newRefs);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.ruleSets.update(ruleSet.rule_set_id, {
        name: name.trim(),
        description,
        rule_refs: ruleRefs,
      });
      addToast('success', `Rule set "${name.trim()}" saved.`);
      onSaved();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Failed to update rule set');
    } finally {
      setSaving(false);
    }
  }

  const rulesById = new Map(allRules.map((r) => [r.rule_id, r]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface-raised rounded-xl shadow-xl border border-gray-200 dark:border-border-subtle w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-border-subtle">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Rule Set</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <label className={labelClasses}>Name <span className="text-red-500">*</span></label>
            <input className={inputClasses} value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className={labelClasses}>Description</label>
            <textarea className={inputClasses} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {/* Current rules in the set */}
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Rules in this set ({ruleRefs.length})
            </h3>
            {ruleRefs.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400 italic">No rules in this set.</p>
            ) : (
              <div className="space-y-1.5">
                {ruleRefs.map((ref, i) => {
                  const rule = rulesById.get(ref);
                  return (
                    <div key={ref} className="flex items-center gap-2 bg-surface-base dark:bg-surface-base/50 rounded-lg px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        <button type="button" onClick={() => moveRule(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                          </svg>
                        </button>
                        <button type="button" onClick={() => moveRule(i, 1)} disabled={i === ruleRefs.length - 1} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                          </svg>
                        </button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-gray-900 dark:text-gray-100 truncate block">
                          {rule?.name ?? ref}
                        </span>
                        {rule && (
                          <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${evaluationModeColors[rule.evaluation_mode] ?? 'bg-gray-100 text-gray-600'}`}>
                            {evaluationModeLabels[rule.evaluation_mode] ?? rule.evaluation_mode}
                          </span>
                        )}
                      </div>
                      <button type="button" onClick={() => removeRule(ref)} className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300">
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Available rules to add */}
          {availableRules.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Available rules ({availableRules.length})
              </h3>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {availableRules.map((rule) => (
                  <div key={rule.rule_id} className="flex items-center justify-between gap-2 bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <span className="text-sm text-gray-900 dark:text-gray-100 truncate block">{rule.name}</span>
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${evaluationModeColors[rule.evaluation_mode] ?? 'bg-gray-100 text-gray-600'}`}>
                        {evaluationModeLabels[rule.evaluation_mode] ?? rule.evaluation_mode}
                      </span>
                    </div>
                    <button type="button" onClick={() => addRule(rule.rule_id)} className="text-xs text-accent-700 dark:text-accent-300 hover:underline">
                      Add
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
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
