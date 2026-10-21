/**
 * Tests for progress_case dispatcher and legacy deprecated signal_* tools.
 *
 * ArbitraClient is stubbed via a minimal fake that records calls made
 * through .get() and .post() so we can assert backend routing without
 * hitting the network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "./agent-tools.js";
import { CASE_STATUSES } from "../constants.js";
import { STATUS_NEXT_ACTION } from "../lifecycle.js";
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
  params?: Record<string, string>;
}

interface FakeClientOptions {
  status?: string;
  // Allow per-path overrides of GET responses.
  getResponses?: Record<string, unknown>;
  // POST responses can be keyed by path as well.
  postResponses?: Record<string, unknown>;
}

function makeFakeClient(options: FakeClientOptions = {}): {
  client: ArbitraClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fake = {
    async get(path: string, params?: Record<string, string>) {
      calls.push({ method: "GET", path, params });
      if (options.getResponses && path in options.getResponses) {
        return options.getResponses[path];
      }
      if (path.startsWith("/api/agent/context/")) {
        return { status: options.status, id: path.split("/").pop() };
      }
      return null;
    },
    async post(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      if (options.postResponses && path in options.postResponses) {
        return options.postResponses[path];
      }
      return { ok: true };
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

test("progress_case dispatches open status to /api/agent/explore with summary (no actor_metadata when client info unknown)", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient({ status: "open" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({
    case_id: "c1",
    summary: "explored the repo",
  });
  const postCalls = calls.filter((c) => c.method === "POST");
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].path, "/api/agent/explore");
  assert.deepEqual(postCalls[0].body, {
    case_id: "c1",
    summary: "explored the repo",
  });
  assert.equal(result.isError, undefined);
});

test("progress_case on open injects actor_metadata when client info is captured", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "cursor", version: "0.42.0" });
  const { client, calls } = makeFakeClient({ status: "open" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({ case_id: "c1", summary: "explored" });
  const post = calls.find(
    (c) => c.method === "POST" && c.path === "/api/agent/explore"
  );
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.case_id, "c1");
  assert.equal(body.summary, "explored");
  assert.deepEqual(body.actor_metadata, {
    client_name: "cursor",
    client_version: "0.42.0",
  });
  resetClientInfoForTests();
});

test("progress_case dispatches exploration status to /api/agent/explore", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient({ status: "exploration" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({ case_id: "c1", summary: "s" });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/agent/explore");
  // No client info captured -> no actor_metadata key on the body.
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.actor_metadata, undefined);
});

test("progress_case on exploration injects actor_metadata when client info is captured", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "Claude-Code", version: "2.0.0" });
  const { client, calls } = makeFakeClient({ status: "exploration" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({ case_id: "c1", summary: "s" });
  const post = calls.find(
    (c) => c.method === "POST" && c.path === "/api/agent/explore"
  );
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.actor_metadata, {
    client_name: "claude-code",
    client_version: "2.0.0",
  });
  resetClientInfoForTests();
});

test("progress_case on ready_for_build calls transition to in_build", async () => {
  const { client, calls } = makeFakeClient({ status: "ready_for_build" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({ case_id: "c1" });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/cases/c1/transition");
  assert.deepEqual(post?.body, { target_status: "in_build" });
});

test("progress_case on in_build calls /api/agent/build-complete with full payload", async () => {
  const { client, calls } = makeFakeClient({ status: "in_build" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({
    case_id: "c1",
    summary: "built it",
    branch: "feat/x",
    pr_url: "https://github.com/o/r/pull/1",
    evidence: [{ type: "ci_result", summary: "green" }],
  });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/agent/build-complete");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.case_id, "c1");
  assert.equal(body.summary, "built it");
  assert.equal(body.branch, "feat/x");
  assert.equal(body.pr_url, "https://github.com/o/r/pull/1");
  assert.ok(Array.isArray(body.evidence));
});

test("progress_case validation: open without summary -> structured error, no POST", async () => {
  const { client, calls } = makeFakeClient({ status: "open" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({ case_id: "c1" });
  assert.equal(result.isError, true);
  const postCalls = calls.filter((c) => c.method === "POST");
  assert.equal(postCalls.length, 0);
  assert.equal(
    (result.structuredContent as { next_action: unknown }).next_action,
    null
  );
});

test("progress_case validation: in_build without summary -> structured error, no POST", async () => {
  const { client, calls } = makeFakeClient({ status: "in_build" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({ case_id: "c1" });
  assert.equal(result.isError, true);
  const postCalls = calls.filter((c) => c.method === "POST");
  assert.equal(postCalls.length, 0);
});

test("progress_case on terminal 'done' -> error, no backend POST", async () => {
  const { client, calls } = makeFakeClient({ status: "done" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({ case_id: "c1" });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("progress_case on terminal 'rejected' -> error, no backend POST", async () => {
  const { client, calls } = makeFakeClient({ status: "rejected" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({ case_id: "c1" });
  assert.equal(result.isError, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("progress_case force_target skips context fetch and hits transition endpoint", async () => {
  const { client, calls } = makeFakeClient({ status: "open" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({
    case_id: "c1",
    force_target: "in_review",
  });
  const postCalls = calls.filter((c) => c.method === "POST");
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].path, "/api/cases/c1/transition");
  assert.deepEqual(postCalls[0].body, { target_status: "in_review" });
  // Only one GET call allowed — the post-mutation re-fetch. The status
  // pre-read is skipped because force_target short-circuits.
  const getCalls = calls.filter((c) => c.method === "GET");
  assert.equal(getCalls.length, 1);
});

test("progress_case next_action shape matches STATUS_NEXT_ACTION for every case status", async () => {
  for (const status of CASE_STATUSES) {
    const { client } = makeFakeClient({ status });
    const progress = findTool(tools(client), "progress_case");

    // Arguments sufficient to avoid validation errors for this status.
    const args: Record<string, unknown> = { case_id: "c1" };
    if (status === "open" || status === "exploration" || status === "in_build") {
      args.summary = "s";
    }

    const result = await progress.handler(args);
    const nextAction = (
      result.structuredContent as { next_action: unknown } | undefined
    )?.next_action;

    if (STATUS_NEXT_ACTION[status] === null) {
      // Terminal statuses return an error; next_action is null.
      assert.equal(result.isError, true);
      assert.equal(nextAction, null);
    } else {
      assert.equal(result.isError, undefined, `status=${status} should not be error`);
      assert.deepEqual(
        nextAction,
        STATUS_NEXT_ACTION[status],
        `next_action mismatch for status=${status}`
      );
    }
  }
});

test("progress_case no-op statuses (in_validation) return current context", async () => {
  const { client, calls } = makeFakeClient({ status: "in_validation" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({ case_id: "c1" });
  // No POST — only context reads.
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(result.isError, undefined);
});

test("progress_case on needs_human_decision returns guidance, no POST", async () => {
  const { client, calls } = makeFakeClient({ status: "needs_human_decision" });
  const progress = findTool(tools(client), "progress_case");
  const result = await progress.handler({ case_id: "c1" });
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(result.isError, undefined);
});

// NOTE: asymmetry — the deprecated signal_exploration_complete tool does NOT
// inject actor_metadata, while progress_case (open/exploration) and the also-
// deprecated signal_build_complete do. The asymmetry is incidental: this PR
// only touched progress_case's open/exploration branch. signal_*  tools are
// scheduled for removal in 3.0.0; backfilling actor_metadata into the legacy
// exploration path is not worth it. New code should use progress_case.
test("[DEPRECATED] signal_exploration_complete still hits /api/agent/explore", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "signal_exploration_complete");
  assert.ok(
    tool.description.includes("[DEPRECATED"),
    "signal_exploration_complete must be marked deprecated"
  );
  await tool.handler({ case_id: "c1", summary: "s" });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/agent/explore");
  assert.deepEqual(post?.body, { case_id: "c1", summary: "s" });
});

test("[DEPRECATED] signal_build_complete still hits /api/agent/build-complete", async () => {
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "signal_build_complete");
  assert.ok(
    tool.description.includes("[DEPRECATED"),
    "signal_build_complete must be marked deprecated"
  );
  await tool.handler({
    case_id: "c1",
    summary: "done",
    branch: "feat/x",
  });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/agent/build-complete");
});

test("[DEPRECATED] get_agent_instructions remains registered", async () => {
  const { client } = makeFakeClient();
  const tool = findTool(tools(client), "get_agent_instructions");
  assert.ok(
    tool.description.includes("[DEPRECATED"),
    "get_agent_instructions must be marked deprecated"
  );
});

test("progress_case on in_build injects actor_metadata top-level + per evidence item", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "Claude-Code", version: "2.0.0" });
  const { client, calls } = makeFakeClient({ status: "in_build" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({
    case_id: "c1",
    summary: "built it",
    evidence: [
      { type: "ci_result", summary: "green" },
      { type: "unit_test_result", summary: "42/42" },
    ],
  });
  const post = calls.find(
    (c) => c.method === "POST" && c.path === "/api/agent/build-complete"
  );
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.actor_metadata, {
    client_name: "claude-code",
    client_version: "2.0.0",
  });
  const evidence = body.evidence as Array<Record<string, unknown>>;
  assert.equal(evidence.length, 2);
  for (const item of evidence) {
    assert.deepEqual(item.actor_metadata, {
      client_name: "claude-code",
      client_version: "2.0.0",
    });
  }
  resetClientInfoForTests();
});

test("progress_case on in_build omits actor_metadata when client info unknown", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient({ status: "in_build" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({
    case_id: "c1",
    summary: "built it",
    evidence: [{ type: "ci_result", summary: "green" }],
  });
  const post = calls.find(
    (c) => c.method === "POST" && c.path === "/api/agent/build-complete"
  );
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.actor_metadata, undefined);
  const evidence = body.evidence as Array<Record<string, unknown>>;
  assert.equal(evidence[0].actor_metadata, undefined);
});

test("signal_build_complete also injects actor_metadata", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "cursor", version: "0.42.0" });
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "signal_build_complete");
  await tool.handler({
    case_id: "c1",
    summary: "done",
    evidence: [{ type: "ci_result", summary: "green" }],
  });
  const post = calls.find((c) => c.path === "/api/agent/build-complete");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.actor_metadata, {
    client_name: "cursor",
    client_version: "0.42.0",
  });
  const evidence = body.evidence as Array<Record<string, unknown>>;
  assert.deepEqual(evidence[0].actor_metadata, {
    client_name: "cursor",
    client_version: "0.42.0",
  });
  resetClientInfoForTests();
});

test("stampEvidence preserves caller-supplied actor_metadata on evidence items", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "claude-code", version: "1.0.0" });
  const { client, calls } = makeFakeClient({ status: "in_build" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({
    case_id: "c1",
    summary: "built it",
    evidence: [
      {
        type: "ci_result",
        summary: "green",
        actor_metadata: { client_name: "custom", client_version: "9.9.9" },
      },
    ],
  });
  const post = calls.find(
    (c) => c.method === "POST" && c.path === "/api/agent/build-complete"
  );
  const body = post?.body as Record<string, unknown>;
  const evidence = body.evidence as Array<Record<string, unknown>>;
  assert.deepEqual(evidence[0].actor_metadata, {
    client_name: "custom",
    client_version: "9.9.9",
  });
  resetClientInfoForTests();
});

test("stampEvidence preserves caller-supplied actor_metadata.model on evidence items", async () => {
  // MCP never auto-populates `model`, but if a caller (e.g. the agent
  // itself) attaches it explicitly to an evidence item, it must survive
  // untouched to the backend.
  resetClientInfoForTests();
  setClientInfo({ name: "claude-code", version: "1.0.0" });
  const { client, calls } = makeFakeClient({ status: "in_build" });
  const progress = findTool(tools(client), "progress_case");
  await progress.handler({
    case_id: "c1",
    summary: "built it",
    evidence: [
      {
        type: "ci_result",
        summary: "green",
        actor_metadata: {
          client_name: "claude-code",
          client_version: "1.0.0",
          model: "claude-opus-4.7",
        },
      },
    ],
  });
  const post = calls.find(
    (c) => c.method === "POST" && c.path === "/api/agent/build-complete"
  );
  const body = post?.body as Record<string, unknown>;
  const evidence = body.evidence as Array<Record<string, unknown>>;
  assert.deepEqual(evidence[0].actor_metadata, {
    client_name: "claude-code",
    client_version: "1.0.0",
    model: "claude-opus-4.7",
  });
  resetClientInfoForTests();
});

test("get_case_context emits next_action from STATUS_NEXT_ACTION", async () => {
  const { client } = makeFakeClient({ status: "in_build" });
  const tool = findTool(tools(client), "get_case_context");
  const result = await tool.handler({ case_id: "c1" });
  const nextAction = (result.structuredContent as { next_action: unknown })
    .next_action;
  assert.deepEqual(nextAction, STATUS_NEXT_ACTION.in_build);
});
