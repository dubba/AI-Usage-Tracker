// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { Account, AccountBucket } from "../../types";
import { ALL_ACCOUNTS_GROUP_ID, type SidebarGroup } from "../dashboard/sidebar-groups";
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

const allGroup: SidebarGroup = {
  id: ALL_ACCOUNTS_GROUP_ID,
  type: "all",
  title: "All",
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
      needsAttention={0}
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
    expect(document.body.textContent).toContain("Connect an AI Provider Account");
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
    expect(document.body.textContent).not.toContain("Connect an AI Provider Account");
    expect(document.body.textContent).not.toContain("Link Devices");
  });
});

describe("AccountsView summary cards", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("displays total accounts count and healthy count in Accounts card", () => {
    app = renderView({
      allAccounts: [account, { ...account, id: "acct-2" }],
      accounts: [account, { ...account, id: "acct-2" }],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }] },
      needsAttention: 1,
    });
    const totalCard = document.querySelector(".summary-card.total-card")!;
    expect(totalCard).not.toBeNull();
    expect(totalCard.querySelector(".summary-value-cluster strong")?.textContent).toBe("2");
    expect(totalCard.querySelector(".summary-helper")?.textContent).toContain("1 healthy");
  });

  it("renders Action Needed as a native button when attention is required, without duplicate counts", () => {
    app = renderView({
      allAccounts: [account, { ...account, id: "acct-2" }],
      accounts: [account, { ...account, id: "acct-2" }],
      selectedGroup: { ...allGroup, accounts: [account, { ...account, id: "acct-2" }] },
      needsAttention: 2,
    });
    const attentionBtn = document.querySelector<HTMLButtonElement>("button.summary-card.attention-card");
    expect(attentionBtn).not.toBeNull();
    expect(attentionBtn?.tagName).toBe("BUTTON");
    expect(attentionBtn?.getAttribute("type")).toBe("button");
    expect(attentionBtn?.getAttribute("aria-pressed")).toBe("false");
    expect(attentionBtn?.querySelector(".summary-helper")?.textContent).toContain("Requires attention");
    expect(attentionBtn?.querySelector(".summary-value-cluster strong")?.textContent).toBe("2");

    // Click toggles filtering
    click(attentionBtn!);
    expect(attentionBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".filter-active-banner")).not.toBeNull();
  });

  it("renders Action Needed as a non-interactive div when all accounts are good", () => {
    app = renderView({
      allAccounts: [account],
      accounts: [account],
      selectedGroup: { ...allGroup, accounts: [account] },
      needsAttention: 0,
    });
    expect(document.querySelector("button.summary-card.attention-card")).toBeNull();
    const attentionDiv = document.querySelector<HTMLDivElement>("div.summary-card.attention-card")!;
    expect(attentionDiv).not.toBeNull();
    expect(attentionDiv.tagName).toBe("DIV");
    expect(attentionDiv.querySelector(".summary-helper")?.textContent).toContain("All good");
    expect(attentionDiv.querySelector(".summary-value-cluster strong")?.textContent).toBe("0");
  });
});

