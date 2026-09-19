import { test } from "node:test";
import assert from "node:assert/strict";
import { allOf, confirmStop } from "../src/confirm-stop.js";

/**
 * Unit coverage for `confirmStop` independent of any running OpenCode
 * instance -- see `test/abort-while-running.test.ts` for the real,
 * process-backed usage. This file is what the issue calls "test the
 * refusal path too": `confirmStop` must never report "Stopped" unless its
 * `hasCeased` check itself produced observed evidence, even after
 * exhausting its whole polling budget.
 */

test("confirmStop: refusal path -- never reports Stopped when hasCeased never observes evidence", async () => {
  let calls = 0;
  const result = await confirmStop({
    hasCeased: async () => {
      calls += 1;
      return { observed: false, detail: "no evidence yet" };
    },
    maxAttempts: 5,
    intervalMs: 1,
  });

  assert.equal(result.status, "not-confirmed", "must refuse to report Stopped without evidence");
  assert.equal(calls, 5, "must exhaust the full polling budget before refusing");
  assert.equal(result.attempts, 5);
  assert.equal(result.observedAtMs, null, "no observation timestamp when never confirmed");
  assert.match(result.reason, /refusing to report Stopped/, "the refusal reason must say so explicitly");
});

test("confirmStop: reports Stopped only once hasCeased observes evidence, and records when", async () => {
  let calls = 0;
  const before = Date.now();
  const result = await confirmStop({
    hasCeased: async () => {
      calls += 1;
      if (calls < 3) return { observed: false, detail: `attempt ${calls}: not yet` };
      return { observed: true, detail: "child process no longer exists" };
    },
    maxAttempts: 10,
    intervalMs: 5,
  });
  const after = Date.now();

  assert.equal(result.status, "Stopped");
  assert.equal(calls, 3, "must stop polling as soon as evidence is observed, not run the full budget");
  assert.equal(result.attempts, 3);
  assert.ok(result.observedAtMs !== null && result.observedAtMs >= before && result.observedAtMs <= after);
  assert.match(result.reason, /child process no longer exists/);
});

test("confirmStop: rejects a non-positive maxAttempts rather than silently doing nothing", async () => {
  await assert.rejects(
    () => confirmStop({ hasCeased: async () => ({ observed: true, detail: "n/a" }), maxAttempts: 0 }),
    /maxAttempts/,
  );
});

test("allOf: only reports observed once every composed check has observed evidence, in one poll", async () => {
  const checkA = async () => ({ observed: true, detail: "A ceased" });
  const checkBFalseThenTrue = (() => {
    let n = 0;
    return async () => {
      n += 1;
      return { observed: n > 1, detail: n > 1 ? "B ceased" : "B still running" };
    };
  })();

  const combined = allOf([checkA, checkBFalseThenTrue]);

  const first = await combined();
  assert.equal(first.observed, false, "must not report observed while any composed check has not");
  assert.match(first.detail, /A ceased/);
  assert.match(first.detail, /B still running/);

  const second = await combined();
  assert.equal(second.observed, true, "must report observed once every composed check does, in the same poll");
  assert.match(second.detail, /B ceased/);
});
