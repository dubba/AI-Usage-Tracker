import { describe, expect, it } from "vitest";
import type { UsageWindow, WindowKind } from "../../types";
import { canonicalWindow } from "./usage-logic";
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
 * fixture in `src-tauri/crates/usage-core/src/model.rs`); the frontend must answer from that kind alone.
 */
describe("window kinds (the fixture shared with src-tauri/crates/usage-core/src/model.rs)", () => {
  it.each(cases)("$name", (entry) => {
    const window = toWindow(entry);
    expect(canonicalWindow(window, "five_hour")).toBe(entry.kind === "five_hour");
    expect(canonicalWindow(window, "weekly")).toBe(entry.kind === "weekly");
  });

  it("has unique case names", () => {
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });
});
