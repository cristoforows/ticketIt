import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  StubModelServer,
  listPending,
  replyQuestion,
  scriptQuestionToolCall,
  scriptTextTurn,
  startManagedOpenCode,
} from "opencode-harness";
import { createLibrary, materializeRoundInputs, publishLibraryVersion, ROUND_INSTRUCTIONS_RELATIVE_PATH } from "../src/index.js";
import { scriptSkillToolCall } from "../src/index.js";

const SKILL_NAME = "fixed-inputs-demo";

const VERSION_A = {
  instructions: "AGENT-INSTRUCTIONS-VERSION-A-SENTINEL\nFollow version A instructions for the M1.8 demo.\n",
  skillBody: "# Fixed Inputs Demo\n\nVERSION-A-SKILL-CONTENT-SENTINEL\n",
  recipe: "# Recipe: M1.8 Fixed Inputs\n\nVERSION-A-RECIPE-CONTENT-SENTINEL\n",
};

const VERSION_B = {
  instructions: "AGENT-INSTRUCTIONS-VERSION-B-SENTINEL\nFollow version B instructions for the M1.8 demo.\n",
  skillBody: "# Fixed Inputs Demo\n\nVERSION-B-SKILL-CONTENT-SENTINEL\n",
  recipe: "# Recipe: M1.8 Fixed Inputs\n\nVERSION-B-RECIPE-CONTENT-SENTINEL\n",
};

async function waitForPendingQuestion(
  v2Client: Parameters<typeof listPending>[0],
  sessionId: string,
  attempts = 40,
) {
  let pending = await listPending(v2Client, sessionId);
  for (let i = 0; i < attempts && pending.questions.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    pending = await listPending(v2Client, sessionId);
  }
  return pending.questions[0];
}

/**
 * M1.8 (issue #19) core proof: a Round's fixed inputs (Agent instructions,
 * one Skill at version A, one Recipe at version A supplied as Ticket
 * context) survive a Waiting-for-Input pause even while the library is
 * republished to version B and conflicting ambient configuration is
 * planted into every discovery source this pinned build (opencode-ai /
 * @opencode-ai/sdk 1.18.31) supports for a currently-running process; a
 * brand-new Round started afterward observes version B instead. See
 * docs/evidence/m1/19-opencode-fixed-inputs.md for the full discovery-source
 * table, per-source citations, and request-log excerpts.
 */
