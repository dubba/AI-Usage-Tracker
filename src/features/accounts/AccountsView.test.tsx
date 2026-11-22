// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCompactDashboardMode } from "../../shared/lib/compact-dashboard";
import { announceReorder } from "../../shared/lib/events";
import { setNarrowWindow } from "../../test-utils/media";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { Account, AccountBucket } from "../../types";
import { ALL_ACCOUNTS_GROUP_ID, type SidebarGroup } from "../sidebar/sidebar-groups";
import { AccountsView } from "./AccountsView";
import { makeAccount } from "../../test-utils/accounts";

const account = makeAccount({ id: "acct-1", label: "Claude", provider: "anthropic", email: "ada@example.com" });

/** An account that needs nothing: it has live usage. (`account` above has none, so it needs attention.) */
const healthyAccount = { ...account, id: "acct-healthy", lastUsage: { freshness: "live", windows: [] }, health: "live" } as unknown as Account;

const allGroup: SidebarGroup = {
  id: ALL_ACCOUNTS_GROUP_ID,
  type: "all",
  title: "All Accounts",
  provider: null,
  accounts: [],
};

const workBucket: AccountBucket = {
  id: "work",
  name: "Work",
  provider: null,
  accountIds: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const bucketGroup: SidebarGroup = {
  id: "bucket:work",
  type: "bucket",
  title: "Work",
  provider: null,
  accounts: [],
  bucket: workBucket,
};

function renderView(overrides: Partial<Parameters<typeof AccountsView>[0]> = {}): Mounted {
  return mount(
    <AccountsView
      allAccounts={[]}
      accounts={[]}
      selectedGroup={allGroup}
      refreshMinutes={15}
      onAdd={() => undefined}
      onRefresh={() => undefined}
      onReconnect={() => undefined}
      onConnectGoogleUsage={() => undefined}
      onRename={async () => undefined}
      onRemove={() => undefined}
      onNotifications={() => undefined}
      busy={new Set()}
      {...overrides}
    />,
  );
}

describe("AccountsView empty dashboard", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("offers Link Devices next to Other Provider", () => {
    const onOpenPairing = vi.fn();
    const onAdd = vi.fn();
    app = renderView({ onOpenPairing, onAdd });
    expect(document.body.textContent).toContain("Connect an AI Account");
    expect(document.body.textContent).toContain("Add an account to begin monitoring its usage limits.");
    expect(document.body.textContent).not.toContain("Add an account to see how much of its weekly limit you use each day.");
    expect(document.querySelector('button[aria-label="Other Provider"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Link Devices");
    const grid = document.querySelector(".empty-provider-grid");
    expect(grid?.querySelectorAll(".empty-provider-card")).toHaveLength(4);
    expect(grid?.querySelector(".empty-provider-actions")?.querySelectorAll(".empty-provider-other")).toHaveLength(2);

    const linkDevices = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Link Devices"));
    expect(linkDevices).toBeTruthy();
    click(linkDevices!);
    expect(onOpenPairing).toHaveBeenCalledOnce();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("still opens Add Account from Other Provider defaulting to opencode_go", () => {
    const onOpenPairing = vi.fn();
    const onAdd = vi.fn();
    app = renderView({ onOpenPairing, onAdd });
    const other = document.querySelector('button[aria-label="Other Provider"]');
    click(other!);
    expect(onAdd).toHaveBeenCalledWith("opencode_go");
    expect(onOpenPairing).not.toHaveBeenCalled();
  });

  it("hides Link Devices on an empty group", () => {
    app = renderView({
      selectedGroup: bucketGroup,
      onOpenPairing: vi.fn(),
      onEditBucket: () => undefined,
      onDeleteBucket: () => undefined,
    });
    expect(document.body.textContent).toContain("No accounts in Work");
    expect(document.body.textContent).not.toContain("Link Devices");
    expect(document.querySelector('button[aria-label="Other Provider"]')).toBeNull();
  });

  it("hides Link Devices when accounts are already listed", () => {
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onOpenPairing: vi.fn(),
    });
    expect(document.body.textContent).not.toContain("Connect an AI Account");
    expect(document.body.textContent).not.toContain("Link Devices");
  });

  it("renders the edit-bucket-title-btn pen button for a custom group and triggers onEditBucket", () => {
    const onEditBucket = vi.fn();
    app = renderView({
      selectedGroup: bucketGroup,
      onEditBucket,
    });
    const editBtn = document.querySelector<HTMLButtonElement>(".edit-bucket-title-btn");
    expect(editBtn).not.toBeNull();
    expect(editBtn?.getAttribute("aria-label")).toBe("Edit Group");
    expect(editBtn?.getAttribute("data-tooltip")).toBe("Edit Group");
    click(editBtn!);
    expect(onEditBucket).toHaveBeenCalledWith(workBucket);
  });

  it("has no trash button in the header of a custom group: Delete Group is in Edit Group and the empty group panel", () => {
    app = renderView({
      selectedGroup: bucketGroup,
      onDeleteBucket: vi.fn(),
    });
    expect(document.querySelector(".delete-bucket-title-btn")).toBeNull();
    expect(document.querySelector('.dashboard-header [aria-label="Delete Group"]')).toBeNull();
  });

  it("renders Edit Group as a primary button in empty custom groups and triggers onEditBucket", () => {
    const onEditBucket = vi.fn();
    const onDeleteBucket = vi.fn();
    app = renderView({
      selectedGroup: bucketGroup,
      onEditBucket,
      onDeleteBucket,
    });
    const editBtn = document.querySelector<HTMLButtonElement>(".edit-bucket-empty-btn");
    expect(editBtn).not.toBeNull();
    expect(editBtn?.classList.contains("primary")).toBe(true);
    expect(editBtn?.textContent).toContain("Edit Group");
    click(editBtn!);
    expect(onEditBucket).toHaveBeenCalledWith(workBucket);

    const deleteBtn = document.querySelector<HTMLButtonElement>(".bucket-delete-button");
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn?.textContent).toContain("Delete Group");
    click(deleteBtn!);
    expect(onDeleteBucket).toHaveBeenCalledWith(workBucket);
  });
});

describe("AccountsView header", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("describes what the page is for in the header subheader", () => {
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
    });
    expect(document.querySelector(".dashboard-description")?.textContent).toBe(
      "Monitor 5-hour & 7-day limits and reset times across all your AI subscriptions."
    );
  });

  it("keeps the Group pill inline inside the title row on a wide window", () => {
    setNarrowWindow(false);
    app = renderView({
      selectedGroup: bucketGroup,
      onEditBucket: () => undefined,
    });
    const row = document.querySelector(".dashboard-title-row");
    const pill = row?.querySelector(".dashboard-bucket-pill");
    expect(pill?.textContent).toBe("Group");
    expect(row?.querySelector(".edit-bucket-title-btn")).not.toBeNull();
  });

  it("omits the Group pill on a phone while keeping the filter dropdown and edit pen", () => {
    setNarrowWindow(true);
    app = renderView({
      selectedGroup: bucketGroup,
      onToggleSidebar: () => undefined,
      onEditBucket: () => undefined,
      onAddGroup: () => undefined,
    });
    const row = document.querySelector(".dashboard-title-row")!;
    expect(row.querySelector(".dashboard-bucket-pill")).toBeNull();
    expect(row.querySelector(".mobile-sidebar-toggle-btn")).not.toBeNull();
    expect(row.querySelector(".edit-bucket-title-btn")).not.toBeNull();
  });

  it("does not render a Group pill for non-bucket views", () => {
    setNarrowWindow(true);
    app = renderView({
      selectedGroup: allGroup,
      onToggleSidebar: () => undefined,
    });
    expect(document.querySelector(".dashboard-bucket-pill")).toBeNull();
  });
});

