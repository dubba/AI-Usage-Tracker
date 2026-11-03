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
vi.mock("../features/dashboard/UsageDisplayToggle", () => ({ UsageDisplayToggle: () => null }));
vi.mock("../shared/hooks/useScrollThumb", () => ({ useScrollThumb: () => ({ overflows: false }) }));

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const allGroup: SidebarGroup = { id: ALL_ACCOUNTS_GROUP_ID, type: "all", title: "All Accounts", provider: null, accounts: [] };

function render(props: { section: Section; topBar: boolean; selectedGroupId?: string }) {
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
      groups={[]}
      accounts={[]}
      refreshMinutes={15}
      busy={new Set()}
      onClose={vi.fn()}
      onAddAccount={vi.fn()}
      onAddGroup={vi.fn()}
      onMoveGroup={vi.fn()}
      onRefreshAll={vi.fn()}
      onSelectGroup={onSelectGroup}
      {...props}
    />,
  );
  return { onSelectGroup };
}

describe("Sidebar", () => {
  it("leaves the app name, add buttons and sync status to the top bar on a wide window", () => {
    render({ section: "accounts", topBar: true });
    expect(mounted!.container.querySelector(".provider-list")).not.toBeNull();
    expect(mounted!.container.querySelector(".brand")).toBeNull();
    expect(mounted!.container.querySelector(".add-account-header-button")).toBeNull();
    expect(mounted!.container.querySelector(".add-bucket-header-button")).toBeNull();
    expect(mounted!.container.querySelector(".sidebar-sync-status")).toBeNull();
  });

  it("keeps them as the phone overlay, with the sync status below the groups", () => {
    render({ section: "accounts", topBar: false });
    expect(mounted!.container.querySelector(".brand")).not.toBeNull();
    expect(mounted!.container.querySelector(".add-account-header-button")).not.toBeNull();
    expect(mounted!.container.querySelector(".add-bucket-header-button")).not.toBeNull();
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
});
