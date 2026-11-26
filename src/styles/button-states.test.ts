/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = __dirname;
const SRC = join(STYLES, "..");
const OBSIDIAN_CSS = readFileSync(join(STYLES, "obsidian-dashboard.css"), "utf8");
const MODAL_CLOSE_CSS = readFileSync(join(STYLES, "modal-close.css"), "utf8");
const UI_REFINEMENTS_CSS = readFileSync(join(STYLES, "ui-refinements.css"), "utf8");
const CARD_RESPONSIVE_CSS = readFileSync(join(STYLES, "account-card-responsive.css"), "utf8");
const TOP_BAR_CSS = readFileSync(join(STYLES, "../app/top-bar.css"), "utf8");
const ACTIVITY_CSS = readFileSync(join(STYLES, "../features/activity/activity.css"), "utf8");
const SIDEBAR_LIST_CSS = readFileSync(join(STYLES, "sidebar-list.css"), "utf8");
const PAIRING_CSS = readFileSync(join(STYLES, "../features/pairing/pairing.css"), "utf8");
const TOKENS_CSS = readFileSync(join(STYLES, "tokens.css"), "utf8");
const TOOLTIP_LAYER_CSS = readFileSync(join(STYLES, "../shared/ui/tooltip-layer.css"), "utf8");

function allCssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return allCssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

