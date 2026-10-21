export const CASE_STATUSES = [
  "open",
  "exploration",
  "ready_for_build",
  "in_build",
  "in_validation",
  "in_review",
  "needs_human_decision",
  "verification_pending",
  "approved",
  "pending_merge",
  "done",
  "rejected",
] as const;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const VALIDATION_TRACKS = ["direct", "manual"] as const;
export const SOURCE_TYPES = ["jira", "manual", "git", "other"] as const;
export const CASE_TYPES = [
  "ticket_implementation",
  "bugfix",
  "refactoring",
  "pr_review",
  "manual_verification",
  "other",
] as const;

// Canonical evidence types — must match the canonical list in `packages/shared`.
// The progress_case / build-complete boundary of the Arbitra server REJECTS
// non-canonical types (they are not silently dropped), so this enum has to stay
// in lock-step with the server. Order mirrors the shared list.
export const EVIDENCE_TYPES = [
  "unit_test_result",
  "integration_test_result",
  "ci_result",
  "lint_result",
  "runtime_log",
  "screenshot",
  "diff_snapshot",
  "manual_confirmation",
  "benchmark_result",
  "external_reference",
  "pr_merged",
  "detection_report",
] as const;

export const EVIDENCE_SOURCE_TYPES = [
  "automated",
  "manual",
  "webhook",
  "agent",
] as const;

export const RULE_CATEGORIES = [
  "architecture_rule",
  "code_quality_rule",
  "test_rule",
  "integration_rule",
  "security_rule",
  "project_convention",
  "customer_constraint",
  "release_gate",
] as const;

export const EVALUATION_MODES = [
  "metadata_check",
  "diff_pattern",
  "evidence_check",
  "llm_evaluation",
  "human_confirmation",
] as const;

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const SCOPE_LAYERS = ["global", "project"] as const;
export const RULE_STATUSES = ["active", "inactive", "draft"] as const;

export const KNOWLEDGE_TYPES = [
  "precedent",
  "pattern",
  "anti_pattern",
  "mock_template",
  "implementation_note",
  "review_guideline",
  "architecture_decision",
  "exception_policy",
] as const;

export const KNOWLEDGE_SCOPE_TYPES = [
  "global",
  "org",
  "team",
  "project",
  "repo",
] as const;

/**
 * Decision types surfaced by the `create_decision` tool.
 *
 * The backend's `createDecisionSchema` accepts a wider enum
 * (`approve` | `auto_approve` | `request_changes` | `waive` | `reject` |
 * `escalate` | `manual_validation_confirmed` | `gate_confirmed` |
 * `gate_rejected` | `merge_not_applicable`). The MCP tool intentionally
 * exposes only the actions an IDE agent should file on a user's behalf:
 * the three reviewer-style actions plus `merge_not_applicable` (records
 * that no PR/merge applies to the case, e.g. work done
 * outside the repo; from `pending_merge` or `approved` it drives the case
 * to `done`; the backend rejects it when the case has a `current_pr_ref`,
 * so the `pr_merged` gate stays authoritative for real PRs). Waive, gate
 * confirmations, and escalations stay UI-only to preserve their
 * human-in-the-loop semantics.
 */
export const DECISION_TYPES = [
  "approve",
  "reject",
  "request_changes",
  "merge_not_applicable",
] as const;
