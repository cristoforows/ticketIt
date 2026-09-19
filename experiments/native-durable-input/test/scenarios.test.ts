import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { assertDatabaseReachable, resolveDatabaseUrl } from "native-harness/src/index.js";
import { MarkerFileStore } from "../src/marker-store.js";
import { LibraryStore } from "../src/library.js";
import { flagFilePath, libraryFilePath, markerFilePath } from "../src/paths.js";
import { runToCompletion, spawnUntilLine } from "./helpers/spawn.js";

/**
 * Every scenario in this file spawns `src/process-a.ts` / `src/process-b.ts`
 * as genuinely separate OS processes (see `test/helpers/spawn.ts`) against
 * ONE shared local PostgreSQL database (the same one `native-harness` uses;
 * see its README, "Database setup"). Per this issue's setup rule 6, every
 * test uses a fresh, unique thread ID (`durable-input-<randomUUID>`) and a
 * fresh temp directory for marker/library/flag files, and cleans both up in
 * a `finally` block, so concurrent/repeated runs never collide and never
 * leak fixture state.
 */

const connectionString = resolveDatabaseUrl();
let rawPool: pg.Pool | undefined;

before(async () => {
  // Fail loudly if PostgreSQL is unreachable -- never silently skip or
  // fall back (see experiments/native-harness/README.md, "Database setup",
  // and this package's src/connection.ts).
  await assertDatabaseReachable(connectionString);
  rawPool = new pg.Pool({ connectionString });
});

after(async () => {
  await rawPool?.end();
});

function newThreadId(label: string): string {
  return `durable-input-${label}-${randomUUID()}`;
}

function newTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "native-durable-input-"));
}

async function checkpointRowCount(threadId: string): Promise<number> {
  assert.ok(rawPool, "expected the raw pg.Pool from before() to be set");
  const { rows } = await rawPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM checkpoints WHERE thread_id = $1",
    [threadId],
  );
  return Number(rows[0]?.count ?? "0");
}

async function checkpointWriteRowCount(threadId: string): Promise<number> {
  assert.ok(rawPool, "expected the raw pg.Pool from before() to be set");
  const { rows } = await rawPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM checkpoint_writes WHERE thread_id = $1",
    [threadId],
  );
  return Number(rows[0]?.count ?? "0");
}

async function roundRegistryHasThread(threadId: string): Promise<boolean> {
  assert.ok(rawPool, "expected the raw pg.Pool from before() to be set");
  const { rows } = await rawPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM round_registry WHERE thread_id = $1",
    [threadId],
  );
  return Number(rows[0]?.count ?? "0") > 0;
}

async function deleteCheckpointThread(threadId: string): Promise<void> {
  assert.ok(rawPool, "expected the raw pg.Pool from before() to be set");
  await rawPool.query("DELETE FROM checkpoints WHERE thread_id = $1", [threadId]);
  await rawPool.query("DELETE FROM checkpoint_writes WHERE thread_id = $1", [threadId]);
  await rawPool.query("DELETE FROM checkpoint_blobs WHERE thread_id = $1", [threadId]);
  await rawPool.query("DELETE FROM execution_snapshots WHERE thread_id = $1", [threadId]);
}

