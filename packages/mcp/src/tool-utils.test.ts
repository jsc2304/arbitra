import test from "node:test";
import assert from "node:assert/strict";
import { csvToArray, pickDefined } from "./tool-utils.js";

test("csvToArray trims and filters comma-separated values", () => {
  assert.deepEqual(csvToArray(" alpha, beta ,, gamma "), [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual(csvToArray(""), []);
  assert.equal(csvToArray(undefined), undefined);
});

test("pickDefined includes only present fields", () => {
  assert.deepEqual(
    pickDefined(
      {
        title: "Case title",
        description: undefined,
        priority: "high",
      },
      ["title", "description", "priority"]
    ),
    {
      title: "Case title",
      priority: "high",
    }
  );
});
