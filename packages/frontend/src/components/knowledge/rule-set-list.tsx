'use client';

import { useState } from 'react';
import type { Rule, RuleSet, RuleStatus } from '@arbitra/shared';
import { api } from '@/lib/api-client';
import { RelativeTime } from '@/components/shared/relative-time';

const statusColors: Record<RuleStatus, string> = {
  active: 'bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-400',
  inactive: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  draft: 'bg-yellow-100 dark:bg-yellow-950/50 text-yellow-700 dark:text-yellow-400',
};

const layerLabels: Record<string, string> = {
  global: 'Global',
  project: 'Project',
};

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

interface RuleSetListProps {
  ruleSets: RuleSet[];
  rules?: Rule[];
  onRuleStatusChange?: () => void;
  onEditRuleSet?: (ruleSet: RuleSet) => void;
  onEditRule?: (rule: Rule) => void;
}

function RuleToggle({
  id,
  type,
  status,
  onToggle,
}: {
  id: string;
  type: 'rule' | 'rule-set';
  status: RuleStatus;
  onToggle: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const isActive = status === 'active';

  async function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    setLoading(true);
    try {
      const newStatus = isActive ? 'inactive' : 'active';
      if (type === 'rule') {
        await api.rules.updateStatus(id, newStatus);
      } else {
        await api.ruleSets.updateStatus(id, newStatus);
      }
      onToggle();
    } catch (err) {
      console.error('Failed to toggle status:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      title={isActive ? 'Deactivate' : 'Activate'}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${
        isActive ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
      } ${loading ? 'opacity-50' : ''}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          isActive ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function RuleSetList({ ruleSets, rules = [], onRuleStatusChange, onEditRuleSet, onEditRule }: RuleSetListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rulesById = new Map(rules.map((r) => [r.rule_id, r]));

  if (ruleSets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-surface-base dark:bg-surface-base/50 px-6 py-12">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">No rule sets</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Rule sets will appear here once configured.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
      {ruleSets.map((ruleSet) => {
        const isExpanded = expandedId === ruleSet.rule_set_id;
        const layer = ruleSet.project_id ? 'project' : 'global';

        return (
          <div key={ruleSet.rule_set_id} className="px-4 py-3">
            <button
              onClick={() =>
                setExpandedId(isExpanded ? null : ruleSet.rule_set_id)
              }
              className="w-full text-left"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" title={ruleSet.name}>
                    {ruleSet.name}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium ${statusColors[ruleSet.status]}`}
                  >
                    {ruleSet.status}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {onEditRuleSet && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onEditRuleSet(ruleSet); }}
                      title="Edit rule set"
                      className="text-gray-400 hover:text-accent-700 dark:hover:text-accent-300 transition-colors"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                      </svg>
                    </button>
                  )}
                  <RuleToggle
                    id={ruleSet.rule_set_id}
                    type="rule-set"
                    status={ruleSet.status}
                    onToggle={() => onRuleStatusChange?.()}
                  />
                  <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-secondary-50 dark:bg-secondary-950/50 text-secondary-700 dark:text-secondary-400">
                    {layerLabels[layer] ?? layer}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    v{ruleSet.version}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {ruleSet.rule_refs.length} rule{ruleSet.rule_refs.length !== 1 ? 's' : ''}
                  </span>
                  <svg
                    className={`h-4 w-4 text-gray-400 dark:text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                    />
                  </svg>
                </div>
              </div>
            </button>

            {isExpanded && (
              <div className="mt-3 pl-2 border-l-2 border-gray-200 dark:border-border-subtle ml-1 space-y-2">
                {ruleSet.description && (
                  <p className="text-sm text-gray-600 dark:text-gray-400">{ruleSet.description}</p>
                )}
                <div className="text-xs text-gray-400 dark:text-gray-500 flex flex-wrap gap-3">
                  <span>ID: {ruleSet.rule_set_id}</span>
                  <RelativeTime timestamp={ruleSet.created_at} prefix="Created" />
                  <RelativeTime timestamp={ruleSet.updated_at} prefix="Updated" />
                </div>
                {ruleSet.rule_refs.length > 0 && (
                  <div className="mt-2 space-y-2">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      Rules:
                    </span>
                    {ruleSet.rule_refs.map((ref) => {
                      const rule = rulesById.get(ref);
                      if (!rule) {
                        return (
                          <div
                            key={ref}
                            className="text-xs text-gray-600 dark:text-gray-400 font-mono bg-surface-base dark:bg-surface-base/50 rounded px-2 py-1"
                          >
                            {ref}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={ref}
                          className="bg-surface-base dark:bg-surface-base/50 rounded-lg px-3 py-2 flex items-center justify-between gap-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm text-gray-900 dark:text-gray-100 truncate" title={rule.name}>
                              {rule.name}
                            </span>
                            <span
                              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${evaluationModeColors[rule.evaluation_mode] ?? 'bg-gray-100 text-gray-600'}`}
                            >
                              {evaluationModeLabels[rule.evaluation_mode] ?? rule.evaluation_mode}
                            </span>
                            <span className="text-[10px] text-gray-400 dark:text-gray-500 capitalize">
                              severity: {rule.severity_if_failed}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span
                              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors[rule.status]}`}
                            >
                              {rule.status}
                            </span>
                            {onEditRule && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onEditRule(rule); }}
                                title="Edit rule"
                                className="text-gray-400 hover:text-accent-700 dark:hover:text-accent-300 transition-colors"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                                </svg>
                              </button>
                            )}
                            <RuleToggle
                              id={rule.rule_id}
                              type="rule"
                              status={rule.status}
                              onToggle={() => onRuleStatusChange?.()}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
