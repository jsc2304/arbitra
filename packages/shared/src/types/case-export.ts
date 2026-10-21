import type { Case } from './case.js';
import type { Finding } from './finding.js';
import type { Evidence } from './evidence.js';
import type { Decision } from './decision.js';
import type { CaseEvent } from './event.js';
import type { Run } from './run.js';
import type { Comment } from './comment.js';
import type { Project } from './project.js';

export type CaseExportFormat =
  | 'markdown'
  | 'json'
  | 'html'
  | 'audit'
  | 'audit-markdown'
  | 'customer-report-markdown'
  | 'customer-report-html';

/**
 * Deterministic + LLM-generated pieces used by the customer-facing report.
 * Internal-vocabulary fields (findings/decisions/evidence/rules/risk) are
 * intentionally absent — they must never leak into a customer export.
 */
export interface CustomerReportContent {
  /** Short, business-friendly title (falls back to case title). */
  title: string;
  /** Short public-ish identifier for the change (the case_id). */
  reference_id: string;
  /** Completion date (from terminal done/approved event) or null if not finished. */
  completion_date: string | null;
  /** Outcome one-liner in plain English, e.g. "Delivered and merged on …". */
  outcome_line: string;
  /** 2-4 sentence LLM-generated business summary. */
  summary: string;
  /** Deterministic list of file paths affected by the change. */
  changed_files: string[];
  /**
   * True when `changed_files` was derived from a diff the resolver had to
   * truncate, i.e. the list names only the files visible in the prefix and
   * more files were changed than are listed. Optional and defaulting to
   * false so reports built before this field existed keep rendering
   * unchanged (issue #877).
   */
  changed_files_truncated?: boolean;
  /** Optional manual verification steps (only when extracted verbatim). */
  manual_test_steps: string[];
  /** Public references: PR link, branch name, repository display name. */
  reference: {
    pr_url: string | null;
    branch: string | null;
    repository: string | null;
  };
}

export interface CaseExportData {
  case: Case;
  findings: Finding[];
  evidence: Evidence[];
  decisions: Decision[];
  events: CaseEvent[];
  runs: Run[];
  comments: Comment[];
  exported_at: string;
  exported_by?: string;
}

export interface AuditExport {
  case: Case;
  project: Project | null;
  timeline: CaseEvent[];
  findings: Finding[];
  evidence: Evidence[];
  decisions: Decision[];
  comments: Comment[];
  runs: Run[];
  exported_at: string;
  exported_by: string;
}

export interface CaseExportResult {
  case_id: string;
  format: CaseExportFormat;
  content: string;
  filename: string;
  content_type: string;
}
