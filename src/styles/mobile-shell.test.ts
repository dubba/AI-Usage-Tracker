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

  it("draws a confirmation above the dialog it opens over and below toasts", () => {
    const modalZ = Number(TOKENS.match(/--z-modal:\s*(\d+);/)?.[1]);
    const stackedZ = Number(TOKENS.match(/--z-modal-stacked:\s*(\d+);/)?.[1]);
    const toastZ = Number(TOKENS.match(/--z-toast:\s*(\d+);/)?.[1]);
    expect(stackedZ).toBeGreaterThan(modalZ);
    expect(toastZ).toBeGreaterThan(stackedZ);
    expect(OBSIDIAN).toMatch(/\.confirm-dialog-backdrop\s*\{[^}]*z-index:\s*var\(--z-modal-stacked,\s*10050\);/);
  });

  it("clears the extra gap above the first settings card", () => {
    const mobileIndex = OBSIDIAN.indexOf("@media (max-width: 860px)");
    expect(mobileIndex).toBeGreaterThan(-1);
    const mobileCss = OBSIDIAN.slice(mobileIndex);
    expect(mobileCss).toMatch(
      /\.settings-style-content \.dashboard-scroll > \.settings-card:first-child[^}]*margin-top:\s*0\s*!important;/
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

  it("styles the mobile Settings header borderless on the canvas with a framed gear badge, natural white title, and visible subtitle while keeping desktop unchanged", () => {
    const settingsLayout = readFileSync(join(__dirname, "..", "features", "settings", "settings-layout.css"), "utf8");
    const mobileIndex = SIDEBAR_LIST.indexOf("@media (max-width: 860px)");
    expect(mobileIndex).toBeGreaterThan(-1);
    const desktopCss = SIDEBAR_LIST.slice(0, mobileIndex);
    const mobileCss = SIDEBAR_LIST.slice(mobileIndex);

    expect(desktopCss).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+\.settings-title-icon-badge,\s*\.settings-style-content\s+\.dashboard-header\s+\.settings-title-icon\s*\{[^}]*display:\s*none;/,
    );
    expect(desktopCss).not.toMatch(/\.settings-style-content\s+\.dashboard-header\s*\{/);
    expect(UI).toMatch(
      /\.obsidian-shell\s+\.settings-style-content\s+\.dashboard-header\s*>\s*div:first-child\s*\{[^}]*border-bottom:\s*1px solid var\(--c-1f1e1f\);/,
    );

    expect(mobileCss).toMatch(
      /\.sidebar-mobile-header\s+\.eyebrow\.sidebar-title\s*\{[^}]*color:\s*var\(--c-ffffff\);[^}]*text-transform:\s*none;/,
    );
    expect(mobileCss).toMatch(
      /\.obsidian-shell\s+\.settings-style-content\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/,
    );
    expect(mobileCss).toMatch(
      /\.obsidian-shell\s+\.settings-style-content\s+\.dashboard-scroll\s*\{[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible;/,
    );
    expect(mobileCss).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s*\{[^}]*background:\s*var\(--obsidian-canvas\);[^}]*border-bottom:\s*0;/,
    );
    expect(mobileCss).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+h1\.eyebrow\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*10px;[^}]*font-size:\s*21px;[^}]*font-weight:\s*700;[^}]*text-transform:\s*none;[^}]*color:\s*var\(--c-ffffff\);/,
    );
    expect(mobileCss).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+\.settings-title-icon-badge\s*\{[^}]*display:\s*inline-grid;[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--settings-pill-bg\);[^}]*border:\s*1px solid var\(--settings-pill-border\);/,
    );
    expect(mobileCss).toMatch(
      /\.settings-style-content\s+\.dashboard-header\s+\.dashboard-description\s*\{[^}]*display:\s*block;/,
    );
    expect(OBSIDIAN).toMatch(
      /\.settings-style-content\s+\.settings-card,\s*\.settings-card\s*\{[^}]*border-radius:\s*14px;/,
    );
    expect(settingsLayout).toMatch(
      /\.settings-card-heading\s*\{[^}]*border-radius:\s*13px 13px 0 0;/,
    );
    expect(SIDEBAR_LIST).toMatch(
      /\.mobile-sidebar-toggle-label\s*\{[^}]*font-size:\s*15px;/,
    );
  });

  it("uses subtle near-black gray card surfaces on a pure black canvas in OLED mode", () => {
    const oledBlock = TOKENS.slice(TOKENS.indexOf(':root[data-theme="oled"]'));
    expect(oledBlock).toMatch(/--obsidian-canvas:\s*#000000;/);
    expect(oledBlock).toMatch(/--obsidian-surface-low:\s*#111114;/);
    expect(oledBlock).toMatch(/--panel:\s*#111114;/);
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

  it("splits low-limit summary strips into two shaded rows with a divider", () => {
    expect(OBSIDIAN).toMatch(/\.summary-strip\.is-low-warning,\s*\.summary-strip\.is-low-critical\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*0;[^}]*padding:\s*0;/);
    expect(OBSIDIAN).toMatch(/\.summary-strip\.is-low-warning\s+\.next-reset-inline,\s*\.summary-strip\.is-low-critical\s+\.next-reset-inline\s*\{[^}]*border-top:\s*1px solid var\(--obsidian-border\);[^}]*background:\s*var\(--obsidian-surface-container\);/);
  });
});
