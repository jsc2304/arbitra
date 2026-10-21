/**
 * Tests for rule-tools.
 *
 * Focused on `create_rule` — the request body must match the backend's
 * `createRuleSchema` (`packages/shared/src/validation/rule-validators.ts`):
 * a nested `scope: { layer, ref }` object (not flat `scope_layer`/`scope_ref`
 * keys), required non-empty `description`/`rationale`, and no `status` key
 * (the route hardcodes `draft`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "./rule-tools.js";
import type { ArbitraClient } from "../client.js";
import type { ToolDefinition } from "../types.js";

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

interface FakeClientOptions {
  postImpl?: (path: string, body?: unknown) => Promise<unknown>;
}

function makeFakeClient(options: FakeClientOptions = {}): {
  client: ArbitraClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fake = {
    async get(path: string) {
      calls.push({ method: "GET", path });
      return null;
    },
    async post(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      if (options.postImpl) return options.postImpl(path, body);
      return { id: "rule_abc", status: "draft" };
    },
    async patch(path: string, body: unknown) {
      calls.push({ method: "PATCH", path, body });
      return { ok: true };
    },
  } as unknown as ArbitraClient;
  return { client: fake, calls };
}

function findTool(defs: ToolDefinition[], name: string): ToolDefinition {
  const tool = defs.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

test("create_rule POSTs a nested scope object, not flat scope_layer/scope_ref keys", async () => {
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  const result = await tool.handler({
    name: "No console.log in production code",
    category: "code_quality_rule",
    evaluation_mode: "diff_pattern",
    severity_if_failed: "medium",
    config: '{"pattern": "console\\\\.log"}',
    description: "Flags console.log statements left in diffs.",
    rationale: "Debug statements should not ship to production.",
    scope_layer: "project",
    scope_ref: "proj_1",
  });
  assert.equal(result.isError, undefined);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/rules");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.scope, { layer: "project", ref: "proj_1" });
  // Flat keys must not leak into the body — the backend schema only accepts
  // a nested `scope` object.
  assert.equal("scope_layer" in body, false);
  assert.equal("scope_ref" in body, false);
});

test("create_rule omits status — the backend hardcodes draft on creation", async () => {
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  await tool.handler({
    name: "No console.log in production code",
    category: "code_quality_rule",
    evaluation_mode: "diff_pattern",
    severity_if_failed: "medium",
    config: "{}",
    description: "Flags console.log statements left in diffs.",
    rationale: "Debug statements should not ship to production.",
    scope_layer: "project",
    scope_ref: "proj_1",
  });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.equal("status" in body, false);
});

test("create_rule forwards description and rationale unchanged", async () => {
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  await tool.handler({
    name: "No console.log in production code",
    category: "code_quality_rule",
    evaluation_mode: "diff_pattern",
    severity_if_failed: "medium",
    config: "{}",
    description: "Flags console.log statements left in diffs.",
    rationale: "Debug statements should not ship to production.",
    scope_layer: "project",
    scope_ref: "proj_1",
  });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.description, "Flags console.log statements left in diffs.");
  assert.equal(body.rationale, "Debug statements should not ship to production.");
});

test("create_rule defaults scope_layer to project and requires scope_ref for it", async () => {
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  const result = await tool.handler({
    name: "No console.log in production code",
    category: "code_quality_rule",
    evaluation_mode: "diff_pattern",
    severity_if_failed: "medium",
    config: "{}",
    description: "Flags console.log statements left in diffs.",
    rationale: "Debug statements should not ship to production.",
    // scope_layer/scope_ref omitted entirely.
  });
  assert.equal(result.isError, true);
  const text = result.content?.[0]?.text ?? "";
  assert.ok(
    text.includes("scope_ref is required"),
    `expected a scope_ref-required error, got: ${text}`
  );
  // Must fail before ever reaching the network.
  assert.equal(calls.find((c) => c.method === "POST"), undefined);
});

test("create_rule allows global scope without a scope_ref", async () => {
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  const result = await tool.handler({
    name: "Org-wide security baseline",
    category: "security_rule",
    evaluation_mode: "metadata_check",
    severity_if_failed: "critical",
    config: "{}",
    description: "Baseline security check applied to every project.",
    rationale: "Security floor should not be optional per project.",
    scope_layer: "global",
  });
  assert.equal(result.isError, undefined);
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.scope, { layer: "global", ref: undefined });
});

test("create_rule schema requires non-empty description and rationale", () => {
  const { client } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  const schema = tool.inputSchema as Record<
    string,
    { safeParse?: (v: unknown) => { success: boolean } }
  >;
  assert.equal(schema.description?.safeParse?.("").success, false);
  assert.equal(schema.description?.safeParse?.("Some description").success, true);
  assert.equal(schema.rationale?.safeParse?.("").success, false);
  assert.equal(schema.rationale?.safeParse?.("Some rationale").success, true);
  // description/rationale are no longer optional: undefined must fail.
  assert.equal(schema.description?.safeParse?.(undefined).success, false);
  assert.equal(schema.rationale?.safeParse?.(undefined).success, false);
});

test("create_rule schema no longer exposes a status field", () => {
  const { client } = makeFakeClient();
  const tool = findTool(tools(client), "create_rule");
  assert.equal("status" in tool.inputSchema, false);
});

test("create_rule surfaces backend error as isError result", async () => {
  const { client } = makeFakeClient({
    postImpl: async () => {
      throw new Error("400 Bad Request: scope.ref is required when scope.layer is 'project'");
    },
  });
  const tool = findTool(tools(client), "create_rule");
  const result = await tool.handler({
    name: "No console.log in production code",
    category: "code_quality_rule",
    evaluation_mode: "diff_pattern",
    severity_if_failed: "medium",
    config: "{}",
    description: "Flags console.log statements left in diffs.",
    rationale: "Debug statements should not ship to production.",
    scope_layer: "project",
    scope_ref: "proj_1",
  });
  assert.equal(result.isError, true);
  const text = result.content?.[0]?.text ?? "";
  assert.ok(text.includes("400"), `expected backend error text in result, got: ${text}`);
});
