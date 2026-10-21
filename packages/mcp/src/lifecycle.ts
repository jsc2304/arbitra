/**
 * Central lifecycle state machine for agent-facing tool responses.
 *
 * Maps each CaseStatus to the single `next_action` pointer that the agent
 * should follow. Co-located here so `progress_case`, `transition_case`,
 * `get_case_context`, and legacy signal_* tools all emit consistent
 * `structuredContent.next_action` fields.
 */

import { CASE_STATUSES } from "./constants.js";
import type { NextAction } from "./hints.js";

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const STATUS_NEXT_ACTION: Record<CaseStatus, NextAction | null> = {
  open: {
    tool_to_call: "progress_case",
    why: "submit exploration summary",
    expected_payload_keys: ["case_id", "summary"],
  },
  exploration: {
    tool_to_call: "progress_case",
    why: "submit exploration summary",
    expected_payload_keys: ["case_id", "summary"],
  },
  ready_for_build: {
    tool_to_call: "progress_case",
    why: "advance to in_build",
    expected_payload_keys: ["case_id"],
  },
  in_build: {
    tool_to_call: "progress_case",
    why: "signal build complete with evidence",
    expected_payload_keys: [
      "case_id",
      "summary",
      "branch",
      "pr_url",
      "evidence",
    ],
  },
  in_validation: {
    tool_to_call: "get_case_context",
    why: "poll until validation finishes",
    expected_payload_keys: ["case_id"],
  },
  in_review: {
    tool_to_call: "get_case_context",
    why: "poll until review finishes",
    expected_payload_keys: ["case_id"],
  },
  approved: {
    tool_to_call: "get_case_context",
    why: "poll until case reaches done/pending_merge",
    expected_payload_keys: ["case_id"],
  },
  pending_merge: {
    tool_to_call: "get_case_context",
    why: "poll; merge the PR in GitHub to complete",
    expected_payload_keys: ["case_id"],
  },
  needs_human_decision: {
    tool_to_call: "get_case_context",
    why: "human action required — see Courtroom UI",
    expected_payload_keys: ["case_id"],
  },
  verification_pending: {
    tool_to_call: "get_case_context",
    why: "manual validation pending",
    expected_payload_keys: ["case_id"],
  },
  done: null,
  rejected: null,
};

export function nextActionFor(status: string | undefined): NextAction | null {
  if (!status) return null;
  if ((CASE_STATUSES as readonly string[]).includes(status)) {
    return STATUS_NEXT_ACTION[status as CaseStatus];
  }
  return null;
}
