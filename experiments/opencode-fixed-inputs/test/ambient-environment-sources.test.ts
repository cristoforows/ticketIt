import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  StubModelServer,
  listPending,
  markerAppendCommand,
  readMarkerLines,
  replyPermission,
  scriptBashToolCall,
  scriptTextTurn,
  startManagedOpenCode,
} from "opencode-harness";

/**
 * M1.8 (issue #19): "environment-based config" as a discovery source is
 * only meaningfully testable at Round-START time (an already-running
 * process's env was copied once at spawn -- see
 * `pause-resume-fixed-inputs.test.ts`'s mid-pause `OPENCODE_PERMISSION`
 * mutation, which the main test asserts has no effect on the
 * already-running Round). These two tests instead check whether an
 * ambient env var already present in the RUNNER's own environment before
 * a NEW Round's process is spawned (never set by `startManagedOpenCode`
 * itself, and not something ticketIt's own harness usage sets) leaks into
 * that new Round.
 *
 * Both tests here are FAILED GATES, not passing isolation proofs: an
 * ambient `OPENCODE_CONFIG` (extra explicit config file) env var's
 * `instructions` array is concatenated onto the Round's own configured
 * instructions rather than being overridden, and an ambient
 * `OPENCODE_PERMISSION` env var's `permission` object is deep-merged in
 * AFTER the Round's own `OPENCODE_CONFIG_CONTENT`-delivered permission
 * config, silently loosening it. Per this issue's instructions, these are
 * recorded as exactly what leaked, not hidden or weakened -- see
 * docs/evidence/m1/19-opencode-fixed-inputs.md, "Fixture/stub evidence"
 * and "Decision impacts", which route both to D1 and D9.
 */

test("FAILED GATE: an ambient OPENCODE_CONFIG env var's instructions array leaks into a new Round (model name itself does not)", async () => {
  const decoyRoot = mkdtempSync(path.join(tmpdir(), "opencode-fixed-inputs-ambient-config-"));
  const decoyInstructionsFile = path.join(decoyRoot, "DECOY-ENV-INSTRUCTIONS.md");
  writeFileSync(decoyInstructionsFile, "DECOY-ENV-INSTRUCTIONS-SENTINEL\n");
  const decoyConfigFile = path.join(decoyRoot, "decoy-opencode-config.json");
  writeFileSync(
    decoyConfigFile,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "decoy-provider/decoy-env-model",
        instructions: [decoyInstructionsFile],
      },
      null,
      2,
    ),
  );

  const stub = new StubModelServer({ modelId: "stub-model", turns: [{ content: "hi" }] });
  await stub.start();

  // Simulate an ambient OPENCODE_CONFIG already present in the runner's
  // own shell/process environment before this Round's process is ever
  // spawned -- e.g. left over from a developer manually running the
  // `opencode` CLI on the same host. `startManagedOpenCode` does not
  // clear or reserve this variable (only HOME/XDG_*/OPENCODE_CONFIG_DIR/
  // TMPDIR/PATH/OPENCODE_DISABLE_MODELS_FETCH are explicitly overridden),
  // so it is inherited by the spawned process exactly as any real ambient
  // pollution would be.
  process.env.OPENCODE_CONFIG = decoyConfigFile;
  let managed;
  try {
    managed = await startManagedOpenCode({
      stub: { baseUrl: `${stub.url}/v1` },
      extraConfig: { instructions: ["AGENT-INSTRUCTIONS.md"] },
    });
    writeFileSync(path.join(managed.projectDir, "AGENT-INSTRUCTIONS.md"), "AGENT-INSTRUCTIONS-VERSION-A-SENTINEL\n");

    const resolved = await managed.client.config.get({});
    // NOT a leak: the Round's own OPENCODE_CONFIG_CONTENT-delivered model
    // wins over the ambient OPENCODE_CONFIG file's model (later-source
    // precedence, see docs/evidence/m1/19-opencode-fixed-inputs.md,
    // "Documentation research", citing the pinned build's own
    // `Config.loadInstanceState` merge order read from its compiled
    // source).
    assert.equal(resolved.data?.model, `${managed.providerId}/${managed.modelId}`, "the Round's own model must win over the ambient OPENCODE_CONFIG file's model");

    const session = await managed.session.create("m1-19 ambient OPENCODE_CONFIG");
    await managed.session.promptText(session.id, "hello");
    const requests = stub.requests.filter((r) => r.url.startsWith("/v1/chat/completions"));
    assert.ok(requests.length >= 1);

    // THIS IS THE FAILED GATE: `instructions` is an array field, and this
    // pinned build's config merge CONCATENATES arrays across sources
    // rather than letting a later source replace an earlier one. The
    // ambient decoy's instructions file content is observed verbatim in
    // the request the Round sends to the model, alongside the Round's
    // own real instructions -- an ambient, unrelated env var was able to
    // inject extra system-prompt content into a Round it has no
    // connection to.
    for (const entry of requests) {
      assert.ok(entry.bodyRaw.includes("AGENT-INSTRUCTIONS-VERSION-A-SENTINEL"), "the Round's own instructions must still be present");
      assert.ok(
        entry.bodyRaw.includes("DECOY-ENV-INSTRUCTIONS-SENTINEL"),
        "FAILED GATE (observed, not hidden): the ambient OPENCODE_CONFIG file's instructions leaked into this unrelated Round's system prompt",
      );
    }
  } finally {
    delete process.env.OPENCODE_CONFIG;
    if (managed) await managed.close();
    await stub.close();
    rmSync(decoyRoot, { recursive: true, force: true });
  }
});

