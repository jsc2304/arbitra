/**
 * Knowledge asset tools: read-only listing of knowledge assets.
 */

import type { ArbitraClient } from "../client.js";
import { createJsonHandler, type ToolDefinition } from "../types.js";

export function tools(client: ArbitraClient): ToolDefinition[] {
  return [
    {
      name: "list_knowledge_assets",
      description:
        "List all knowledge assets. Knowledge assets are patterns, precedents, guidelines, and architecture decisions discovered during case reviews.",
      inputSchema: {},
      handler: createJsonHandler(async () => client.get("/api/knowledge")),
    },
  ];
}
