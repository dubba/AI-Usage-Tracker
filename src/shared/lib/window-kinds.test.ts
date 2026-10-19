import { describe, expect, it } from "vitest";
import type { UsageWindow } from "../../types";
import { canonicalWindow, isMonthlyWindow } from "./usage-logic";
import fixture from "./window-kinds.fixture.json";

type Kind = "five_hour" | "weekly" | "monthly" | null;

type Case = {
  name: string;
  id: string;
  label: string;
  windowSeconds: number | null;
  kind: Kind;
  knownExceptions?: { ts?: Kind; rust?: Kind };
};

/** The order the Rust classifier uses: five hours, then a week, then a month. */
function classify(window: UsageWindow): Kind {
  if (canonicalWindow(window, "five_hour")) return "five_hour";
  if (canonicalWindow(window, "weekly")) return "weekly";
  if (isMonthlyWindow(window)) return "monthly";
  return null;
}

function toWindow(entry: Case): UsageWindow {
  return {
    id: entry.id,
    label: entry.label,
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    windowSeconds: entry.windowSeconds,
  };
}

const cases = fixture.cases as Case[];

describe("window kinds (shared with src-tauri/src/alerts.rs)", () => {
  it.each(cases)("$name", (entry) => {
    const expected = entry.knownExceptions && "ts" in entry.knownExceptions ? entry.knownExceptions.ts : entry.kind;
    expect(classify(toWindow(entry))).toBe(expected);
  });

  it("lists a known exception only where it really differs from the intended kind", () => {
    for (const entry of cases) {
      for (const [engine, value] of Object.entries(entry.knownExceptions ?? {})) {
        expect(value, `${entry.name} (${engine})`).not.toBe(entry.kind);
      }
    }
  });

  it("has unique case names", () => {
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });
});
