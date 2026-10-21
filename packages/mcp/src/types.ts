/**
 * Shared result helpers for MCP tool responses.
 */

import type { ZodRawShape } from "zod";
import { ArbitraApiError } from "./client.js";
import type { ArbitraClient } from "./client.js";

export type ToolArgs = Record<string, unknown>;
export type StructuredContent = Record<string, unknown>;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: StructuredContent;
  isError?: boolean;
  /**
   * HTTP status of the underlying `ArbitraApiError` when a tool handler
   * swallowed an API error into this result. The `withCredsRetry` wrapper
   * reads this to detect a 401 (expired/invalid token) so it can fall through
   * to the Connect device-flow re-auth path instead of returning a dead-end
   * "Invalid or expired access token" to the agent. Internal signal only — not
   * part of the MCP wire format. `withCredsRetry` reads this tag and then
   * strips it from the result before returning to the client, so it never
   * leaks onto the wire.
   */
  _apiErrorStatus?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: ToolArgs, extra?: unknown) => Promise<ToolResult>;
}

export type ToolFactory = (client: ArbitraClient) => ToolDefinition[];

export function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError && { isError: true }),
  };
}

export function jsonResult(data: unknown, isError = false): ToolResult {
  const text = JSON.stringify(data ?? null, null, 2);
  const structuredContent =
    data && typeof data === "object"
      ? Array.isArray(data)
        ? { data }
        : (data as StructuredContent)
      : { data: data ?? null };
  return {
    ...textResult(text, isError),
    structuredContent,
  };
}

export function errorResult(error: unknown): ToolResult {
  if (error instanceof ArbitraApiError) {
    // Tag the HTTP status so withCredsRetry can recognise a 401 and route to
    // re-auth instead of returning a bare error to the agent.
    return { ...textResult(error.message, true), _apiErrorStatus: error.status };
  }
  if (error instanceof Error) {
    return textResult(error.message, true);
  }
  return textResult(String(error), true);
}

export function createJsonHandler<T extends ToolArgs>(
  fn: (args: T) => Promise<unknown>
): ToolDefinition["handler"] {
  return async (args) => {
    try {
      return jsonResult(await fn(args as T));
    } catch (error) {
      return errorResult(error);
    }
  };
}
