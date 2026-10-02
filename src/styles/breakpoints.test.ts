/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_OVERLAY_QUERY } from "../features/dashboard/sidebar-width";

/**
 * Every width used in a CSS media query. Keep this list, the table in
 * docs/CSS_ARCHITECTURE.md and the CSS in step: adding a new breakpoint should
 * be a deliberate decision, not something that happens by accident.
 */
const MAX_WIDTHS = [360, 400, 480, 600, 640, 720, 760, 768, 860, 1180, 1220];
const MIN_WIDTHS = [861];

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

const cssSources = cssFiles(join(__dirname, "..")).map((file) => readFileSync(file, "utf8"));

function widths(kind: "max" | "min"): number[] {
  const found = new Set<number>();
  for (const source of cssSources) {
    for (const match of source.matchAll(new RegExp(`\\(${kind}-width:\\s*(\\d+)px\\)`, "g"))) {
      found.add(Number(match[1]));
    }
  }
  return [...found].sort((a, b) => a - b);
}

describe("CSS breakpoints", () => {
  it("reads the stylesheets", () => {
    expect(cssSources.length).toBeGreaterThan(5);
  });

  it("only uses the documented widths", () => {
    expect(widths("max")).toEqual(MAX_WIDTHS);
    expect(widths("min")).toEqual(MIN_WIDTHS);
  });

  it("keeps the JS mobile query on the CSS mobile/desktop split", () => {
    expect(MOBILE_OVERLAY_QUERY).toBe("(max-width: 860px)");
    expect(widths("max")).toContain(860);
    expect(widths("min")).toContain(861);
  });
});
