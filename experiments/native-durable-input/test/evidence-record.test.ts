import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_SECTIONS } from "shared";
import { packageRoot } from "./helpers/spawn.js";

/**
 * This package depends on `shared` (per this issue's "What to build":
 * "Create experiments/native-durable-input/ depending on
 * file:../native-harness and file:../shared"). The one thing `shared`
 * exports that this package's own runtime code has no other reason to use
 * is `EVIDENCE_SECTIONS` (`experiments/shared/src/evidence.ts`) -- the
 * canonical, template-derived list of section headings every M1 evidence
 * record must contain. This test uses it for real: it fails if this
 * slice's own evidence record (`docs/evidence/m1/23-native-durable-input.md`)
 * is missing a required section, catching a mismatch against
 * `docs/evidence/m1/TEMPLATE.md` mechanically instead of by eye.
 */
test("evidence record contains every required M1 template section heading", () => {
  const evidencePath = join(packageRoot, "..", "..", "docs", "evidence", "m1", "23-native-durable-input.md");
  const content = readFileSync(evidencePath, "utf8");
  for (const section of EVIDENCE_SECTIONS) {
    assert.ok(
      content.includes(`## ${section}`),
      `expected docs/evidence/m1/23-native-durable-input.md to contain a "## ${section}" section`,
    );
  }
});
