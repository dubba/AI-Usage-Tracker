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
    kind: "five_hour",
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

describe("AccountUsageMetric unavailable mode", () => {
  it("shows an empty bar and says to refresh", () => {
    const m = mount(<AccountUsageMetric unavailable creditLabel="Credits: $4.00" />);
    try {
      const root = document.querySelector(".account-usage-metric")!;
      expect(root.classList.contains("unavailable-metric")).toBe(true);
      const bar = root.querySelector("[role=progressbar]")!;
      expect(bar.getAttribute("aria-label")).toBe("Quota remaining");
      expect(bar.getAttribute("aria-valuetext")).toBe("Unavailable");
      expect(bar.getAttribute("aria-valuenow")).toBeNull();
      expect((bar.firstElementChild as HTMLElement).style.width).toBe("0%");
      expect(root.querySelector(".metric-full-value")?.textContent).toBe("Unavailable");
      expect(root.querySelector(".metric-reset")?.textContent).toBe("Refresh this account to retrieve its limits.");
      expect(root.querySelector(".metric-inline-credit")?.textContent).toBe("Credits: $4.00");
      expect(root.querySelector(".metric-window-pill")).toBeNull();
    } finally {
      m.unmount();
    }
  });

  it("omits the credit line when there is none", () => {
    const m = mount(<AccountUsageMetric unavailable />);
    try {
      expect(document.querySelector(".metric-inline-credit")).toBeNull();
    } finally {
      m.unmount();
    }
  });
});
