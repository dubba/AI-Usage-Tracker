// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SIDEBAR_CSS = readFileSync(join(__dirname, "sidebar-list.css"), "utf8");

describe("sidebar list separators", () => {
  it("defines separators between consecutive account rows", () => {
    expect(SIDEBAR_CSS).toContain(
      ".provider-summary-row:not(.is-bucket-row):not(.is-all-row) + .provider-summary-row:not(.is-bucket-row):not(.is-all-row)::after",
    );
  });

  it("defines separators between consecutive bucket group rows", () => {
    expect(SIDEBAR_CSS).toContain(
      ".provider-summary-row.is-bucket-row + .provider-summary-row.is-bucket-row::after",
    );
  });

  it("uses a 1px separator styled with the obsidian border token", () => {
    const ruleStart = SIDEBAR_CSS.indexOf(
      ".provider-summary-row:not(.is-bucket-row):not(.is-all-row) + .provider-summary-row:not(.is-bucket-row):not(.is-all-row)::after",
    );
    expect(ruleStart).toBeGreaterThan(-1);
    const rule = SIDEBAR_CSS.slice(ruleStart, ruleStart + 600);
    expect(rule).toContain("height: 1px;");
    expect(rule).toContain("background: var(--obsidian-border);");
    expect(rule).toContain("pointer-events: none;");
    expect(rule).toContain("top: -4px;");
  });

  it("adds top margin on consecutive rows to evenly center cards between separators", () => {
    const marginRuleStart = SIDEBAR_CSS.indexOf(
      ".provider-summary-row:not(.is-bucket-row):not(.is-all-row) + .provider-summary-row:not(.is-bucket-row):not(.is-all-row),",
    );
    expect(marginRuleStart).toBeGreaterThan(-1);
    const rule = SIDEBAR_CSS.slice(marginRuleStart, marginRuleStart + 350);
    expect(rule).toContain("margin-top: 5px;");
  });

  it("preserves separators during drag reordering and suppresses them on dragged/origin rows", () => {
    expect(SIDEBAR_CSS).not.toContain("html.dashboard-reordering .provider-summary-row::after");
    expect(SIDEBAR_CSS).toContain(".provider-summary-row.is-dragging::after");
    expect(SIDEBAR_CSS).toContain(".provider-summary-row.is-reorder-origin::after");
    expect(SIDEBAR_CSS).toContain(".provider-reorder-placeholder + .provider-summary-row::after");
  });

  it("matches selectors only when two or more rows exist in the section", () => {
    // Verify CSS selector matching logic in DOM
    const container = document.createElement("div");
    container.className = "provider-list";
    container.innerHTML = `
      <button class="provider-summary-row is-all-row"></button>
      <div class="sidebar-section-header"><span class="sidebar-section-title">Accounts</span></div>
      <button class="provider-summary-row" data-account="1"></button>
      <button class="provider-summary-row" data-account="2"></button>
      <button class="provider-summary-row" data-account="3"></button>
      <div class="sidebar-section-header"><span class="sidebar-section-title">Groups</span></div>
      <button class="provider-summary-row is-bucket-row" data-group="1"></button>
    `;

    const accountSeparators = container.querySelectorAll(
      ".provider-summary-row:not(.is-bucket-row):not(.is-all-row) + .provider-summary-row:not(.is-bucket-row):not(.is-all-row)",
    );
    expect(accountSeparators).toHaveLength(2); // accounts 2 and 3 match; account 1 does not

    const groupSeparators = container.querySelectorAll(
      ".provider-summary-row.is-bucket-row + .provider-summary-row.is-bucket-row",
    );
    expect(groupSeparators).toHaveLength(0); // only 1 group, so 0 separators

    // Add a second group
    const secondGroup = document.createElement("button");
    secondGroup.className = "provider-summary-row is-bucket-row";
    secondGroup.dataset.group = "2";
    container.appendChild(secondGroup);

    const groupSeparatorsWithTwo = container.querySelectorAll(
      ".provider-summary-row.is-bucket-row + .provider-summary-row.is-bucket-row",
    );
    expect(groupSeparatorsWithTwo).toHaveLength(1);
  });
});
