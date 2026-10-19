import { describe, expect, it } from "vitest";
import type { UsageWindow, WindowKind } from "../../types";
import { canonicalWindow, isMonthlyWindow } from "./usage-logic";
import { windowPillClass } from "./display";
import fixture from "./window-kinds.fixture.json";

type Case = {
  name: string;
  id: string;
  label: string;
  windowSeconds: number | null;
  kind: WindowKind | null;
};

const cases = fixture.cases as Case[];

function toWindow(entry: Case): UsageWindow {
  return {
    id: entry.id,
    label: entry.label,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    windowSeconds: entry.windowSeconds,
    kind: entry.kind,
  };
}

/**
 * The backend decides what kind a window is (`WindowKind::classify`, checked against the same
 * fixture in `src-tauri/src/model.rs`); the frontend must answer from that kind alone.
 */
describe("window kinds (the fixture shared with src-tauri/src/model.rs)", () => {
  it.each(cases)("$name", (entry) => {
    const window = toWindow(entry);
    expect(canonicalWindow(window, "five_hour")).toBe(entry.kind === "five_hour");
    expect(canonicalWindow(window, "weekly")).toBe(entry.kind === "weekly");
    expect(isMonthlyWindow(window)).toBe(entry.kind === "monthly");
    const pills = { five_hour: "window-pill-5h", weekly: "window-pill-7d", monthly: "window-pill-monthly" };
    expect(windowPillClass(window)).toBe(entry.kind ? pills[entry.kind] : "window-pill-default");
  });

  it("has unique case names", () => {
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });
});
