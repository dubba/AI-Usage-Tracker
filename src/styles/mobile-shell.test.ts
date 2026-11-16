/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = readFileSync(join(__dirname, "ui-refinements.css"), "utf8");
const OBSIDIAN = readFileSync(join(__dirname, "obsidian-dashboard.css"), "utf8");
const CARD_RESPONSIVE = readFileSync(join(__dirname, "account-card-responsive.css"), "utf8");
const BOTTOM_NAV = readFileSync(join(__dirname, "..", "app", "bottom-nav.css"), "utf8");
const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8");

describe("mobile shell clears the bottom bar", () => {
  it("lets the page run under the floating bar: the stage is not shortened", () => {
    expect(UI).not.toContain(".obsidian-shell.has-bottom-nav .main-stage");
  });

  it("pads the scroll by the bar's room so the last row can be scrolled clear of it", () => {
    expect(UI).toContain(
      ".obsidian-shell.has-bottom-nav .dashboard-scroll {\n    padding-bottom: calc(var(--bottom-nav-height, 0px) + 10px) !important;",
    );
  });

  it("layers open account card dropdowns above the floating bottom bar and below modals", () => {
    const navZ = Number(BOTTOM_NAV.match(/\.bottom-nav\s*\{[\s\S]*?z-index:\s*(\d+);/)?.[1]);
    const dropdownZ = Number(TOKENS.match(/--z-dropdown:\s*(\d+);/)?.[1]);
    const modalZ = Number(TOKENS.match(/--z-modal:\s*(\d+);/)?.[1]);
    expect(dropdownZ).toBeGreaterThan(navZ);
    expect(modalZ).toBeGreaterThan(dropdownZ);
    expect(CARD_RESPONSIVE).toMatch(
      /\.provider-account-card:has\(\.mobile-dropdown-menu\),\s*\.provider-account-card\.has-open-menu\s*\{[^}]*z-index:\s*var\(--z-dropdown,\s*1000\)\s*!important;/,
    );
    expect(CARD_RESPONSIVE).toMatch(/\.mobile-dropdown-menu\s*\{[^}]*z-index:\s*var\(--z-dropdown,\s*1000\);/);
    expect(OBSIDIAN).toMatch(/\.modal-backdrop\s*\{[^}]*z-index:\s*var\(--z-modal,\s*10000\);/);
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
