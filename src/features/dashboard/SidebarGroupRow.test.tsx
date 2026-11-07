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
    const fills = document.querySelectorAll<HTMLElement>(".provider-summary-track > span");
    expect(fills[0].classList.contains("tone-healthy")).toBe(true);
    expect(fills[1].classList.contains("tone-critical")).toBe(true);
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
    expect(meters().map((meter) => [meter.label, meter.text])).toEqual([["7D Bot", "62%"], ["7D Grok", "16%"]]);
    expect(document.querySelector(".provider-summary-row")?.getAttribute("aria-label")).toContain("7D Bot 62%, 7D Grok 16%");
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

describe("SidebarGroupRow monthly limit (e.g. ChatGPT Free)", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  function monthlyAccount(id: string, remainingPercent: number): Account {
    return {
      id,
      label: "ChatGPT",
      provider: "openai" as Provider,
      plan: "free",
      lastUsage: {
        fetchedAt: new Date().toISOString(),
        freshness: "live",
        source: "test",
        windows: [
          {
            id: "monthly",
            label: "GPT · 30-Day Limit",
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            resetsAt: null,
            windowSeconds: 2592000,
            kind: "monthly",
          },
        ],
      } as unknown as UsageSnapshot,
      lastError: null,
      authRequired: false,
    } as Account;
  }

  const row = (accounts: Account[]) =>
    mount(
      <SidebarGroupRow
        group={{ id: "openai", type: "provider", title: "ChatGPT", provider: "openai", accounts }}
        selected={false}
        onSelect={vi.fn()}
      />,
    );

  it("labels the second meter 30d and includes 30d in aria-label for an account with a 30-day limit", () => {
    app = row([monthlyAccount("gpt1", 98)]);
    expect(meters().map((meter) => [meter.label, meter.text])).toEqual([["5h", "—"], ["30d", "98%"]]);
    expect(document.querySelector(".provider-summary-row")?.getAttribute("aria-label")).toContain("5h —, 30d 98%");
  });
});

describe("SidebarGroupRow averages and account problems", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    setUsageDisplayMode("left");
  });

  const render = (accounts: Account[]) => {
    app = mount(<SidebarGroupRow group={makeGroup(accounts)} selected={false} onSelect={vi.fn()} />);
    return app.container.querySelector<HTMLButtonElement>(".provider-summary-row")!;
  };
  const values = () => Array.from(document.querySelectorAll(".sidebar-meter-value")).map((el) => [el.textContent, el.className]);

  it("shows the average of the row's accounts for each limit", () => {
    const row = render([
      makeAccount({ id: "a1", fiveRemaining: 8, weeklyRemaining: 22 }),
      makeAccount({ id: "a2", fiveRemaining: 46, weeklyRemaining: 4 }),
    ]);
    expect(values()).toEqual([
      ["27%", "sidebar-meter-value tone-warning"],
      ["13%", "sidebar-meter-value tone-critical"],
    ]);
    expect(row.getAttribute("aria-label")).toBe("Claude, 2 accounts, 5h 27%, 7d 13%");
  });

  it("averages what is used in % Used mode", () => {
    setUsageDisplayMode("used");
    render([makeAccount({ id: "a1", fiveRemaining: 8 }), makeAccount({ id: "a2", fiveRemaining: 46 })]);
    expect(values()[0][0]).toBe("73%");
  });

  it("flags a signed-out account and says so instead of blank meters", () => {
    const signedOut = { ...makeAccount({ id: "a1" }), authRequired: true, lastUsage: null };
    const row = render([signedOut]);
    expect(row.querySelector(".sidebar-row-alert")!.className).toBe("sidebar-row-alert is-sign-in");
    expect(row.querySelector(".sidebar-group-signin")!.textContent).toBe("Sign-in needed");
    expect(row.querySelector(".sidebar-meters")).toBeNull();
    expect(row.getAttribute("aria-label")).toBe("Claude, 1 account, needs sign-in, 5h —, 7d —");
  });

  it("keeps the other accounts' meters when only one of several must sign in", () => {
    const signedOut = { ...makeAccount({ id: "a1" }), authRequired: true, lastUsage: null };
    const row = render([signedOut, makeAccount({ id: "a2", fiveRemaining: 70, weeklyRemaining: 50 })]);
    expect(row.querySelector(".sidebar-row-alert.is-sign-in")).not.toBeNull();
    expect(values().map(([text]) => text)).toEqual(["70%", "50%"]);
    expect(row.getAttribute("aria-label")).toContain(", needs sign-in, ");
  });

  it("marks out-of-date data in amber, and sign-in outranks it", () => {
    const stale = makeAccount({ id: "a1", fiveRemaining: 50 });
    stale.lastUsage!.freshness = "stale";
    const errored = { ...makeAccount({ id: "a2", fiveRemaining: 50 }), lastError: "Couldn't refresh" };
    let row = render([stale, errored]);
    expect(row.querySelector(".sidebar-row-alert")!.className).toBe("sidebar-row-alert is-stale");
    expect(row.getAttribute("aria-label")).toContain(", 2 accounts out of date, ");
    app!.unmount();

    const signedOut = { ...makeAccount({ id: "a3", fiveRemaining: 50 }), authRequired: true };
    row = render([stale, signedOut]);
    expect(row.querySelector(".sidebar-row-alert")!.className).toBe("sidebar-row-alert is-sign-in");
  });

  it("shows no marker when every account is live", () => {
    const row = render([makeAccount({ id: "a1", fiveRemaining: 50 })]);
    expect(row.querySelector(".sidebar-row-alert")).toBeNull();
  });
});
