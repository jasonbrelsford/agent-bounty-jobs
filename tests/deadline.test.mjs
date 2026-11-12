// The board's deadline column counts down to an open deadline and says when a past one ended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deadlineLabel } from "../.test-build/dashboard.js";

const now = Date.parse("2026-11-12T00:00:00Z");
test("future deadline counts down", () => {
  assert.equal(deadlineLabel("2026-12-12T00:00:00Z", now), "30d left");
  assert.equal(deadlineLabel("2026-11-12T03:00:00Z", now), "3h left");
});
test("past deadline says when it ended", () => {
  assert.equal(deadlineLabel("2026-11-11T22:00:00Z", now), "ended 2h ago");
});
