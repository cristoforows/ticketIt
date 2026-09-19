/**
 * Manual, slow (~100s) verification of ChatOpenRouter's DEFAULT retry
 * behavior against a persistently-failing invoke. Not part of `npm test`
 * (this file does not match `test/**\/*.test.ts`) because it is too slow
 * to run on every verification pass; run it directly when you need to
 * reproduce the exact default-configuration numbers cited in
 * docs/evidence/m1/25-openrouter-fidelity.md.
 *
 * Run: node --import tsx scripts/verify-default-retry.ts
 */
import { ChatOpenRouter, OpenRouterError } from "@langchain/openrouter";
import { FakeOpenRouterServer } from "../src/server.js";
import { FIXTURES, MID_STREAM_ERROR_MODEL } from "../src/fixtures.js";

async function main(): Promise<void> {
  const server = new FakeOpenRouterServer(FIXTURES);
  await server.start();
  // No maxRetries override: this is ChatOpenRouter's default caller behavior.
  const model = new ChatOpenRouter({ model: MID_STREAM_ERROR_MODEL, apiKey: "dummy-key", baseURL: server.baseURL });

  const startedAt = Date.now();
  let thrown: unknown;
  try {
    await model.invoke("analyze this");
  } catch (err) {
    thrown = err;
  }
  const elapsedMs = Date.now() - startedAt;

  console.log("threw:", thrown instanceof OpenRouterError ? thrown.constructor.name : thrown);
  console.log("elapsed ms:", elapsedMs);
  console.log("total requests received by the fake server:", server.requests.length);

  await server.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
