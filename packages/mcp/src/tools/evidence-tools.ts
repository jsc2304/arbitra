/**
 * Evidence, comments, and findings tools.
 */

import { z } from "zod";
import type { ArbitraClient } from "../client.js";
import {
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_TYPES,
} from "../constants.js";
import {
  createJsonHandler,
  jsonResult,
  errorResult,
  type ToolDefinition,
} from "../types.js";
import { pickDefined } from "../tool-utils.js";
import { withActorMetadata } from "../actor-metadata.js";
import { SHARE_URL_HINT } from "../share-url.js";

/**
 * Maps the agent-facing `resolution` label to a leading phrase for the
 * human-readable resolution note persisted on the finding. The backend stores
 * the full string in `finding.resolution`; the label just anchors it.
 */
const RESOLUTION_LABELS = {
  waived: "Waived",
  resolved: "Resolved",
  false_positive: "False positive",
} as const;

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "register_evidence",
      description:
        "Register evidence for a case (test results, CI output, screenshots, etc.). " +
        "Evidence is required before a case can progress through validation. " +
        "PREFERRED: pass evidence inline to `progress_case` in the same call that advances the case. " +
        "For a MANUAL ATTESTATION (a human confirming something by hand) use the canonical type " +
        "`manual_confirmation` — NOT a free-form type like `manual_verification`, which the Arbitra server rejects. " +
        "This tool remains fully supported as an alternative to inline evidence and is NOT going away. " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        type: z
          .enum(EVIDENCE_TYPES)
          .describe("Type of evidence being registered"),
        source_type: z
          .enum(EVIDENCE_SOURCE_TYPES)
          .default("agent")
          .describe("How this evidence was collected"),
        summary: z
          .string()
          .optional()
          .describe(
            "Human-readable summary of the evidence (e.g. '42/42 tests pass', 'No lint warnings')"
          ),
        artifact_ref: z
          .string()
          .optional()
          .describe("Reference to an artifact (e.g. file path, URL)"),
        machine_readable: z
          .boolean()
          .optional()
          .describe("Whether the evidence is machine-parseable (default false)"),
      },
      handler: createJsonHandler(async (args) => {
        const body: Record<string, unknown> = {
          case_id: args.case_id,
          type: args.type,
          source_type: args.source_type || "agent",
          ...pickDefined(args, ["summary", "artifact_ref", "machine_readable"]),
        };
        return client.post(
          `/api/cases/${args.case_id as string}/evidence`,
          withActorMetadata(body)
        );
      }),
    },
    {
      name: "get_evidence_requirements",
      description:
        "Get the evidence requirements for a case based on its risk level and validation track. " +
        "Shows which evidence types are required, which are optional, and which are already satisfied.",
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
      },
      handler: createJsonHandler((args) =>
        client.get(`/api/cases/${args.case_id as string}/evidence/requirements`)
      ),
    },
    {
      name: "add_comment",
      description:
        "Add a comment to a case. Comments are visible in the case timeline and can be used " +
        "for status updates, questions, or notes. " +
        "Write the comment in the project's default_language (see get_case_context / arbitra://defaults). " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        body: z.string().describe("Comment text (supports markdown)"),
      },
      handler: createJsonHandler((args) =>
        client.post(
          `/api/cases/${args.case_id as string}/comments`,
          withActorMetadata({ body: args.body as string })
        )
      ),
    },
    {
      name: "list_findings",
      description:
        "List review findings for a case. Findings are generated during the review phase " +
        "and represent issues, suggestions, or observations from the review engine.",
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
      },
      handler: createJsonHandler((args) =>
        client.get(`/api/cases/${args.case_id as string}/findings`)
      ),
    },
    {
      name: "resolve_finding",
      description:
        "Propose waiving/resolving a specific review finding — e.g. after analysis you conclude it is a false positive. " +
        "HUMAN-IN-THE-LOOP, scoped: the proposal lands the finding in `waiver_proposed`, which blocks approval only where findings gate at all (high/critical severity); " +
        "low/medium/info findings never gate approval, and auto-approve may already have fired before your proposal exists. " +
        "A human confirms it (Waive/Approve in the Courtroom) while the case is in a decision phase. " +
        "A proposal still open when the case completes is closed administratively as `waived_on_completion` — a system-recorded decision, no human confirmation. " +
        "So: propose BEFORE approval; if the finding is real and you fixed the code, prefer the loopback (`create_decision(type: request_changes)` → fix in `in_build` → re-review) over a post-approval proposal. " +
        "It mirrors `create_knowledge_asset`, which lands assets as `suggested` — the agent proposes, a human confirms. " +
        "The proposal records your rationale onto the finding's resolution note and does NOT transition the case. " +
        "To capture the learning, first `create_knowledge_asset` and pass its id as `knowledge_asset_ref` here so the KA is linked to the waiver. " +
        "Write the rationale in the project's default_language (see get_case_context / arbitra://defaults). " +
        SHARE_URL_HINT,
      inputSchema: {
        case_id: z.string().describe("The Arbitra case ID"),
        finding_id: z
          .string()
          .describe("The ID of the finding to propose waiving/resolving"),
        resolution: z
          .enum(["waived", "resolved", "false_positive"])
          .describe(
            "How you are proposing to resolve the finding: 'waived' (excused with rationale), 'resolved' (addressed), or 'false_positive' (the finding is wrong)."
          ),
        rationale: z
          .string()
          .trim()
          .min(
            10,
            "rationale must be at least 10 characters — explain WHY the finding is waived/resolved/a false positive (this is the audit record)"
          )
          .max(5000)
          .describe(
            "Required. Evidence-backed explanation for the proposed resolution. Lives in the audit trail and on the finding's resolution note."
          ),
        severity_contested: z
          .boolean()
          .optional()
          .describe(
            "Set true if you also dispute the finding's assigned severity (not just its validity)."
          ),
        knowledge_asset_ref: z
          .string()
          .optional()
          .describe(
            "Optional knowledge-asset id (from a prior create_knowledge_asset call) to link to this waiver — e.g. the precedent explaining why this class of finding is a false positive."
          ),
      },
      handler: async (args) => {
        try {
          const caseId = args.case_id as string;
          const label = RESOLUTION_LABELS[args.resolution as keyof typeof RESOLUTION_LABELS];
          const rationale = args.rationale as string;
          // The backend `propose_waiver` decision writes the `resolution` string
          // onto the finding. Anchor it with the chosen label so the note reads
          // e.g. "False positive — <rationale>".
          const resolutionNote = `${label} — ${rationale}`;
          const body: Record<string, unknown> = {
            type: "propose_waiver",
            finding_id: args.finding_id,
            rationale,
            resolution: resolutionNote,
            ...pickDefined(args, ["severity_contested", "knowledge_asset_ref"]),
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
  ];
}
