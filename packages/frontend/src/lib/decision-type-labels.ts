/**
 * Single source of truth for human-readable decision-type labels and chip
 * styling. Consumed by both `decision-history.tsx` (decisions list) and
 * `decision-context-panel.tsx` (compact summary above case tabs).
 *
 * Canonical form is **past-tense** ("Approved", "Changes requested",
 * "Waived"). This reads naturally in the history list ("Approved by alice"
 * – implicit "was") and in the context panel ("Approved by alice · 2 h
 * ago"). Imperative-form verbs ("Approve", "Waive") previously diverged
 * between the two surfaces and caused drift on the same page.
 */

import type { DecisionType } from '@arbitra/shared';

export interface DecisionTypeConfig {
  /** Canonical human label (past tense). */
  label: string;
  /** Tailwind classes for the chip background + text. */
  className: string;
}

export const DECISION_TYPE_LABELS: Record<DecisionType, DecisionTypeConfig> = {
  approve: {
    label: 'Approved',
    className: 'text-corp-dark dark:text-corp-green bg-corp-green/10 dark:bg-corp-green/20',
  },
  auto_approve: {
    label: 'Auto-approved',
    className: 'text-corp-dark dark:text-corp-green-dark bg-corp-green-dark/10 dark:bg-corp-green-dark/20',
  },
  request_changes: {
    label: 'Changes requested',
    className: 'text-corp-dark dark:text-corp-yellow-bright bg-corp-yellow/20 dark:bg-corp-yellow/30',
  },
  waive: {
    label: 'Waived',
    className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
  },
  propose_waiver: {
    label: 'Waiver proposed',
    className: 'text-corp-dark dark:text-corp-yellow-bright bg-corp-yellow/20 dark:bg-corp-yellow/30',
  },
  reject: {
    label: 'Rejected',
    className: 'text-corp-dark dark:text-corp-red bg-corp-red/10 dark:bg-corp-red/20',
  },
  escalate: {
    label: 'Escalated',
    className: 'text-corp-dark dark:text-corp-orange bg-corp-orange/10 dark:bg-corp-orange/20',
  },
  manual_validation_confirmed: {
    label: 'Manual validation confirmed',
    className: 'text-secondary-700 dark:text-secondary-300 bg-secondary-50 dark:bg-secondary-950/50',
  },
  merge_not_applicable: {
    label: 'Merge not applicable',
    className: 'text-slate-700 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/50',
  },
  review_not_applicable: {
    label: 'Review not applicable',
    className: 'text-slate-700 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/50',
  },
  gate_confirmed: {
    label: 'Gate confirmed',
    className: 'text-corp-dark dark:text-corp-teal-bright bg-corp-teal/10 dark:bg-corp-teal/20',
  },
  gate_rejected: {
    label: 'Gate declined',
    className: 'text-slate-700 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/50',
  },
  // "(system)" is part of the label on purpose: this row states that nobody
  // confirmed the waiver — the case simply completed with the proposal open.
  waived_on_completion: {
    label: 'Waived on completion (system)',
    className: 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800',
  },
};
