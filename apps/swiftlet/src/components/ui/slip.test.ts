// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ticketSerial } from "./serial";
import { slipTilt } from "./slip";

describe("slip helpers", () => {
  it("derives the serial from the id", () => {
    expect(ticketSerial("0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe("#0A1B2C");
  });

  it("keeps the tilt within two degrees and stable per id", () => {
    for (const id of ["a", "0a1b2c3d-4e5f", "ffffffff-ffff", "Ticket 42"]) {
      const tilt = slipTilt(id);
      expect(Math.abs(tilt)).toBeLessThanOrEqual(2);
      expect(slipTilt(id)).toBe(tilt);
    }
    const spread = new Set(Array.from({ length: 40 }, (_, index) => slipTilt(`id-${index}`)));
    expect(spread.size).toBeGreaterThan(3);
  });
});

describe("slip motion", () => {
  const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
  const reduced = css.slice(css.indexOf("@layer components"), css.indexOf("@layer base")).match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\})\s*\}/)?.[1] ?? "";

  it("turns off tilt and lift under reduced motion, including hover and focus-within", () => {
    expect(reduced).toContain(".slip:hover");
    expect(reduced).toContain(".slip:focus-within");
    expect(reduced).toMatch(/rotate:\s*none/);
    expect(reduced).toMatch(/translate:\s*none/);
  });
});

describe("delivery indicator motion", () => {
  const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
  const components = css.slice(css.indexOf("@layer components"), css.indexOf("@layer base"));
  const reducedAt = components.indexOf("@media (prefers-reduced-motion: reduce)");
  const motion = components.slice(0, reducedAt);
  const reduced = components.slice(reducedAt);
  const rule = (selector: string) => motion.match(new RegExp(`${selector.replace(/[[\]().*"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it.each([
    ["starting", "delivery-idle"],
    ["working", "delivery-ride"],
    ["stopping", "delivery-return"],
  ])("animates the rider while the reason is %s", (reason, keyframes) => {
    expect(rule(`.delivery[data-reason="${reason}"] .delivery-rider`)).toContain(keyframes);
    expect(motion).toContain(`@keyframes ${keyframes}`);
  });

  it.each(["runner_disconnected", "runner_replaced", "reconciling", "execution_unknown"])("keeps the rider still while the reason is %s", (reason) => {
    expect(motion).not.toContain(`[data-reason="${reason}"]`);
    expect(rule(".delivery .delivery-rider")).toContain("inset-inline-start");
    expect(rule(".delivery .delivery-rider")).not.toContain("animation");
  });

  it("stops the rider under reduced motion", () => {
    expect(reduced).toMatch(/\.delivery \.delivery-rider\s*\{\s*animation:\s*none !important;/);
  });
});
