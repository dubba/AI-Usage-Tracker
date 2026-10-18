import { describe, expect, it } from "vitest";
import { displayPercent, isUsageDisplayMode, usageDisplaySuffix } from "./usage-display";

describe("usage display mode", () => {
  it("shows the percent remaining in left mode and its complement in used mode", () => {
    expect(displayPercent(72, "left")).toBe(72);
    expect(displayPercent(72, "used")).toBe(28);
    expect(displayPercent(100, "used")).toBe(0);
    expect(displayPercent(0, "used")).toBe(100);
  });

  it("labels each mode", () => {
    expect(usageDisplaySuffix("left")).toBe("left");
    expect(usageDisplaySuffix("used")).toBe("used");
  });

  it("validates stored values", () => {
    expect(isUsageDisplayMode("left")).toBe(true);
    expect(isUsageDisplayMode("used")).toBe(true);
    expect(isUsageDisplayMode("remaining")).toBe(false);
    expect(isUsageDisplayMode(null)).toBe(false);
  });
});
