// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announceReorder } from "../../shared/lib/events";
import { setNarrowWindow } from "../../test-utils/media";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { Account, AccountBucket } from "../../types";
import { ALL_ACCOUNTS_GROUP_ID, type SidebarGroup } from "../sidebar/sidebar-groups";
import { AccountsView } from "./AccountsView";

const account = {
  id: "acct-1",
  label: "Claude",
  provider: "anthropic",
  email: "ada@example.com",
  providerAccountId: null,
  chatgptAccountId: null,
  plan: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastUsage: null,
  lastError: null,
  authRequired: false,
} as Account;

/** An account that needs nothing: it has live usage. (`account` above has none, so it needs attention.) */
const healthyAccount = { ...account, id: "acct-healthy", lastUsage: { freshness: "live", windows: [] } } as unknown as Account;

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
      "Monitor weekly limits, session limits, and reset times across all your AI subscriptions."
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
    expect(document.querySelector(".dashboard-bucket-title-stack")).toBeNull();
    expect(row?.hasAttribute("data-pill-wrapped")).toBe(false);
  });

  it("keeps the Group pill inline on line 1 on a phone when there is enough horizontal space", () => {
    setNarrowWindow(true);
    app = renderView({
      selectedGroup: bucketGroup,
      onToggleSidebar: () => undefined,
      onEditBucket: () => undefined,
      onAddGroup: () => undefined,
    });
    const row = document.querySelector(".dashboard-title-row")!;
    const main = row.querySelector(".dashboard-bucket-title-main")!;
    expect(row.hasAttribute("data-pill-wrapped")).toBe(false);
    expect(main.querySelector(".dashboard-bucket-pill")?.textContent).toBe("Group");
    expect(main.querySelector(".edit-bucket-title-btn")).not.toBeNull();
    expect(document.querySelectorAll(".dashboard-bucket-pill")).toHaveLength(1);
  });

  it("wraps the Group pill onto line 2 under the title on a phone only when cramped", () => {
    setNarrowWindow(true);
    let cramped = true;
    let triggerResize: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          triggerResize = () => cb([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "H1") return cramped ? 220 : 120;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "H1") return cramped ? 160 : 180;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("dashboard-bucket-pill")) return 54;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("dashboard-bucket-title-main")) {
        return { left: 60, right: cramped ? 250 : 180, top: 0, bottom: 24, width: 120, height: 24, x: 60, y: 0, toJSON: () => ({}) };
      }
      if (this.classList.contains("dashboard-header-actions")) {
        return { left: 262, right: 350, top: 0, bottom: 40, width: 88, height: 40, x: 262, y: 0, toJSON: () => ({}) };
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });

    app = renderView({
      selectedGroup: bucketGroup,
      onToggleSidebar: () => undefined,
      onEditBucket: () => undefined,
      onAddGroup: () => undefined,
    });

    const row = document.querySelector(".dashboard-title-row")!;
    const stack = row.querySelector(".dashboard-bucket-title-stack")!;
    const main = stack.querySelector(".dashboard-bucket-title-main")!;

    expect(row.hasAttribute("data-pill-wrapped")).toBe(true);
    expect(main.querySelector(".dashboard-bucket-pill")).toBeNull();
    expect(main.querySelector(".edit-bucket-title-btn")).not.toBeNull();
    expect(stack.lastElementChild?.classList.contains("dashboard-bucket-pill")).toBe(true);
    expect(document.querySelectorAll(".dashboard-bucket-pill")).toHaveLength(1);

    // When space opens up again, the pill returns inline to line 1.
    cramped = false;
    act(() => triggerResize?.());
    expect(row.hasAttribute("data-pill-wrapped")).toBe(false);
    expect(main.querySelector(".dashboard-bucket-pill")?.textContent).toBe("Group");
  });

  it("does not render a Group pill or stack for non-bucket views", () => {
    setNarrowWindow(true);
    app = renderView({
      selectedGroup: allGroup,
      onToggleSidebar: () => undefined,
    });
    expect(document.querySelector(".dashboard-bucket-pill")).toBeNull();
    expect(document.querySelector(".dashboard-bucket-title-stack")).toBeNull();
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

  it("renders a non-interactive status bar with 'All accounts good' and 'No upcoming reset' when healthy", () => {
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
    expect(strip?.querySelector(".summary-status-text")?.textContent).toBe("All accounts good");
    expect(strip?.querySelector(".summary-attention-count")).toBeNull();
    expect(strip?.querySelector(".next-reset-inline")?.textContent).toBe("No upcoming reset");
  });

  it("formats next reset inline for desktop and compactly for phone", () => {
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
    expect(phoneNext.textContent).toContain("Next:");
    expect(phoneNext.textContent).not.toContain("Next reset:");

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

  it("ends the phone title row with icon-only New group and Add account buttons", () => {
    setNarrowWindow(true);
    const onAdd = vi.fn();
    const onAddGroup = vi.fn();
    app = renderView({ onToggleSidebar: () => undefined, onAdd, onAddGroup });
    const row = document.querySelector(".dashboard-title-row")!;
    const actions = row.lastElementChild!;
    expect(actions.classList.contains("dashboard-header-actions")).toBe(true);
    const [group, account] = [...actions.querySelectorAll("button")];
    expect(group.getAttribute("aria-label")).toBe("Add new group");
    expect(group.getAttribute("data-tooltip")).toBe("Group AI accounts to track their usage\ntogether, such as Work or Personal");
    expect(account.getAttribute("aria-label")).toBe("Add new account");
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

  it("is not in the page header on a phone: the side menu has it (Sidebar.tsx)", () => {
    setNarrowWindow(true);
    app = renderView({ onToggleSidebar: () => undefined });
    expect(document.querySelector(".dashboard-header .usage-display-toggle")).toBeNull();
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

  it("renders a Compact toggle beside Show % Used / % Left and toggles compact cards (L7)", () => {
    setNarrowWindow(false);
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      onToggleSidebar: () => undefined,
    });

    const compactToggle = document.querySelector<HTMLButtonElement>(".accounts-display-switch .compact-dashboard-toggle")!;
    expect(compactToggle).not.toBeNull();
    expect(compactToggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(false);
    expect(document.querySelector(".compact-card-row")).toBeNull();

    click(compactToggle);
    expect(compactToggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(true);
    expect(document.querySelector(".compact-card-row")).not.toBeNull();

    // Restore default off state for subsequent tests
    click(compactToggle);
    expect(compactToggle.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".provider-account-cards")?.classList.contains("is-compact")).toBe(false);
  });
});
