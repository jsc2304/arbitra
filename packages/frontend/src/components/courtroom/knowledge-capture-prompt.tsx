'use client';

import { useState } from 'react';
import type { DecisionType, KnowledgeType } from '@arbitra/shared';
import { api } from '../../lib/api-client';
import { useToast } from '../../providers/toast-provider';

const decisionToKnowledgeType: Record<DecisionType, KnowledgeType> = {
  approve: 'precedent',
  auto_approve: 'precedent',
  request_changes: 'review_guideline',
  waive: 'exception_policy',
  propose_waiver: 'exception_policy',
  reject: 'anti_pattern',
  escalate: 'architecture_decision',
  manual_validation_confirmed: 'implementation_note',
  merge_not_applicable: 'implementation_note',
  review_not_applicable: 'implementation_note',
  gate_confirmed: 'precedent',
  gate_rejected: 'review_guideline',
  waived_on_completion: 'exception_policy',
};

const knowledgeTypeLabels: Record<string, string> = {
  precedent: 'Precedent',
  pattern: 'Pattern',
  anti_pattern: 'Anti-Pattern',
  review_guideline: 'Review Guideline',
  architecture_decision: 'Architecture Decision',
  exception_policy: 'Exception Policy',
  implementation_note: 'Implementation Note',
  mock_template: 'Mock Template',
};

const knowledgeTypeOptions: { value: KnowledgeType; label: string }[] = [
  { value: 'precedent', label: 'Precedent' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'anti_pattern', label: 'Anti-Pattern' },
  { value: 'review_guideline', label: 'Review Guideline' },
  { value: 'architecture_decision', label: 'Architecture Decision' },
  { value: 'exception_policy', label: 'Exception Policy' },
  { value: 'implementation_note', label: 'Implementation Note' },
];

// Mirror the create-knowledge-asset API contract (see app/api/knowledge/route.ts):
// summary must be >= 10 chars, body >= 50 chars of real content.
const SUMMARY_MIN = 10;
const BODY_MIN = 50;

type PromptState = 'prompt' | 'form' | 'success';

interface KnowledgeCapturePromptProps {
  caseId: string;
  caseTitle: string;
  projectId: string;
  decisionId: string;
  decisionType: DecisionType;
  rationale: string;
  onClose: () => void;
}

