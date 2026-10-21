import type { Case, Finding, KnowledgeAsset } from '@arbitra/shared';
import type { ReviewContext } from '../../diff/review-context.js';

export interface ReviewObservation {
  source: string;
  model?: string;
  location?: string;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  description: string;
  recommendation?: string;
  rationale?: string;
  diff_refs?: string[];
}

export interface ReviewAdapterConfig {
  model?: string;
  timeout?: number;
  prompt_template?: string;
  /** Previous findings from earlier review iterations, passed for delta-review context. */
  previous_findings?: Finding[];
  /**
   * Human-verified, review-relevant KnowledgeAssets scoped to this case's
   * project/repo. Injected into the review prompt so the reviewer applies
   * project-specific guidelines and precedents (e.g. known false-positive
   * classes for vendor APIs) instead of re-raising them every run.
   */
  knowledge_assets?: KnowledgeAsset[];
  /**
   * Server-side enrichment fetched from the GitHub API: post-change contents
   * of the files touched by the diff, plus a repository file listing. Lets
   * the reviewer verify "missing import" / "file does not exist" style
   * claims against ground truth instead of the diff alone. Absent when the
   * pipeline has no repo checkout access or the GitHub fetch failed
   * (fail-soft — reviews must still work with the diff-only fallback).
   */
  review_context?: ReviewContext;
}

export interface ReviewResult {
  observations: ReviewObservation[];
  token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    model: string;
  };
  prompt_version?: string;
}

export interface ReviewerAdapter {
  readonly name: string;
  review(case_: Case, diff: string, config?: ReviewAdapterConfig): Promise<ReviewObservation[] | ReviewResult>;
}
