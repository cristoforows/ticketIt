import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_SECTIONS,
  EVIDENCE_TEMPLATE_PATH,
  EVIDENCE_INDEX_PATH,
  renderEvidenceSkeleton,
} from "../src/evidence.js";

test("evidence paths point at the M1 evidence directory", () => {
  assert.equal(EVIDENCE_TEMPLATE_PATH, "docs/evidence/m1/TEMPLATE.md");
  assert.equal(EVIDENCE_INDEX_PATH, "docs/evidence/m1/README.md");
});

test("renderEvidenceSkeleton includes every required section in order", () => {
  const rendered = renderEvidenceSkeleton("Example experiment");
  let lastIndex = -1;
  for (const section of EVIDENCE_SECTIONS) {
    const index = rendered.indexOf(`## ${section}`);
    assert.ok(index > lastIndex, `expected section "${section}" to appear in order`);
    lastIndex = index;
  }
});

test("renderEvidenceSkeleton includes the given title as an H1", () => {
  const rendered = renderEvidenceSkeleton("Example experiment");
  assert.ok(rendered.startsWith("# Example experiment\n"));
});
