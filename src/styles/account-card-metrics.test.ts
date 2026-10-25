// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RESPONSIVE_CSS = readFileSync(join(__dirname, "account-card-responsive.css"), "utf8");

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
});
