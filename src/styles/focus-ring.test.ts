/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE = readFileSync(join(__dirname, "base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the keyboard focus ring", () => {
  it("is drawn on desktop", () => {
    expect(BASE).toMatch(/(^|\n):focus-visible\s*\{\s*outline:\s*2px solid var\(--purple\);/);
  });

  it("is never drawn on a touch screen, which has no Tab key", () => {
    expect(BASE).toMatch(/@media \(hover: none\) and \(pointer: coarse\)\s*\{\s*:focus-visible\s*\{\s*outline:\s*none;/);
  });

  it("is never drawn around a dialog's own box, which is not in the Tab order", () => {
    expect(BASE).toMatch(/\.modal-card:focus-visible\s*\{\s*outline:\s*none;/);
  });
});
