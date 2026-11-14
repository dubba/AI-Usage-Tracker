/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = readFileSync(join(__dirname, "ui-refinements.css"), "utf8");
const OBSIDIAN = readFileSync(join(__dirname, "obsidian-dashboard.css"), "utf8");

describe("mobile shell clears the bottom bar", () => {
  it("lets the page run under the floating bar: the stage is not shortened", () => {
    expect(UI).not.toContain(".obsidian-shell.has-bottom-nav .main-stage");
  });

  it("pads the scroll by the bar's room so the last row can be scrolled clear of it", () => {
    expect(UI).toContain(
      ".obsidian-shell.has-bottom-nav .dashboard-scroll {\n    padding-bottom: calc(var(--bottom-nav-height, 0px) + 10px) !important;",
    );
  });

  it("matches the gap above the first settings section title to the other sections", () => {
    const mobileIndex = OBSIDIAN.indexOf("@media (max-width: 860px)");
    expect(mobileIndex).toBeGreaterThan(-1);
    const mobileCss = OBSIDIAN.slice(mobileIndex);
    expect(mobileCss).toMatch(
      /\.settings-style-content \.dashboard-scroll > \.settings-section-title:first-child[^}]*margin-top:\s*8px;/
    );
  });

  it("sets bottom margin of settings cards to 0 on mobile to match the 10px scroll gap", () => {
    const mobileIndex = OBSIDIAN.indexOf("@media (max-width: 860px)");
    expect(mobileIndex).toBeGreaterThan(-1);
    const mobileCss = OBSIDIAN.slice(mobileIndex);
    expect(mobileCss).toMatch(
      /\.settings-style-content \.settings-card[^}]*margin-bottom:\s*0\s*!important;/
    );
  });
});