describe("AccountsView summary status strip", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    setNarrowWindow(false);
    vi.restoreAllMocks();
  });

  it("renders a non-interactive status bar with the healthy account count and 'No upcoming reset' when healthy", () => {
    app = renderView({
      allAccounts: [healthyAccount],
      accounts: [healthyAccount],
      selectedGroup: { ...allGroup, accounts: [healthyAccount] },
    });
    expect(document.querySelector("button.summary-strip")).toBeNull();
    const strip = document.querySelector<HTMLDivElement>("div.summary-strip");
    expect(strip).not.toBeNull();
    expect(strip?.tagName).toBe("DIV");
    expect(strip?.classList.contains("has-attention")).toBe(false);
    expect(strip?.querySelector(".summary-status-text")?.textContent).toBe("1 account is healthy");
    expect(strip?.querySelector(".summary-attention-count")).toBeNull();
    expect(strip?.querySelector(".next-reset-inline")?.textContent).toBe("No upcoming reset");

    app.unmount();
    const fourHealthy = [
      healthyAccount,
      { ...healthyAccount, id: "acct-healthy-2" },
      { ...healthyAccount, id: "acct-healthy-3" },
      { ...healthyAccount, id: "acct-healthy-4" },
    ];
    app = renderView({
      allAccounts: fourHealthy,
      accounts: fourHealthy,
      selectedGroup: { ...allGroup, accounts: fourHealthy },
    });
    expect(document.querySelector("div.summary-strip .summary-status-text")?.textContent).toBe(
      "All 4 accounts are healthy",
    );
  });

  it("says 'No accounts yet' with an icon in the status bar when there are no accounts", () => {
    app = renderView({ allAccounts: [], accounts: [], selectedGroup: { ...allGroup, accounts: [] } });
    const strip = document.querySelector<HTMLDivElement>("div.summary-strip");
    expect(strip?.classList.contains("is-empty")).toBe(true);
    expect(strip?.querySelector(".summary-status-text")?.textContent).toBe("No accounts yet");
    expect(strip?.querySelector(".summary-status-dot")).toBeNull();
    expect(strip?.querySelector(".summary-status-cluster > svg")).not.toBeNull();
    expect(strip?.querySelector(".next-reset-inline")).toBeNull();
  });

  it("formats next reset inline identically for desktop and phone", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const futureReset = new Date(now + (4 * 60 + 16) * 60_000).toISOString();
    const withReset = {
      ...healthyAccount,
      lastUsage: {
        freshness: "live",
        windows: [
          {
            id: "five_hour",
            kind: "five_hour",
            label: "5-hour",
            usedPercent: 25,
            remainingPercent: 75,
            resetsAt: futureReset,
          },
        ],
      },
    } as unknown as Account;

    app = renderView({
      allAccounts: [withReset],
      accounts: [withReset],
      selectedGroup: { ...allGroup, accounts: [withReset] },
    });
    const desktopNext = document.querySelector(".summary-strip .next-reset-inline")!;
    expect(desktopNext.textContent).toContain("Next reset:");
    expect(desktopNext.querySelector(".next-reset-limit")?.textContent).toBe("5H");
    expect(desktopNext.querySelector(".next-reset-account")?.textContent).toBe("Claude");
    expect(desktopNext.textContent).toContain("in");
    expect(desktopNext.querySelector(".next-reset-pill")?.textContent).toBeTruthy();

    app.unmount();
    setNarrowWindow(true);
    app = renderView({
      allAccounts: [withReset],
      accounts: [withReset],
      selectedGroup: { ...allGroup, accounts: [withReset] },
    });
    const phoneNext = document.querySelector(".summary-strip .next-reset-inline")!;
    expect(phoneNext.textContent).toContain("Next reset:");
    expect(phoneNext.querySelector(".next-reset-limit")?.textContent).toBe("5H");
    expect(phoneNext.querySelector(".next-reset-account")?.textContent).toBe("Claude");
    expect(phoneNext.textContent).toContain("in");
    expect(phoneNext.querySelector(".next-reset-pill")?.textContent).toBeTruthy();

    app.unmount();
    setNarrowWindow(false);
    const antigravityGemini = {
      ...healthyAccount,
      id: "acct-ag",
      label: "Antigravity",
      provider: "antigravity",
      lastUsage: {
        freshness: "live",
        windows: [
          {
            id: "gemini_pro",
            kind: "five_hour",
            label: "Gemini",
            usedPercent: 10,
            remainingPercent: 90,
            resetsAt: futureReset,
          },
        ],
      },
    } as unknown as Account;
    app = renderView({
      allAccounts: [antigravityGemini],
      accounts: [antigravityGemini],
      selectedGroup: { ...allGroup, accounts: [antigravityGemini] },
    });
    const limitPills = document.querySelectorAll(".summary-strip .next-reset-limit");
    expect(limitPills).toHaveLength(1);
    expect(limitPills[0]?.textContent).toBe("5H Gemini");
  });

  it("combines status, next reset, and Show all into one amber box when filtering on desktop and mobile", () => {
    app = renderView({
      allAccounts: [account, { ...account, id: "acct-2" }, healthyAccount],
      accounts: [account, { ...account, id: "acct-2" }, healthyAccount],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }, healthyAccount] },
    });
    const attentionBtn = document.querySelector<HTMLButtonElement>("button.summary-strip.has-attention");
    expect(attentionBtn).not.toBeNull();
    expect(attentionBtn?.tagName).toBe("BUTTON");
    expect(attentionBtn?.getAttribute("type")).toBe("button");
    expect(attentionBtn?.getAttribute("aria-pressed")).toBe("false");
    expect(attentionBtn?.classList.contains("is-filtering")).toBe(false);
    expect(attentionBtn?.querySelector(".summary-status-text")?.textContent).toBe("Attention needed");
    expect(attentionBtn?.querySelector(".summary-attention-count")?.textContent).toBe("2");
    expect(document.querySelectorAll(".provider-account-card")).toHaveLength(3);

    // Desktop click turns the strip into the combined two-row Option A box.
    click(attentionBtn!);
    expect(document.querySelector(".filter-active-banner")).toBeNull();
    const filteringBox = document.querySelector(".summary-strip.has-attention.is-filtering")!;
    expect(filteringBox).not.toBeNull();
    expect(filteringBox.querySelector(".summary-strip-toggle .summary-status-text")?.textContent).toBe("Attention needed");
    expect(filteringBox.querySelector(".summary-strip-toggle .summary-attention-count")?.textContent).toBe("2");
    expect(filteringBox.querySelector(".summary-strip-toggle")?.getAttribute("aria-pressed")).toBe("true");
    const desktopSubrow = filteringBox.querySelector(".summary-filter-subrow")!;
    expect(desktopSubrow).not.toBeNull();
    expect(desktopSubrow.textContent).toContain("Showing 2 accounts needing attention");
    expect(document.querySelectorAll(".provider-account-card")).toHaveLength(2);

    // Show all clears the filter and restores the clickable status strip.
    const clearBtn = desktopSubrow.querySelector<HTMLButtonElement>(".filter-active-clear-btn")!;
    expect(clearBtn).not.toBeNull();
    click(clearBtn);
    expect(document.querySelector(".summary-strip.is-filtering")).toBeNull();
    expect(document.querySelectorAll(".provider-account-card")).toHaveLength(3);

    // Phone uses the same two-row combined box layout.
    app.unmount();
    setNarrowWindow(true);
    app = renderView({
      allAccounts: [account, { ...account, id: "acct-2" }, healthyAccount],
      accounts: [account, { ...account, id: "acct-2" }, healthyAccount],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }, healthyAccount] },
    });
    click(document.querySelector<HTMLButtonElement>("button.summary-strip.has-attention")!);
    const phoneBox = document.querySelector(".summary-strip.has-attention.is-filtering")!;
    expect(phoneBox.querySelector(".summary-strip-toggle .summary-status-text")?.textContent).toBe("Attention needed");
    expect(phoneBox.querySelector(".summary-strip-toggle .summary-attention-count")?.textContent).toBe("2");
    const subrow = phoneBox.querySelector(".summary-filter-subrow")!;
    expect(subrow).not.toBeNull();
    expect(subrow.textContent).toContain("Showing 2 accounts needing attention");
    expect(subrow.querySelector(".filter-active-clear-btn")).not.toBeNull();
    expect(document.querySelectorAll(".provider-account-card")).toHaveLength(2);

    // Clicking the status toggle row also clears filtering.
    click(phoneBox.querySelector<HTMLButtonElement>(".summary-strip-toggle")!);
    expect(document.querySelector(".summary-strip.is-filtering")).toBeNull();
    expect(document.querySelectorAll(".provider-account-card")).toHaveLength(3);
  });

  it("scrolls to and highlights the targeted account card when highlightedAccount is set", () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      app = renderView({
        allAccounts: [account, healthyAccount],
        accounts: [account, healthyAccount],
        selectedGroup: { ...allGroup, accounts: [account, healthyAccount] },
        highlightedAccount: { accountId: healthyAccount.id, seq: 1 },
      });

      const targetCard = document.querySelector<HTMLElement>(`.provider-account-card[data-account-id="${healthyAccount.id}"]`)!;
      expect(targetCard).not.toBeNull();
      expect(targetCard.classList.contains("is-alert-highlighted")).toBe(true);

      vi.advanceTimersByTime(10);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    } finally {
      scrollIntoView.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shows '1 low limit' in amber under 30% and in red under 15% without turning the strip into has-attention", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const futureReset = new Date(now + 60 * 60_000).toISOString();

    const makeLiveWithRemaining = (id: string, label: string, remainingPercent: number): Account => ({
      ...healthyAccount,
      id,
      label,
      lastUsage: {
        ...healthyAccount.lastUsage!,
        windows: [
          {
            id: "five_hour",
            kind: "five_hour",
            label: "5-hour",
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            resetsAt: futureReset,
            windowSeconds: 18_000,
          },
        ],
      },
    });

    const amberAccount = makeLiveWithRemaining("acct-amber", "Codex", 25);
    app = renderView({
      allAccounts: [amberAccount],
      accounts: [amberAccount],
      selectedGroup: { ...allGroup, accounts: [amberAccount] },
    });
    let strip = document.querySelector<HTMLDivElement>("div.summary-strip")!;
    expect(strip).not.toBeNull();
    expect(strip.classList.contains("has-attention")).toBe(false);
    expect(strip.classList.contains("is-low-warning")).toBe(true);
    expect(strip.classList.contains("is-low-critical")).toBe(false);
    expect(strip.querySelector(".summary-status-text")?.textContent).toBe("0 healthy & 1 low limit:");
    let lowItems = [...strip.querySelectorAll(".summary-low-limit-item")];
    expect(lowItems).toHaveLength(1);
    expect(lowItems[0]?.querySelector(".next-reset-limit")?.textContent).toBe("5H");
    expect(lowItems[0]?.querySelector(".next-reset-account")?.textContent).toBe("Codex");
    expect(strip.querySelectorAll(".summary-low-limit-sep")).toHaveLength(0);

    app.unmount();
    const redAccount: Account = {
      ...healthyAccount,
      id: "acct-red",
      label: "Claude",
      provider: "anthropic",
      lastUsage: {
        ...healthyAccount.lastUsage!,
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "7-day",
            usedPercent: 90,
            remainingPercent: 10,
            resetsAt: futureReset,
            windowSeconds: 604_800,
          },
        ],
      },
    };
    app = renderView({
      allAccounts: [amberAccount, redAccount],
      accounts: [amberAccount, redAccount],
      selectedGroup: { ...allGroup, accounts: [amberAccount, redAccount] },
    });
    strip = document.querySelector<HTMLDivElement>("div.summary-strip")!;
    expect(strip.classList.contains("has-attention")).toBe(false);
    expect(strip.classList.contains("is-low-critical")).toBe(true);
    expect(strip.querySelector(".summary-status-text")?.textContent).toBe("0 healthy & 2 low limit:");
    lowItems = [...strip.querySelectorAll(".summary-low-limit-item")];
    expect(lowItems).toHaveLength(2);
    expect(lowItems[0]?.querySelector(".next-reset-limit")?.textContent).toBe("7D");
    expect(lowItems[0]?.querySelector(".next-reset-account")?.textContent).toBe("Claude");
    expect(lowItems[1]?.querySelector(".next-reset-limit")?.textContent).toBe("5H");
    expect(lowItems[1]?.querySelector(".next-reset-account")?.textContent).toBe("Codex");
    expect(strip.querySelector(".summary-low-limits")?.textContent).toBe("7DClaude·5HCodex");
    expect([...strip.querySelectorAll(".summary-low-limit-sep")].map((el) => el.textContent)).toEqual(["·"]);

    // Includes healthy accounts in the status text when some accounts are above the threshold.
    app.unmount();
    const healthyPlusLow = [
      healthyAccount,
      { ...healthyAccount, id: "acct-h2" },
      { ...healthyAccount, id: "acct-h3" },
      amberAccount,
    ];
    app = renderView({
      allAccounts: healthyPlusLow,
      accounts: healthyPlusLow,
      selectedGroup: { ...allGroup, accounts: healthyPlusLow },
    });
    strip = document.querySelector<HTMLDivElement>("div.summary-strip")!;
    expect(strip.classList.contains("is-low-warning")).toBe(true);
    expect(strip.querySelector(".summary-status-text")?.textContent).toBe("3 healthy & 1 low limit:");

    app.unmount();
    const twoHealthyTwoLow = [healthyAccount, { ...healthyAccount, id: "acct-h2" }, amberAccount, redAccount];
    app = renderView({
      allAccounts: twoHealthyTwoLow,
      accounts: twoHealthyTwoLow,
      selectedGroup: { ...allGroup, accounts: twoHealthyTwoLow },
    });
    expect(document.querySelector("div.summary-strip .summary-status-text")?.textContent).toBe(
      "2 healthy & 2 low limit:",
    );

    // Attention needed stays higher priority when another account needs sign-in.
    app.unmount();
    app = renderView({
      allAccounts: [account, redAccount],
      accounts: [account, redAccount],
      selectedGroup: { ...allGroup, accounts: [account, redAccount] },
    });
    const attentionBtn = document.querySelector<HTMLButtonElement>("button.summary-strip.has-attention");
    expect(attentionBtn).not.toBeNull();
    expect(attentionBtn?.querySelector(".summary-status-text")?.textContent).toBe("Attention needed");
  });
});

