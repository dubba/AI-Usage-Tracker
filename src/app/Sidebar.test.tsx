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
      onMoveGroup={vi.fn()}
      onRefreshAll={vi.fn()}
      onSelectGroup={onSelectGroup}
      {...props}
    />,
  );
  return { onSelectGroup };
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
    // No add buttons: the phone Dashboard header has them (AccountsView).
    expect(mounted!.container.querySelector(".provider-sidebar-heading")).toBeNull();
    expect(mounted!.container.querySelector(".add-account-header-button")).toBeNull();
    const list = mounted!.container.querySelector(".provider-list")!;
    const status = mounted!.container.querySelector(".sidebar-sync-status")!;
    expect(list.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([true, false])("never lists the Dashboard, Usage and Settings pages (top bar %s)", (topBar) => {
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

    it.each([true, false])("has no add buttons in its headings: the top bar or page header has them (top bar %s)", (topBar) => {
      render({ section: "accounts", topBar });
      expect(mounted!.container.querySelector(".sidebar-section-header button")).toBeNull();
      expect(mounted!.container.querySelector('[aria-label="Add new account"], [aria-label="Add new group"]')).toBeNull();
      const titles = [...mounted!.container.querySelectorAll(".sidebar-section-title")].map((el) => el.textContent);
      expect(titles).toEqual(["Accounts", "Groups"]);
    });

    it.each(["accounts", "activity", "settings"] as const)(
      "starts the phone overlay's list with All Accounts and pins the % Left / % Used switch above the sync line (%s page)",
      (section) => {
        render({ section, topBar: false });
        const list = mounted!.container.querySelector(".provider-list")!;
        expect(list.children[0].classList.contains("is-all-row")).toBe(true);
        expect(list.querySelector(".sidebar-filter-header")).toBeNull();

        // Outside the scrolling list, between it and the sync line.
        const switchRow = list.nextElementSibling!;
        expect(switchRow.classList.contains("sidebar-display-switch")).toBe(true);
        expect(switchRow.nextElementSibling?.classList.contains("sidebar-sync-status")).toBe(true);
        const toggle = switchRow.querySelector(".usage-display-toggle")!;
        expect(toggle.classList.contains("is-words")).toBe(true);
        expect(toggle.textContent).toBe("% Left% Used");
        expect(list.querySelector(".usage-display-toggle")).toBeNull();
      },
    );

    it("has no % Left / % Used switch on a wide window: the Dashboard header has it", () => {
      render({ section: "accounts", topBar: true });
      expect(mounted!.container.querySelector(".usage-display-toggle")).toBeNull();
      expect(mounted!.container.querySelector(".sidebar-display-switch, .sidebar-filter-header")).toBeNull();
    });

    it("says so when there are no accounts and no custom groups", () => {
      render({ section: "accounts", topBar: true, groups: [] });
      const empties = [...mounted!.container.querySelectorAll(".sidebar-section-empty")].map((el) => el.textContent);
      expect(empties).toEqual(["No accounts yet", "No groups yet"]);
    });

    it("says so when there are no custom groups", () => {
      render({ section: "accounts", topBar: true, groups: [mixed[1]] });
      const empties = [...mounted!.container.querySelectorAll(".sidebar-section-empty")].map((el) => el.textContent);
      expect(empties).toEqual(["No groups yet"]);
    });
  });
});
