// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { SidebarGroupRow } from "./SidebarGroupRow";
import type { SidebarGroup } from "./sidebar-groups";
import type { Account, UsageSnapshot, UsageWindow } from "../../types";

function makeAccount({
  id = "acc1",
  provider = "anthropic" as const,
  fiveRemaining = null as number | null,
  weeklyRemaining = null as number | null,
}: {
  id?: string;
  provider?: "anthropic" | "openai";
  fiveRemaining?: number | null;
  weeklyRemaining?: number | null;
}): Account {
  const windows: UsageWindow[] = [];
  if (fiveRemaining !== null) {
    windows.push({
      id: "five_hour",
      label: "5-Hour Window",
      usedPercent: 100 - fiveRemaining,
      remainingPercent: fiveRemaining,
      resetsAt: null,
      windowSeconds: 18000,
    });
  }
  if (weeklyRemaining !== null) {
    windows.push({
      id: "weekly",
      label: "7-Day Window",
      usedPercent: 100 - weeklyRemaining,
      remainingPercent: weeklyRemaining,
      resetsAt: null,
      windowSeconds: 604800,
    });
  }
  return {
    id,
    label: "Test Account",
    provider,
    lastUsage: {
      fetchedAt: new Date().toISOString(),
      freshness: "live",
      source: "test",
      windows,
    } as unknown as UsageSnapshot,
    lastError: null,
    authRequired: false,
  } as Account;
}

function makeGroup(accounts: Account[]): SidebarGroup {
  return {
    id: "anthropic",
    type: "provider",
    title: "Claude",
    provider: "anthropic",
    accounts,
  };
}

describe("SidebarGroupRow progress bar and tone matching", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("applies tone-critical to the progress bar and percentage when account is at 9%", () => {
    const account = makeAccount({ fiveRemaining: 9 });
    const group = makeGroup([account]);
    app = mount(
      <SidebarGroupRow
        group={group}
        selected={false}
        onSelect={vi.fn()}
      />
    );

    const track = document.querySelector(".provider-summary-track");
    expect(track).not.toBeNull();
    const fill = track?.querySelector("span");
    expect(fill).not.toBeNull();
    expect(fill?.classList.contains("tone-critical")).toBe(true);
    expect(fill?.style.width).toBe("9%");

    const average = document.querySelector(".provider-average");
    const criticalPercent = average?.querySelector(".tone-critical");
    expect(criticalPercent).not.toBeNull();
    expect(criticalPercent?.textContent).toBe("9%");
  });

  it("applies tone-warning to the progress bar and percentage when account is at 25%", () => {
    const account = makeAccount({ fiveRemaining: 25 });
    const group = makeGroup([account]);
    app = mount(
      <SidebarGroupRow
        group={group}
        selected={false}
        onSelect={vi.fn()}
      />
    );

    const track = document.querySelector(".provider-summary-track");
    const fill = track?.querySelector("span");
    expect(fill?.classList.contains("tone-warning")).toBe(true);
    expect(fill?.style.width).toBe("25%");

    const average = document.querySelector(".provider-average");
    const warningPercent = average?.querySelector(".tone-warning");
    expect(warningPercent).not.toBeNull();
    expect(warningPercent?.textContent).toBe("25%");
  });

  it("applies tone-healthy to the progress bar and percentage when account is at 75%", () => {
    const account = makeAccount({ fiveRemaining: 75 });
    const group = makeGroup([account]);
    app = mount(
      <SidebarGroupRow
        group={group}
        selected={false}
        onSelect={vi.fn()}
      />
    );

    const track = document.querySelector(".provider-summary-track");
    const fill = track?.querySelector("span");
    expect(fill?.classList.contains("tone-healthy")).toBe(true);
    expect(fill?.style.width).toBe("75%");

    const average = document.querySelector(".provider-average");
    const healthyPercent = average?.querySelector(".tone-healthy");
    expect(healthyPercent).not.toBeNull();
    expect(healthyPercent?.textContent).toBe("75%");
  });

  it("uses the lowest window value for the progress bar when both 5h and weekly exist", () => {
    // 5h is 80% (healthy), but weekly is 9% (critical) -> bar must be critical with 9% width
    const account = makeAccount({ fiveRemaining: 80, weeklyRemaining: 9 });
    const group = makeGroup([account]);
    app = mount(
      <SidebarGroupRow
        group={group}
        selected={false}
        onSelect={vi.fn()}
      />
    );

    const track = document.querySelector(".provider-summary-track");
    const fill = track?.querySelector("span");
    expect(fill?.classList.contains("tone-critical")).toBe(true);
    expect(fill?.style.width).toBe("9%");

    const average = document.querySelector(".provider-average");
    expect(average?.querySelector(".tone-healthy")?.textContent).toBe("80%");
    expect(average?.querySelector(".tone-critical")?.textContent).toBe("9%");
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    const account = makeAccount({ fiveRemaining: 50 });
    const group = makeGroup([account]);
    app = mount(
      <SidebarGroupRow
        group={group}
        selected={false}
        onSelect={onSelect}
      />
    );

    const button = document.querySelector<HTMLButtonElement>(".provider-summary-row");
    expect(button).not.toBeNull();
    click(button!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
