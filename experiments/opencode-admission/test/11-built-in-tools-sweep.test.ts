import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptTextTurn, StubModelServer, type ScriptedTurn } from "opencode-harness";
import { startAdmittedOpenCode } from "../src/index.js";

/**
 * Issue #21, priority row 4: "the remaining built-in tools enumerated live
 * from the client's tool list."
 *
 * Live enumeration (ad hoc probe during development, not a network call --
 * `managed.client.tool.ids()` / `.tool.list({query:{provider,model}})`
 * against a running managed instance of this exact pinned build, reusing
 * the same method `docs/evidence/m1/17-opencode-questions.md`'s "Tool
 * discovery" already used): the registered tool ids on
 * `opencode-ai@1.18.31` are `["invalid","question","bash","read","glob",
 * "grep","edit","write","task","webfetch","todowrite","websearch","skill",
 * "apply_patch"]` (14 total). `tool.list({query:{provider:"stub",
 * model:"stub-model"}})` -- the set actually OFFERED to this experiment's
 * stub provider/model -- returns only 12 of those: "websearch" and
 * "apply_patch" are excluded. This is itself evidence for priority row 6
 * ("provider-executed tools"): both appear to require specific
 * provider/model capability declarations this workspace's generic
 * OpenAI-compatible stub does not advertise, consistent with "websearch"
 * being a provider-native search tool and "apply_patch" being a
 * provider-specific edit-format tool on other engines -- see this file's
 * own assertion on `tool.list()` below and the evidence record's
 * "provider-executed tools" row.
 *
 * "invalid" is the engine's own internal placeholder for a model calling
 * an unregistered tool name (its own schema is `{tool, error}`, confirmed
 * by the same probe) -- not a real user-invokable action path, excluded
 * from this sweep. "question" already has its own dedicated coverage
 * (test/07-always-grant-hook-still-runs.test.ts and
 * docs/evidence/m1/17-opencode-questions.md's question-round-trip test);
 * "bash" already has its own dedicated coverage (every other test in this
 * suite). This test sweeps the remaining 10 listed built-in tool ids:
 * read, glob, grep, edit, write, task, webfetch, todowrite, skill --
 * plus "bash" and "question" again for completeness of the single-turn
 * sweep, so every listed id's actual gating is asserted in one place.
 *
 * Design: `startAdmittedOpenCode({ gateAllTools: true })` (the #21
 * extension to the #20 plugin -- see `src/plugin/admission-plugin.ts`)
 * makes `tool.execute.before` gate EVERY tool call, using each tool's own
 * id as the ledger `action`. The ledger is left with ZERO grants ("deny
 * everything," per issue #21's own instruction). One scripted assistant
 * turn carries a PARALLEL tool_calls array with one call per built-in tool
 * id being swept (mirroring test/05-parallel-requests.test.ts's parallel
 * shape, just heterogeneous tool names instead of two "bash" calls). Since
 * every call is denied by the hook's `throw` BEFORE the tool's own
 * `execute()` ever runs (the same mechanism proven for "bash" throughout
 * this suite), no call needs realistic/successful arguments -- only
 * schema-valid ones -- because none of them can reach real execution.
 * Side-effect markers (a target file for write/edit, a marker directory
 * for tools with no meaningful side effect) independently confirm zero
 * execution reached any tool's real implementation.
 */
