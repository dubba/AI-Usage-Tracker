// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { SidebarGroupRow } from "./SidebarGroupRow";
import { setUsageDisplayMode } from "../../shared/lib/usage-display";
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
      kind: "five_hour",
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
      kind: "weekly",
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


/** The two meters of the mounted row: label, percentage text, its tone class, and the bar's fill width. */
function meters() {
  return Array.from(document.querySelectorAll<HTMLElement>(".sidebar-meter")).map((meter) => {
    const value = meter.querySelector<HTMLElement>(".sidebar-meter-value")!;
    const fill = meter.querySelector<HTMLElement>(".provider-summary-track > span")!;
    return {
      label: meter.querySelector(".sidebar-meter-label")?.textContent,
      text: value.textContent,
      tone: Array.from(value.classList).find((name) => name.startsWith("tone-")),
      width: fill.style.width,
    };
  });
}

describe("SidebarGroupRow meters and tone matching", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  const mountRow = (account: Account) => {
    app = mount(<SidebarGroupRow group={makeGroup([account])} selected={false} onSelect={vi.fn()} />);
  };

  it("colors the percentage critical when the 5-hour window is at 9%", () => {
    mountRow(makeAccount({ fiveRemaining: 9 }));
    expect(meters()[0]).toEqual({ label: "5h", text: "9%", tone: "tone-critical", width: "9%" });
  });

  it("colors the percentage warning when the 5-hour window is at 25%", () => {
    mountRow(makeAccount({ fiveRemaining: 25 }));
    expect(meters()[0]).toEqual({ label: "5h", text: "25%", tone: "tone-warning", width: "25%" });
  });

  it("colors the percentage healthy when the 5-hour window is at 75%", () => {
    mountRow(makeAccount({ fiveRemaining: 75 }));
    expect(meters()[0]).toEqual({ label: "5h", text: "75%", tone: "tone-healthy", width: "75%" });
  });

  it("gives each window its own bar and tone", () => {
    mountRow(makeAccount({ fiveRemaining: 80, weeklyRemaining: 9 }));
    expect(meters()).toEqual([
      { label: "5h", text: "80%", tone: "tone-healthy", width: "80%" },
      { label: "7d", text: "9%", tone: "tone-critical", width: "9%" },
    ]);
  });

  it("leaves the bar unfilled and the percentage a dash for a window with no data", () => {
    mountRow(makeAccount({ weeklyRemaining: 98 }));
    expect(meters()).toEqual([
      { label: "5h", text: "—", tone: "tone-na", width: "0%" },
      { label: "7d", text: "98%", tone: "tone-healthy", width: "98%" },
    ]);
  });

  it("has no tooltip on the row or its meters, only on the drag dots", () => {
    app = mount(<SidebarGroupRow group={makeGroup([makeAccount({ fiveRemaining: 50 })])} selected={false} onSelect={vi.fn()} />);
    const tooltips = Array.from(document.querySelectorAll("[data-tooltip]"));
    expect(tooltips.map((el) => el.className)).toEqual(["reorder-grip"]);
    expect(tooltips[0].getAttribute("data-tooltip")).toBe("Drag to reorder");
    expect(document.querySelector(".provider-summary-row")?.hasAttribute("data-tooltip")).toBe(false);
  });

  it("shows no meters for an empty group", () => {
    app = mount(<SidebarGroupRow group={makeGroup([])} selected={false} onSelect={vi.fn()} />);
    expect(document.querySelector(".sidebar-meter")).toBeNull();
    expect(document.querySelector(".sidebar-group-empty")?.textContent).toBe("No accounts yet");
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    app = mount(<SidebarGroupRow group={makeGroup([makeAccount({ fiveRemaining: 50 })])} selected={false} onSelect={onSelect} />);

    const button = document.querySelector<HTMLButtonElement>(".provider-summary-row");
    expect(button).not.toBeNull();
    click(button!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarGroupRow usage display mode", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    setUsageDisplayMode("left");
  });

  it("shows the percentage used, and fills the bars to match, in used mode", () => {
    setUsageDisplayMode("used");
    app = mount(
      <SidebarGroupRow
        group={makeGroup([makeAccount({ fiveRemaining: 80, weeklyRemaining: 9 })])}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

    // The tone still reflects how much is left, so a nearly used-up account stays critical.
    expect(meters()).toEqual([
      { label: "5h", text: "20%", tone: "tone-healthy", width: "20%" },
      { label: "7d", text: "91%", tone: "tone-critical", width: "91%" },
    ]);
  });

  it("switches back to the percentage left", () => {
    setUsageDisplayMode("used");
    app = mount(
      <SidebarGroupRow
        group={makeGroup([makeAccount({ fiveRemaining: 80, weeklyRemaining: 9 })])}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    act(() => setUsageDisplayMode("left"));
    expect(meters().map((meter) => meter.text)).toEqual(["80%", "9%"]);
  });
});

describe("SidebarGroupRow Grok Bot limit", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  function grokAccount(id: string, weeklyRemaining: number, botRemaining: number | null): Account {
    const account = makeAccount({ id, provider: "grok", weeklyRemaining });
    if (botRemaining !== null) {
      account.lastUsage!.windows.push({
        id: "grok_bot",
        label: "Grok Bot weekly",
        usedPercent: 100 - botRemaining,
        remainingPercent: botRemaining,
        resetsAt: null,
        windowSeconds: 604800,
        kind: "weekly",
      });
    }
    return account;
  }

  const row = (accounts: Account[], provider: Provider = "grok") =>
    mount(
      <SidebarGroupRow
        group={{ id: provider, type: "provider", title: "Grok", provider, accounts }}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

  it("shows the Grok Bot limit before the Grok limit on a Grok-only row", () => {
    app = row([grokAccount("g1", 16, 62)]);
    expect(meters().map((meter) => [meter.label, meter.text])).toEqual([["GrokBot", "62%"], ["Grok", "16%"]]);
    expect(document.querySelector(".provider-summary-row")?.getAttribute("aria-label")).toContain("Grok Bot 62%, Grok 16%");
  });

  it("shows a dash for the Grok Bot limit when no account reports one", () => {
    app = row([grokAccount("g1", 16, null)]);
    expect(meters().map((meter) => meter.text)).toEqual(["—", "16%"]);
  });

  it("leaves rows that mix providers on 5-hour and 7-day", () => {
    app = row([grokAccount("g1", 16, 62), makeAccount({ id: "a1", fiveRemaining: 80, weeklyRemaining: 50 })], "anthropic");
    expect(meters().map((meter) => [meter.label, meter.text])).toEqual([["5h", "80%"], ["7d", "33%"]]);
  });
});
