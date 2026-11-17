// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNarrowWindow } from "../../test-utils/media";
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
    expect(document.querySelector(".account-metric-track")?.classList.contains("is-hatched")).toBe(false);
    expect(document.querySelector(".account-usage-metric")?.classList.contains("is-stale")).toBe(false);
  });

  it("stripes a live percent when the reading is out of date, and only the fill", () => {
    app = mount(
      <AccountUsageMetric
        window={makeWindow(80)}
        provider="openai"
        stale
      />
    );

    expect(document.querySelector(".account-usage-metric")?.classList.contains("is-stale")).toBe(true);
    expect(document.querySelector(".account-metric-track")?.classList.contains("is-hatched")).toBe(false);
    expect(document.querySelector(".account-metric-track span")?.classList.contains("tone-healthy")).toBe(true);
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
    expect(document.querySelector(".account-metric-track")?.classList.contains("is-hatched")).toBe(true);
    expect(document.querySelector(".account-usage-metric")?.classList.contains("is-stale")).toBe(false);
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
      expect(bar.classList.contains("is-hatched")).toBe(true);
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

// The phone draws a window the same way a wide window does.
describe.each([
  ["a wide window", false],
  ["a phone", true],
])("AccountUsageMetric on %s", (_name, narrow) => {
  let app: Mounted | null = null;

  beforeEach(() => setNarrowWindow(narrow));

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("puts the window and its name beside the percent, the bar under them, then the reset time and date", () => {
    const resetsAt = new Date(Date.now() + (2 * 60 + 8) * 60_000 + 30_000).toISOString();
    app = mount(
      <AccountUsageMetric
        window={{ id: "weekly", label: "Grok 7d", usedPercent: 79, remainingPercent: 21, resetsAt, windowSeconds: 604800, kind: "weekly" }}
        provider="grok"
      />,
    );
    const metric = document.querySelector(".desktop-metric")!;
    expect(metric.querySelector(".desktop-metric-span")?.textContent).toBe("7-day");
    expect(metric.querySelector(".desktop-metric-name")?.textContent).toBe("Grok");
    expect(metric.querySelector(".metric-full-value")?.textContent).toBe("21%");
    expect(metric.querySelector(".metric-full-value")?.classList.contains("tone-warning")).toBe(true);
    expect(metric.querySelector(".metric-percent-suffix")?.textContent).toBe("left");
    expect(metric.querySelector(".metric-reset strong")?.textContent).toBe("2h 8m");
    expect(metric.querySelector(".metric-reset")?.textContent).toMatch(/^Resets in 2h 8m · (Today|\w{3}, \w{3} \d+) @ \d+:\d\d[ap]?/);
    expect(metric.querySelector(".metric-reset .desktop-metric-date")).not.toBeNull();
    const parts = [...metric.children].map((child) => child.className);
    expect(parts).toEqual(["desktop-metric-head", "account-metric-track", "desktop-metric-foot"]);
    expect(metric.querySelector(".account-metric-track")?.getAttribute("aria-label")).toBe("7-day Grok remaining");
    expect(document.querySelector(".metric-window-pill")).toBeNull();
  });

  it("says a Claude window starts on first use, with no date", () => {
    app = mount(<AccountUsageMetric window={makeWindow(100)} provider="anthropic" />);
    expect(document.querySelector(".desktop-metric-span")?.textContent).toBe("5-hour");
    expect(document.querySelector(".desktop-metric-name")?.textContent).toBe("Claude");
    expect(document.querySelector(".desktop-metric .metric-reset")?.textContent).toBe("Starts on first use");
    expect(document.querySelector(".desktop-metric-date")).toBeNull();
  });

  it("hides old percentages, hatches the bar, and says Reset on <date> · last seen <N>% when expired", () => {
    const expiredAt = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const expectedDay = new Date(expiredAt).toLocaleString(undefined, { month: "short", day: "numeric" });
    app = mount(
      <AccountUsageMetric
        window={{ id: "five_hour", label: "5-Hour Window", usedPercent: 23, remainingPercent: 77, resetsAt: expiredAt, windowSeconds: 18000, kind: "five_hour" }}
        provider="anthropic"
        stale
      />,
    );
    const metric = document.querySelector(".desktop-metric")!;
    expect(metric.classList.contains("is-expired")).toBe(true);
    expect(metric.classList.contains("is-stale")).toBe(false);
    expect(metric.querySelector(".metric-full-value")?.textContent).toBe("—");
    expect(metric.querySelector(".metric-full-value")?.classList.contains("tone-neutral")).toBe(true);
    expect(metric.querySelector(".metric-percent-suffix")).toBeNull();
    const track = metric.querySelector(".account-metric-track")!;
    expect(track.classList.contains("is-hatched")).toBe(true);
    expect((track.firstElementChild as HTMLElement).style.width).toBe("0%");
    expect((track.firstElementChild as HTMLElement).classList.contains("tone-neutral")).toBe(true);
    expect(track.getAttribute("aria-valuenow")).toBeNull();
    expect(track.getAttribute("aria-valuetext")).toBe(`Reset on ${expectedDay}, last seen 77% left`);
    expect(metric.querySelector(".metric-reset")?.textContent).toBe(`Reset on ${expectedDay} · last seen 77% left`);
    expect(metric.querySelector(".desktop-metric-date")).toBeNull();
  });

  it("omits last seen when an expired window had no recorded percentage", () => {
    const expiredAt = new Date(Date.now() - 86_400_000).toISOString();
    const expectedDay = new Date(expiredAt).toLocaleString(undefined, { month: "short", day: "numeric" });
    app = mount(
      <AccountUsageMetric
        window={{ id: "five_hour", label: "5-Hour Window", usedPercent: null, remainingPercent: null, resetsAt: expiredAt, windowSeconds: 18000, kind: "five_hour" }}
        provider="anthropic"
      />,
    );
    expect(document.querySelector(".metric-full-value")?.textContent).toBe("—");
    expect(document.querySelector(".metric-reset")?.textContent).toBe(`Reset on ${expectedDay}`);
    expect(document.querySelector(".desktop-metric-date")).toBeNull();
  });
});
