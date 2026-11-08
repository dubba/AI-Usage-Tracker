/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "obsidian-dashboard.css"), "utf8");

/** How many blocks (an at-rule like `@media`, or a rule) are open at `index`. */
function depthAt(index: number): number {
  let depth = 0;
  for (const char of CSS.slice(0, index).replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth;
}

describe("loading skeleton", () => {
  // App.tsx draws it before the first snapshot. Inside a width query, a wide window showed nothing.
  it.each([".skeleton-grid {", ".skeleton-card {", ".skeleton-line {", "@keyframes skeletonShimmer {"])(
    "%s applies at every window width",
    (rule) => {
      const index = CSS.indexOf(rule);
      expect(index, `${rule} is missing`).toBeGreaterThan(-1);
      expect(depthAt(index)).toBe(0);
    },
  );
});