export function KnowledgeCapturePrompt({
  caseId,
  caseTitle,
  projectId,
  decisionId,
  decisionType,
  rationale,
  onClose,
}: KnowledgeCapturePromptProps) {
  const { addToast } = useToast();
  const suggestedType = decisionToKnowledgeType[decisionType] ?? 'pattern';
  const decisionLabel = decisionType.replace(/_/g, ' ');
  const defaultTitle = `${decisionLabel.charAt(0).toUpperCase()}${decisionLabel.slice(1)} — ${caseTitle}`;

  const [state, setState] = useState<PromptState>('prompt');
  const [title, setTitle] = useState(defaultTitle);
  const [summary, setSummary] = useState(rationale);
  const [body, setBody] = useState('');
  const [type, setType] = useState<KnowledgeType>(suggestedType);
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const trimmedSummary = summary.trim();
  const trimmedBody = body.trim();
  const summaryValid = trimmedSummary.length >= SUMMARY_MIN;
  const bodyValid = trimmedBody.length >= BODY_MIN;
  const canSubmit = trimmedTitle.length > 0 && summaryValid && bodyValid;

  async function handleSave() {
    setSubmitting(true);
    setError(null);

    try {
      await api.knowledge.create({
        type,
        title: trimmedTitle,
        summary: trimmedSummary,
        body: trimmedBody,
        scope_type: 'project',
        scope_ref: projectId,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        source_case_refs: [caseId],
        source_decision_refs: [decisionId],
      });
      addToast('success', 'Knowledge asset suggested successfully');
      setState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create knowledge asset');
    } finally {
      setSubmitting(false);
    }
  }

  if (state === 'success') {
    return (
      <div className="mt-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg
            className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          <p className="text-sm text-green-700 dark:text-green-400">
            Knowledge asset suggested. It will appear on the Knowledge page for review.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 text-xs text-green-600 dark:text-green-400 hover:text-green-500 dark:hover:text-green-300 underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (state === 'prompt') {
    return (
      <div className="mt-3 rounded-lg border border-secondary-200 dark:border-secondary-800 bg-secondary-50 dark:bg-secondary-950/50 px-4 py-3">
        <div className="flex items-start gap-2">
          <svg
            className="h-5 w-5 text-accent flex-shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"
            />
          </svg>
          <div className="flex-1">
            <p className="text-sm font-medium text-secondary-800 dark:text-secondary-300">
              Save this decision as a knowledge asset?
            </p>
            <p className="text-xs text-accent-700 dark:text-accent-300 mt-0.5">
              Your rationale could help future reviews as a{' '}
              <span className="font-medium">{knowledgeTypeLabels[suggestedType] ?? suggestedType}</span>.
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-border-subtle transition-colors"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => setState('form')}
            className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 transition-colors"
          >
            Save as Knowledge
          </button>
        </div>
      </div>
    );
  }

  // state === 'form'
  return (
    <div className="mt-3 rounded-lg border border-secondary-200 dark:border-secondary-800 bg-secondary-50 dark:bg-secondary-950/50 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-secondary-800 dark:text-secondary-300">
          Suggest Knowledge Asset
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          aria-label="Close"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Title */}
      <div>
        <label htmlFor="ka-title" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          Title
        </label>
        <input
          id="ka-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2.5 py-1.5 text-sm text-gray-900 dark:text-gray-200 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Summary (pre-filled with rationale) — short 1–2 sentence field */}
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label htmlFor="ka-summary" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Summary <span className="text-gray-400 dark:text-gray-500">(1–2 sentences, min {SUMMARY_MIN} chars)</span>
          </label>
          <span
            className={`text-xs ${summaryValid ? 'text-gray-400 dark:text-gray-500' : 'text-red-600 dark:text-red-400'}`}
          >
            {trimmedSummary.length}/{SUMMARY_MIN}
          </span>
        </div>
        <textarea
          id="ka-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2.5 py-1.5 text-sm text-gray-900 dark:text-gray-200 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Body / Content (markdown) — the actual learning */}
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label htmlFor="ka-body" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Body / Content <span className="text-gray-400 dark:text-gray-500">(markdown, min {BODY_MIN} chars)</span>
          </label>
          <span
            className={`text-xs ${bodyValid ? 'text-gray-400 dark:text-gray-500' : 'text-red-600 dark:text-red-400'}`}
          >
            {trimmedBody.length}/{BODY_MIN}
          </span>
        </div>
        <textarea
          id="ka-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Explain the actual learning in markdown — context, the decision, and why it applies to future reviews."
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2.5 py-1.5 text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Type dropdown */}
      <div>
        <label htmlFor="ka-type" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          Type
        </label>
        <select
          id="ka-type"
          value={type}
          onChange={(e) => setType(e.target.value as KnowledgeType)}
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2.5 py-1.5 text-sm text-gray-700 dark:text-gray-300 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {knowledgeTypeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Tags */}
      <div>
        <label htmlFor="ka-tags" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          Tags <span className="text-gray-400 dark:text-gray-500">(comma-separated, optional)</span>
        </label>
        <input
          id="ka-tags"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g. security, auth, api"
          className="w-full rounded-md border border-gray-300 dark:border-border-default bg-input-bg px-2.5 py-1.5 text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/50 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-end pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-surface-base dark:hover:bg-border-subtle transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting || !canSubmit}
          className="rounded-md bg-accent-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-800 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 transition-colors"
        >
          {submitting ? 'Saving...' : 'Suggest Knowledge Asset'}
        </button>
      </div>
    </div>
  );
}
