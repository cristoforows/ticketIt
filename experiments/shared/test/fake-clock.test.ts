import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/fake-clock.js";

test("FakeClock defaults to the Unix epoch", () => {
  const clock = new FakeClock();
  assert.equal(clock.nowMs(), 0);
  assert.equal(clock.toISOString(), "1970-01-01T00:00:00.000Z");
});

test("FakeClock can start from an ISO string", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  assert.equal(clock.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("advance() moves the clock forward deterministically", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  clock.advance(1_000);
  assert.equal(clock.toISOString(), "2026-01-01T00:00:01.000Z");
  clock.advance(60_000);
  assert.equal(clock.toISOString(), "2026-01-01T00:01:01.000Z");
});

test("advance() accepts negative values", () => {
  const clock = new FakeClock("2026-01-01T00:01:00.000Z");
  clock.advance(-60_000);
  assert.equal(clock.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("set() jumps to an absolute point in time", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  clock.set("2030-06-15T12:00:00.000Z");
  assert.equal(clock.toISOString(), "2030-06-15T12:00:00.000Z");
});

test("now() returns a Date instance reflecting the current time", () => {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  assert.ok(clock.now() instanceof Date);
  assert.equal(clock.now().getUTCFullYear(), 2026);
});

test("constructor rejects unparseable strings", () => {
  assert.throws(() => new FakeClock("not-a-date"));
});

test("set() rejects unparseable strings", () => {
  const clock = new FakeClock();
  assert.throws(() => clock.set("not-a-date"));
});
