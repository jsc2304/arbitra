'use client';

import { useState } from 'react';
import type { EvidencePolicy, EvidencePolicyRule } from '@arbitra/shared';
import { classifyPolicyCell } from '@arbitra/shared';
import { getEvidenceLabel, getEvidenceDescription } from '@/lib/evidence-labels';
import { useProjectMap } from '@/hooks/use-projects';
import { RISK_PILL_COLORS } from '@/lib/risk-colors';
import { EditPolicyModal } from './edit-policy-modal';
import { RelativeTime } from '../shared/relative-time';

const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
const tracks = ['direct', 'manual'] as const;

interface PolicyEditorProps {
  policy: EvidencePolicy;
  onPolicyUpdated?: () => void;
}

export function PolicyRuleCell({ rule }: { rule: EvidencePolicyRule | undefined }) {
  const state = classifyPolicyCell(rule);

  // Absent cell AND a legacy empty cell with no explicit intent both resolve
  // to the built-in defaults (see classifyPolicyCell's LEGACY READ DECISION)
  // — render them identically so the label matches what actually happens at
  // evaluation time.
  if (state === 'inherits_defaults') {
    return (
      <td className="px-3 py-2 align-top">
        <span
          className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
          title="No custom rule for this cell — the built-in default evidence requirements apply."
        >
          Inherits defaults
        </span>
      </td>
    );
  }

  const definedRule = rule!;

  if (state === 'requires_nothing') {
    return (
      <td className="px-3 py-2 align-top">
        <div className="space-y-1.5">
          <span
            className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-teal-100 dark:bg-teal-950/50 text-teal-700 dark:text-teal-400"
            title="Explicitly configured to require no evidence — the case can pass this gate with none."
          >
            Requires no evidence
          </span>
          <div className="flex flex-wrap gap-1">
            {definedRule.four_eyes_required && (
              <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-purple-100 dark:bg-purple-950/50 text-purple-700 dark:text-purple-400">
                Four-eyes required
              </span>
            )}
            {definedRule.allow_self_approval && (
              <span
                className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400"
                title="Case owner may approve or confirm this gate themselves (anti-gaming disabled for this cell)."
              >
                Self-approval allowed
              </span>
            )}
          </div>
        </div>
      </td>
    );
  }

  // state === 'custom': an authored cell with its own required/optional
  // evidence types (required_evidence_types is guaranteed non-empty here).
  return (
    <td className="px-3 py-2 align-top">
      <div className="space-y-1.5">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Required
          </span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {definedRule.required_evidence_types.map((t) => (
              <span
                key={t}
                className="inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400"
                title={getEvidenceDescription(t)}
              >
                {getEvidenceLabel(t)}
              </span>
            ))}
          </div>
        </div>
        {definedRule.optional_evidence_types.length > 0 && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Optional
            </span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {definedRule.optional_evidence_types.map((t) => (
                <span
                  key={t}
                  className="inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                  title={getEvidenceDescription(t)}
                >
                  {getEvidenceLabel(t)}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {definedRule.four_eyes_required && (
            <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-purple-100 dark:bg-purple-950/50 text-purple-700 dark:text-purple-400">
              Four-eyes required
            </span>
          )}
          {definedRule.allow_self_approval && (
            <span
              className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400"
              title="Case owner may approve or confirm this gate themselves (anti-gaming disabled for this cell)."
            >
              Self-approval allowed
            </span>
          )}
        </div>
      </div>
    </td>
  );
}

export function PolicyEditor({ policy, onPolicyUpdated }: PolicyEditorProps) {
  const [editOpen, setEditOpen] = useState(false);
  const projectMap = useProjectMap();
  const rules = policy.rules;
  const projectLabel = projectMap[policy.project_id]
    ? `${projectMap[policy.project_id]} (${policy.project_id})`
    : policy.project_id;

  return (
    <div className="bg-surface-raised border border-gray-200 dark:border-border-subtle rounded-lg">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-border-subtle flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Evidence Policy
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Project: {projectLabel}
            {policy.repository_id ? ` / ${policy.repository_id}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
          <span>v{policy.version}</span>
          <RelativeTime timestamp={policy.updated_at} prefix="Updated:" />
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="ml-2 rounded-md border border-gray-300 dark:border-gray-600 bg-surface-raised px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 shadow-sm hover:bg-surface-base dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1"
          >
            Edit
          </button>
        </div>
      </div>

      {tracks.map((track) => (
        <div key={track} className="border-b border-gray-100 dark:border-border-subtle last:border-b-0">
          <div className="px-4 py-2 bg-surface-base dark:bg-surface-base/50">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
              {track} track
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-100 dark:border-border-subtle">
                  <th className="px-3 py-2 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide w-28">
                    Risk Level
                  </th>
                  <th className="px-3 py-2 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Evidence Requirements
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800/50">
                {riskLevels.map((risk) => {
                  const trackRules = rules[risk];
                  const policyRule = trackRules?.[track];

                  return (
                    <tr key={risk}>
                      <td className="px-3 py-2 align-top">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${RISK_PILL_COLORS[risk].pill}`}
                        >
                          {risk}
                        </span>
                      </td>
                      <PolicyRuleCell rule={policyRule} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="px-4 py-2 bg-surface-base dark:bg-surface-base/50 rounded-b-lg">
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          Manage policies via the API or your IDE agent using the Arbitra MCP server.
        </p>
      </div>

      <EditPolicyModal
        policy={policy}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={() => onPolicyUpdated?.()}
      />
    </div>
  );
}
