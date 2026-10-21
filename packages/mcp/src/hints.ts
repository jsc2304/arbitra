import { type ToolResult, type StructuredContent } from "./types.js";

/**
 * Structured next-action pointer for lifecycle tools.
 * Machine-readable counterpart to the human-facing `withHint` text.
 */
export interface NextAction {
  tool_to_call: string;
  why: string;
  expected_payload_keys: string[];
}

export interface LifecycleToolResult extends ToolResult {
  structuredContent: StructuredContent & { next_action: NextAction | null };
}

/**
 * Append a next_action hint to a tool result.
 */
export function withHint(result: ToolResult, hint: string): ToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text" as const, text: `\n---\nNext action: ${hint}` },
    ],
  };
}

/**
 * Attach a structured `next_action` field to a tool result's
 * `structuredContent`, and also append a human-readable hint text.
 *
 * Use for lifecycle tools (progress_case, transition_case,
 * signal_* and get_case_context) so that both LLMs and UIs get a
 * consistent, machine-readable pointer to the next step.
 */
export function withNextAction(
  result: ToolResult,
  next: NextAction | null
): LifecycleToolResult {
  const prior = (result.structuredContent ?? {}) as StructuredContent;
  const structuredContent: StructuredContent & { next_action: NextAction | null } = {
    ...prior,
    next_action: next,
  };
  const hintText = next
    ? `Call ${next.tool_to_call} — ${next.why}. Expected payload keys: ${next.expected_payload_keys.join(", ")}.`
    : "Case is terminal. No further tool calls required.";
  return {
    ...result,
    structuredContent,
    content: [
      ...result.content,
      { type: "text" as const, text: `\n---\nNext action: ${hintText}` },
    ],
  };
}