test("fixed inputs: version A survives pause and ambient decoys; a new Round observes version B", async () => {
  const libraryRoot = mkdtempSync(path.join(tmpdir(), "opencode-fixed-inputs-library-"));
  const library = createLibrary(libraryRoot, SKILL_NAME);
  publishLibraryVersion(library, VERSION_A);

  // ---------------------------------------------------------------------
  // Round 1: materialize version A into a Round-private location, start a
  // session, script a Skill read followed by a question so the Round pauses.
  // ---------------------------------------------------------------------
  const stub1 = new StubModelServer({
    modelId: "stub-model",
    turns: [
      scriptSkillToolCall({ name: SKILL_NAME }),
      scriptQuestionToolCall({
        questions: [
          {
            question: "Which approach do you want for M1.8?",
            header: "Approach",
            options: [
              { label: "Option A", description: "First approach" },
              { label: "Option B", description: "Second approach" },
            ],
          },
        ],
      }),
      scriptTextTurn("Thanks, continuing Round 1 after your answer."),
    ],
  });
  await stub1.start();

  const round1 = await startManagedOpenCode({
    stub: { baseUrl: `${stub1.url}/v1` },
    // The instructions config field is fixed at process start (this
    // pinned build's config is "loaded once ... not hot-reloaded" -- see
    // the evidence file's "Documentation research", citing the pinned
    // binary's own embedded "customize-opencode" skill); the relative
    // path is a known constant (ROUND_INSTRUCTIONS_RELATIVE_PATH), so it
    // can be declared here even though the file itself is written just
    // below, once `round1.projectDir` is known.
    extraConfig: { instructions: [ROUND_INSTRUCTIONS_RELATIVE_PATH] },
  });

  try {
    const materializedA = materializeRoundInputs(round1.projectDir, library);
    assert.ok(materializedA.recipeText.includes("VERSION-A-RECIPE-CONTENT-SENTINEL"));

    const session1 = await round1.session.create("m1-19 round 1");
    const promptPromise = round1.session.promptText(
      session1.id,
      `Ticket context (Recipe):\n${materializedA.recipeText}\n\nPlease use the ${SKILL_NAME} skill, then ask me which approach to use.`,
    );

    const questionRequest = await waitForPendingQuestion(round1.v2Client, session1.id);
    assert.ok(questionRequest, "the Round should pause on the scripted question after the skill read");

    // ---------------------------------------------------------------------
    // While Round 1 waits: publish version B to the library, and plant
    // conflicting ambient configuration into every discovery source this
    // pinned build supports for an ALREADY-RUNNING process. Each decoy
    // carries a distinct model name and distinct instructions/skill text
    // so a leak from any one of them is individually identifiable.
    // ---------------------------------------------------------------------
    publishLibraryVersion(library, VERSION_B);

    // (a) Fake global config directory (this Round's own isolated
    // `XDG_CONFIG_HOME`/`OPENCODE_CONFIG_DIR`-resolved location -- not the
    // real developer machine's, which #16 already proved is unreachable;
    // this decoy tests whether writing into the process's OWN resolved
    // global config path AFTER boot has any live effect).
    const decoyGlobalConfigDir = round1.isolatedPaths.opencodeConfigDir;
    mkdirSync(decoyGlobalConfigDir, { recursive: true });
    writeFileSync(
      path.join(decoyGlobalConfigDir, "DECOY-GLOBAL-INSTRUCTIONS.md"),
      "DECOY-GLOBAL-INSTRUCTIONS-SENTINEL\n",
    );
    writeFileSync(
      path.join(decoyGlobalConfigDir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: "decoy-provider/decoy-global-model",
          instructions: ["DECOY-GLOBAL-INSTRUCTIONS.md"],
        },
        null,
        2,
      ),
    );
    const decoyGlobalSkillDir = path.join(decoyGlobalConfigDir, "skill", SKILL_NAME);
    mkdirSync(decoyGlobalSkillDir, { recursive: true });
    writeFileSync(
      path.join(decoyGlobalSkillDir, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: decoy global skill\n---\nDECOY-GLOBAL-SKILL-CONTENT-SENTINEL\n`,
    );

    // (b) Project config in the SAME running Round's worktree (a file that
    // did not exist when the Round started).
    writeFileSync(
      path.join(round1.projectDir, "DECOY-PROJECT-INSTRUCTIONS.md"),
      "DECOY-PROJECT-INSTRUCTIONS-SENTINEL\n",
    );
    writeFileSync(
      path.join(round1.projectDir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: "decoy-provider/decoy-project-model",
          instructions: ["DECOY-PROJECT-INSTRUCTIONS.md"],
        },
        null,
        2,
      ),
    );
    // A brand-new (non-colliding) project skill planted mid-pause, to
    // check the discovery-source table's "new skill entirely" sub-case,
    // not just a same-name collision.
    const decoyProjectSkillDir = path.join(round1.projectDir, ".opencode", "skill", "brand-new-project-skill");
    mkdirSync(decoyProjectSkillDir, { recursive: true });
    writeFileSync(
      path.join(decoyProjectSkillDir, "SKILL.md"),
      "---\nname: brand-new-project-skill\ndescription: decoy\n---\nDECOY-NEW-PROJECT-SKILL-SENTINEL\n",
    );

    // (c) Ambient external skill directories (`~/.claude/skills`,
    // `~/.agents/skills`), auto-loaded per the pinned build's own
    // documented behavior (see the evidence file).
    const claudeSkillDir = path.join(round1.homeDir, ".claude", "skills", SKILL_NAME);
    mkdirSync(claudeSkillDir, { recursive: true });
    writeFileSync(
      path.join(claudeSkillDir, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: decoy claude skill\n---\nDECOY-CLAUDE-SKILL-CONTENT-SENTINEL\n`,
    );
    const agentsSkillDir = path.join(round1.homeDir, ".agents", "skills", SKILL_NAME);
    mkdirSync(agentsSkillDir, { recursive: true });
    writeFileSync(
      path.join(agentsSkillDir, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: decoy agents skill\n---\nDECOY-AGENTS-SKILL-CONTENT-SENTINEL\n`,
    );

    // (d) Environment-based config: mutate THIS test process's own env
    // while Round 1 waits. A running child process's env was copied at
    // spawn time (see `startManagedOpenCode`'s own comment on
    // `ServerOptions` having no custom-env hook), so this cannot reach
    // Round 1's already-running process -- asserted below via
    // `client.config.get()` rather than assumed.
    process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow" });
    try {
      // ---------------------------------------------------------------
      // Resume Round 1 with the answer.
      // ---------------------------------------------------------------
      const replyResult = await replyQuestion(round1.v2Client, questionRequest!.id, [["Option A"]]);
      assert.equal(replyResult.ok, true, `answering the question should succeed: ${JSON.stringify(replyResult.error)}`);
      await promptPromise;
    } finally {
      delete process.env.OPENCODE_PERMISSION;
    }

    const messagesAfterResume = (await round1.session.messages(session1.id)) as Array<{
      parts: Array<Record<string, unknown>>;
    }>;
    assert.ok(
      JSON.stringify(messagesAfterResume).includes("Thanks, continuing Round 1 after your answer."),
      "Round 1 should continue to the scripted follow-up turn after the resume",
    );

    // The Skill read (via the engine's own "skill" tool) must have
    // returned version A, never version B or any decoy.
    const skillToolPart = messagesAfterResume
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool" && (p as { tool?: string }).tool === "skill") as
      | { state?: { output?: unknown } }
      | undefined;
    assert.ok(skillToolPart, "the skill tool call should have completed");
    const skillOutput = String(skillToolPart!.state?.output ?? "");
    assert.ok(skillOutput.includes("VERSION-A-SKILL-CONTENT-SENTINEL"), "the skill read must return version A content");
    assert.ok(!skillOutput.includes("VERSION-B-SKILL-CONTENT-SENTINEL"), "the skill read must not return version B content");
    assert.ok(!skillOutput.includes("DECOY-GLOBAL-SKILL-CONTENT-SENTINEL"), "the skill read must not return the decoy global skill");
    assert.ok(!skillOutput.includes("DECOY-CLAUDE-SKILL-CONTENT-SENTINEL"), "the skill read must not return the decoy ~/.claude skill");
    assert.ok(!skillOutput.includes("DECOY-AGENTS-SKILL-CONTENT-SENTINEL"), "the skill read must not return the decoy ~/.agents skill");

    // Ground truth: every request the stub received during the entire
    // Round 1 lifetime (before AND after the pause) must carry version A
    // instructions/recipe/model, and must never carry version B or any
    // decoy's instructions/model/skill content.
    const completionRequests = stub1.requests.filter((r) => r.url.startsWith("/v1/chat/completions"));
    assert.ok(completionRequests.length >= 3, "expected at least 3 completion requests (skill call, question call, post-resume continuation)");
    // The skill's full body only enters the transcript once its tool
    // result has been returned to the model, i.e. from the second
    // completion request onward (the first is the request whose response
    // IS the scripted "skill" tool call).
    for (const entry of completionRequests.slice(1)) {
      assert.ok(entry.bodyRaw.includes("VERSION-A-SKILL-CONTENT-SENTINEL"), "every request after the skill call must carry the version A skill content");
    }
    // Instructions and recipe text: every request must carry version A's
    // instructions file content, never version B's or any decoy's.
    for (const entry of completionRequests) {
      assert.ok(entry.bodyRaw.includes("AGENT-INSTRUCTIONS-VERSION-A-SENTINEL"), "every request must carry version A instructions content");
      assert.ok(!entry.bodyRaw.includes("AGENT-INSTRUCTIONS-VERSION-B-SENTINEL"), "no request may carry version B instructions content");
      assert.ok(!entry.bodyRaw.includes("VERSION-B-RECIPE-CONTENT-SENTINEL"), "no request may carry version B recipe content");
    }
    const firstPromptRequest = completionRequests.find((r) => r.bodyRaw.includes("VERSION-A-RECIPE-CONTENT-SENTINEL"));
    assert.ok(firstPromptRequest, "the initial prompt request must carry the version A recipe text (Ticket context)");
    for (const entry of completionRequests) {
      assert.ok(!entry.bodyRaw.includes("decoy-global-model"), "no request may reference the decoy global model name");
      assert.ok(!entry.bodyRaw.includes("decoy-project-model"), "no request may reference the decoy project model name");
      assert.ok(!entry.bodyRaw.includes("DECOY-GLOBAL-INSTRUCTIONS-SENTINEL"), "no request may carry the decoy global instructions text");
      assert.ok(!entry.bodyRaw.includes("DECOY-PROJECT-INSTRUCTIONS-SENTINEL"), "no request may carry the decoy project instructions text");
      assert.ok(!entry.bodyRaw.includes("DECOY-NEW-PROJECT-SKILL-SENTINEL"), "no request may mention the brand-new decoy project skill");
      assert.ok(!entry.bodyRaw.includes("brand-new-project-skill"), "no request may mention the brand-new decoy project skill's name");
    }
    // The model actually used must remain the real stub model throughout.
    for (const entry of completionRequests) {
      const body = entry.body as { model?: string } | undefined;
      assert.equal(body?.model, "stub-model", "every request must use the Round's real configured model, never a decoy");
    }

    // The live resolved config (queried through the SDK, after resume)
    // must also show no decoy leakage.
    const resolvedAfterResume = await round1.client.config.get({});
    const resolvedJson = JSON.stringify(resolvedAfterResume.data);
    assert.ok(!resolvedJson.includes("decoy-global-model"), "resolved config must not show the decoy global model");
    assert.ok(!resolvedJson.includes("decoy-project-model"), "resolved config must not show the decoy project model");
    assert.equal(resolvedAfterResume.data?.model, `${round1.providerId}/${round1.modelId}`, "resolved config's model must remain the Round's real model");
  } finally {
    await round1.close();
    await stub1.close();
  }

  // ---------------------------------------------------------------------
  // Round 2: a brand-new Round (a fresh `startManagedOpenCode` process,
  // per the evidence file's "new Round needs a new process, not just a
  // new session" finding) materializes from the library's CURRENT
  // (now version B) content and must observe version B.
  // ---------------------------------------------------------------------
  const stub2 = new StubModelServer({
    modelId: "stub-model",
    turns: [scriptSkillToolCall({ name: SKILL_NAME }), scriptTextTurn("Round 2 done.")],
  });
  await stub2.start();

  const round2 = await startManagedOpenCode({
    stub: { baseUrl: `${stub2.url}/v1` },
    extraConfig: { instructions: [ROUND_INSTRUCTIONS_RELATIVE_PATH] },
  });
  try {
    const materializedB = materializeRoundInputs(round2.projectDir, library);
    assert.ok(materializedB.recipeText.includes("VERSION-B-RECIPE-CONTENT-SENTINEL"));

    const session2 = await round2.session.create("m1-19 round 2");
    await round2.session.promptText(
      session2.id,
      `Ticket context (Recipe):\n${materializedB.recipeText}\n\nPlease use the ${SKILL_NAME} skill.`,
    );

    const messages2 = (await round2.session.messages(session2.id)) as Array<{ parts: Array<Record<string, unknown>> }>;
    const skillToolPart2 = messages2
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool" && (p as { tool?: string }).tool === "skill") as
      | { state?: { output?: unknown } }
      | undefined;
    assert.ok(skillToolPart2, "Round 2's skill tool call should have completed");
    const skillOutput2 = String(skillToolPart2!.state?.output ?? "");
    assert.ok(skillOutput2.includes("VERSION-B-SKILL-CONTENT-SENTINEL"), "Round 2's skill read must return version B content");
    assert.ok(!skillOutput2.includes("VERSION-A-SKILL-CONTENT-SENTINEL"), "Round 2's skill read must not return version A content");

    const completionRequests2 = stub2.requests.filter((r) => r.url.startsWith("/v1/chat/completions"));
    assert.ok(completionRequests2.some((r) => r.bodyRaw.includes("VERSION-B-RECIPE-CONTENT-SENTINEL")), "Round 2's prompt must carry version B recipe content");
    for (const entry of completionRequests2) {
      assert.ok(!entry.bodyRaw.includes("VERSION-A-RECIPE-CONTENT-SENTINEL"), "Round 2 must never carry version A recipe content");
      assert.ok(!entry.bodyRaw.includes("decoy-global-model"), "Round 2 must not see the decoy global model (fresh isolated home)");
      assert.ok(!entry.bodyRaw.includes("decoy-project-model"), "Round 2 must not see the decoy project model (fresh project dir)");
      assert.ok(!entry.bodyRaw.includes("DECOY-GLOBAL-SKILL-CONTENT-SENTINEL"), "Round 2 must not see the decoy global skill (fresh isolated home)");
      assert.ok(!entry.bodyRaw.includes("DECOY-CLAUDE-SKILL-CONTENT-SENTINEL"), "Round 2 must not see the decoy ~/.claude skill (fresh isolated home)");
    }
  } finally {
    await round2.close();
    await stub2.close();
    rmSync(libraryRoot, { recursive: true, force: true });
  }
});
