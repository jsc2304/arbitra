/**
 * Project and repository tools: list projects, get project details, list repositories.
 */

import { z } from "zod";
import type { ArbitraClient } from "../client.js";
import { createJsonHandler, type ToolDefinition } from "../types.js";

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "list_projects",
      description:
        "List all projects you can see. Projects group cases, rules, and repositories. " +
        "For case-bound work, `get_case_context` already returns the case's project — only call `list_projects` when registering a new case or browsing setup state.",
      inputSchema: {},
      handler: createJsonHandler(async () => client.get("/api/projects")),
    },
    {
      name: "get_project",
      description:
        "Get a single project by ID. Returns reviewer pool, tech leads, and default rule sets — fields that `get_case_context` does NOT include. " +
        "For everything else about a case's project, prefer `get_case_context(case_id)`.",
      inputSchema: {
        project_id: z.string().describe("The project ID"),
      },
      handler: createJsonHandler((args) =>
        client.get(`/api/projects/${args.project_id as string}`)
      ),
    },
    {
      name: "list_repositories",
      description:
        "List repositories linked to a project. Requires `project_id`. " +
        "For case-bound work prefer `get_case_context(case_id)` — it returns the case's `repository_id` directly.",
      inputSchema: {
        project_id: z
          .string()
          .describe("The project ID to list repositories for"),
      },
      handler: createJsonHandler((args) =>
        client.get(`/api/projects/${args.project_id as string}/repositories`)
      ),
    },
  ];
}
