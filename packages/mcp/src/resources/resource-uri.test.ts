import test from "node:test";
import assert from "node:assert/strict";
import { extractCaseIdFromResourceUri } from "./resource-uri.js";

test("extracts case ids from authority-based resource URIs", () => {
  assert.equal(
    extractCaseIdFromResourceUri(new URL("arbitra://case/case_123")),
    "case_123"
  );
  assert.equal(
    extractCaseIdFromResourceUri(new URL("arbitra://case/case_123/context")),
    "case_123"
  );
});

test("extracts case ids from path-based fallback resource URIs", () => {
  assert.equal(
    extractCaseIdFromResourceUri(new URL("arbitra:///case/case_456")),
    "case_456"
  );
  assert.equal(
    extractCaseIdFromResourceUri(new URL("arbitra:///case/case_456/context")),
    "case_456"
  );
});
