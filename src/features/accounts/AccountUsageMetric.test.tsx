// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { AccountUsageMetric } from "./AccountUsageMetric";
import type { UsageWindow } from "../../types";

function makeWindow(remainingPercent: number | null): UsageWindow {
  return {
    id: "five_hour",
    label: "5-Hour Window",
    usedPercent: remainingPercent == null ? 0 : 100 - remainingPercent,
    remainingPercent,
    resetsAt: null,
    windowSeconds: 18000,
  };
}

describe("AccountUsageMetric tone classes", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("applies tone-critical to the percentage when remaining is <= 15%", () => {
    app = mount(
      <AccountUsageMetric
        window={makeWindow(10)}
        provider="openai"
      />
    );

    const fullValue = document.querySelector(".metric-full-value");
    expect(fullValue).not.toBeNull();
    expect(fullValue?.textContent).toBe("10%");
    expect(fullValue?.classList.contains("tone-critical")).toBe(true);

    const bar = document.querySelector(".account-metric-track span");
    expect(bar?.classList.contains("tone-critical")).toBe(true);
  });

  it("applies tone-warning to the percentage when remaining is <= 30% and > 15%", () => {
    app = mount(
      <AccountUsageMetric
        window={makeWindow(25)}
        provider="openai"
      />
    );

    const fullValue = document.querySelector(".metric-full-value");
    expect(fullValue).not.toBeNull();
    expect(fullValue?.textContent).toBe("25%");
    expect(fullValue?.classList.contains("tone-warning")).toBe(true);

    const bar = document.querySelector(".account-metric-track span");
    expect(bar?.classList.contains("tone-warning")).toBe(true);
  });

  it("applies tone-healthy to the percentage when remaining is > 30%", () => {
    app = mount(
      <AccountUsageMetric
        window={makeWindow(80)}
        provider="openai"
      />
    );

    const fullValue = document.querySelector(".metric-full-value");
    expect(fullValue).not.toBeNull();
    expect(fullValue?.textContent).toBe("80%");
    expect(fullValue?.classList.contains("tone-healthy")).toBe(true);

    const bar = document.querySelector(".account-metric-track span");
    expect(bar?.classList.contains("tone-healthy")).toBe(true);
  });

  it("applies tone-neutral when remaining is null", () => {
    app = mount(
      <AccountUsageMetric
        window={makeWindow(null)}
        provider="openai"
      />
    );

    const fullValue = document.querySelector(".metric-full-value");
    expect(fullValue).not.toBeNull();
    expect(fullValue?.textContent).toBe("Unavailable");
    expect(fullValue?.classList.contains("tone-neutral")).toBe(true);

    const bar = document.querySelector(".account-metric-track span");
    expect(bar?.classList.contains("tone-neutral")).toBe(true);
  });
});
