import test from "node:test";
import assert from "node:assert/strict";

import { classifyEnvironment, registerDefaultsResource } from "./defaults-resource.js";
import type { ResolvedCreds } from "../credentials.js";
import type { ArbitraClient } from "../client.js";

type ReadCallback = (uri: URL) => Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}>;

interface CapturedRegistration {
  name: string;
  uri: string;
  callback: ReadCallback;
}

function captureRegistration(): {
  server: unknown;
  registered: CapturedRegistration[];
} {
  const registered: CapturedRegistration[] = [];
  const server = {
    registerResource: (name: string, uri: string, _config: unknown, callback: ReadCallback) => {
      registered.push({ name, uri, callback });
      return {};
    },
  };
  return { server, registered };
}

function okCreds(overrides: Partial<ResolvedCreds> = {}): ResolvedCreds {
  return {
    ok: true,
    baseUrl: "https://arbitra.example.com",
    token: "arb_xyz",
    tokenSource: "keychain",
    clientName: "cursor",
    deviceLabel: "alex-macbook",
    deviceId: "0123456789abcdef",
    ...overrides,
  } as ResolvedCreds;
}

async function readPayload(
  baseUrl: string,
  credsOverrides: Partial<ResolvedCreds> = {},
  project?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { server, registered } = captureRegistration();
  // Minimal client stub: only `get` is exercised by the project-meta fetch.
  const client = project
    ? ({ get: async () => project } as unknown as ArbitraClient)
    : undefined;
  registerDefaultsResource(
    server as unknown as Parameters<typeof registerDefaultsResource>[0],
    () => okCreds(credsOverrides),
    () => baseUrl,
    client
  );
  const entry = registered[0]!;
  const result = await entry.callback(new URL("arbitra://defaults"));
  return JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
}

test("arbitra://defaults surfaces base_url + environment", async () => {
  const payload = await readPayload("https://arbitra.example.com", {
    projectId: "proj_xyz",
  } as Partial<ResolvedCreds>);

  // Identity fields still present.
  assert.equal(payload.client_name, "cursor");
  assert.equal(payload.device_label, "alex-macbook");
  assert.equal(payload.default_project_id, "proj_xyz");

  assert.equal(payload.base_url, "https://arbitra.example.com");
  assert.equal(payload.environment, "custom");
});

test("arbitra://defaults omits default_project_id when no project pinned", async () => {
  const payload = await readPayload("http://localhost:3000");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "default_project_id"), false);
  // base_url is always present.
  assert.equal(payload.base_url, "http://localhost:3000");
  assert.equal(payload.environment, "local");
});

test("arbitra://defaults surfaces project default_language when set", async () => {
  const payload = await readPayload(
    "https://arbitra.example.com",
    { projectId: "proj_lang_de" } as Partial<ResolvedCreds>,
    { name: "demo-project", default_language: "de" }
  );
  assert.equal(payload.default_project_name, "demo-project");
  assert.equal(payload.default_language, "de");
});

test("arbitra://defaults omits default_language when project doesn't set one", async () => {
  const payload = await readPayload(
    "https://arbitra.example.com",
    { projectId: "proj_lang_absent" } as Partial<ResolvedCreds>,
    { name: "legacy-project" } // old backend: no default_language
  );
  assert.equal(payload.default_project_name, "legacy-project");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "default_language"), false);
});

test("environment classification: loopback hosts are local", () => {
  assert.equal(classifyEnvironment("http://localhost:3000"), "local");
  assert.equal(classifyEnvironment("http://127.0.0.1:8080"), "local");
  assert.equal(classifyEnvironment("http://[::1]:3000"), "local");
});

test("environment classification: every other host is custom", () => {
  assert.equal(classifyEnvironment("https://arbitra.example.com"), "custom");
  assert.equal(classifyEnvironment("https://arbitra.example.com/"), "custom");
  assert.equal(classifyEnvironment("https://arbitra.internal.example.net"), "custom");
  assert.equal(classifyEnvironment("not-a-url"), "custom");
});
