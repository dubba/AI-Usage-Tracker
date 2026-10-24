// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_PERIOD_DAYS,
  getActivityPeriod,
  isActivityPeriod,
  refreshActivityPeriod,
  setActivityPeriod,
  subscribeActivityPeriod,
} from "./activity-period";

const KEY = "ai-usage-tracker:activity-period";

beforeEach(() => {
  localStorage.clear();
  refreshActivityPeriod();
});

describe("activity period", () => {
  it("is 7 days until the user picks another, and 30 days means 30", () => {
    expect(getActivityPeriod()).toBe("7d");
    expect(ACTIVITY_PERIOD_DAYS).toEqual({ "7d": 7, "30d": 30 });
  });

  it("accepts only the two periods", () => {
    expect(isActivityPeriod("7d")).toBe(true);
    expect(isActivityPeriod("30d")).toBe(true);
    for (const value of ["14d", "7", "", null, undefined, 7]) expect(isActivityPeriod(value)).toBe(false);
  });

  it("remembers the choice on this device and tells subscribers", () => {
    const heard = vi.fn();
    const stop = subscribeActivityPeriod(heard);
    setActivityPeriod("30d");
    expect(getActivityPeriod()).toBe("30d");
    expect(localStorage.getItem(KEY)).toBe("30d");
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it("starts from what was saved, and ignores a saved value that is not a period", () => {
    localStorage.setItem(KEY, "30d");
    refreshActivityPeriod();
    expect(getActivityPeriod()).toBe("30d");
    localStorage.setItem(KEY, "forever");
    refreshActivityPeriod();
    expect(getActivityPeriod()).toBe("7d");
  });
});
