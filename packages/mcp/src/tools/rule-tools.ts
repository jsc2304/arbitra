/**
 * Rule and rule set management tools: CRUD, status updates.
 */

import { z } from "zod";
import type { ArbitraClient } from "../client.js";
import {
  EVALUATION_MODES,
  RULE_CATEGORIES,
  RULE_STATUSES,
  SCOPE_LAYERS,
  SEVERITIES,
} from "../constants.js";
import { createJsonHandler, type ToolDefinition } from "../types.js";
import { csvToArray, pickDefined } from "../tool-utils.js";

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "list_rules",
      description:
        "List all rules and rule sets. Returns both rules and their grouping into rule sets.",
      inputSchema: {},
      handler: createJsonHandler(async () => client.get("/api/rules")),
    },
    {
      name: "create_rule",
      description:
        "Create a new rule. Rules check individual aspects of a case during review. " +
        "The rule is always created in `draft` status — it does not evaluate until activated. " +
        "Call `update_rule(rule_id, status: 'active')` once it's ready.",
      inputSchema: {
        name: z.string().describe("Rule name"),
        category: z
          .enum(RULE_CATEGORIES)
          .describe("Rule category"),
        evaluation_mode: z
          .enum(EVALUATION_MODES)
          .describe("How the rule is evaluated"),
        severity_if_failed: z
          .enum(SEVERITIES)
          .describe("Severity when rule fails"),
        config: z
          .string()
          .describe(
            'JSON string of evaluation config (e.g. {"pattern": "console\\\\.log"}). Structure depends on evaluation_mode.'
          ),
        description: z
          .string()
          .min(1)
          .describe("What the rule checks"),
        rationale: z
          .string()
          .min(1)
          .describe("Why this rule exists"),
        scope_layer: z
          .enum(SCOPE_LAYERS)
          .default("project")
          .describe(
            "Scope layer. 'project' (default) scopes the rule to a single project via scope_ref. " +
              "'global' applies the rule everywhere and is admin-only."
          ),
        scope_ref: z
          .string()
          .optional()
          .describe(
            "Scope reference (e.g. project ID). Required when scope_layer is 'project'; omit for 'global'."
          ),
      },
      handler: createJsonHandler(async (args) => {
        let parsedConfig: unknown;
        try {
          parsedConfig = JSON.parse(args.config as string);
        } catch {
          throw new Error("Invalid JSON in config parameter");
        }
        const scopeLayer = (args.scope_layer as string | undefined) || "project";
        const scopeRef = args.scope_ref as string | undefined;
        if (scopeLayer === "project" && !scopeRef) {
          throw new Error(
            "scope_ref is required when scope_layer is 'project' (pass scope_layer: 'global' for an admin-only global rule instead)."
          );
        }
        const body: Record<string, unknown> = {
          name: args.name,
          category: args.category,
          evaluation_mode: args.evaluation_mode,
          severity_if_failed: args.severity_if_failed,
          config: parsedConfig,
          description: args.description,
          rationale: args.rationale,
          scope: { layer: scopeLayer, ref: scopeRef },
        };
        return client.post("/api/rules", body);
      }),
    },
    {
      name: "update_rule",
      description:
        "Update a rule's status (activate, deactivate, or set to draft).",
      inputSchema: {
        rule_id: z.string().describe("The rule ID"),
        status: z
          .enum(RULE_STATUSES)
          .describe("New rule status"),
      },
      handler: createJsonHandler((args) =>
        client.patch(`/api/rules/${args.rule_id as string}`, {
          status: args.status,
        })
      ),
    },
    {
      name: "create_rule_set",
      description:
        "Create a rule set that groups rules together. Rule sets are assigned to projects.",
      inputSchema: {
        name: z.string().describe("Rule set name"),
        description: z
          .string()
          .optional()
          .describe("What this rule set covers"),
        project_id: z
          .string()
          .optional()
          .describe("Project ID to assign this rule set to"),
        rule_refs: z
          .string()
          .describe("Comma-separated rule IDs to include"),
        status: z
          .enum(RULE_STATUSES)
          .default("active")
          .describe("Initial status"),
      },
      handler: createJsonHandler(async (args) => {
        const body: Record<string, unknown> = {
          name: args.name,
          status: args.status || "active",
          ...pickDefined(args, ["description", "project_id"]),
          rule_refs: csvToArray(args.rule_refs as string) || [],
        };
        return client.post("/api/rule-sets", body);
      }),
    },
    {
      name: "update_rule_set",
      description: "Update a rule set's status.",
      inputSchema: {
        rule_set_id: z.string().describe("The rule set ID"),
        status: z
          .enum(RULE_STATUSES)
          .describe("New status"),
      },
      handler: createJsonHandler((args) =>
        client.patch(`/api/rule-sets/${args.rule_set_id as string}`, {
          status: args.status,
        })
      ),
    },
  ];
}
