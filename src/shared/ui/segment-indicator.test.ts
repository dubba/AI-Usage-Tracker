/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "segment-indicator.css"), "utf8");

describe("segmented control highlight geometry", () => {
  it("centers every option within its track", () => {
    expect(CSS).toMatch(/\.segmented\s*\{[^}]*align-items:\s*center;/);
  });

  it("uses layout placement instead of a composited transform that can round onto another pixel", () => {
    const highlight = CSS.match(/\.segmented::before\s*\{([^}]*)\}/)?.[1];
    expect(highlight).toContain("left: var(--segment-x, 0px);");
    expect(highlight).toContain("top: var(--segment-y, 0px);");
    expect(highlight).not.toMatch(/(?:^|\s)transform\s*:/);
  });
});
