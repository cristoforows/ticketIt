// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ticketSerial } from "./serial";
import { shortDate, slipTilt } from "./slip";

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

  it("formats the capture date in UTC", () => {
    expect(shortDate("2026-09-22T23:59:00Z")).toBe("22 Sep");
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
