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

describe("AccountUsageMetric header row and neutral chip (Option B)", () => {
  let app: Mounted | null = null;

  // The chip above the bar is the phone layout.
  beforeEach(() => setNarrowWindow(true));

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("renders the limit chip and reset countdown above the bar with the percent to its right for Anthropic", () => {
    app = mount(
      <AccountUsageMetric
        window={{
          id: "five_hour",
          label: "5-Hour Window",
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null,
          windowSeconds: 18000,
          kind: "five_hour",
        }}
        provider="anthropic"
      />
    );

    const header = document.querySelector(".metric-header-row");
    expect(header).not.toBeNull();

    const pill = header?.querySelector(".metric-window-pill");
    expect(pill?.textContent?.trim()).toBe("5H LIMIT · Claude");
    expect(pill?.classList.contains("window-pill-5h")).toBe(true);

    const reset = header?.querySelector(".metric-reset");
    expect(reset?.textContent).toBe("Starts on first use");

    const valueRow = document.querySelector(".metric-value-row");
    const children = Array.from(valueRow?.children ?? []);
    expect(children[0]?.classList.contains("account-metric-track")).toBe(true);
    expect(children[1]?.classList.contains("metric-percent-line")).toBe(true);

    const track = document.querySelector(".account-metric-track");
    expect(track?.getAttribute("aria-label")).toContain("5H LIMIT");
  });

  it("renders weekly chip for GrokBot with subtype context", () => {
    app = mount(
      <AccountUsageMetric
        window={{
          id: "grok_bot",
          label: "Grok Bot weekly",
          usedPercent: 1,
          remainingPercent: 99,
          resetsAt: "2026-10-22T20:43:00Z",
          windowSeconds: 604800,
          kind: "weekly",
        }}
        provider="grok"
      />
    );

    const pill = document.querySelector(".metric-header-row .metric-window-pill");
    expect(pill?.textContent?.trim()).toBe("7D LIMIT · GrokBot");
    expect(pill?.classList.contains("window-pill-7d")).toBe(true);
  });
});

describe("AccountUsageMetric on a wide window", () => {
  let app: Mounted | null = null;

  beforeEach(() => setNarrowWindow(false));

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
    expect(metric.querySelector(".metric-reset")?.textContent).toBe("Resets in 2h 8m");
    expect(metric.querySelector(".desktop-metric-date")?.textContent).toMatch(/, /);
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
});
