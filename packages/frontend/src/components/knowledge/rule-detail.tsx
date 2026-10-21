import type { Rule, EvaluationMode, RuleStatus } from '@arbitra/shared';
import { RelativeTime } from '../shared/relative-time';

const evaluationModeColors: Record<EvaluationMode, string> = {
  metadata_check: 'bg-blue-100 text-blue-700',
  diff_pattern: 'bg-purple-100 text-purple-700',
  evidence_check: 'bg-teal-100 text-teal-700',
  llm_evaluation: 'bg-amber-100 text-amber-700',
  human_confirmation: 'bg-rose-100 text-rose-700',
};

const evaluationModeLabels: Record<EvaluationMode, string> = {
  metadata_check: 'Metadata Check',
  diff_pattern: 'Diff Pattern',
  evidence_check: 'Evidence Check',
  llm_evaluation: 'LLM Evaluation',
  human_confirmation: 'Human Confirmation',
};

const statusColors: Record<RuleStatus, string> = {
  active: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-600',
  draft: 'bg-yellow-100 text-yellow-700',
};

interface RuleDetailProps {
  rule: Rule;
}

export function RuleDetail({ rule }: RuleDetailProps) {
  const hasConfig = Object.keys(rule.config).length > 0;

  return (
    <div className="bg-surface-raised border border-gray-200 rounded-lg">
      <div className="px-5 py-4 border-b border-gray-200">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-gray-900">{rule.name}</h3>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${evaluationModeColors[rule.evaluation_mode]}`}
            >
              {evaluationModeLabels[rule.evaluation_mode]}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[rule.status]}`}
            >
              {rule.status}
            </span>
          </div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {rule.description && (
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Description
            </dt>
            <dd className="mt-1 text-sm text-gray-700">{rule.description}</dd>
          </div>
        )}

        {rule.rationale && (
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Rationale
            </dt>
            <dd className="mt-1 text-sm text-gray-600">{rule.rationale}</dd>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Category
            </dt>
            <dd className="mt-1 text-sm text-gray-700">
              {rule.category.replace(/_/g, ' ')}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Severity
            </dt>
            <dd className="mt-1 text-sm text-gray-700">
              {rule.severity_if_failed}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Scope
            </dt>
            <dd className="mt-1 text-sm text-gray-700">
              {rule.scope.layer} / {rule.scope.ref}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Version
            </dt>
            <dd className="mt-1 text-sm text-gray-700">v{rule.version}</dd>
          </div>
        </div>

        {hasConfig && (
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Configuration
            </dt>
            <dd className="mt-1">
              <pre className="rounded-md bg-surface-base border border-gray-200 p-3 text-xs text-gray-700 overflow-x-auto">
                {JSON.stringify(rule.config, null, 2)}
              </pre>
            </dd>
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-xs text-gray-400 pt-2 border-t border-gray-100">
          <span>ID: {rule.rule_id}</span>
          <RelativeTime timestamp={rule.created_at} prefix="Created:" />
          <RelativeTime timestamp={rule.updated_at} prefix="Updated:" />
        </div>
      </div>
    </div>
  );
}
