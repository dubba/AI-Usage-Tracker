// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../test-utils/react";
import { ALL_ACCOUNTS_GROUP_ID, type SidebarGroup } from "../features/dashboard/sidebar-groups";
import { Sidebar } from "./Sidebar";
import type { Section } from "./useSidebarNavigation";

// The parts of the sidebar that are not under test measure and observe the page.
vi.mock("../features/dashboard/SyncStatusLine", () => ({
  SyncStatusLine: () => <div className="sidebar-sync-status" />,
}));
vi.mock("../features/dashboard/SidebarResizeHandle", () => ({ SidebarResizeHandle: () => null }));
vi.mock("../shared/hooks/useScrollThumb", () => ({ useScrollThumb: () => ({ overflows: false }) }));

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const allGroup: SidebarGroup = { id: ALL_ACCOUNTS_GROUP_ID, type: "all", title: "All Accounts", provider: null, accounts: [] };

function render(props: { section: Section; topBar: boolean; selectedGroupId?: string; groups?: SidebarGroup[] }) {
  const onSelectGroup = vi.fn();
  const onAddAccount = vi.fn();
  const onAddGroup = vi.fn();
  mounted = mount(
    <Sidebar
      sidebarRef={{ current: null }}
      shellRef={{ current: null }}
      open={false}
      hidden={false}
      modal={false}
      selectedGroupId={props.selectedGroupId ?? ALL_ACCOUNTS_GROUP_ID}
      allAccountsGroup={allGroup}
      groups={props.groups ?? []}
      accounts={[]}
      refreshMinutes={15}
      busy={new Set()}
      onClose={vi.fn()}
      onAddAccount={onAddAccount}
      onAddGroup={onAddGroup}
      onMoveGroup={vi.fn()}
      onRefreshAll={vi.fn()}
      onSelectGroup={onSelectGroup}
      {...props}
    />,
  );
  return { onSelectGroup, onAddAccount, onAddGroup };
}

describe("Sidebar", () => {
  it("leaves the app name to the top bar on a wide window, and keeps the sync status below the groups as on a phone", () => {
    render({ section: "accounts", topBar: true });
    expect(mounted!.container.querySelector(".provider-list")).not.toBeNull();
    expect(mounted!.container.querySelector(".brand")).toBeNull();
    expect(mounted!.container.querySelector(".add-account-header-button")).toBeNull();
    expect(mounted!.container.querySelector(".add-bucket-header-button")).toBeNull();
    const list = mounted!.container.querySelector(".provider-list")!;
    const status = mounted!.container.querySelector(".sidebar-sync-status")!;
    expect(list.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps them as the phone overlay, with the sync status below the groups", () => {
    render({ section: "accounts", topBar: false });
    expect(mounted!.container.querySelector(".brand")).not.toBeNull();
    // The add buttons moved out of a heading at the top into the Accounts and Groups headers.
    expect(mounted!.container.querySelector(".provider-sidebar-heading")).toBeNull();
    expect(mounted!.container.querySelector(".add-account-header-button")).toBeNull();
    expect(mounted!.container.querySelector('.sidebar-section-header [aria-label="Add new account"]')).not.toBeNull();
    expect(mounted!.container.querySelector('.sidebar-section-header [aria-label="New group"]')).not.toBeNull();
    const list = mounted!.container.querySelector(".provider-list")!;
    const status = mounted!.container.querySelector(".sidebar-sync-status")!;
    expect(list.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([true, false])("never lists the Accounts, Usage and Settings pages (top bar %s)", (topBar) => {
    render({ section: "accounts", topBar });
    expect(mounted!.container.querySelector('nav[aria-label="Main"]')).toBeNull();
    expect(mounted!.container.textContent).not.toContain("Settings");
  });

  it("leaves the group rows selected only on the Accounts page", () => {
    render({ section: "accounts", topBar: true });
    expect(mounted!.container.querySelector(".provider-summary-row.selected")).not.toBeNull();
    mounted!.unmount();
    render({ section: "activity", topBar: true });
    expect(mounted!.container.querySelector(".provider-summary-row.selected")).toBeNull();
    mounted!.unmount();
    render({ section: "settings", topBar: true });
    expect(mounted!.container.querySelector(".provider-summary-row.selected")).toBeNull();
  });

  it("selects a group when its row is clicked", () => {
    const { onSelectGroup } = render({ section: "accounts", topBar: true });
    click(mounted!.container.querySelector<HTMLElement>(".provider-summary-row")!);
    expect(onSelectGroup).toHaveBeenCalledTimes(1);
  });

  describe("sections", () => {
    const group = (id: string, type: SidebarGroup["type"], title: string): SidebarGroup => ({
      id,
      type,
      title,
      provider: null,
      accounts: [],
    });
    // The saved order interleaves custom groups and provider rows; the sidebar splits them in two.
    const mixed = [
      group("bucket:b1", "bucket", "work"),
      group("provider:anthropic", "provider", "Claude"),
      group("bucket:b2", "bucket", "home"),
      group("provider:grok", "provider", "Grok"),
    ];
    const titles = () => Array.from(mounted!.container.querySelectorAll(".sidebar-group-name")).map((el) => el.textContent);

    it("lists provider rows under Accounts and custom groups under Groups", () => {
      render({ section: "accounts", topBar: true, groups: mixed });
      expect(titles()).toEqual(["All Accounts", "Claude", "Grok", "work", "home"]);
      const headers = Array.from(mounted!.container.querySelectorAll(".sidebar-section-title")).map((el) => el.textContent);
      expect(headers).toEqual(["Accounts", "Groups"]);
    });

    it("puts the add buttons in the section headers on a wide window", () => {
      const { onAddAccount, onAddGroup } = render({ section: "accounts", topBar: true });
      click(mounted!.container.querySelector<HTMLElement>('[aria-label="Add new account"]')!);
      click(mounted!.container.querySelector<HTMLElement>('[aria-label="New group"]')!);
      expect(onAddAccount).toHaveBeenCalledTimes(1);
      expect(onAddGroup).toHaveBeenCalledTimes(1);
    });

    it("spells the buttons out beside their icons (shown on the phone overlay by CSS)", () => {
      render({ section: "accounts", topBar: false });
      const labels = [...mounted!.container.querySelectorAll(".sidebar-section-button .sidebar-section-button-label")].map((el) => el.textContent);
      expect(labels).toEqual(["Account", "Group"]);
    });

    it("puts the add buttons in the section headers on the phone overlay too", () => {
      const { onAddAccount, onAddGroup } = render({ section: "accounts", topBar: false });
      click(mounted!.container.querySelector<HTMLElement>('[aria-label="Add new account"]')!);
      click(mounted!.container.querySelector<HTMLElement>('[aria-label="New group"]')!);
      expect(onAddAccount).toHaveBeenCalledTimes(1);
      expect(onAddGroup).toHaveBeenCalledTimes(1);
      expect(mounted!.container.querySelectorAll(".sidebar-section-title")).toHaveLength(2);
    });

    it("has no L / U switch of its own: it is in the page header on a phone and the top bar on a wide window", () => {
      render({ section: "accounts", topBar: false });
      expect(mounted!.container.querySelector(".usage-display-toggle")).toBeNull();
    });

    it("says so when there are no custom groups", () => {
      render({ section: "accounts", topBar: true, groups: [mixed[1]] });
      expect(mounted!.container.querySelector(".sidebar-section-empty")?.textContent).toBe("No groups yet");
    });
  });
});
