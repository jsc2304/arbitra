/**
 * MCP resources for case data.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ArbitraClient } from "../client.js";
import { extractCaseIdFromResourceUri } from "./resource-uri.js";

export function registerResources(
  server: McpServer,
  client: ArbitraClient
): void {
  server.resource(
    "case",
    "arbitra://case/{caseId}",
    {
      description:
        "Arbitra case details. Provides full case metadata, status, and configuration.",
    },
    async (uri) => {
      const caseId = extractCaseIdFromResourceUri(uri);
      const data = await client.get(`/api/cases/${caseId}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    "case-context",
    "arbitra://case/{caseId}/context",
    {
      description:
        "Full agent context for an Arbitra case including findings, evidence, rules, and knowledge.",
    },
    async (uri) => {
      const caseId = extractCaseIdFromResourceUri(uri);
      const data = await client.get(`/api/agent/context/${caseId}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
