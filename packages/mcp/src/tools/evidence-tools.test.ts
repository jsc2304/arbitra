/**
 * Tests for actor_metadata injection on evidence + comment writes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "./evidence-tools.js";
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

function makeFakeClient(): {
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

test("add_comment injects actor_metadata when client info is captured", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "Claude-Code", version: "2.0.0" });
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "add_comment");
  await tool.handler({ case_id: "c1", body: "hello" });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/cases/c1/comments");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.body, "hello");
  assert.deepEqual(body.actor_metadata, {
    client_name: "claude-code",
    client_version: "2.0.0",
  });
  resetClientInfoForTests();
});

test("add_comment omits actor_metadata when nothing is known", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "add_comment");
  await tool.handler({ case_id: "c1", body: "hello" });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.actor_metadata, undefined);
  assert.equal(body.body, "hello");
});

test("resolve_finding posts a propose_waiver decision with resolution note + actor_metadata", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "Claude-Code", version: "2.0.0" });
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "resolve_finding");
  await tool.handler({
    case_id: "c1",
    finding_id: "fnd_1",
    resolution: "false_positive",
    rationale: "hallucinated platform API signature — verified against the vendor API",
    severity_contested: true,
    knowledge_asset_ref: "know_precedent_1",
  });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/cases/c1/decisions");
  const body = post?.body as Record<string, unknown>;
  // Human-in-the-loop: always the PROPOSED (non-terminal) decision type.
  assert.equal(body.type, "propose_waiver");
  assert.equal(body.finding_id, "fnd_1");
  assert.equal(
    body.resolution,
    "False positive — hallucinated platform API signature — verified against the vendor API",
  );
  assert.equal(body.severity_contested, true);
  assert.equal(body.knowledge_asset_ref, "know_precedent_1");
  assert.deepEqual(body.actor_metadata, {
    client_name: "claude-code",
    client_version: "2.0.0",
  });
  resetClientInfoForTests();
});

test("resolve_finding omits optional fields when not provided", async () => {
  resetClientInfoForTests();
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "resolve_finding");
  await tool.handler({
    case_id: "c1",
    finding_id: "fnd_1",
    resolution: "waived",
    rationale: "not applicable to this change",
  });
  const post = calls.find((c) => c.method === "POST");
  const body = post?.body as Record<string, unknown>;
  assert.equal(body.type, "propose_waiver");
  assert.equal(body.resolution, "Waived — not applicable to this change");
  assert.equal(body.severity_contested, undefined);
  assert.equal(body.knowledge_asset_ref, undefined);
  assert.equal(body.actor_metadata, undefined);
});

test("register_evidence injects actor_metadata top-level", async () => {
  resetClientInfoForTests();
  setClientInfo({ name: "cursor", version: "0.42.0" });
  const { client, calls } = makeFakeClient();
  const tool = findTool(tools(client), "register_evidence");
  await tool.handler({
    case_id: "c1",
    type: "ci_result",
    summary: "green",
  });
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/api/cases/c1/evidence");
  const body = post?.body as Record<string, unknown>;
  assert.deepEqual(body.actor_metadata, {
    client_name: "cursor",
    client_version: "0.42.0",
  });
  resetClientInfoForTests();
});
