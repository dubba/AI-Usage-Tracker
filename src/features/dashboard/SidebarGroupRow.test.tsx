// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { SidebarGroupRow } from "./SidebarGroupRow";
import type { SidebarGroup } from "./sidebar-groups";
import type { Account, Provider, UsageSnapshot, UsageWindow } from "../../types";

function makeAccount({
  id = "acc1",
  provider = "anthropic" as Provider,
  fiveRemaining = null as number | null,
  weeklyRemaining = null as number | null,
}: {
  id?: string;
  provider?: Provider;
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

function makeBucketGroup(accounts: Account[]): SidebarGroup {
  return {
    id: "bucket:b1",
    type: "bucket",
    title: "My Group",
    provider: accounts[0]?.provider ?? null,
    accounts,
  };
}

describe("SidebarGroupRow bucket composite icons", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  const renderGroup = (accounts: Account[]) => {
    app = mount(
      <SidebarGroupRow
        group={makeBucketGroup(accounts)}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
  };
  const cells = () => document.querySelectorAll(".provider-composite .composite-cell");
  const iconLabels = () =>
    Array.from(document.querySelectorAll(".provider-composite svg")).map((el) =>
      el.getAttribute("aria-label"),
    );
  const composite = () => document.querySelector(".provider-summary-icon.provider-composite");

  it("splits a two-provider group into left and right halves", () => {
    renderGroup([
      makeAccount({ id: "a1", provider: "openai" }),
      makeAccount({ id: "a2", provider: "grok" }),
    ]);
    expect(composite()?.classList.contains("composite-2")).toBe(true);
    expect(cells().length).toBe(2);
    expect(iconLabels()).toEqual(["ChatGPT", "Grok"]);
  });

  it("stacks two icons beside a third in a three-provider group", () => {
    renderGroup([
      makeAccount({ id: "a1", provider: "anthropic" }),
      makeAccount({ id: "a2", provider: "grok" }),
      makeAccount({ id: "a3", provider: "openai" }),
    ]);
    expect(composite()?.classList.contains("composite-3")).toBe(true);
    expect(cells().length).toBe(3);
    expect(iconLabels()).toEqual(["Claude", "Grok", "ChatGPT"]);
  });

  it("uses quadrants for a four-provider group, in the group's order", () => {
    renderGroup([
      makeAccount({ id: "a1", provider: "opencode_go" }),
      makeAccount({ id: "a2", provider: "grok" }),
      makeAccount({ id: "a3", provider: "anthropic" }),
      makeAccount({ id: "a4", provider: "openai" }),
    ]);
    expect(composite()?.classList.contains("composite-4")).toBe(true);
    expect(iconLabels()).toEqual(["OpenCode", "Grok", "Claude", "ChatGPT"]);
  });

  it("shows only the first four providers when the group is larger", () => {
    renderGroup([
      makeAccount({ id: "a1", provider: "grok" }),
      makeAccount({ id: "a2", provider: "openai" }),
      makeAccount({ id: "a3", provider: "opencode_go" }),
      makeAccount({ id: "a4", provider: "grok" }),
      makeAccount({ id: "a5", provider: "anthropic" }),
      makeAccount({ id: "a6", provider: "antigravity" }),
    ]);
    expect(composite()?.classList.contains("composite-4")).toBe(true);
    expect(cells().length).toBe(4);
    expect(iconLabels()).toEqual(["Grok", "ChatGPT", "OpenCode", "Grok"]);
  });

  it("keeps the single provider icon when the visible accounts share one provider", () => {
    renderGroup([
      makeAccount({ id: "a1", provider: "anthropic" }),
      makeAccount({ id: "a2", provider: "anthropic" }),
      makeAccount({ id: "a3", provider: "anthropic" }),
    ]);
    expect(composite()).toBeNull();
    const icon = document.querySelector(".provider-summary-icon.provider-anthropic");
    expect(icon).not.toBeNull();
    expect(icon?.querySelectorAll("svg").length).toBe(1);
  });

  it("keeps the generic group icon for an empty group", () => {
    renderGroup([]);
    expect(composite()).toBeNull();
    expect(document.querySelector(".provider-summary-icon.provider-all")).not.toBeNull();
  });

  it("never composites provider rows or the All row", () => {
    app = mount(
      <SidebarGroupRow
        group={makeGroup([makeAccount({ id: "a1" }), makeAccount({ id: "a2" })])}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(composite()).toBeNull();
  });
});


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
