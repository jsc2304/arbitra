import test from "node:test";
import assert from "node:assert/strict";
import { ArbitraApiError, ArbitraClient } from "./client.js";

test("client parses JSON success responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new ArbitraClient("https://example.com", "token", 100);
    const result = await client.get<{ ok: boolean }>("/api/projects");
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client returns null for empty success responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });

  try {
    const client = new ArbitraClient("https://example.com", "token", 100);
    const result = await client.post<null>("/api/projects");
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client preserves API errors with parsed JSON messages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new ArbitraClient("https://example.com", "token", 100);
    await assert.rejects(
      () => client.get("/api/projects"),
      (error: unknown) =>
        error instanceof ArbitraApiError &&
        error.status === 403 &&
        error.message === "Arbitra API error (403): forbidden"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client parses structured VALIDATION_ERROR envelope", async () => {
  const originalFetch = globalThis.fetch;
  const envelope = {
    error: {
      code: "VALIDATION_ERROR",
      message: "Invalid request body",
      details: {
        issues: [{ path: "summary", message: "Required" }],
      },
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(envelope), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new ArbitraClient("https://example.com", "token", 100);
    await assert.rejects(
      () => client.post("/api/cases"),
      (error: unknown) => {
        assert.ok(error instanceof ArbitraApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.equal(
          error.message,
          "Arbitra API error (400): Invalid request body"
        );
        assert.deepEqual(error.details, {
          issues: [{ path: "summary", message: "Required" }],
        });
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client parses structured MISSING_REQUIRED_EVIDENCE envelope", async () => {
  const originalFetch = globalThis.fetch;
  const envelope = {
    error: {
      code: "MISSING_REQUIRED_EVIDENCE",
      message: "Cannot complete build — missing required evidence: ci_result",
      details: {
        missing: ["ci_result"],
        satisfied: false,
        hint: "Register the missing evidence types and retry build completion.",
      },
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(envelope), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new ArbitraClient("https://example.com", "token", 100);
    await assert.rejects(
      () => client.post("/api/agent/build-complete"),
      (error: unknown) => {
        assert.ok(error instanceof ArbitraApiError);
        assert.equal(error.code, "MISSING_REQUIRED_EVIDENCE");
        const details = error.details as { missing?: string[] };
        assert.deepEqual(details.missing, ["ci_result"]);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client parses structured INVALID_CASE_STATE envelope", async () => {
  const originalFetch = globalThis.fetch;
  const envelope = {
    error: {
      code: "INVALID_CASE_STATE",
      message: "Case is in 'done' — must be 'in_build' to complete build",
      details: {
        current_status: "done",
        required_status: "in_build",
      },
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(envelope), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  try {
    const client = new ArbitraClient("https://example.com", "token", 100);
    await assert.rejects(
      () => client.post("/api/agent/build-complete"),
      (error: unknown) => {
        assert.ok(error instanceof ArbitraApiError);
        assert.equal(error.code, "INVALID_CASE_STATE");
        const details = error.details as {
          current_status?: string;
          required_status?: string;
        };
        assert.equal(details.current_status, "done");
        assert.equal(details.required_status, "in_build");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