describe("AccountsView reorder hint banner", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows the reorder hint banner on desktop and dismisses when clicked", () => {
    app = renderView({
      allAccounts: [account, { ...account, id: "acct-2" }],
      accounts: [account, { ...account, id: "acct-2" }],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }] },
    });
    const banner = document.querySelector(".reorder-hint-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Press & drag a card below or in the sidebar to reorder");

    const dismissBtn = banner?.querySelector<HTMLButtonElement>(".reorder-hint-dismiss");
    expect(dismissBtn).not.toBeNull();
    click(dismissBtn!);
    expect(document.querySelector(".reorder-hint-banner")).toBeNull();
  });

  it("shows the reorder hint banner on mobile devices", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" });
    app = renderView({
      allAccounts: [account, { ...account, id: "acct-2" }],
      accounts: [account, { ...account, id: "acct-2" }],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }] },
    });
    const banner = document.querySelector(".reorder-hint-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Press & drag a card below or in the sidebar to reorder");
  });

  it("appears on the first 2 opens and stops appearing on the 3rd open", () => {
    const props = {
      allAccounts: [account, { ...account, id: "acct-2" }],
      accounts: [account, { ...account, id: "acct-2" }],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }] },
    };

    // Open #1
    app = renderView(props);
    expect(document.querySelector(".reorder-hint-banner")).not.toBeNull();
    // Dismiss in session 1
    click(document.querySelector<HTMLButtonElement>(".reorder-hint-dismiss")!);
    expect(document.querySelector(".reorder-hint-banner")).toBeNull();
    app.unmount();

    // Open #2 (new session: clear sessionStorage, keep localStorage)
    sessionStorage.clear();
    app = renderView(props);
    expect(document.querySelector(".reorder-hint-banner")).not.toBeNull();
    app.unmount();

    // Open #3 (new session)
    sessionStorage.clear();
    app = renderView(props);
    expect(document.querySelector(".reorder-hint-banner")).toBeNull();
  });

  it("permanently dismisses when an actual reorder event occurs", () => {
    const props = {
      allAccounts: [account, { ...account, id: "acct-2" }],
      accounts: [account, { ...account, id: "acct-2" }],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }] },
    };

    // Open #1: banner is shown
    app = renderView(props);
    expect(document.querySelector(".reorder-hint-banner")).not.toBeNull();

    // Trigger an actual reorder event
    act(() => announceReorder("accounts"));

    // Banner is dismissed immediately
    expect(document.querySelector(".reorder-hint-banner")).toBeNull();
    app.unmount();

    // Open #2: does not appear because reorder completed
    sessionStorage.clear();
    app = renderView(props);
    expect(document.querySelector(".reorder-hint-banner")).toBeNull();
  });
});

