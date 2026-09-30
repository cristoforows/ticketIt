// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn } from "./cn";

const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
const names = (prefix: string) => [...css.matchAll(new RegExp(`--${prefix}-([a-z-]+):(?! *var)`, "g"))].map((match) => match[1]).filter((name) => !name.endsWith("-line-height"));

describe("cn", () => {
  it("keeps the custom font-size and colour tokens side by side", () => {
    expect(cn("text-label text-ink")).toBe("text-label text-ink");
    expect(cn("text-title text-status-blocked-deep")).toBe("text-title text-status-blocked-deep");
  });

  it("lets a later font size or colour replace an earlier one of the same kind", () => {
    expect(cn("text-body text-label")).toBe("text-label");
    expect(cn("text-ink text-muted")).toBe("text-muted");
    expect(cn("text-ink", "text-status-in-review-text")).toBe("text-status-in-review-text");
  });

  it("keeps custom tracking, shadow, radius and background tokens apart from their neighbours", () => {
    expect(cn("tracking-label text-label")).toBe("tracking-label text-label");
    expect(cn("tracking-button", "tracking-wordmark")).toBe("tracking-wordmark");
    expect(cn("shadow-paper", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-paper shadow-slip")).toBe("shadow-slip");
    expect(cn("rounded-tag", "rounded-pill")).toBe("rounded-pill");
    expect(cn("bg-paper bg-rail", "bg-rail-shade")).toBe("bg-rail-shade");
    expect(cn("border-2 border-rule")).toBe("border-2 border-rule");
    expect(cn("border-ink", "border-amber")).toBe("border-amber");
  });

  it("resolves overrides that would otherwise need the important modifier", () => {
    expect(cn("my-3", "my-0")).toBe("my-0");
    expect(cn("min-h-24 resize-y", "min-h-0")).toBe("resize-y min-h-0");
    expect(cn("bg-transparent", "bg-paper")).toBe("bg-paper");
  });

  it("does not merge across variants and drops falsy input", () => {
    expect(cn("text-dim", "group-data-drop-target:text-amber", false, null, undefined)).toBe("text-dim group-data-drop-target:text-amber");
    expect(cn("hover:bg-ink/10", "hover:bg-paper")).toBe("hover:bg-paper");
  });

  describe("every theme name in styles.css", () => {
    it.each(names("text").filter((name) => !name.includes("--")))("text-%s is a size, not a colour", (name) => {
      expect(cn(`text-${name}`, "text-ink")).toBe(`text-${name} text-ink`);
      expect(cn("text-body", `text-${name}`)).toBe(`text-${name}`);
    });
    it.each(names("tracking"))("tracking-%s replaces another tracking", (name) => {
      expect(cn("tracking-normal", `tracking-${name}`)).toBe(`tracking-${name}`);
    });
    it.each(names("shadow"))("shadow-%s replaces another shadow", (name) => {
      expect(cn("shadow-md", `shadow-${name}`, "shadow-ink")).toBe(`shadow-${name} shadow-ink`);
    });
    it.each(names("radius"))("rounded-%s replaces another radius", (name) => {
      expect(cn("rounded-none", `rounded-${name}`)).toBe(`rounded-${name}`);
    });
  });
});
