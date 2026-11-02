/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = readFileSync(join(__dirname, "ui-refinements.css"), "utf8");
const OBSIDIAN = readFileSync(join(__dirname, "obsidian-dashboard.css"), "utf8");

describe("mobile shell clears the bottom bar", () => {
  it("shortens the stage after the later height: 100% rule", () => {
    const fill = UI.indexOf(".obsidian-shell .sidebar,\n.obsidian-shell .main-stage {\n  min-height: 0;\n  height: 100%;");
    const shorten = UI.indexOf(".obsidian-shell.has-bottom-nav .main-stage");
    expect(fill).toBeGreaterThan(-1);
    expect(shorten).toBeGreaterThan(fill);
    expect(UI.slice(shorten, shorten + 280)).toContain(
      "height: calc(100dvh - var(--bottom-nav-height, 0px));",
    );
  });

  it("does not add the system inset again under the bottom bar", () => {
    expect(UI).toContain(".obsidian-shell.has-bottom-nav .dashboard-scroll {\n    padding-bottom: 10px !important;");
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