describe("AccountsView L / U switch", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
  });

  it("ends the phone title row with U | L, New group, and Add account in order, without Compact", () => {
    setNarrowWindow(true);
    const onAdd = vi.fn();
    const onAddGroup = vi.fn();
    app = renderView({ onToggleSidebar: () => undefined, onAdd, onAddGroup });
    const row = document.querySelector(".dashboard-title-row")!;
    const actions = row.lastElementChild!;
    expect(actions.classList.contains("dashboard-header-actions")).toBe(true);
    expect([...actions.children].map((el) => {
      if (el.classList.contains("usage-display-toggle")) return "usage-display";
      return el.getAttribute("aria-label");
    })).toEqual(["usage-display", "Add new group", "Add new account"]);

    const usageSwitch = actions.querySelector(".usage-display-toggle")!;
    expect(usageSwitch.classList.contains("is-mobile-header")).toBe(true);
    expect([...usageSwitch.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["U", "L"]);
    expect(document.querySelector(".compact-dashboard-toggle")).toBeNull();

    const group = actions.querySelector<HTMLButtonElement>('[aria-label="Add new group"]')!;
    const account = actions.querySelector<HTMLButtonElement>('[aria-label="Add new account"]')!;
    expect(group.getAttribute("data-tooltip")).toBe("Group AI accounts to track their usage\ntogether, such as Work or Personal");
    expect(account.getAttribute("data-tooltip")).toBe("Connect an AI account to track usage");
    expect(group.textContent).toBe("");
    expect(account.textContent).toBe("");
    click(group);
    click(account);
    expect(onAddGroup).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("has no header add buttons on a wide window: the top bar has them", () => {
    setNarrowWindow(false);
    app = renderView({ onToggleSidebar: () => undefined, onAddGroup: () => undefined });
    expect(document.querySelector(".dashboard-header-actions")).toBeNull();
  });

  it("places U | L in the phone header instead of top-bar-segmented or Compact button", () => {
    setNarrowWindow(true);
    app = renderView({ onToggleSidebar: () => undefined });
    const buttons = document.querySelectorAll(".dashboard-header-actions .usage-display-toggle.is-mobile-header button");
    expect([...buttons].map((b) => b.textContent)).toEqual(["U", "L"]);
    expect(document.querySelector(".dashboard-header .compact-dashboard-toggle")).toBeNull();
    expect(document.querySelector(".dashboard-header .top-bar-segmented")).toBeNull();
  });

  it("sits at the header's top right on a wide window, spelled out, and not in the title row", () => {
    setNarrowWindow(false);
    app = renderView({ onToggleSidebar: () => undefined });
    const toggle = document.querySelector(".accounts-display-switch .usage-display-toggle, .accounts-display-switch .top-bar-segmented");
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toBe("% Used% Left");
    // Labeled, as "Period" is beside 7D / 30D.
    expect(document.querySelector(".accounts-display-switch .accounts-display-label")?.textContent).toBe("Show");
    expect(document.querySelector(".dashboard-title-row .top-bar-segmented")).toBeNull();
    expect(document.querySelectorAll(".top-bar-segmented")).toHaveLength(1);
  });

  it("leaves Compact toggle to the top bar and responds to shared compact mode changes (L7)", () => {
    setNarrowWindow(false);
    setCompactDashboardMode("off");
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onToggleSidebar: () => undefined,
    });

    expect(document.querySelector(".accounts-display-switch .compact-dashboard-toggle")).toBeNull();
    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(false);
    expect(document.querySelector(".compact-card-row")).toBeNull();

    act(() => setCompactDashboardMode("on"));
    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(true);
    expect(document.querySelector(".compact-card-row")).not.toBeNull();

    // Restore default off state for subsequent tests
    act(() => setCompactDashboardMode("off"));
    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(false);
  });

  it("ignores global compact mode on mobile so cards default to regular view", () => {
    setNarrowWindow(true);
    setCompactDashboardMode("on");
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onToggleSidebar: () => undefined,
    });

    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(false);
    expect(document.querySelector(".provider-account-card")?.classList.contains("is-compact")).toBe(false);
    expect(document.querySelector(".compact-card-row")).toBeNull();

    setCompactDashboardMode("off");
  });

  it("uses the title as the phone filter pill and marks filtered groups while keeping add actions", () => {
    setNarrowWindow(true);
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onToggleSidebar: () => undefined,
      onAddGroup: () => undefined,
    });
    const heading = document.querySelector(".dashboard-title-row h1.eyebrow")!;
    const allPill = heading.querySelector<HTMLButtonElement>(".mobile-sidebar-toggle-btn")!;
    expect(allPill).not.toBeNull();
    expect(document.querySelectorAll(".dashboard-title-row .mobile-sidebar-toggle-btn")).toHaveLength(1);
    expect(allPill.querySelector("svg.mobile-sidebar-toggle-filter")).not.toBeNull();
    expect(allPill.querySelector(".mobile-sidebar-toggle-label")?.textContent).toBe("All Accounts");
    expect(allPill.querySelector("svg.mobile-sidebar-toggle-chevron")).not.toBeNull();
    expect(allPill.classList.contains("is-filtered")).toBe(false);
    expect(document.querySelector('.dashboard-header-actions [aria-label="Add new group"]')).not.toBeNull();
    expect(document.querySelector('.dashboard-header-actions [aria-label="Add new account"]')).not.toBeNull();

    app.rerender(
      <AccountsView
        allAccounts={[account]}
        accounts={[account]}
        selectedGroup={bucketGroup}
        refreshMinutes={15}
        onToggleSidebar={() => undefined}
        onAdd={() => undefined}
        onAddGroup={() => undefined}
        onEditBucket={() => undefined}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
        busy={new Set()}
      />,
    );
    const workPill = document.querySelector<HTMLButtonElement>(".dashboard-title-row h1.eyebrow .mobile-sidebar-toggle-btn")!;
    expect(workPill.querySelector(".mobile-sidebar-toggle-label")?.textContent).toBe("Work Acct");
    expect(workPill.classList.contains("is-filtered")).toBe(true);
    expect(document.querySelector(".dashboard-bucket-pill")).toBeNull();
    expect(document.querySelector(".edit-bucket-title-btn")).not.toBeNull();

    const grokGroup: SidebarGroup = {
      id: "provider:grok",
      type: "provider",
      title: "Grok",
      provider: "grok",
      accounts: [account],
    };
    app.rerender(
      <AccountsView
        allAccounts={[account]}
        accounts={[account]}
        selectedGroup={grokGroup}
        refreshMinutes={15}
        onToggleSidebar={() => undefined}
        onAdd={() => undefined}
        onAddGroup={() => undefined}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
        busy={new Set()}
      />,
    );
    const grokPill = document.querySelector<HTMLButtonElement>(".dashboard-title-row h1.eyebrow .mobile-sidebar-toggle-btn")!;
    expect(grokPill.querySelector(".mobile-sidebar-toggle-label")?.textContent).toBe("Grok Accts");
    expect(grokPill.classList.contains("is-filtered")).toBe(true);

    const claudeCustomCardGroup: SidebarGroup = {
      id: "provider:anthropic",
      type: "provider",
      title: "Claude123",
      provider: "anthropic",
      accounts: [{ ...account, provider: "anthropic", label: "Claude123" }],
    };
    app.rerender(
      <AccountsView
        allAccounts={[account]}
        accounts={[account]}
        selectedGroup={claudeCustomCardGroup}
        refreshMinutes={15}
        onToggleSidebar={() => undefined}
        onAdd={() => undefined}
        onAddGroup={() => undefined}
        onRefresh={() => undefined}
        onReconnect={() => undefined}
        onConnectGoogleUsage={() => undefined}
        onRename={async () => undefined}
        onRemove={() => undefined}
        onNotifications={() => undefined}
        busy={new Set()}
      />,
    );
    const claudePill = document.querySelector<HTMLButtonElement>(".dashboard-title-row h1.eyebrow .mobile-sidebar-toggle-btn")!;
    expect(claudePill.querySelector(".mobile-sidebar-toggle-label")?.textContent).toBe("Claude Accts");
  });
});

