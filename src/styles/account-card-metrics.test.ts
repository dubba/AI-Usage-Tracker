// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RESPONSIVE_CSS = readFileSync(join(__dirname, "account-card-responsive.css"), "utf8");
const SIDEBAR_CSS = readFileSync(join(__dirname, "sidebar-list.css"), "utf8");
const ACTIVITY_CSS = readFileSync(join(__dirname, "../features/activity/activity.css"), "utf8");

describe("account card metric row spacing", () => {
  it("keeps uniform vertical padding across all intermediate rows in multi-row cards", () => {
    expect(RESPONSIVE_CSS).toContain(
      ".provider-account-card .account-card-metrics.multi-row-metrics .account-usage-metric:not(:last-child):not(:nth-child(odd):nth-last-child(2))",
    );
  });

  it("matches only non-last rows for 3, 4, 5, and 6 item two-column layouts", () => {
    const selector = ":not(:last-child):not(:nth-child(odd):nth-last-child(2))";

    // 3 items (Row 1: [1, 2], Row 2: [3]) -> Row 1 items get padding-bottom: 12px
    const dom3 = document.createElement("div");
    for (let i = 1; i <= 3; i++) {
      const child = document.createElement("div");
      child.className = "account-usage-metric";
      dom3.appendChild(child);
    }
    const matches3 = Array.from(dom3.children).map((el) => el.matches(selector));
    expect(matches3).toEqual([true, true, false]);

    // 4 items (Row 1: [1, 2], Row 2: [3, 4]) -> Row 1 items get padding-bottom: 12px
    const dom4 = document.createElement("div");
    for (let i = 1; i <= 4; i++) {
      const child = document.createElement("div");
      child.className = "account-usage-metric";
      dom4.appendChild(child);
    }
    const matches4 = Array.from(dom4.children).map((el) => el.matches(selector));
    expect(matches4).toEqual([true, true, false, false]);

    // 5 items (Row 1: Gemini [1, 2], Row 2: Other [3, 4], Row 3: Argon [5])
    // Both Row 1 and Row 2 items get padding-bottom: 12px, ensuring Argon's top gap matches Other's top gap.
    const dom5 = document.createElement("div");
    for (let i = 1; i <= 5; i++) {
      const child = document.createElement("div");
      child.className = "account-usage-metric";
      dom5.appendChild(child);
    }
    const matches5 = Array.from(dom5.children).map((el) => el.matches(selector));
    expect(matches5).toEqual([true, true, true, true, false]);

    // 6 items (Row 1: [1, 2], Row 2: [3, 4], Row 3: [5, 6]) -> Rows 1 and 2 get padding-bottom: 12px
    const dom6 = document.createElement("div");
    for (let i = 1; i <= 6; i++) {
      const child = document.createElement("div");
      child.className = "account-usage-metric";
      dom6.appendChild(child);
    }
    const matches6 = Array.from(dom6.children).map((el) => el.matches(selector));
    expect(matches6).toEqual([true, true, true, true, false, false]);
  });

  it("keeps 4px spacing above and below progress bars on desktop and on mobile", () => {
    expect(RESPONSIVE_CSS).toMatch(/\.desktop-metric\s+\.account-metric-track\s*\{[^}]*margin:\s*4px 0;/);
    expect(RESPONSIVE_CSS).toMatch(/@media\s*\(max-width:\s*860px\)\s*\{[\s\S]*?\.desktop-metric\s+\.account-metric-track\s*\{[^}]*margin:\s*4px 0;/);
  });

  it("stripes an account-card bar with nothing to show, and a stale fill, and leaves sidebar meters alone", () => {
    expect(RESPONSIVE_CSS).toMatch(/\.account-usage-metric \.account-metric-track\.is-hatched\s*\{[^}]*repeating-linear-gradient\(-45deg, var\(--c-353434\)/);
    expect(RESPONSIVE_CSS).toMatch(/\.account-usage-metric\.is-stale \.account-metric-track > span::after\s*\{[^}]*repeating-linear-gradient\(-45deg, transparent/);
    expect(RESPONSIVE_CSS).not.toMatch(/\.provider-summary-track\.is-hatched/);
  });

  it("styles account card progress bars with amber and red for warning and critical tones", () => {
    expect(RESPONSIVE_CSS).toMatch(/\.account-metric-track\s*>\s*\.tone-warning\s*\{[^}]*background:\s*var\(--obsidian-amber\)/);
    expect(RESPONSIVE_CSS).toMatch(/\.account-metric-track\s*>\s*\.tone-critical\s*\{[^}]*background:\s*var\(--danger-fill\)/);
  });

  it("styles sidebar meter text and bars with amber and red matching account cards", () => {
    // Text uses the readable tone tokens (tone-contrast.test.ts); the bars keep the saturated fills.
    expect(SIDEBAR_CSS).toMatch(/\.sidebar-meter-value\.tone-critical\s*\{[^}]*color:\s*var\(--tone-critical-text\)/);
    expect(SIDEBAR_CSS).toMatch(/\.sidebar-meter-value\.tone-warning\s*\{[^}]*color:\s*var\(--tone-warning-text\)/);
    expect(SIDEBAR_CSS).toMatch(/\.provider-summary-track\s*>\s*\.tone-warning\s*\{[^}]*background:\s*var\(--obsidian-amber\)/);
    expect(SIDEBAR_CSS).toMatch(/\.provider-summary-track\s*>\s*\.tone-critical\s*\{[^}]*background:\s*var\(--danger-fill\)/);
    expect(SIDEBAR_CSS).toMatch(/\.provider-summary-track\s*>\s*\.tone-healthy\s*\{[^}]*background:\s*linear-gradient\(90deg,\s*var\(--purple-fill\),\s*var\(--purple-accent\)\)\s*!important/);
  });

  it("gives a phone account error the same gap above it as the usage rows", () => {
    expect(RESPONSIVE_CSS).toMatch(/\.provider-account-card \.account-card-error\s*\{[^}]*margin-top:\s*16px/);
    expect(RESPONSIVE_CSS).not.toMatch(/account-card-updated-error/);
  });

  it("styles sidebar alert dot and mobile sidebar list margins", () => {
    expect(SIDEBAR_CSS).toMatch(/\.provider-summary-row\s+\.sidebar-row-alert\s*\{[\s\S]*?width:\s*7px;[\s\S]*?height:\s*7px;[\s\S]*?border-radius:\s*50%;/);
    expect(SIDEBAR_CSS).toMatch(/\.obsidian-shell\s+\.provider-list\s*\{[\s\S]*?margin-left:\s*-7px;[\s\S]*?margin-right:\s*-7px;/);
  });

  it("styles activity card header with aligned columns and tight title-detail spacing", () => {
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-head\s*\{[\s\S]*?grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto;[\s\S]*?align-items:\s*start;[\s\S]*?column-gap:\s*6px;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-identity\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-total\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*flex-end;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-total-period\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*100%;[\s\S]*?right:\s*0;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-limit\s*\{[\s\S]*?margin:\s*2px 0 0;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-details\s*\{[\s\S]*?margin:\s*2px 0 0;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-icon\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?margin-right:\s*6px;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-card-email\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
  });

  it("styles mobile notification modal to stack limit suffix onto the next line", () => {
    expect(RESPONSIVE_CSS).toMatch(/\.alert-window-label\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*flex-start;/);
    expect(RESPONSIVE_CSS).toMatch(/\.alert-window-suffix\s*\{[\s\S]*?display:\s*block;/);
  });

  it("centers the empty activity message on mobile with equal gap above and below", () => {
    expect(ACTIVITY_CSS).toMatch(/\.activity-message > svg\s*\{[\s\S]*?margin-top:\s*43\.95px;/);
    expect(ACTIVITY_CSS).toMatch(/\.activity-message > h2\s*\{[\s\S]*?margin-bottom:\s*53\.95px;/);
  });

  it("caps the desktop inline rename input box to the end of the progress bar", () => {
    expect(RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card\s*\{[^}]*container-type:\s*inline-size;/,
    );
    expect(RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card\s+\.account-card-name-edit-wrap\s*\{[^}]*width:\s*min\(360px,\s*100cqi - 104px\);/,
    );
    expect(RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card:has\(\.account-card-metrics\.two-column-metrics\)\s+\.account-card-name-edit-wrap\s*\{[^}]*width:\s*calc\(50cqi - 102px\);/,
    );
  });
});
