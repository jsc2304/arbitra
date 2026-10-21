/**
 * Case management tools: CRUD, transitions, field detection.
 */

import { z } from "zod";
import type { ArbitraClient } from "../client.js";
import {
  CASE_STATUSES,
  CASE_TYPES,
  DECISION_TYPES,
  PRIORITIES,
  RISK_LEVELS,
  SOURCE_TYPES,
  VALIDATION_TRACKS,
} from "../constants.js";
import { withNextAction } from "../hints.js";
import { nextActionFor } from "../lifecycle.js";
import {
  createJsonHandler,
  jsonResult,
  errorResult,
  type ToolDefinition,
} from "../types.js";
import { csvToArray, pickDefined } from "../tool-utils.js";
import { withActorMetadata } from "../actor-metadata.js";
import { SHARE_URL_HINT } from "../share-url.js";

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "create_case",
      description:
        "Create a new Arbitra case. A case represents a unit of work to be reviewed and validated. " +
        "Pass `git_context.branch` when the branch name is already chosen, so that follow-up PR webhooks can link to this case automatically. Skip only when the branch is not yet known. " +
        "The legacy flat fields `git_branch` / `git_remote_url` remain accepted for backward compatibility; prefer the structured `git_context` object for new integrations. " +
        SHARE_URL_HINT,
      inputSchema: {
        title: z.string().describe("Case title — concise description of the work"),
        description: z
          .string()
          .describe(
            "Detailed description of what needs to be done. Write it in the project's default_language (see get_case_context / arbitra://defaults)."
          ),
        project_id: z.string().describe("Project ID this case belongs to"),
        repository_id: z.string().describe("Repository ID this case belongs to"),
        source_type: z
          .enum(SOURCE_TYPES)
          .default("manual")
          .describe("How this case was created"),
        source_ref: z
          .string()
          .optional()
          .describe("External reference (e.g. JIRA ticket ID)"),
        validation_track: z
          .enum(VALIDATION_TRACKS)
          .default("direct")
          .describe("Validation track: 'direct' (automated) or 'manual'"),
        risk_level: z
          .enum(RISK_LEVELS)
          .default("medium")
          .describe("Risk level of the change"),
        priority: z
          .enum(PRIORITIES)
          .default("normal")
          .describe("Priority of this case"),
        case_type: z
          .enum(CASE_TYPES)
          .optional()
          .describe("Type of case"),
        git_context: z
          .object({
            branch: z
              .string()
              .optional()
              .describe(
                "If the agent has already selected/created the branch for the work, pass the exact branch name here. Enables the Arbitra server webhook to link incoming PRs to this case without guessing from branch-name conventions."
              ),
            remote_url: z
              .string()
              .optional()
              .describe(
                "Git remote URL, e.g. 'https://github.com/org/repo.git' or 'git@github.com:org/repo.git'. Used to resolve the repository when `repository_id` is ambiguous."
              ),
            commit_sha: z
              .string()
              .optional()
              .describe(
                "Current commit SHA on the working branch. Optional; helpful for evidence replay and for pinning the case to a specific tree state."
              ),
          })
          .optional()
          .describe(
            "Structured git context. Prefer passing `git_context.branch` whenever the branch already exists, so webhooks can link incoming PRs to this case up-front (no branch-name-regex fallback needed)."
          ),
        git_branch: z
          .string()
          .optional()
          .describe(
            "DEPRECATED (legacy): current git branch name. Prefer `git_context.branch`. Used only when `git_context` is not provided."
          ),
        git_remote_url: z
          .string()
          .optional()
          .describe(
            "DEPRECATED (legacy): git remote URL. Prefer `git_context.remote_url`. Used only when `git_context` is not provided."
          ),
        jira_refs: z
          .string()
          .optional()
          .describe("Comma-separated JIRA ticket references"),
        assigned_reviewer_id: z
          .string()
          .optional()
          .describe("User ID of assigned reviewer"),
      },
      handler: async (args) => {
        try {
          const body: Record<string, unknown> = {
            title: args.title,
            description: args.description,
            project_id: args.project_id,
            repository_id: args.repository_id,
            source_type: args.source_type || "manual",
            validation_track: args.validation_track || "direct",
            risk_level: args.risk_level || "medium",
            priority: args.priority || "normal",
            ...pickDefined(args, [
              "source_ref",
              "case_type",
              "assigned_reviewer_id",
            ]),
          };
          const jiraRefs = csvToArray(args.jira_refs as string | undefined);
          if (jiraRefs) {
            body.jira_refs = jiraRefs;
          }
          // Structured git_context wins; legacy flat fields are a fallback.
          const explicit = args.git_context as
            | { branch?: string; remote_url?: string; commit_sha?: string }
            | undefined;
          if (explicit && (explicit.branch || explicit.remote_url || explicit.commit_sha)) {
            const gitContext: Record<string, unknown> = {};
            if (explicit.branch) gitContext.branch = explicit.branch;
            if (explicit.remote_url) gitContext.remote_url = explicit.remote_url;
            if (explicit.commit_sha) gitContext.commit_sha = explicit.commit_sha;
            body.git_context = gitContext;
          } else if (args.git_branch || args.git_remote_url) {
            const gitContext: Record<string, unknown> = {};
            if (args.git_branch) gitContext.branch = args.git_branch;
            if (args.git_remote_url) gitContext.remote_url = args.git_remote_url;
            body.git_context = gitContext;
          }
          const data = await client.post("/api/cases", body);
          const status = (data as { status?: string }).status ?? "open";
          return withNextAction(jsonResult(data), nextActionFor(status));
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "list_cases",
      description:
        "List Arbitra cases with optional filters. Returns lightweight rows sorted by most recently updated. " +
        "For actionable context on a single case, follow up with `get_case_context(case_id)` rather than `get_case` plus separate findings/evidence/rules lookups.",
      inputSchema: {
        status: z
          .enum(CASE_STATUSES)
          .optional()
          .describe("Filter by case status"),
        project_id: z.string().optional().describe("Filter by project ID"),
        risk_level: z
          .enum(RISK_LEVELS)
          .optional()
          .describe("Filter by risk level"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Max number of cases to return (default 20, max 100)"),
      },
      handler: createJsonHandler(async (args) => {
        const params: Record<string, string> = {};
        if (args.status) params.status = args.status as string;
        if (args.project_id) params.project_id = args.project_id as string;
        if (args.risk_level) params.risk_level = args.risk_level as string;
        if (args.limit) params.limit = String(args.limit);
        return client.get("/api/cases", params);
      }),
    },
    {
      name: "get_case",
      description:
        "Get a single Arbitra case by ID. Returns full case details including status, risk level, and metadata. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
      },
      handler: createJsonHandler((args) =>
        client.get(`/api/cases/${args.case_id as string}`)
      ),
    },
    {
      name: "update_case",
      description:
        "Update an existing Arbitra case. Only provided fields are updated; omitted fields remain unchanged. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID to update"),
        title: z.string().optional().describe("Updated case title"),
        description: z.string().optional().describe("Updated case description"),
        risk_level: z
          .enum(RISK_LEVELS)
          .optional()
          .describe("Updated risk level"),
        priority: z
          .enum(PRIORITIES)
          .optional()
          .describe("Updated priority"),
        validation_track: z
          .enum(VALIDATION_TRACKS)
          .optional()
          .describe("Updated validation track"),
        case_type: z
          .enum(CASE_TYPES)
          .optional()
          .describe("Updated case type"),
        current_branch: z
          .string()
          .optional()
          .describe("Updated git branch name"),
        current_pr_ref: z
          .string()
          .optional()
          .describe("Updated PR reference"),
        jira_refs: z
          .string()
          .optional()
          .describe("Comma-separated JIRA refs (replaces existing)"),
        assigned_reviewer_id: z
          .string()
          .optional()
          .describe("Updated reviewer user ID"),
      },
      handler: createJsonHandler(async (args) => {
        const caseId = args.case_id as string;
        const body = pickDefined(args, [
          "title",
          "description",
          "risk_level",
          "priority",
          "validation_track",
          "case_type",
          "current_branch",
          "current_pr_ref",
          "assigned_reviewer_id",
        ]);
        const jiraRefs = csvToArray(args.jira_refs as string | undefined);
        if (jiraRefs !== undefined) {
          body.jira_refs = jiraRefs;
        }
        return client.patch(`/api/cases/${caseId}`, body);
      }),
    },
    {
      name: "transition_case",
      description:
        "Transition a case to a new status. The transition must be valid according to the state machine. " +
        "Common flows: open -> exploration -> ready_for_build -> in_build -> in_validation -> in_review -> approved -> done. " +
        "To reject a case, use `create_decision(type='reject', rationale=...)` instead — direct transitions to `rejected` are gated by an `explicit_rejection` precondition that only a formal decision satisfies. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        target_status: z
          .enum(CASE_STATUSES)
          .describe("Target case status to transition to"),
      },
      handler: async (args) => {
        try {
          const data = await client.post(
            `/api/cases/${args.case_id as string}/transition`,
            { target_status: args.target_status }
          );
          const newStatus =
            (data as { status?: string }).status ??
            (args.target_status as string);
          return withNextAction(jsonResult(data), nextActionFor(newStatus));
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "create_decision",
      description:
        "File a formal decision on a case. Use this when the user asks you to act as a reviewer — approve, reject, or request changes with a recorded rationale. " +
        "For the informal 'user found a bug, send it back' flow, use `transition_case` + `add_comment` instead. " +
        "Decisions create an audit trail; transitions do not. " +
        "Use `merge_not_applicable` when the case has no PR and never will (work done outside the repo, e.g. instance-side configuration): from `pending_merge` or `approved` it drives the case to `done`. " +
        "The backend rejects `merge_not_applicable` when the case has a PR reference (`current_pr_ref`) — the `pr_merged` gate stays authoritative for cases with a real PR. " +
        "Anti-gaming: the backend rejects self-approval unless the effective evidence-policy cell permits it (case owner cannot approve their own case).",
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        type: z
          .enum(DECISION_TYPES)
          .describe(
            "Decision type: 'approve' (case passes), 'reject' (case fails, terminal), 'request_changes' (send case back to in_build for fixes), or 'merge_not_applicable' (no PR/merge applies — work done outside the repo; completes the case from pending_merge/approved; rejected when the case has a PR reference)."
          ),
        rationale: z
          .string()
          .min(10)
          .max(5000)
          .describe(
            "Reviewer rationale for the decision. Lives in the audit trail — be specific: what was approved, why it was rejected, or what changes are requested."
          ),
        finding_id: z
          .string()
          .optional()
          .describe(
            "Optional finding ID to scope the decision to a specific finding (e.g. waive/approve/reject that finding only). Omit for a case-level decision."
          ),
      },
      handler: async (args) => {
        try {
          const caseId = args.case_id as string;
          const body: Record<string, unknown> = {
            type: args.type,
            rationale: args.rationale,
            ...pickDefined(args, ["finding_id"]),
          };
          const data = await client.post(
            `/api/cases/${caseId}/decisions`,
            withActorMetadata(body)
          );
          return jsonResult(data);
        } catch (e) {
          return errorResult(e);
        }
      },
    },
    {
      name: "detect_case_fields",
      description:
        "Use AI to detect case fields (title, description, risk level, case type) from a natural language prompt. " +
        "Useful for auto-populating case creation forms.",
      inputSchema: {
        prompt: z
          .string()
          .describe(
            "Natural language description of the work to be done. AI will extract structured fields from this."
          ),
        project_id: z
          .string()
          .optional()
          .describe("Project context for better detection"),
      },
      handler: createJsonHandler(async (args) => {
        const body: Record<string, unknown> = { prompt: args.prompt };
        if (args.project_id) body.project_id = args.project_id;
        return client.post("/api/cases/detect", body);
      }),
    },
  ];
}
