/**
 * Agent workflow tools: context retrieval, lifecycle progression.
 *
 * `progress_case` is the canonical state-driven lifecycle dispatcher.
 * The legacy `signal_exploration_complete`, `signal_build_complete`, and
 * `get_agent_instructions` tools remain registered but are marked
 * [DEPRECATED — use progress_case]. They continue to hit the same backend
 * endpoints so existing agent installs keep working.
 */

import { z } from "zod";
import type { ArbitraClient } from "../client.js";
import { CASE_STATUSES } from "../constants.js";
import {
  createJsonHandler,
  jsonResult,
  errorResult,
  textResult,
  type ToolDefinition,
  type ToolResult,
} from "../types.js";
import { withNextAction } from "../hints.js";
import { nextActionFor, type CaseStatus } from "../lifecycle.js";
import { buildActorMetadata, withActorMetadata } from "../actor-metadata.js";
import { SHARE_URL_HINT } from "../share-url.js";

const EVIDENCE_ITEM_SCHEMA = z.object({
  type: z
    .string()
    .min(1)
    .describe(
      "Evidence type, e.g. 'ci_result', 'unit_test_result', 'lint_result', 'manual_verification'. The backend validates against its canonical enum."
    ),
  summary: z
    .string()
    .describe("Short human description of what this evidence represents."),
  artifact_ref: z
    .string()
    .optional()
    .describe("Optional URI, file path, or reference identifier."),
  run_id: z.string().optional().describe("Optional run correlation id."),
  machine_readable: z
    .boolean()
    .optional()
    .describe("Whether the evidence is machine-readable."),
  source_type: z
    .enum(["automated", "manual", "webhook", "agent"])
    .optional()
    .default("agent")
    .describe(
      "Provenance of this evidence: 'automated' (CI/tools), 'manual' (human attestation), 'webhook' (external system), 'agent' (default — MCP-registered by an IDE agent)."
    ),
});

