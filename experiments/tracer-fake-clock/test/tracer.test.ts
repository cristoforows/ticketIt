import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "shared";
import { hasElapsed } from "../src/index.js";

test("tracer: FakeClock is deterministic across advance() and set()", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const startMs = clock.nowMs();

  assert.equal(hasElapsed(clock, startMs, 1_000), false);

  clock.advance(999);
  assert.equal(hasElapsed(clock, startMs, 1_000), false);

  clock.advance(1);
  assert.equal(hasElapsed(clock, startMs, 1_000), true);

  clock.set("2026-01-01T00:00:00.000Z");
  assert.equal(hasElapsed(clock, startMs, 1_000), false, "set() rewinds deterministically");
});

test("tracer: two independent FakeClocks never observe real wall-clock time", () => {
  const a = new FakeClock("2000-01-01T00:00:00.000Z");
  const b = new FakeClock("2030-01-01T00:00:00.000Z");
  a.advance(365 * 24 * 60 * 60 * 1000);
  assert.notEqual(a.toISOString(), b.toISOString());
  assert.ok(a.nowMs() < Date.now(), "FakeClock time is independent of the real clock");
});