test("FAILED GATE: an ambient OPENCODE_PERMISSION env var overrides a new Round's configured bash permission", async () => {
  const markerRoot = mkdtempSync(path.join(tmpdir(), "opencode-fixed-inputs-ambient-permission-"));
  const markerFile = path.join(markerRoot, "marker.log");

  const stub = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptBashToolCall({ command: markerAppendCommand(markerFile) }), scriptTextTurn("done")],
  });
  await stub.start();

  // Simulate an ambient OPENCODE_PERMISSION already present in the
  // runner's environment, unrelated to this Round, that happens to allow
  // bash unconditionally.
  process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow" });
  let managed;
  try {
    managed = await startManagedOpenCode({
      stub: { baseUrl: `${stub.url}/v1` },
      // This Round explicitly configures bash to require approval.
      extraConfig: { permission: { bash: "ask" } },
    });

    const resolved = await managed.client.config.get({});
    // THIS IS THE FAILED GATE: `OPENCODE_PERMISSION` is merged in AFTER
    // the Round's own OPENCODE_CONFIG_CONTENT-delivered `permission`
    // field (see the same `Config.loadInstanceState` merge order cited
    // above), so it silently overrides the Round's configured "ask" with
    // "allow".
    assert.equal(
      (resolved.data as { permission?: { bash?: unknown } } | undefined)?.permission?.bash,
      "allow",
      "FAILED GATE (observed, not hidden): an ambient OPENCODE_PERMISSION env var overrode this Round's configured bash permission",
    );

    const session = await managed.session.create("m1-19 ambient OPENCODE_PERMISSION");
    const promptPromise = managed.session.promptText(session.id, "please run the marker command");

    // Poll briefly for a permission request; per the observed override
    // above, none should ever appear -- the bash call executes directly.
    let pending = await listPending(managed.v2Client, session.id);
    for (let i = 0; i < 15 && pending.permissions.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pending = await listPending(managed.v2Client, session.id);
    }
    const permissionWasAsked = pending.permissions.length > 0;
    if (permissionWasAsked) {
      // Resolve it either way so the test can finish deterministically,
      // but this branch means the override did NOT reproduce this run.
      await replyPermission(managed.v2Client, pending.permissions[0]!.id, "once");
    }
    await promptPromise;

    assert.equal(
      permissionWasAsked,
      false,
      "FAILED GATE (observed, not hidden): the ambient OPENCODE_PERMISSION env var suppressed the Round's own 'ask' permission request",
    );
    assert.equal(readMarkerLines(markerFile).length, 1, "the shell command executed exactly once, without ever pausing for approval");
  } finally {
    delete process.env.OPENCODE_PERMISSION;
    if (managed) await managed.close();
    await stub.close();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});
