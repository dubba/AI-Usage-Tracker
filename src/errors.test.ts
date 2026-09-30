import { describe, expect, it } from "vitest";
import { clearError, errorMessage, reportError, type AppError } from "./errors";

describe("errorMessage", () => {
  it("reads Error instances without the 'Error:' prefix", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("passes through string rejections (as Tauri produces them)", () => {
    expect(errorMessage("Unable to refresh")).toBe("Unable to refresh");
  });

  it("reads message from plain objects", () => {
    expect(errorMessage({ message: "from object" })).toBe("from object");
  });

  it("falls back for empty messages and unknown values", () => {
    expect(errorMessage(new Error("  "))).toBe("Something went wrong.");
    expect(errorMessage("")).toBe("Something went wrong.");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("reportError / clearError", () => {
  it("appends an error for a new source", () => {
    expect(reportError([], "load", "down")).toEqual([{ source: "load", message: "down" }]);
  });

  it("replaces in place when the same source fails again", () => {
    const first: AppError[] = [
      { source: "load", message: "a" },
      { source: "settings", message: "b" },
    ];
    expect(reportError(first, "load", "c")).toEqual([
      { source: "load", message: "c" },
      { source: "settings", message: "b" },
    ]);
  });

  it("returns the same array when nothing changes, so React skips a render", () => {
    const list: AppError[] = [{ source: "load", message: "a" }];
    expect(reportError(list, "load", "a")).toBe(list);
    expect(clearError(list, "other")).toBe(list);
  });

  it("clears only the matching source", () => {
    const list: AppError[] = [
      { source: "refresh:a", message: "x" },
      { source: "refresh:b", message: "y" },
    ];
    expect(clearError(list, "refresh:a")).toEqual([{ source: "refresh:b", message: "y" }]);
  });

  it("does not mutate its input", () => {
    const list: AppError[] = [{ source: "a", message: "1" }];
    reportError(list, "b", "2");
    clearError(list, "a");
    expect(list).toEqual([{ source: "a", message: "1" }]);
  });
});
