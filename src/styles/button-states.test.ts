/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = __dirname;
const OBSIDIAN_CSS = readFileSync(join(STYLES, "obsidian-dashboard.css"), "utf8");
const MODAL_CLOSE_CSS = readFileSync(join(STYLES, "modal-close.css"), "utf8");
const UI_REFINEMENTS_CSS = readFileSync(join(STYLES, "ui-refinements.css"), "utf8");

describe("Button hover and active state invariants", () => {
  it("excludes danger and amber buttons from generic button:hover override", () => {
    // Ensure the default button hover rule excludes all custom buttons so their hover states are not hijacked
    expect(OBSIDIAN_CSS).toMatch(
      /\.button:hover:not\(:disabled\)(?::not\(\.[a-zA-Z0-9_-]+\)){4,}/
    );
    expect(OBSIDIAN_CSS).toContain(":not(.bucket-delete-button)");
    expect(OBSIDIAN_CSS).toContain(":not(.remove-confirm-button)");
    expect(OBSIDIAN_CSS).toContain(":not(.filter-active-clear-btn)");
    expect(OBSIDIAN_CSS).toContain(":not(.settings-update-action-danger)");
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

  it("provides hover and active states for the filter active banner clear button", () => {
    expect(OBSIDIAN_CSS).toContain(".filter-active-banner .compact-button:hover:not(:disabled)");
    expect(OBSIDIAN_CSS).toContain(".filter-active-banner .compact-button:active:not(:disabled)");
  });

  it("provides active states for account card actions and rename buttons", () => {
    expect(UI_REFINEMENTS_CSS).toContain(".account-card-action.remove-action:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-card-action.refresh-action:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-card-action.notify-action:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-name-confirm:active:not(:disabled)");
    expect(UI_REFINEMENTS_CSS).toContain(".account-name-cancel:active:not(:disabled)");
  });

  it("scopes usage display toggle hover states to pointer devices and preserves default purple on mobile", () => {
    expect(OBSIDIAN_CSS).toContain("@media (hover: hover) and (pointer: fine)");
    expect(OBSIDIAN_CSS).toContain(".provider-window-toggle button.active:hover");
    expect(OBSIDIAN_CSS).toMatch(
      /\.provider-window-toggle button\.active,\s*\.provider-window-toggle button\.active:hover,\s*\.provider-window-toggle button\.active:focus/
    );
  });

  it("keeps full 4-sided amber borders on the attention card without border-left clobbering", () => {
    expect(OBSIDIAN_CSS).not.toContain(".summary-strip > .summary-card + .summary-card");
    expect(OBSIDIAN_CSS).toContain(".summary-card.attention-card.is-filtering");
    expect(OBSIDIAN_CSS).toContain("border-color: var(--obsidian-amber)");
  });

  it("anchors L / U tooltips to the left edge when stacked on a second line", () => {
    expect(UI_REFINEMENTS_CSS).toContain("html[data-sidebar-toggle-stacked] .provider-window-toggle button[data-tooltip]::after");
    expect(UI_REFINEMENTS_CSS).toContain("html[data-sidebar-toggle-stacked] .provider-window-toggle button:last-child[data-tooltip]::after");
  });

  it("keeps the group title pen at the account-card size without stretching the title row", () => {
    // The pen matches .account-name-edit (24px). On a wide window the title row is locked
    // to the eyebrow line (15px * 1.15) so the subtitle and divider stay with the other views.
    expect(OBSIDIAN_CSS).toMatch(/\.dashboard-bucket-pill\s*\{[^}]*height:\s*16px/);
    expect(UI_REFINEMENTS_CSS).toMatch(/\.edit-bucket-title-btn\s*\{[^}]*height:\s*24px\s*!important/);
    expect(UI_REFINEMENTS_CSS).toMatch(
      /@media \(min-width: 861px\)\s*\{\s*\.dashboard-header \.dashboard-title-row:has\(\.edit-bucket-title-btn\)\s*\{\s*height:\s*calc\(15px \* 1\.15\);/,
    );
  });
});
