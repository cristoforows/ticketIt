import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StubModelServer, createRoundMapping, startManagedOpenCode } from "../src/index.js";

test("boot: stub -> opencode -> session -> prompt -> scripted reply -> isolation -> clean close", async () => {
  const scriptedReply = "Hello from the scripted stub turn for M1.5.";
  const stub = new StubModelServer({ modelId: "stub-model", turns: [{ content: scriptedReply }] });
  await stub.start();

  // Plant a marker in a fake "real" global config location that must
  // never be observed by the isolated OpenCode process. This directory is
  // never referenced by any env var passed to the managed process below.
  const decoyRoot = mkdtempSync(path.join(tmpdir(), "opencode-harness-decoy-"));
  const decoyConfigDir = path.join(decoyRoot, ".config", "opencode");
  mkdirSync(decoyConfigDir, { recursive: true });
  const markerModel = "decoy-provider/decoy-marker-model";
  const markerInstructionFile = "MARKER-INSTRUCTIONS.md";
  writeFileSync(
    path.join(decoyConfigDir, "opencode.json"),
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", model: markerModel, instructions: [markerInstructionFile] },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(decoyConfigDir, markerInstructionFile),
    "DECOY MARKER: config isolation failed if OpenCode ever read this file.\n",
  );

  const managed = await startManagedOpenCode({
    stub: { baseUrl: `${stub.url}/v1` },
  });

  try {
    assert.ok(managed.pid, "startManagedOpenCode should report a pid for the spawned process");
    assert.notEqual(managed.projectDir, decoyRoot, "the managed project dir must not be the decoy dir");
    assert.notEqual(
      new URL(managed.serverUrl).port,
      "4096",
      "the managed server must bind an OS-assigned free port, not the pinned CLI's fixed default (see 'Observed limitations' in docs/evidence/m1/16-opencode-boot.md)",
    );

    const session = await managed.session.create("m1-16 boot test");
    assert.ok(session.id, "session.create should return a session id");

    const roundMapping = createRoundMapping(session.id);
    assert.notEqual(
      roundMapping.roundId,
      roundMapping.engineExecutionReference,
      "Round ID and OpenCode session ID (engine execution reference) must be distinct identities",
    );
    assert.equal(roundMapping.engineExecutionReference, session.id);

    const promptText = "Please greet the M1.5 boot test, token ROUND-PROMPT-9f31.";
    await managed.session.promptText(session.id, promptText);

    // The stub must have received exactly the prompt sent through the SDK.
    const completionRequests = stub.requests.filter((entry) => entry.url.startsWith("/v1/chat/completions"));
    assert.ok(completionRequests.length >= 1, "stub should have received at least one chat completion request");
    assert.ok(
      completionRequests.some((entry) => entry.bodyRaw.includes(promptText)),
      "stub request body should contain the exact prompt text sent through the SDK",
    );

    // The scripted reply must be visible through the SDK's message query.
    const messages = await managed.session.messages(session.id);
    const messagesJson = JSON.stringify(messages);
    assert.ok(
      messagesJson.includes(scriptedReply),
      "the scripted stub reply should appear in the session's messages via the SDK query",
    );

    // The Round ID must never be sent to OpenCode / the stub.
    for (const entry of stub.requests) {
      assert.ok(!entry.bodyRaw.includes(roundMapping.roundId), "Round ID must never appear in a request OpenCode sent to the stub");
    }

    // The fake "real" global config marker must not have been observed
    // anywhere: not in what OpenCode sent the stub, and not in OpenCode's
    // own resolved config (queried live through the SDK).
    for (const entry of stub.requests) {
      assert.ok(!entry.bodyRaw.includes(markerModel), "stub must never see the decoy marker model name");
      assert.ok(!entry.bodyRaw.includes("DECOY MARKER"), "stub must never see the decoy marker instruction content");
    }
    const resolvedConfig = await managed.client.config.get({});
    const resolvedConfigJson = JSON.stringify(resolvedConfig.data);
    assert.ok(
      !resolvedConfigJson.includes(markerModel),
      "OpenCode's own resolved config (via client.config.get()) must not include the decoy marker model",
    );
    assert.ok(
      !resolvedConfigJson.includes(markerInstructionFile),
      "OpenCode's own resolved config must not include the decoy marker instruction file",
    );
    assert.equal(
      resolvedConfig.data?.model,
      `${managed.providerId}/${managed.modelId}`,
      "the resolved config's active model must be the stub model, not the decoy marker",
    );
  } finally {
    const closeResult = await managed.close();
    assert.equal(closeResult.orphanCheckError, null, `close() must leave no orphaned process: ${closeResult.orphanCheckError}`);
    await stub.close();
    rmSync(decoyRoot, { recursive: true, force: true });
  }
});
