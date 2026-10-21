'use client';

import { useState } from 'react';
import type { Finding } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';

interface ConflictMarkerProps {
  finding: Finding;
  /** Project the case belongs to — the overriding (shadowing) rule in a
   * `rule_override_conflict` is always project-scoped (see
   * `conflict-detector.ts`: conflicts only match a project rule against a
   * global rule), so this is the scope recorded on the RuleOverride. */
  projectId: string;
  /** Called after a successful override so the parent can refetch findings. */
  onResolved?: () => void;
}

const MIN_RATIONALE_LENGTH = 10;

export function ConflictMarker({ finding, projectId, onResolved }: ConflictMarkerProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();

  if (finding.category !== 'rule_override_conflict') {
    return null;
  }

  // `rule_refs` ordering convention set by `rule-service.ts`: index 0 is the
  // shadowed global rule (`rule_id`), index 1 is the shadowing project rule
  // (`overriding_rule_id`).
  const [ruleId, overridingRuleId] = finding.rule_refs;
  const canConfirm = finding.status === 'open' && Boolean(ruleId) && Boolean(overridingRuleId);
  const isValid = rationale.trim().length >= MIN_RATIONALE_LENGTH;

  async function handleConfirm() {
    if (!isValid || !ruleId || !overridingRuleId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.rules.overrides.create({
        rule_id: ruleId,
        overriding_rule_id: overridingRuleId,
        scope: { layer: 'project', ref: projectId },
        rationale: rationale.trim(),
        finding_id: finding.finding_id,
      });
      addToast('success', 'Override confirmed', 'The rule conflict has been resolved.');
      setFormOpen(false);
      setRationale('');
      onResolved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm override');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-4">
      <div className="flex items-start gap-3">
        <svg
          className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-400">
            Rule Override Conflict
          </h4>
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
            {finding.status === 'open'
              ? 'This finding indicates a conflict between rule overrides. A human decision is required to confirm or reject the override.'
              : 'This rule override conflict has been resolved.'}
          </p>
          {finding.rule_refs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {finding.rule_refs.map((ref) => (
                <span
                  key={ref}
                  className="inline-flex items-center rounded bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 text-[10px] font-mono text-amber-700 dark:text-amber-400"
                >
                  {ref}
                </span>
              ))}
            </div>
          )}

          {canConfirm && !formOpen && (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="mt-3 inline-flex items-center rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-100 dark:bg-amber-900/50 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-400 transition-colors hover:bg-amber-200 dark:hover:bg-amber-900"
            >
              Confirm Override
            </button>
          )}

          {canConfirm && formOpen && (
            <div className="mt-3 space-y-2">
              <label
                htmlFor={`override-rationale-${finding.finding_id}`}
                className="block text-xs font-medium text-amber-800 dark:text-amber-400"
              >
                Rationale{' '}
                <span className="text-amber-600 dark:text-amber-500">
                  (min {MIN_RATIONALE_LENGTH} characters)
                </span>
              </label>
              <textarea
                id={`override-rationale-${finding.finding_id}`}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                rows={3}
                placeholder="Explain why the project rule should override the global rule..."
                className="w-full rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-input-bg px-3 py-2 text-sm text-gray-900 dark:text-gray-200 placeholder-amber-400 dark:placeholder-amber-600 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              {error && (
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={!isValid || submitting}
                  className="inline-flex items-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-300 dark:disabled:bg-amber-900"
                >
                  {submitting ? 'Confirming...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFormOpen(false);
                    setRationale('');
                    setError(null);
                  }}
                  disabled={submitting}
                  className="inline-flex items-center rounded-lg border border-amber-300 dark:border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 transition-colors hover:bg-amber-100 dark:hover:bg-amber-900/50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
