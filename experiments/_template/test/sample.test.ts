import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "shared";
import { describeElapsed } from "../src/index.js";

test("sample: describeElapsed uses the injected FakeClock, not wall time", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const startMs = clock.nowMs();
  clock.advance(5_000);
  assert.equal(describeElapsed(clock, startMs), "5000ms elapsed since 2026-01-01T00:00:00.000Z");
});
