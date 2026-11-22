/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two counts per stylesheet that may only go down: `!important` flags, and color literals
 * (hex, rgb(), rgba()) written in place of a token from tokens.css. See the `!important` and
 * Tokens sections of docs/CSS_ARCHITECTURE.md.
 *
 * When a count drops, lower the number here in the same change. A count that needs to rise is a
 * deliberate decision: raise or restructure the selector instead of adding `!important`, and
 * add a token instead of pasting a color. A stylesheet that is not listed gets a budget of zero.
 * The token files themselves (tokens.css, theme-palette.css) are where the literals belong, so
 * they have no color budget.
 */
const BUDGET: Record<string, { important: number; rawColors: number }> = {
  "app/bottom-nav.css": { important: 0, rawColors: 0 },
  "app/top-bar.css": { important: 2, rawColors: 0 },
  "features/activity/activity.css": { important: 4, rawColors: 3 },
  "features/pairing/pairing.css": { important: 94, rawColors: 13 },
  "features/startup/startup-gate.css": { important: 0, rawColors: 0 },
  "shared/ui/segment-indicator.css": { important: 3, rawColors: 0 },
  "styles/account-card-responsive.css": { important: 106, rawColors: 7 },
  "styles/api-integration.css": { important: 1, rawColors: 1 },
  "styles/base.css": { important: 4, rawColors: 0 },
  "styles/dashboard-reorder.css": { important: 19, rawColors: 3 },
  "styles/modal-close.css": { important: 9, rawColors: 0 },
  "styles/obsidian-dashboard.css": { important: 130, rawColors: 8 },
  "styles/shell-patches.css": { important: 9, rawColors: 0 },
  "styles/sidebar-list.css": { important: 21, rawColors: 0 },
  "styles/theme-palette.css": { important: 0, rawColors: 0 },
  "styles/tokens.css": { important: 0, rawColors: 0 },
  "styles/ui-refinements.css": { important: 222, rawColors: 7 },
};

const TOKEN_FILES = new Set(["styles/tokens.css", "styles/theme-palette.css"]);
const SRC = join(__dirname, "..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

/** Counts in one stylesheet, with comments left out. */
function measure(source: string, countColors: boolean): { important: number; rawColors: number } {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const important = css.match(/!\s*important/g)?.length ?? 0;
  // rgb(var(--purple-accent-rgb) / 0.2) is a token with an alpha, not a literal: the pattern
  // skips any rgb() that contains a nested parenthesis.
  const colors = css.match(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^()]*\)/g);
  return { important, rawColors: countColors ? (colors?.length ?? 0) : 0 };
}

const measured = Object.fromEntries(
  cssFiles(SRC).map((file) => {
    const name = relative(SRC, file).split(sep).join("/");
    return [name, measure(readFileSync(file, "utf8"), !TOKEN_FILES.has(name))];
  }),
);

describe("CSS debt", () => {
  it("reads the stylesheets", () => {
    expect(Object.keys(measured).length).toBeGreaterThan(5);
  });

  it("does not add !important flags or raw colors", () => {
    const over = Object.entries(measured).flatMap(([name, found]) => {
      const allowed = BUDGET[name] ?? { important: 0, rawColors: 0 };
      return (["important", "rawColors"] as const)
        .filter((kind) => found[kind] > allowed[kind])
        .map((kind) => `${name}: ${kind} is ${found[kind]}, budget ${allowed[kind]}`);
    });
    expect(over).toEqual([]);
  });

  it("keeps the budget at the current counts", () => {
    const stale = Object.entries(BUDGET).flatMap(([name, allowed]) => {
      const found = measured[name];
      if (!found) return [`${name}: listed here but the file is gone; remove the entry`];
      return (["important", "rawColors"] as const)
        .filter((kind) => found[kind] < allowed[kind])
        .map((kind) => `${name}: ${kind} is now ${found[kind]}; lower the budget from ${allowed[kind]}`);
    });
    expect(stale).toEqual([]);
  });
});