test("built-in tools sweep (gate-all-tools, zero grants): every listed tool id is gated by the hook, none executes", async () => {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "opencode-admission-tools-sweep-"));
  const writeTargetFile = path.join(scratchRoot, "write-target.txt");
  const editTargetFile = path.join(scratchRoot, "edit-target.txt");
  // Pre-existing content for "edit" to attempt to replace -- if edit's real
  // execute() ever ran despite denial, this file's content would change.
  const editOriginalContent = "ORIGINAL-EDIT-TARGET-CONTENT\n";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(editTargetFile, editOriginalContent, "utf8");

  const sweptToolIds = ["bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "skill", "question"] as const;

  const parallelTurn: ScriptedTurn = {
    content: "",
    toolCalls: [
      { id: "call_sweep_bash", name: "bash", arguments: JSON.stringify({ command: `echo should-not-run >> ${scratchRoot}/bash-marker.txt` }) },
      { id: "call_sweep_read", name: "read", arguments: JSON.stringify({ filePath: editTargetFile }) },
      { id: "call_sweep_glob", name: "glob", arguments: JSON.stringify({ pattern: "*.txt", path: scratchRoot }) },
      { id: "call_sweep_grep", name: "grep", arguments: JSON.stringify({ pattern: "ORIGINAL", path: scratchRoot }) },
      {
        id: "call_sweep_edit",
        name: "edit",
        arguments: JSON.stringify({ filePath: editTargetFile, oldString: "ORIGINAL-EDIT-TARGET-CONTENT", newString: "MUTATED-BY-EDIT-TOOL" }),
      },
      { id: "call_sweep_write", name: "write", arguments: JSON.stringify({ filePath: writeTargetFile, content: "should-not-be-written" }) },
      {
        id: "call_sweep_task",
        name: "task",
        arguments: JSON.stringify({ description: "sweep probe", prompt: "do nothing", subagent_type: "general" }),
      },
      { id: "call_sweep_webfetch", name: "webfetch", arguments: JSON.stringify({ url: "https://example.invalid/should-not-fetch" }) },
      {
        id: "call_sweep_todowrite",
        name: "todowrite",
        arguments: JSON.stringify({ todos: [{ content: "sweep probe todo", status: "pending", priority: "low" }] }),
      },
      { id: "call_sweep_skill", name: "skill", arguments: JSON.stringify({ name: "nonexistent-sweep-skill" }) },
      {
        id: "call_sweep_question",
        name: "question",
        arguments: JSON.stringify({ questions: [{ question: "sweep probe?", header: "Sweep", options: [{ label: "A", description: "a" }] }] }),
      },
    ],
  };

  const stub = new StubModelServer({ turns: [parallelTurn, scriptTextTurn("Done after built-in tools sweep.")] });
  await stub.start();

  // gateAllTools: true, and deliberately NO grant() call anywhere --
  // "the ledger set to deny everything" per issue #21.
  const admitted = await startAdmittedOpenCode({ stub: { baseUrl: `${stub.url}/v1` }, gateAllTools: true });
  try {
    // Live tool enumeration against this exact pinned instance (documented
    // above; asserted here, not just claimed).
    const idsResult = await admitted.managed.client.tool.ids();
    const ids = (idsResult as { data?: string[] }).data ?? [];
    assert.deepEqual(
      [...ids].sort(),
      ["apply_patch", "bash", "edit", "glob", "grep", "invalid", "question", "read", "skill", "task", "todowrite", "webfetch", "websearch", "write"].sort(),
      "the registered tool id set for this pinned build should match what was recorded in docs/evidence/m1/17-opencode-questions.md",
    );
    const listResult = await admitted.managed.client.tool.list({ query: { provider: admitted.managed.providerId, model: admitted.managed.modelId } });
    const listedIds = ((listResult as { data?: Array<{ id: string }> }).data ?? []).map((t) => t.id).sort();
    assert.ok(!listedIds.includes("websearch"), "PROVIDER-EXECUTED (row 6): \"websearch\" is registered but not offered to this generic OpenAI-compatible stub provider/model");
    assert.ok(!listedIds.includes("apply_patch"), "PROVIDER-EXECUTED (row 6): \"apply_patch\" is registered but not offered to this generic OpenAI-compatible stub provider/model");
    for (const sweptId of sweptToolIds) {
      assert.ok(listedIds.includes(sweptId), `expected "${sweptId}" to be offered to the stub provider/model, listed ids: ${JSON.stringify(listedIds)}`);
    }

    const session = await admitted.managed.session.create("m1-21 built-in tools sweep");
    await admitted.managed.session.promptText(session.id, "run every scripted tool call");

    // Every swept tool id must have produced its own admit() decision,
    // correlated by `action` (gate-all-tools mode uses the tool's own id
    // as the ledger action), and every one must have been denied.
    const decisions = admitted.ledger.decisions();
    const decisionsByAction = new Map(decisions.map((d) => [d.request.action, d]));
    for (const sweptId of sweptToolIds) {
      const decision = decisionsByAction.get(sweptId);
      assert.ok(decision, `expected the hook to have called admit() for tool id "${sweptId}"; recorded actions: ${JSON.stringify([...decisionsByAction.keys()])}`);
      assert.notEqual(decision!.decision, "allow", `tool id "${sweptId}" must have been denied (zero grants): ${JSON.stringify(decision)}`);
      assert.equal(decision!.reason, "no-grant");
    }
    assert.equal(admitted.ledger.dispatches().length, 0, "nothing should have been dispatched -- every swept tool id was denied");

    // Side-effect witnesses, independent of the ledger: none of the
    // real tool implementations ran.
    assert.ok(!existsSync(path.join(scratchRoot, "bash-marker.txt")), "the bash sub-call must not have executed");
    assert.ok(!existsSync(writeTargetFile), "the write tool must not have created its target file");
    assert.equal(readFileSync(editTargetFile, "utf8"), editOriginalContent, "the edit tool must not have mutated its target file");

    // Every denial must have been surfaced to the model/session (per the
    // scenario-1 finding: a hook denial is delivered as a normal tool
    // error, never a fatal engine error), and the session continued to the
    // scripted follow-up turn.
    const messagesJson = JSON.stringify(await admitted.managed.session.messages(session.id));
    assert.ok(messagesJson.includes("Done after built-in tools sweep."), "the session should have continued to the follow-up turn after every denial");
    for (const sweptId of sweptToolIds) {
      // `messagesJson` is `JSON.stringify(...)` of the whole message array,
      // so a literal `"` inside the denial text (embedded in a nested JSON
      // string) is escaped as `\"` in this outer serialization -- match the
      // same escaped form rather than the raw thrown-error text.
      const escapedNeedle = JSON.stringify(`tool "${sweptId}" not admitted`).slice(1, -1);
      assert.ok(messagesJson.includes(escapedNeedle), `expected the denial text for "${sweptId}" to appear in session messages`);
    }
  } finally {
    await admitted.close();
    await stub.close();
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