test(
  "durable question: Process A interrupts and exits; a fresh Process B " +
    "recovers the pending interrupt from Postgres and resumes, running the " +
    "marker side effect exactly once",
  async () => {
    const threadId = newThreadId("question");
    const tmpDir = newTmpDir();
    try {
      const a = await runToCompletion("process-a", ["question", threadId, tmpDir]);
      assert.equal(a.exitCode, 0, `process-a exited non-zero: ${a.stderr}`);
      const aJson = a.json as {
        interrupted: boolean;
        interruptId: string;
        interruptValue: { kind: string; question: string };
        marker: { sideEffectCount: number; toolInvocations: number };
      };
      assert.equal(aJson.interrupted, true, "Process A must report a pending interrupt before exiting");
      assert.ok(aJson.interruptId, "Process A must print the interrupt ID");
      assert.equal(aJson.interruptValue.kind, "question");
      assert.equal(aJson.marker.sideEffectCount, 0, "the side effect must not run before the answer is supplied");

      // Database state: the checkpoint the interrupt was written to is
      // actually durable -- a genuinely fresh process (Process B below)
      // reads it back with no shared memory from Process A.
      assert.ok(
        (await checkpointRowCount(threadId)) > 0,
        "expected at least one persisted checkpoint row after Process A's interrupt",
      );
      assert.ok(await roundRegistryHasThread(threadId), "expected RoundRegistry to have registered this thread");

      const b = await runToCompletion("process-b", ["question", threadId, tmpDir, "yes, proceed"]);
      assert.equal(b.exitCode, 0, `process-b exited non-zero: ${b.stderr}`);
      const bJson = b.json as {
        hadPendingInterruptBeforeResume: boolean;
        pendingInterruptId: string;
        marker: { sideEffectCount: number };
      };
      assert.equal(bJson.hadPendingInterruptBeforeResume, true);
      assert.equal(bJson.pendingInterruptId, aJson.interruptId, "Process B must recover the SAME interrupt ID");
      assert.equal(bJson.marker.sideEffectCount, 1, "the side effect must run exactly once after resume");

      // Cross-check via the marker FILE directly (not just the process's
      // self-reported JSON) -- this is the cross-process side-effect
      // ledger the issue requires (see src/marker-store.ts).
      const markerFromDisk = new MarkerFileStore(markerFilePath(tmpDir, threadId)).read();
      assert.equal(markerFromDisk.sideEffectCount, 1);
      assert.ok(markerFromDisk.appliedKeys.length === 1);
    } finally {
      await deleteCheckpointThread(threadId);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "duplicate reply: resuming a second time with the same answer does not " +
    "repeat the side effect",
  async () => {
    const threadId = newThreadId("duplicate");
    const tmpDir = newTmpDir();
    try {
      const a = await runToCompletion("process-a", ["question", threadId, tmpDir]);
      assert.equal((a.json as { interrupted: boolean }).interrupted, true);

      const b1 = await runToCompletion("process-b", ["question", threadId, tmpDir, "yes, proceed"]);
      const b1Json = b1.json as { marker: { sideEffectCount: number }; modelRequestCountThisProcess: number };
      assert.equal(b1Json.marker.sideEffectCount, 1);

      // Second resume: same thread, same answer. A fresh process again
      // (call it "Process C" per the issue text; this script does not care
      // which index it is, only that it is a fresh reconnect -- see
      // src/process-b.ts's module doc comment).
      const b2 = await runToCompletion("process-b", ["question", threadId, tmpDir, "yes, proceed"]);
      assert.equal(b2.exitCode, 0, `duplicate process-b exited non-zero: ${b2.stderr}`);
      const b2Json = b2.json as {
        hadPendingInterruptBeforeResume: boolean;
        marker: { sideEffectCount: number; toolInvocations: number; appliedKeys: string[] };
        modelRequestCountThisProcess: number;
      };

      // The side-effect count must still be exactly one.
      assert.equal(b2Json.marker.sideEffectCount, 1, "duplicate resume must not repeat the side effect");
      assert.equal(b2Json.marker.appliedKeys.length, 1);

      // Record WHICH mechanism was responsible for the no-op. Observed on
      // this pinned version (langchain 1.5.11 / @langchain/langgraph
      // 1.4.15): once a thread has advanced past its only interrupt (its
      // checkpoint's `next` is empty), invoking `Command({ resume })` again
      // is a FRAMEWORK-level no-op -- it reports no pending interrupt
      // (`hadPendingInterruptBeforeResume: false`) and makes zero model
      // calls / zero tool re-invocations (`modelRequestCountThisProcess:
      // 0`, `toolInvocations` unchanged from the first resume). The
      // harness-level idempotency key in `MarkerFileStore.recordSideEffectOnce`
      // (keyed on `interruptId:answer`, see src/tools.ts) was therefore not
      // the deciding mechanism for THIS duplicate-resume path -- the tool
      // body never ran a second time for the framework to need it. It
      // remains as defense-in-depth for a path where the tool body DOES
      // re-run with an already-applied key (the restart-semantics scenario
      // below shows node re-execution does happen before an interrupt).
      assert.equal(
        b2Json.hadPendingInterruptBeforeResume,
        false,
        "expected the framework to report no pending interrupt on an already-completed thread",
      );
      assert.equal(
        b2Json.modelRequestCountThisProcess,
        0,
        "expected the framework to no-op the duplicate resume without any model call",
      );
      assert.equal(
        b2Json.marker.toolInvocations,
        2,
        "expected the tool body to NOT re-run on the duplicate resume (framework no-op): toolInvocations should " +
          "still be 2 (one from Process A's paused attempt, one from Process B's first resume), unchanged by the " +
          "duplicate",
      );

      const markerFromDisk = new MarkerFileStore(markerFilePath(tmpDir, threadId)).read();
      assert.equal(markerFromDisk.sideEffectCount, 1);
    } finally {
      await deleteCheckpointThread(threadId);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "fixed inputs across pause: a resumed thread still uses version A even " +
    "after version B is published; a new thread started afterwards uses B",
  async () => {
    const threadId1 = newThreadId("fixed-a");
    const threadId2 = newThreadId("fixed-b");
    const tmpDir = newTmpDir();
    try {
      // Version A is live when Process A starts (LibraryStore.read()
      // auto-publishes "A" the first time it is read with nothing
      // published yet -- see src/library.ts).
      const a1 = await runToCompletion("process-a", ["fixed-inputs", threadId1, tmpDir]);
      const a1Json = a1.json as { version: string; firstRequestSystemPrompt: string };
      assert.equal(a1Json.version, "A");
      assert.match(a1Json.firstRequestSystemPrompt, /instructions version A/);
      assert.match(a1Json.firstRequestSystemPrompt, /Skill v A/);
      assert.match(a1Json.firstRequestSystemPrompt, /Recipe v A/);

      // Publish version B to the SAME library file, simulating an owner
      // edit to the shared library while the round is paused for input.
      new LibraryStore(libraryFilePath(tmpDir, "main")).publish("B");

      // Resume the paused thread. It must still have received version A's
      // system prompt -- from the durable per-thread execution snapshot
      // (src/execution-snapshot-store.ts), not by re-reading the (now
      // mutated) library file.
      const b1 = await runToCompletion("process-b", ["fixed-inputs", threadId1, tmpDir, "ok, proceed with A"]);
      assert.equal(b1.exitCode, 0, `process-b exited non-zero: ${b1.stderr}`);
      const b1Json = b1.json as { snapshotVersion: string; resumedRequestSystemPrompt: string };
      assert.equal(b1Json.snapshotVersion, "A");
      assert.match(b1Json.resumedRequestSystemPrompt, /instructions version A/);
      assert.match(b1Json.resumedRequestSystemPrompt, /Skill v A/);
      assert.doesNotMatch(b1Json.resumedRequestSystemPrompt, /version B/);

      // A brand-new thread started AFTER B was published must receive B.
      const a2 = await runToCompletion("process-a", ["fixed-inputs", threadId2, tmpDir]);
      const a2Json = a2.json as { version: string; firstRequestSystemPrompt: string };
      assert.equal(a2Json.version, "B");
      assert.match(a2Json.firstRequestSystemPrompt, /instructions version B/);
      assert.match(a2Json.firstRequestSystemPrompt, /Skill v B/);
      assert.match(a2Json.firstRequestSystemPrompt, /Recipe v B/);
    } finally {
      await deleteCheckpointThread(threadId1);
      await deleteCheckpointThread(threadId2);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "restart semantics: a side effect placed BEFORE interrupt() in the same " +
    "node repeats on resume; the mechanism requires effects to be placed " +
    "after the interrupt, or made idempotent",
  async () => {
    const threadId = newThreadId("restart");
    const tmpDir = newTmpDir();
    try {
      const a = await runToCompletion("process-a", ["restart", threadId, tmpDir]);
      const aJson = a.json as { markerAfterProcessA: { beforeInterruptCount: number; toolInvocations: number } };
      assert.equal(aJson.markerAfterProcessA.beforeInterruptCount, 1, "Process A ran the before-interrupt code once");
      assert.equal(aJson.markerAfterProcessA.toolInvocations, 0, "the after-interrupt code has not run yet");

      const b = await runToCompletion("process-b", ["restart", threadId, tmpDir, "go ahead"]);
      assert.equal(b.exitCode, 0, `process-b exited non-zero: ${b.stderr}`);
      const bJson = b.json as { markerAfterResume: { beforeInterruptCount: number; toolInvocations: number } };

      // LangGraph restarts the interrupted node from the beginning on
      // resume (docs/integration-feasibility.md, "LangChain human input":
      // "Interrupted nodes may restart from the beginning; effects before
      // an interrupt can repeat."): the before-interrupt marker runs AGAIN
      // (1 -> 2), while the after-interrupt marker (guarded by the
      // interrupt itself only truly resolving once) runs exactly once.
      assert.equal(
        bJson.markerAfterResume.beforeInterruptCount,
        2,
        "expected the pre-interrupt side effect to repeat once on resume (restart-from-beginning semantics)",
      );
      assert.equal(
        bJson.markerAfterResume.toolInvocations,
        1,
        "expected the post-interrupt code to run exactly once",
      );

      const markerFromDisk = new MarkerFileStore(markerFilePath(tmpDir, threadId)).read();
      assert.equal(markerFromDisk.beforeInterruptCount, 2);
    } finally {
      await deleteCheckpointThread(threadId);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

test(
  "process death: SIGKILL mid-tool leaves an incomplete checkpoint step; " +
    "the harness's RecoveryPolicy refuses automatic resume, and a clearly " +
    "labelled negative demonstration proves LangGraph itself would have " +
    "continued if asked directly",
  async () => {
    const threadId = newThreadId("death");
    const tmpDir = newTmpDir();
    try {
      const spawned = await spawnUntilLine("process-a", ["process-death", threadId, tmpDir], (line) => {
        try {
          return (JSON.parse(line) as { started?: boolean }).started === true;
        } catch {
          return false;
        }
      });
      // The tool has printed "started" (it is inside its poll loop over the
      // flag file, which does not exist yet) -- give it a brief moment to
      // genuinely be blocked on the `await sleep(100)` poll before killing,
      // then SIGKILL the whole process (not a graceful stop).
      await sleep(300);
      const killed = spawned.child.kill("SIGKILL");
      assert.ok(killed, "expected SIGKILL to be delivered to Process A");
      await new Promise<void>((resolve) => spawned.child.on("exit", () => resolve()));

      // Database state: a checkpoint write for the in-flight "tools" step
      // was durably recorded even though the process never returned from
      // the tool call and never wrote a completing checkpoint.
      assert.ok(
        (await checkpointRowCount(threadId)) > 0,
        "expected at least one persisted checkpoint row despite the SIGKILL",
      );
      assert.ok(
        (await checkpointWriteRowCount(threadId)) > 0,
        "expected at least one checkpoint_writes row for the in-flight step",
      );

      // The harness's own recovery rule: refuse automatic resume.
      const refusal = await runToCompletion("process-b", ["process-death", threadId, tmpDir]);
      assert.equal(refusal.exitCode, 0, `process-b (refusal path) exited non-zero: ${refusal.stderr}`);
      const refusalJson = refusal.json as {
        refused: boolean;
        reason: string;
        classification: { status: string; next: string[]; hasPendingInterrupt: boolean };
      };
      assert.equal(refusalJson.refused, true, "the harness must refuse to resume a mid-node death");
      assert.equal(refusalJson.reason, "interrupted-not-resumable");
      assert.equal(refusalJson.classification.hasPendingInterrupt, false, "this is a real death, not a durable question wait");
      assert.ok(
        refusalJson.classification.next.length > 0,
        "the last checkpoint must show a scheduled-but-incomplete step (non-empty `next`)",
      );
      assert.ok(
        refusalJson.classification.next.includes("tools"),
        `expected the incomplete step to be the tools node, got next=${JSON.stringify(refusalJson.classification.next)}`,
      );

      // Clearly labelled NEGATIVE demonstration: prove the underlying
      // framework itself is willing to continue this same checkpoint if
      // asked directly (bypassing RecoveryPolicy) -- this is what shows the
      // refusal above is the HARNESS's application-level choice
      // (docs/v1-scope.md "Lifecycle"; docs/contracts/execution-interface.md
      // "Reconciliation on reconnect"), not something LangGraph itself
      // would have prevented.
      writeFileSync(flagFilePath(tmpDir, threadId), "go");
      const negative = await runToCompletion("process-b", ["process-death", threadId, tmpDir, "--negative-demo"]);
      assert.equal(negative.exitCode, 0, `negative demo exited non-zero: ${negative.stderr}`);
      const negativeJson = negative.json as { negativeDemo: boolean; frameworkContinued: boolean };
      assert.equal(negativeJson.negativeDemo, true);
      assert.equal(
        negativeJson.frameworkContinued,
        true,
        "NEGATIVE DEMONSTRATION: the framework itself completed the interrupted tool call when asked directly " +
          "(graph.invoke(null, config)), proving the earlier refusal was the harness's own applied rule, not a " +
          "limitation of LangGraph",
      );
    } finally {
      await deleteCheckpointThread(threadId);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);
