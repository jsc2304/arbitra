/**
 * Tests for case-tools.
 *
 * Focused on `create_decision` — the other case tools (create_case,
 * list_cases, get_case, update_case, transition_case, detect_case_fields)
 * are thin REST wrappers exercised indirectly via agent-tools.test.ts
 * (progress_case) and the live integration environment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "./case-tools.js";
import type { ArbitraClient } from "../client.js";
import type { ToolDefinition } from "../types.js";
import {
  resetClientInfoForTests,
  setClientInfo,
} from "../actor-metadata.js";

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
      return { ok: true, decision_id: "decision_abc" };
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

test("create_decision POSTs to /api/cases/:caseId/decisions with type + rationale", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_decision");
  const result = await tool.handler({
    case_id: "case_123",
    type: "approve",
    rationale: "All tests pass and evidence is sufficient.",
  });
  assert.equal(result.isError, undefined);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/cases/case_123/decisions");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.type, "approve");
  assert.equal(body.rationale, "All tests pass and evidence is sufficient.");
  // finding_id omitted when not provided — do not send undefined keys.
  assert.equal("finding_id" in body, false);
});

test("create_decision forwards optional finding_id when provided", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_decision");
  await tool.handler({
    case_id: "case_123",
    type: "request_changes",
    rationale: "Need better unit-test coverage on the new path.",
    finding_id: "finding_xyz",
  });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.finding_id, "finding_xyz");
  assert.equal(body.type, "request_changes");
});

test("create_decision injects actor_metadata from MCP handshake", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "Claude-Code", version: "2.0.0" });
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_decision");
  await tool.handler({
    case_id: "case_123",
    type: "reject",
    rationale: "Approach conflicts with an existing architecture rule.",
  });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.actor_metadata, {
    client_name: "claude-code",
    client_version: "2.0.0",
  });
  resetClientInfoForTests();
});

test("create_decision omits actor_metadata when client info is unknown", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "create_decision");
  await tool.handler({
    case_id: "case_123",
    type: "approve",
    rationale: "All checks green — approving.",
  });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.actor_metadata, undefined);
});

test("create_decision surfaces backend error as isError result", async () => {
  resetClientInfoForTests();
  const { client } = makeFakeClient({
    postImpl: async () => {
      throw new Error("409 Conflict: open high/critical findings block approval");
    },
  });
  const tool = findTool(tools(client), "create_decision");
  const result = await tool.handler({
    case_id: "case_123",
    type: "approve",
    rationale: "Trying to approve with open blockers.",
  });
  assert.equal(result.isError, true);
  const text = result.content?.[0]?.text ?? "";
  assert.ok(text.includes("409"), `expected backend error text in result, got: ${text}`);
});

test("create_case forwards git_context.branch unchanged in POST body", async () => {
  const { client, calls } = makeFakeClient({
    postImpl: async () => ({ id: "case_1", status: "open" }),
  });
  const tool = findTool(tools(client), "create_case");
  const result = await tool.handler({
    title: "Wire new webhook handler",
    description: "Implement hybrid case lookup by branch name.",
    project_id: "proj_1",
    repository_id: "repo_1",
    git_context: {
      branch: "feat/webhook-hybrid-lookup",
      remote_url: "https://github.com/org/repo.git",
      commit_sha: "deadbeef",
    },
  });
  assert.equal(result.isError, undefined);
  const post = calls.find((c) => c.method === "POST" && c.path === "/api/cases");
  assert.ok(post, "expected POST /api/cases");
  const body = post.body as Record<string, unknown>;
  assert.deepEqual(body.git_context, {
    branch: "feat/webhook-hybrid-lookup",
    remote_url: "https://github.com/org/repo.git",
    commit_sha: "deadbeef",
  });
  // Legacy keys must not leak into the body when the structured object is used.
  assert.equal("git_branch" in body, false);
  assert.equal("git_remote_url" in body, false);
});

test("create_case falls back to legacy git_branch/git_remote_url when git_context is absent", async () => {
  const { client, calls } = makeFakeClient({
    postImpl: async () => ({ id: "case_2", status: "open" }),
  });
  const tool = findTool(tools(client), "create_case");
  await tool.handler({
    title: "Legacy caller",
    description: "Older IDE client still passing flat git fields.",
    project_id: "proj_1",
    repository_id: "repo_1",
    git_branch: "feat/legacy-path",
    git_remote_url: "git@github.com:org/repo.git",
  });
  const post = calls.find((c) => c.method === "POST" && c.path === "/api/cases");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.git_context, {
    branch: "feat/legacy-path",
    remote_url: "git@github.com:org/repo.git",
  });
});

test("create_case omits git_context entirely when neither structured nor legacy fields provided", async () => {
  const { client, calls } = makeFakeClient({
    postImpl: async () => ({ id: "case_3", status: "open" }),
  });
  const tool = findTool(tools(client), "create_case");
  await tool.handler({
    title: "No branch yet",
    description: "Agent has not created a branch.",
    project_id: "proj_1",
    repository_id: "repo_1",
  });
  const post = calls.find((c) => c.method === "POST" && c.path === "/api/cases");
  const body = post?.body as Record<string, unknown>;
  assert.equal("git_context" in body, false);
});

test("create_case prefers structured git_context over legacy flat fields when both are passed", async () => {
  const { client, calls } = makeFakeClient({
    postImpl: async () => ({ id: "case_4", status: "open" }),
  });
  const tool = findTool(tools(client), "create_case");
  await tool.handler({
    title: "Conflict resolution",
    description: "Both shapes provided — structured should win.",
    project_id: "proj_1",
    repository_id: "repo_1",
    git_context: { branch: "feat/new-shape" },
    git_branch: "feat/legacy-shape",
    git_remote_url: "https://example.com/legacy.git",
  });
  const post = calls.find((c) => c.method === "POST" && c.path === "/api/cases");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.git_context, { branch: "feat/new-shape" });
});

test("create_decision is registered with the expected enum + min-length rationale", () => {
  const { client } = makeFakeClient();
  const tool = findTool(tools(client), "create_decision");
  // Smoke-check that the schema rejects short rationales (client-side guard;
  // backend accepts min 1, but we enforce a stricter floor for agent writes).
  const schema = tool.inputSchema as Record<string, { safeParse?: (v: unknown) => { success: boolean } }>;
  const rationale = schema.rationale;
  if (rationale?.safeParse) {
    assert.equal(rationale.safeParse("short").success, false);
    assert.equal(rationale.safeParse("a decent rationale string").success, true);
  }
  const typeField = schema.type;
  if (typeField?.safeParse) {
    assert.equal(typeField.safeParse("approve").success, true);
    // merge_not_applicable: pending_merge/approved → done recovery for cases
    // without a PR (arbitra PR #689 / issue #687).
    assert.equal(typeField.safeParse("merge_not_applicable").success, true);
    assert.equal(typeField.safeParse("waive").success, false);
    assert.equal(typeField.safeParse("gate_confirmed").success, false);
  }
});
