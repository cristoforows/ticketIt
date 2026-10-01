// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { statuses } from "./status";

const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`missing token --color-${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const slug = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

const textPairs: Array<[string, string, string]> = [
  ["paper on ground", "paper", "ground"],
  ["paper on header", "paper", "header"],
  ["amber on header", "amber", "header"],
  ["amber on ground", "amber", "ground"],
  ["dim on header", "dim", "header"],
  ["dim on ground", "dim", "ground"],
  ["ink on paper", "ink", "paper"],
  ["muted on paper", "muted", "paper"],
  ["ink on amber", "ink", "amber"],
  ["amber on ink", "amber", "ink"],
  ["queued tag: status-ready-deep on paper", "status-ready-deep", "paper"],
  ["claimed tag: ink on paper", "ink", "paper"],
  ["lock notice and lock glyph: ink on paper", "ink", "paper"],
];

// Every foreground each HealthPill variant paints (text, dot and border share it) over the surface it sits on.
const healthPillPairs: Array<[string, string, string]> = [
  ["header pill connected", "status-done-text", "header"],
  ["header pill disconnected", "status-blocked-text", "header"],
  ["header pill not paired / unknown", "dim", "header"],
  ["ground pill connected", "status-done-text", "ground"],
  ["ground pill disconnected", "status-blocked-text", "ground"],
  ["ground pill not paired / unknown", "dim", "ground"],
  ["paper pill connected", "status-done-deep", "paper"],
  ["paper pill disconnected", "status-blocked-deep", "paper"],
  ["paper pill not paired / unknown", "muted", "paper"],
];

describe("token contrast (WCAG AA)", () => {
  it.each(textPairs)("%s is at least 4.5:1", (_label, fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(healthPillPairs)("%s is at least 4.5:1", (_label, fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  describe.each(statuses)("$value", ({ value }) => {
    const name = `status-${slug(value)}`;
    it("text on the dark ground is at least 4.5:1", () => {
      expect(contrast(token(`${name}-text`), token("ground"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(`${name}-text`), token("header"))).toBeGreaterThanOrEqual(4.5);
    });
    it("deep colour is at least 4.5:1 against paper, as text and as a tag fill under paper text", () => {
      expect(contrast(token(`${name}-deep`), token("paper"))).toBeGreaterThanOrEqual(4.5);
    });
    it("marker fill (text token) is at least 3:1 against the ground", () => {
      expect(contrast(token(`${name}-text`), token("ground"))).toBeGreaterThanOrEqual(3);
    });
    it("is declared in the data-status block", () => {
      expect(css).toContain(`[data-status="${value}"]`);
    });
  });
});