describe("Button hover and active state invariants", () => {
  it("excludes the green update button and other custom buttons from generic button:hover override", () => {
    // Ensure the default button hover rule excludes all custom buttons so their hover states are not hijacked
    expect(OBSIDIAN_CSS).toMatch(
      /\.button:hover:not\(:disabled\)(?::not\(\.[a-zA-Z0-9_-]+\)){4,}/
    );
    expect(OBSIDIAN_CSS).toContain(":not(.bucket-delete-button)");
    expect(OBSIDIAN_CSS).toContain(":not(.remove-confirm-button)");
    expect(OBSIDIAN_CSS).toContain(":not(.filter-active-clear-btn)");
    expect(OBSIDIAN_CSS).toContain(":not(.button-green)");
    expect(OBSIDIAN_CSS).toContain(":not(.limit-reset-use)");
  });

  it("provides hover and active states for destructive confirmation buttons", () => {
    // Delete Group (bucket-delete-button)
    expect(OBSIDIAN_CSS).toContain(".button.ghost.bucket-delete-button:hover:not(:disabled)");
    expect(OBSIDIAN_CSS).toContain(".button.ghost.bucket-delete-button:active:not(:disabled)");

    // Remove Confirmation (remove-confirm-button)
    expect(MODAL_CLOSE_CSS).toContain(".button.remove-confirm-button:hover:not(:disabled)");
    expect(MODAL_CLOSE_CSS).toContain(".button.remove-confirm-button:focus-visible:not(:disabled)");
    expect(MODAL_CLOSE_CSS).toContain(".button.remove-confirm-button:active:not(:disabled)");
  });

  it("provides hover and active states for the inline filter clear button", () => {
    expect(OBSIDIAN_CSS).toContain(".summary-strip .compact-button:hover:not(:disabled)");
    expect(OBSIDIAN_CSS).toContain(".summary-strip .compact-button:active:not(:disabled)");
  });

  it("provides active states for account card actions and rename buttons", () => {
    expect(UI_REFINEMENTS_CSS).toContain(".account-card-action.remove-action:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-card-action.refresh-action:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-card-action.notify-action:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-name-confirm:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-name-cancel:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".delete-bucket-title-btn:active:not(:disabled)");
  });

  it("scopes usage display toggle hover states to pointer devices and preserves default purple on mobile", () => {
    expect(OBSIDIAN_CSS).toContain("@media (hover: hover) and (pointer: fine)");
    expect(OBSIDIAN_CSS).toContain(".provider-window-toggle button.active:hover");
    expect(OBSIDIAN_CSS).toMatch(
      /\.provider-window-toggle button\.active,\s*\.provider-window-toggle button\.active:hover,\s*\.provider-window-toggle button\.active:focus/
    );
  });

  it("scopes settings switch toggle hover states to pointer devices so mobile taps do not stick in lighter purple", () => {
    expect(UI_REFINEMENTS_CSS).toMatch(
      /@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*\{[\s\S]*?\.settings-style-content \.toggle:hover:not\(:disabled\)[\s\S]*?\.settings-style-content \.toggle\.on:hover:not\(:disabled\)[\s\S]*?\}/
    );
  });

  it("provides light theme off-state toggle contrast for track, knob, and border", () => {
    expect(UI_REFINEMENTS_CSS).toMatch(
      /:root\[data-theme="light"\] \.toggle:not\(\.on\)\s*\{[^}]*background:\s*#edeaf2;[^}]*outline-color:\s*#857f90;/
    );
    expect(UI_REFINEMENTS_CSS).toMatch(
      /:root\[data-theme="light"\] \.toggle:not\(\.on\) span\s*\{[^}]*background:\s*#958ea0;/
    );
  });

  it("keeps full 4-sided amber borders on the attention bar without border-left clobbering", () => {
    expect(OBSIDIAN_CSS).not.toContain(".summary-strip > .summary-card + .summary-card");
    expect(OBSIDIAN_CSS).toContain(".summary-strip.has-attention.is-filtering");
    expect(OBSIDIAN_CSS).toContain("border-color: var(--obsidian-amber)");
  });

  it("renders tooltips exclusively through the top-level portal above every UI layer, never as ::after pseudo-elements", () => {
    const offenders = allCssFiles(SRC).flatMap((file) => {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      if (/data-tooltip[^\n{]*::after/.test(css)) {
        return [relative(SRC, file).split(sep).join("/")];
      }
      return [];
    });
    expect(offenders).toEqual([]);
    expect(TOOLTIP_LAYER_CSS).toMatch(/\.app-tooltip\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*var\(--z-tooltip\);/);

    const zValue = (token: string) => {
      const match = TOKENS_CSS.match(new RegExp(`--z-${token}:\\s*(\\d+);`));
      expect(match, `--z-${token} must be defined in tokens.css`).not.toBeNull();
      return Number(match![1]);
    };
    const tooltipZ = zValue("tooltip");
    expect(tooltipZ).toBeGreaterThan(zValue("dropdown"));
    expect(tooltipZ).toBeGreaterThan(zValue("modal"));
    expect(tooltipZ).toBeGreaterThan(zValue("toast"));
    expect(tooltipZ).toBeGreaterThan(zValue("error-banner"));
  });

  it("keeps the group title pen and delete button at the account-card size without stretching the title row", () => {
    // The pen matches .account-name-edit (24px). On a wide window the title row is locked
    // to the eyebrow line (15px * 1.15) so the subtitle and divider stay with the other views.
    expect(OBSIDIAN_CSS).toMatch(/\.dashboard-bucket-pill\s*\{[^}]*height:\s*16px/);
    expect(UI_REFINEMENTS_CSS).toMatch(/\.edit-bucket-title-btn\s*\{[^}]*height:\s*24px\s*!important/);
    expect(UI_REFINEMENTS_CSS).toMatch(/\.delete-bucket-title-btn\s*\{[^}]*height:\s*24px\s*!important/);
    expect(UI_REFINEMENTS_CSS).toMatch(
      /@media \(min-width: 861px\)\s*\{\s*\.dashboard-header \.dashboard-title-row:has\(\.edit-bucket-title-btn\)\s*\{\s*height:\s*calc\(15px \* 1\.15\);/,
    );
  });

  it("lines the page switch up with the left edge of the sidebar cards", () => {
    // Sidebar padding 12px plus the list's 5px. The switch used to start at the provider icons.
    expect(SIDEBAR_LIST_CSS).toMatch(/--sidebar-card-inset:\s*17px/);
    expect(TOP_BAR_CSS).toMatch(/padding:\s*12px 24px 12px var\(--sidebar-card-inset,\s*17px\)/);
  });

  it("scales down the pairing modal title on phones to fit on one line", () => {
    expect(PAIRING_CSS).toMatch(/@media\s*\(max-width:\s*480px\)\s*\{[\s\S]*?\.modal-card\.pairing-modal\s+h2[^{]*\{[^}]*font-size:\s*1\.2rem\s*!important/);
  });

  it("shortens spacing instead of shrinking link code tiles when the mobile keyboard is open", () => {
    expect(PAIRING_CSS).not.toMatch(/keyboard-(?:open|active)[^{]*\.pairing-code-tile/);
    expect(PAIRING_CSS).toMatch(/\.modal-card\.pairing-modal\.view-code-entry\.keyboard-open\s+\.pairing-code-entry-view\s*\{\s*gap:\s*12px;/);
    expect(PAIRING_CSS).toMatch(/\.modal-card\.pairing-modal\.view-code-entry\.keyboard-open\s+p\.pairing-subtitle\s*\{\s*margin:\s*0 0 12px 0;/);
    expect(PAIRING_CSS).toMatch(/\.modal-card\.pairing-modal\.view-code-entry\.keyboard-open\s+\.pairing-step-dots\s*\{\s*margin:\s*8px auto;/);
  });

  it("styles X buttons on mobile to match their desktop red hover appearance", () => {
    expect(MODAL_CLOSE_CSS).toMatch(
      /@media\s*\(max-width:\s*860px\),\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.ui-modal-close:not\(:disabled\)\s*\{[^}]*color:\s*var\(--white\);[^}]*border-color:\s*var\(--danger-line-hover\);[^}]*background:\s*var\(--danger-fill-hover\);/,
    );
    expect(MODAL_CLOSE_CSS).toMatch(
      /@media\s*\(max-width:\s*860px\),\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?:root\[data-theme="light"\]\s+\.ui-modal-close:not\(:disabled\)\s*\{[^}]*color:\s*var\(--white\);[^}]*border-color:\s*var\(--danger-line\);[^}]*background:\s*var\(--danger-fill\);/,
    );
    expect(UI_REFINEMENTS_CSS).toMatch(
      /@media\s*\(max-width:\s*860px\),\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.account-name-cancel:not\(:disabled\)\s*\{[^}]*color:\s*var\(--white\)\s*!important;[^}]*border-color:\s*var\(--danger-line-hover\)\s*!important;[^}]*background:\s*var\(--danger-fill-hover\)\s*!important;/,
    );
    expect(UI_REFINEMENTS_CSS).toMatch(
      /@media\s*\(max-width:\s*860px\),\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.sidebar-mobile-header\s+\.mobile-sidebar-close-btn:not\(:disabled\),[\s\S]*?\.mobile-sidebar-close-btn:not\(:disabled\)\s*\{[^}]*background:\s*var\(--danger-fill-hover\)\s*!important;[^}]*border-color:\s*var\(--danger-line-hover\)\s*!important;[^}]*color:\s*var\(--white\)\s*!important;/,
    );
  });

  it("centers X icons inside their buttons and sizes the sidebar close button like the dialogs' ×, in the filter button's 40px footprint", () => {
    expect(UI_REFINEMENTS_CSS).toMatch(
      /\.sidebar-mobile-header\s+\.mobile-sidebar-close-btn,\s*\.mobile-sidebar-close-btn\s*\{[^}]*border-radius:\s*8px\s*!important;[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*display:\s*inline-flex;\s*align-items:\s*center;\s*justify-content:\s*center;\s*margin:\s*4px;\s*padding:\s*0;\s*line-height:\s*0;/,
    );
    expect(UI_REFINEMENTS_CSS).toMatch(
      /\.sidebar-mobile-header\s+\.mobile-sidebar-close-btn\s+svg,\s*\.mobile-sidebar-close-btn\s+svg\s*\{[^}]*display:\s*block;[^}]*width:\s*20px;\s*height:\s*20px;/,
    );
    expect(MODAL_CLOSE_CSS).toMatch(
      /\.ui-modal-close\s*\{[^}]*width:\s*32px;\s*height:\s*32px;\s*display:\s*flex;\s*align-items:\s*center;\s*justify-content:\s*center;\s*padding:\s*0;[^}]*line-height:\s*0;/,
    );
    expect(MODAL_CLOSE_CSS).toMatch(/\.ui-modal-close\s+svg\s*\{[^}]*display:\s*block;/);
    expect(UI_REFINEMENTS_CSS).toMatch(
      /\.account-name-cancel\s+svg\s*\{[^}]*display:\s*block;[^}]*width:\s*14px\s*!important;\s*height:\s*14px\s*!important;/,
    );
  });

  it("styles the inline rename checkmark button with a solid green background and white icon on hover and on mobile", () => {
    expect(UI_REFINEMENTS_CSS).toMatch(
      /@media\s*\(max-width:\s*860px\),\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.account-name-confirm:not\(:disabled\)\s*\{[^}]*color:\s*var\(--white\)\s*!important;[^}]*border-color:\s*var\(--success-line-hover\)\s*!important;[^}]*background:\s*var\(--success-fill-hover\)\s*!important;/,
    );
    expect(UI_REFINEMENTS_CSS).toMatch(
      /\.account-name-confirm:hover:not\(:disabled\),\s*\.account-name-confirm:focus-visible\s*\{[^}]*color:\s*var\(--white\)\s*!important;[^}]*border-color:\s*var\(--success-line-hover\)\s*!important;[^}]*background:\s*var\(--success-fill-hover\)\s*!important;/,
    );
  });

  it("fills rename pen buttons on hover with plain purple like Use… rather than the brighter already-purple hover shade", () => {
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\s+\.limit-reset-use\.button:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--purple-fill\);\s*border-color:\s*var\(--purple-fill\);\s*color:\s*var\(--purple-on-fill\);/,
    );
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card\s+\.account-name-edit:hover:not\(:disabled\),\s*\.provider-account-card\.desktop-card\s+\.account-card-name-hit:hover\s+\.account-name-edit:not\(:disabled\),\s*\.provider-account-card\.desktop-card\s+\.account-name-edit:focus-visible\s*\{[^}]*border-color:\s*var\(--purple-fill\)\s*!important;\s*background:\s*var\(--purple-fill\)\s*!important;\s*color:\s*var\(--purple-on-fill\)\s*!important;/,
    );
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /:root\s+\.dashboard-header\s+\.edit-bucket-title-btn:hover:not\(:disabled\),\s*:root\s+\.dashboard-header\s+\.edit-bucket-title-btn:focus-visible\s*\{[^}]*border-color:\s*var\(--purple-fill\)\s*!important;\s*background:\s*var\(--purple-fill\)\s*!important;\s*color:\s*var\(--purple-on-fill\)\s*!important;/,
    );
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /:root\s+\.provider-account-card\s+\.account-name-edit:hover:not\(:disabled\),\s*:root\s+\.provider-account-card\s+\.account-name-edit:focus-visible,\s*:root\s+\.provider-account-card\s+\.account-name-edit:active:not\(:disabled\)\s*\{[^}]*border-color:\s*var\(--purple-fill\)\s*!important;\s*background:\s*var\(--purple-fill\)\s*!important;\s*color:\s*var\(--purple-on-fill\)\s*!important;/,
    );
  });

  it("matches the desktop chevron menu's interactive states to the rename pen", () => {
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card\s+\.account-card-desktop-actions\s+\.account-card-action\.more-action:not\(:disabled\):hover,\s*\.provider-account-card\.desktop-card\s+\.account-card-desktop-actions\s+\.account-card-action\.more-action:focus-visible,\s*\.provider-account-card\.desktop-card\s+\.account-card-desktop-actions\s+\.account-card-action\.more-action:not\(:disabled\):active\s*\{[^}]*border-color:\s*var\(--purple-fill\);[^}]*background:\s*var\(--purple-fill\);[^}]*color:\s*var\(--purple-on-fill\);/,
    );
  });

  it("gives the desktop Refresh, bell, and chevron buttons matching 9px corners", () => {
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card\s+\.account-card-desktop-actions\s+\.account-card-refresh-time\s*\{[^}]*border-radius:\s*9px;/,
    );
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\.desktop-card\s+\.account-card-desktop-actions\s+\.account-card-action\s*\{[^}]*border-radius:\s*9px\s*!important;/,
    );
  });

  it("styles the limit reset Use button on mobile with the desktop hover purple fill", () => {
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /@media\s*\(max-width:\s*860px\)\s*\{[\s\S]*?\.provider-account-card\s+\.limit-reset-use\.button\s*\{[^}]*background:\s*var\(--purple-fill\);\s*border-color:\s*var\(--purple-fill\);\s*color:\s*var\(--purple-on-fill\);/,
    );
  });

  it("styles limit resets as a full-width black footer band with a top separator", () => {
    expect(CARD_RESPONSIVE_CSS).toMatch(
      /\.provider-account-card\s+\.limit-resets-section\s*\{[^}]*margin:\s*0;[^}]*border-top:\s*1px solid var\(--obsidian-border\);[^}]*background:\s*var\(--obsidian-canvas\);/,
    );
  });

  it("highlights inactive switcher options on hover with --purple-surface like outlined buttons", () => {
    expect(TOP_BAR_CSS).toMatch(
      /\.top-bar-nav-item:not\(\.is-active\):hover,\s*\.top-bar-segmented button:not\(\.active\):hover\s*\{[^}]*background:\s*var\(--purple-surface\);[^}]*color:\s*var\(--obsidian-text\);/,
    );
    expect(ACTIVITY_CSS).toMatch(
      /\.activity-period-switch button:not\(\.active\):hover\s*\{[^}]*background:\s*var\(--purple-surface\);[^}]*color:\s*var\(--obsidian-text\);/,
    );
    expect(OBSIDIAN_CSS).toMatch(
      /\.provider-window-toggle button:hover:not\(\.active\)\s*\{[^}]*background:\s*var\(--purple-surface\);/,
    );
  });

  it("keeps the scrollbar's visible thickness fixed on hover while preserving its wider hit target", () => {
    expect(OBSIDIAN_CSS).toContain("width: var(--scrollbar-hit-size);");
    expect(OBSIDIAN_CSS).not.toMatch(/::-webkit-scrollbar-thumb:(?:hover|active)[^{]*\{[^}]*border-width:/);
    // The background shorthand on :hover/:active resets background-clip: content-box back to border-box,
    // painting the full 14px hit track instead of the 6px thumb.
    expect(OBSIDIAN_CSS).not.toMatch(/::-webkit-scrollbar-thumb:(?:hover|active)[^{]*\{[^}]*\bbackground\s*:/);
    expect(UI_REFINEMENTS_CSS).toMatch(/\.scroll-thumb::before\s*\{[^}]*inset:/);
    expect(UI_REFINEMENTS_CSS).not.toMatch(/\.scroll-thumb:(?:hover|active)\s*\{[^}]*width:/);
  });

  it("matches modal action buttons to the 44px height, 10px corners, and 650 weight of top-bar and Settings buttons", () => {
    expect(UI_REFINEMENTS_CSS).toMatch(
      /\.modal-card\s+\.button:not\(\.compact-button\):not\(\.ui-modal-close\),\s*\.modal-actions\s+\.button:not\(\.compact-button\)\s*\{[^}]*min-height:\s*44px;[^}]*border-radius:\s*10px\s*!important;[^}]*font-weight:\s*650;/,
    );
  });

  it("highlights the hovered Sync Devices role card border just like buttons", () => {
    expect(PAIRING_CSS).toMatch(
      /\.pairing-role-card:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*var\(--obsidian-purple-strong\);[^}]*background:\s*var\(--purple-surface\);/,
    );
    expect(PAIRING_CSS).toMatch(
      /\.modal-card\.pairing-modal\s+\.pairing-settings-toggle:hover\s*\{[^}]*border-color:\s*var\(--obsidian-purple-strong\);[^}]*background:\s*var\(--purple-surface\);/,
    );
  });

  it("highlights tertiary modal buttons (Cancel, Back, Not Now) with --purple-surface on hover like View and Group", () => {
    expect(OBSIDIAN_CSS).toMatch(
      /\.button\.ghost\.button-tertiary:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*var\(--obsidian-purple-strong\);[^}]*background:\s*var\(--purple-surface\);/,
    );
  });
});
