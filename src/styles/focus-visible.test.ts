/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * base.css gives every focused control a 2px purple ring (`:focus-visible`). These controls used to
 * switch it off with `outline: none` and show no other change, so a keyboard user could not see
 * where they were. This keeps a rule from switching their ring off again. Mouse and touch focus is
 * still ring-free through base.css's `:focus:not(:focus-visible)`.
 */
const SRC = join(__dirname, "..");
const GUARDED = [
  "account-card-provider-icon",
  "mobile-sidebar-toggle-btn",
  "mobile-sidebar-close-btn",
  "ui-modal-close",
  "mobile-dropdown-item",
];

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

/** Every `selector { body }` in a file, with comments removed and @media wrappers flattened. */
function rules(source: string): Array<{ selector: string; body: string }> {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Array<{ selector: string; body: string }> = [];
  for (const match of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    found.push({ selector: match[1].trim(), body: match[2] });
  }
  return found;
}

describe("keyboard focus rings", () => {
  const all = cssFiles(SRC).flatMap((file) => rules(readFileSync(file, "utf8")).map((rule) => ({ file, ...rule })));

  it.each(GUARDED)("no rule switches off the focus ring of .%s", (name) => {
    const offenders = all
      .filter(({ selector, body }) =>
        selector
          .split(",")
          .some((part) => part.includes(`.${name}`) && !part.includes(":focus:not(:focus-visible)")) &&
        /(^|;|\s)outline\s*:\s*(none|0)\b/.test(body),
      )
      .map(({ file, selector }) => `${file.slice(SRC.length + 1)}: ${selector.replace(/\s+/g, " ").slice(0, 100)}`);
    expect(offenders).toEqual([]);
  });
});