describe("AccountsView pull-to-refresh hint banner", () => {
  let app: Mounted | null = null;
  const originalInnerWidth = window.innerWidth;
  const hadOntouchstart = "ontouchstart" in window;

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, writable: true, configurable: true });
    if (!hadOntouchstart && "ontouchstart" in window) {
      delete (window as unknown as { ontouchstart?: unknown }).ontouchstart;
    }
    localStorage.clear();
    sessionStorage.clear();
  });

  function createTouchEvent(type: string, target: Element, clientX: number, clientY: number) {
    const touch = { clientX, clientY, identifier: 0, target };
    return new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === "touchend" || type === "touchcancel" ? [] : [touch as unknown as Touch],
      targetTouches: type === "touchend" || type === "touchcancel" ? [] : [touch as unknown as Touch],
      changedTouches: [touch as unknown as Touch],
    });
  }

  it("stays hidden on desktop non-touch viewports and when there are no accounts", () => {
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onRefreshAll: vi.fn(),
    });
    expect(document.querySelector(".pull-refresh-hint-banner")).toBeNull();

    app.unmount();
    setNarrowWindow(true);
    app = renderView({
      allAccounts: [],
      accounts: [],
      selectedGroup: allGroup,
      onRefreshAll: vi.fn(),
    });
    expect(document.querySelector(".pull-refresh-hint-banner")).toBeNull();
  });

  it("shows on mobile for up to 2 sessions, dismisses for the session, and stops on the 3rd", () => {
    setNarrowWindow(true);
    const props = {
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onRefreshAll: vi.fn(),
    };

    app = renderView(props);
    const banner = document.querySelector(".pull-refresh-hint-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Pull down on the screen to refresh data");

    click(banner!.querySelector<HTMLButtonElement>(".pull-refresh-hint-dismiss")!);
    expect(document.querySelector(".pull-refresh-hint-banner")).toBeNull();
    app.unmount();

    sessionStorage.clear();
    app = renderView(props);
    expect(document.querySelector(".pull-refresh-hint-banner")).not.toBeNull();
    app.unmount();

    sessionStorage.clear();
    app = renderView(props);
    expect(document.querySelector(".pull-refresh-hint-banner")).toBeNull();
  });

  it("permanently dismisses when the user performs a pull-to-refresh gesture", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, writable: true, configurable: true });
    Object.defineProperty(window, "ontouchstart", { value: {}, writable: true, configurable: true });
    setNarrowWindow(true);

    const onRefreshAll = vi.fn();
    const props = {
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onRefreshAll,
    };

    app = renderView(props);
    expect(document.querySelector(".pull-refresh-hint-banner")).not.toBeNull();

    const container = document.querySelector(".content-scroll")!;
    act(() => {
      container.dispatchEvent(createTouchEvent("touchstart", container, 100, 100));
      window.dispatchEvent(createTouchEvent("touchmove", container, 100, 260));
      window.dispatchEvent(createTouchEvent("touchend", container, 100, 260));
    });

    expect(onRefreshAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".pull-refresh-hint-banner")).toBeNull();
    app.unmount();

    sessionStorage.clear();
    app = renderView(props);
    expect(document.querySelector(".pull-refresh-hint-banner")).toBeNull();
  });
});