async function fetchContext(
  client: ArbitraClient,
  caseId: string
): Promise<{ data: unknown; status: string | undefined }> {
  const data = await client.get(`/api/agent/context/${caseId}`);
  // The backend returns { case: { status, ... }, phase, next_steps, ... }.
  // Keep the top-level fallback so older backend responses still parse.
  const typed = data as { case?: { status?: string }; status?: string };
  const status = typed.case?.status ?? typed.status;
  return { data, status };
}

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "get_case_context",
      description:
        "Get full context for a case including case details, findings, evidence, rules, knowledge assets, preconditions (per-transition satisfaction), lifecycle_profile (project gate autonomy), and pending_gate (confirm-gate blocker if any). " +
        "Use this as the primary entry point when starting work on a case. " +
        "The response's `project.default_language` ('en'/'de', defaults to 'en') is the language to write case comments, descriptions, and summaries in. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
      },
      handler: async (args) => {
        try {
          const { data, status } = await fetchContext(
            client,
            args.case_id as string
          );
          return withNextAction(jsonResult(data), nextActionFor(status));
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "progress_case",
      description:
        "Advance a case through its lifecycle. State-driven dispatcher: reads current status and routes to the correct backend call (exploration -> ready_for_build -> in_build -> validation). " +
        "Provide `summary` when advancing from exploration or in_build. Provide `branch`, `pr_url`, and `evidence` at in_build. Use `force_target` only as an escape hatch to call the raw transition endpoint. " +
        "Returns the fresh case context with a structured `next_action` pointer. This is the single lifecycle verb — prefer it over the deprecated signal_* tools. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        summary: z
          .string()
          .optional()
          .describe(
            "Markdown summary. Required when current status is open/exploration (what was explored) or in_build (what was implemented). " +
              "Sign the summary with a trailing line `— <client> · <model>` so the audit trail records the model identity (mirrors AGENTS.md)."
          ),
        branch: z
          .string()
          .optional()
          .describe("Git branch name (only meaningful at in_build)."),
        pr_url: z
          .string()
          .optional()
          .describe("Pull request URL (only meaningful at in_build)."),
        evidence: z
          .array(EVIDENCE_ITEM_SCHEMA)
          .optional()
          .describe(
            "Evidence items produced during build (only meaningful at in_build)."
          ),
        force_target: z
          .enum(CASE_STATUSES)
          .optional()
          .describe(
            "Escape hatch: bypass state-driven dispatch and call the raw transition endpoint with this target status. Use only when state machine routing is insufficient."
          ),
      },
      handler: async (args) => {
        try {
          const caseId = args.case_id as string;

          // 1. Escape hatch: raw transition.
          if (args.force_target) {
            await client.post(`/api/cases/${caseId}/transition`, {
              target_status: args.force_target,
            });
            const { data, status } = await fetchContext(client, caseId);
            return withNextAction(jsonResult(data), nextActionFor(status));
          }

          // 2. Read current status.
          const { status } = await fetchContext(client, caseId);

          // 3. Dispatch.
          switch (status as CaseStatus | undefined) {
            case "open":
            case "exploration": {
              if (!args.summary) {
                return structuredError(
                  `progress_case requires 'summary' when current status is '${status}'. Provide a markdown summary of what was explored.`
                );
              }
              await client.post(
                "/api/agent/explore",
                withActorMetadata({
                  case_id: caseId,
                  summary: args.summary,
                })
              );
              break;
            }
            case "ready_for_build": {
              await client.post(`/api/cases/${caseId}/transition`, {
                target_status: "in_build",
              });
              break;
            }
            case "in_build": {
              if (!args.summary) {
                return structuredError(
                  "progress_case requires 'summary' when current status is 'in_build'. Provide a markdown summary of changes implemented."
                );
              }
              const body: Record<string, unknown> = {
                case_id: caseId,
                summary: args.summary,
              };
              if (args.branch) body.branch = args.branch;
              if (args.pr_url) body.pr_url = args.pr_url;
              if (args.evidence) body.evidence = stampEvidence(args.evidence);
              await client.post(
                "/api/agent/build-complete",
                withActorMetadata(body)
              );
              break;
            }
            case "in_validation":
            case "in_review":
            case "approved":
            case "pending_merge": {
              // No-op. Re-fetch and return with polling hint.
              const ctx = await fetchContext(client, caseId);
              return withNextAction(
                jsonResult(ctx.data),
                nextActionFor(ctx.status)
              );
            }
            case "needs_human_decision":
            case "verification_pending": {
              const ctx = await fetchContext(client, caseId);
              return withNextAction(
                jsonResult(ctx.data),
                nextActionFor(ctx.status)
              );
            }
            case "done":
            case "rejected": {
              return structuredError(
                `Case is terminal (status='${status}'). progress_case cannot advance a terminal case.`
              );
            }
            default: {
              return structuredError(
                `progress_case: unknown case status '${status ?? "<missing>"}'. Use force_target if the state machine does not cover this case.`
              );
            }
          }

          // 4. Re-fetch fresh state after any mutation.
          const fresh = await fetchContext(client, caseId);
          return withNextAction(
            jsonResult(fresh.data),
            nextActionFor(fresh.status)
          );
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "signal_exploration_complete",
      description:
        "[DEPRECATED — use progress_case] Signal that exploration phase is complete for a case. " +
        "Provide a markdown summary of what was explored and discovered. " +
        "This transitions the case from 'exploration' to 'ready_for_build'. " +
        "Retained for backward compatibility; will be removed in a future major version. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        summary: z
          .string()
          .describe(
            "Markdown summary of what was explored: codebase analysis, dependencies found, approach decided"
          ),
      },
      handler: async (args) => {
        try {
          const data = await client.post("/api/agent/explore", {
            case_id: args.case_id,
            summary: args.summary,
          });
          return withNextAction(
            jsonResult(data),
            nextActionFor("ready_for_build")
          );
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "signal_build_complete",
      description:
        "[DEPRECATED — use progress_case] Signal that the build phase is complete for a case. " +
        "Provide a summary of changes made, optionally with branch name, PR URL, and structured evidence items. " +
        "Retained for backward compatibility; will be removed in a future major version. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        summary: z
          .string()
          .describe(
            "Markdown summary of changes: files modified, approach taken, decisions made"
          ),
        branch: z
          .string()
          .optional()
          .describe("Git branch name where changes were made"),
        pr_url: z
          .string()
          .optional()
          .describe("Pull request URL if a PR was created"),
        evidence: z
          .array(EVIDENCE_ITEM_SCHEMA)
          .optional()
          .describe(
            "Array of evidence items produced during build. Each item requires 'type' and 'summary'. Avoid passing markdown reports as evidence — use the top-level 'summary' param for prose."
          ),
      },
      handler: async (args) => {
        try {
          const body: Record<string, unknown> = {
            case_id: args.case_id,
            summary: args.summary,
          };
          if (args.branch) body.branch = args.branch;
          if (args.pr_url) body.pr_url = args.pr_url;
          if (args.evidence) {
            body.evidence = stampEvidence(args.evidence);
          }
          const data = await client.post(
            "/api/agent/build-complete",
            withActorMetadata(body)
          );
          return withNextAction(
            jsonResult(data),
            nextActionFor("in_validation")
          );
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "get_agent_instructions",
      description:
        "[DEPRECATED — use progress_case + get_case_context] Get structured agent instructions for a case. " +
        "Returns phase-specific guidance on what the agent should do next. " +
        "Retained for backward compatibility; will be removed in a future major version.",
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
      },
      handler: createJsonHandler((args) =>
        client.get(`/api/agent/instructions/${args.case_id as string}`)
      ),
    },
  ];
}

function structuredError(message: string): ToolResult {
  return {
    ...textResult(message, true),
    structuredContent: { error: message, next_action: null },
  };
}

/**
 * Stamp each evidence item with the current actor_metadata (if known).
 * Preserves any caller-supplied `actor_metadata` on the item. Leaves
 * non-array inputs untouched.
 */
function stampEvidence(evidence: unknown): unknown {
  if (!Array.isArray(evidence)) return evidence;
  const meta = buildActorMetadata();
  if (meta === undefined) return evidence;
  return evidence.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const existing = (item as Record<string, unknown>).actor_metadata;
      if (existing !== undefined) return item;
      return { ...(item as Record<string, unknown>), actor_metadata: meta };
    }
    return item;
  });
}
