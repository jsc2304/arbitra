/**
 * Search and knowledge asset tools.
 */

import { z } from "zod";
import type { ArbitraClient } from "../client.js";
import {
  KNOWLEDGE_SCOPE_TYPES,
  KNOWLEDGE_TYPES,
} from "../constants.js";
import { createJsonHandler, type ToolDefinition } from "../types.js";
import { csvToArray } from "../tool-utils.js";

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "search",
      description:
        "Search across all Arbitra entities (cases, findings, knowledge assets, etc.). " +
        "Returns matching results with relevance ranking.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Search query — matches against titles, descriptions, and content"
          ),
      },
      handler: createJsonHandler((args) =>
        client.get("/api/search", {
          q: args.query as string,
        })
      ),
    },
    {
      name: "create_knowledge_asset",
      description:
        "Create a new knowledge asset (pattern, precedent, guideline, architecture decision, etc.). " +
        "Knowledge assets start in 'suggested' status and require human verification to become 'canonical'. " +
        "Do not create an asset without real content — `body` must explain the actual learning in markdown " +
        "(context, decision, consequences, examples). A title plus a one-line summary is not a knowledge asset.",
      inputSchema: {
        type: z
          .enum(KNOWLEDGE_TYPES)
          .describe("Type of knowledge asset"),
        title: z.string().min(1).describe("Title of the knowledge asset"),
        summary: z
          .string()
          .trim()
          .min(10, "summary must be at least 10 characters of real content")
          .describe("Brief summary (1-2 sentences, min 10 chars)"),
        body: z
          .string()
          .trim()
          .min(
            50,
            "body must be at least 50 characters of real content (use markdown to explain the learning — context, decision, consequences)"
          )
          .describe(
            "Full content of the knowledge asset in markdown (min 50 chars). Explain context, decision, and consequences — not a one-liner."
          ),
        scope_type: z
          .enum(KNOWLEDGE_SCOPE_TYPES)
          .default("project")
          .describe("Scope level of this knowledge"),
        scope_ref: z
          .string()
          .describe("Reference to the scope (e.g. project ID, repo ID)"),
        tags: z
          .string()
          .optional()
          .describe("Comma-separated tags for categorization"),
        source_case_refs: z
          .string()
          .optional()
          .describe("Comma-separated case IDs that this knowledge originated from"),
      },
      handler: createJsonHandler(async (args) => {
        const body: Record<string, unknown> = {
          type: args.type,
          title: args.title,
          summary: args.summary,
          body: args.body,
          scope_type: args.scope_type || "project",
          scope_ref: args.scope_ref,
        };
        const tags = csvToArray(args.tags as string | undefined);
        if (tags) {
          body.tags = tags;
        }
        const sourceCaseRefs = csvToArray(
          args.source_case_refs as string | undefined
        );
        if (sourceCaseRefs) {
          body.source_case_refs = sourceCaseRefs;
        }
        return client.post("/api/knowledge", body);
      }),
    },
  ];
}
