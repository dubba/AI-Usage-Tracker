/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = readFileSync(join(__dirname, "ui-refinements.css"), "utf8");
const OBSIDIAN = readFileSync(join(__dirname, "obsidian-dashboard.css"), "utf8");
const CARD_RESPONSIVE = readFileSync(join(__dirname, "account-card-responsive.css"), "utf8");
const BOTTOM_NAV = readFileSync(join(__dirname, "..", "app", "bottom-nav.css"), "utf8");
const SIDEBAR_LIST = readFileSync(join(__dirname, "sidebar-list.css"), "utf8");
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

  it("layers open account card dropdowns above the floating bottom bar without lifting the card above it", () => {
    const navZ = Number(BOTTOM_NAV.match(/\.bottom-nav\s*\{[\s\S]*?z-index:\s*(\d+);/)?.[1]);
    const dropdownZ = Number(TOKENS.match(/--z-dropdown:\s*(\d+);/)?.[1]);
    const modalZ = Number(TOKENS.match(/--z-modal:\s*(\d+);/)?.[1]);
    expect(dropdownZ).toBeGreaterThan(navZ);
    expect(modalZ).toBeGreaterThan(dropdownZ);
    expect(CARD_RESPONSIVE).toMatch(/\.mobile-dropdown-menu\s*\{[^}]*position:\s*fixed;/);
    expect(CARD_RESPONSIVE).toMatch(/\.mobile-dropdown-menu\s*\{[^}]*z-index:\s*var\(--z-dropdown,\s*1000\);/);
    expect(CARD_RESPONSIVE).not.toMatch(/\.provider-account-card[^{]*\{[^}]*z-index:\s*var\(--z-dropdown/);
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

  it("styles mobile Dashboard header U | L to match the 40px header controls without a Compact button", () => {
    expect(SIDEBAR_LIST).not.toContain(".sidebar-display-switch");
    expect(SIDEBAR_LIST).not.toContain(".compact-dashboard-toggle.is-mobile-header");
    expect(SIDEBAR_LIST).toMatch(
      /\.dashboard-header-actions\s+\.provider-window-toggle\.is-mobile-header\s*\{[^}]*height:\s*40px;[^}]*box-sizing:\s*border-box;/,
    );
  });

  it("keeps the mobile header title row at least 40px tall so App Settings matches Dashboard and Usage", () => {
    const mobileIndex = OBSIDIAN.indexOf("@media (max-width: 860px)");
    expect(mobileIndex).toBeGreaterThan(-1);
    const mobileCss = OBSIDIAN.slice(mobileIndex);
    expect(mobileCss).toMatch(
      /\.dashboard-header\s+\.dashboard-title-row\s*\{[^}]*min-height:\s*40px;/,
    );
  });

  it("styles the mobile title-as-filter pill at 40px with chevron and hides the Usage Period label on mobile", () => {
    const activityCss = readFileSync(join(__dirname, "..", "features", "activity", "activity.css"), "utf8");
    expect(SIDEBAR_LIST).toMatch(
      /\.dashboard-header\s+>\s+div:first-child\s+\.mobile-sidebar-toggle-btn\.has-filter-label\s*\{[^}]*height:\s*40px;[^}]*border-radius:\s*10px;/,
    );
    expect(SIDEBAR_LIST).toMatch(
      /\.dashboard-header\s+\.dashboard-title-row\s+h1\.mobile-title-filter-heading\s*\{[^}]*text-transform:\s*none;/,
    );
    expect(activityCss).toMatch(/@media\s*\(max-width:\s*860px\)\s*\{[\s\S]*?\.activity-period-label\s*\{[^}]*display:\s*none;/);
  });

  it("styles mobile App Settings and AI Usage Tracker headers white without uppercase, with App Settings aligned to All Accounts", () => {
    expect(SIDEBAR_LIST).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+h1\.eyebrow,\s*\.sidebar-mobile-header\s+\.eyebrow\.sidebar-title\s*\{[^}]*color:\s*var\(--c-ffffff\);[^}]*text-transform:\s*none;/,
    );
    expect(SIDEBAR_LIST).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+h1\.eyebrow\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px;[^}]*min-height:\s*40px;[^}]*font-size:\s*15px;[^}]*padding-left:\s*13px;/,
    );
    expect(SIDEBAR_LIST).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+\.settings-title-icon\s*\{[^}]*display:\s*block;[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*opacity:\s*0\.75;/,
    );
    expect(SIDEBAR_LIST).toMatch(
      /\.mobile-sidebar-toggle-label\s*\{[^}]*font-size:\s*15px;/,
    );
  });

  it("styles the compact card plan badge identically to the expanded card plan pill on mobile", () => {
    expect(CARD_RESPONSIVE).toMatch(
      /\.provider-account-card\s+\.account-card-header-meta\s+\.account-plan-badge,\s*\.provider-account-card\s+\.compact-card-identity\s+\.account-plan-badge\s*\{[^}]*height:\s*26px;[^}]*border-radius:\s*999px;[^}]*background:\s*var\(--purple-surface\);[^}]*color:\s*var\(--purple-text\);/,
    );
  });

  it("sizes the leading filter icon and trailing chevron inside the mobile filter pill", () => {
    expect(SIDEBAR_LIST).toMatch(
      /\.dashboard-header\s+\.mobile-sidebar-toggle-btn\.has-filter-label\s+svg\.mobile-sidebar-toggle-filter,\s*\.dashboard-header\s+\.mobile-sidebar-toggle-btn\.has-filter-label\s+svg\.mobile-sidebar-toggle-chevron\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/,
    );
  });

  it("positions desktop in-app alert toasts at the top right below the header/top bar and gates them off mobile", () => {
    const appSource = readFileSync(join(__dirname, "..", "app", "App.tsx"), "utf8");
    expect(appSource).toContain("const inAppAlertsEnabled = !isAndroid() && !isIOS();");
    expect(appSource).toContain("useUsageAlerts(inAppAlertsEnabled)");
    expect(appSource).toContain("<UsageAlertToasts");
    expect(appSource).toContain("onSelectAlert={handleSelectAlert}");
    expect(UI).toMatch(/\.usage-alert-toast-container\s*\{[^}]*top:\s*calc\(64px \+ var\(--safe-area-top, 0px\)\);[^}]*right:\s*24px;/);
    expect(UI).not.toMatch(/\.usage-alert-toast-container\s*\{[^}]*bottom:/);
    expect(UI).toMatch(/\.app-shell\.has-top-bar\s+\.usage-alert-toast-container\s*\{[^}]*top:\s*calc\(81px \+ var\(--safe-area-top, 0px\)\);/);
    expect(UI).toMatch(/@keyframes\s+toastSlideIn\s*\{[\s\S]*?translateY\(-16px\)/);
  });

  it("stacks the mobile summary strip into two lines with next reset on the second line", () => {
    const mobileIndex = OBSIDIAN.indexOf("@media (max-width: 860px)");
    expect(mobileIndex).toBeGreaterThan(-1);
    const mobileCss = OBSIDIAN.slice(mobileIndex);
    expect(mobileCss).toMatch(/\.summary-strip\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/);
    expect(mobileCss).toMatch(
      /\.summary-strip\.has-attention\.is-filtering\s+\.summary-strip-toggle\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/,
    );
    expect(mobileCss).toMatch(/\.next-reset-inline\s*\{[^}]*justify-content:\s*flex-start;[^}]*margin-left:\s*0;/);
  });
});
