/**
 * Tests for the actor_metadata builder + withActorMetadata() merge helper.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActorMetadata,
  resetClientInfoForTests,
  setClientInfo,
  withActorMetadata,
} from "./actor-metadata.js";

test("buildActorMetadata returns undefined when nothing is known", () => {
  resetClientInfoForTests();
  assert.equal(buildActorMetadata(), undefined);
});

test("buildActorMetadata lowercases client_name and trims version", () => {
  resetClientInfoForTests();
  setClientInfo({ name: "  Claude-Code  ", version: "  1.2.3  " });
  const meta = buildActorMetadata();
  assert.deepEqual(meta, {
    client_name: "claude-code",
    client_version: "1.2.3",
  });
});

test("buildActorMetadata drops subfields that are blank after trim", () => {
  resetClientInfoForTests();
  setClientInfo({ name: "   ", version: "" });
  assert.equal(buildActorMetadata(), undefined);
});

test("buildActorMetadata returns only client_name when version missing", () => {
  resetClientInfoForTests();
  setClientInfo({ name: "claude-code" });
  const meta = buildActorMetadata();
  assert.deepEqual(meta, { client_name: "claude-code" });
});

test("buildActorMetadata never populates model (agent self-signs)", () => {
  resetClientInfoForTests();
  setClientInfo({ name: "cursor", version: "0.42.0" });
  const meta = buildActorMetadata();
  assert.deepEqual(meta, {
    client_name: "cursor",
    client_version: "0.42.0",
  });
  // Explicitly assert the model field is absent from the auto-built payload.
  assert.equal((meta as Record<string, unknown>).model, undefined);
});

test("setClientInfo(undefined) is a no-op and does not clobber the last-known value", () => {
  resetClientInfoForTests();
  setClientInfo({ name: "claude-code", version: "1.0.0" });
  setClientInfo(undefined);
  const meta = buildActorMetadata();
  assert.deepEqual(meta, {
    client_name: "claude-code",
    client_version: "1.0.0",
  });
});

test("withActorMetadata returns body unchanged when no metadata available", () => {
  resetClientInfoForTests();
  const body = { hello: "world" };
  const merged = withActorMetadata(body);
  assert.deepEqual(merged, { hello: "world" });
  // Same reference when nothing added — avoids gratuitous allocations.
  assert.equal(merged, body);
});

test("withActorMetadata merges actor_metadata into the body when client info set", () => {
  resetClientInfoForTests();
  setClientInfo({ name: "claude-code", version: "1.0.0" });
  const body = { body: "hi" } as const;
  const merged = withActorMetadata(body) as Record<string, unknown>;
  assert.equal(merged.body, "hi");
  assert.deepEqual(merged.actor_metadata, {
    client_name: "claude-code",
    client_version: "1.0.0",
  });
});
