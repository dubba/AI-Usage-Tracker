// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  getCompactDashboardMode,
  isCompactDashboardMode,
  setCompactDashboardMode,
  subscribeCompactDashboardMode,
} from "./compact-dashboard";
import { STORAGE_KEYS } from "./storage";

describe("compact dashboard preference", () => {
  it("validates stored values", () => {
    expect(isCompactDashboardMode("on")).toBe(true);
    expect(isCompactDashboardMode("off")).toBe(true);
    expect(isCompactDashboardMode("compact")).toBe(false);
    expect(isCompactDashboardMode(null)).toBe(false);
  });

  it("defaults to off and updates subscribers when toggled", () => {
    setCompactDashboardMode("off");
    expect(getCompactDashboardMode()).toBe("off");

    const listener = vi.fn();
    const unsub = subscribeCompactDashboardMode(listener);
    setCompactDashboardMode("on");
    expect(getCompactDashboardMode()).toBe("on");
    expect(listener).toHaveBeenCalledTimes(1);

    setCompactDashboardMode("off");
    expect(getCompactDashboardMode()).toBe("off");
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();

    expect(STORAGE_KEYS.compactDashboard).toBe("ai-usage-tracker:compact-dashboard");
  });
});
