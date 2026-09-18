import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOpencodeSdkVersion, resolveOpencodeVersion } from "../src/index.js";

test("versions: pinned opencode-ai and @opencode-ai/sdk resolve to the same version, released together", () => {
  const opencodeVersion = resolveOpencodeVersion();
  const sdkVersion = resolveOpencodeSdkVersion();
  assert.equal(opencodeVersion, "1.18.31");
  assert.equal(sdkVersion, "1.18.31");
  assert.equal(opencodeVersion, sdkVersion, "the pinned executable and SDK must be the matching lockstep-released version");
});
