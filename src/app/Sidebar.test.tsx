// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../test-utils/react";
import { ALL_ACCOUNTS_GROUP_ID, type SidebarGroup } from "../features/dashboard/sidebar-groups";
import { Sidebar } from "./Sidebar";
import type { Section } from "./useSidebarNavigation";

// The parts of the sidebar that are not under test measure and observe the page.
vi.mock("../features/dashboard/SyncStatusLine", () => ({ SyncStatusLine: () => null }));
vi.mock("../features/dashboard/SidebarResizeHandle", () => ({ SidebarResizeHandle: () => null }));
vi.mock("../features/dashboard/UsageDisplayToggle", () => ({ UsageDisplayToggle: () => null }));
vi.mock("../shared/hooks/useScrollThumb", () => ({ useScrollThumb: () => ({ overflows: false }) }));

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const allGroup: SidebarGroup = { id: ALL_ACCOUNTS_GROUP_ID, type: "all", title: "All Accounts", provider: null, accounts: [] };

function render(props: { section: Section; showMainNav: boolean; selectedGroupId?: string }) {
  const handlers = {
    onOpenActivity: vi.fn(),
    onOpenAccounts: vi.fn(),
    onSelectGroup: vi.fn(),
    onOpenSettings: vi.fn(),
  };
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
      {...props}
      {...handlers}
    />,
  );
  const nav = mounted.container.querySelector<HTMLElement>('nav[aria-label="Main"]');
  return { nav, items: nav ? [...nav.querySelectorAll<HTMLButtonElement>("button")] : [], handlers };
}

describe("Sidebar entries for Usage and Accounts", () => {
  it("are above the group list on a wide window", () => {
    const { nav, items } = render({ section: "accounts", showMainNav: true });
    expect(items.map((item) => item.textContent)).toEqual(["Usage", "Accounts"]);
    const list = mounted!.container.querySelector(".provider-list")!;
    expect(nav!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("are left to the bottom bar when the sidebar is an overlay", () => {
    const { nav } = render({ section: "accounts", showMainNav: false });
    expect(nav).toBeNull();
    expect(mounted!.container.querySelector(".provider-list")).not.toBeNull();
  });

  it.each([
    ["activity", 0],
    ["accounts", 1],
  ] as const)("show the %s entry as the current page", (section, index) => {
    const { items } = render({ section, showMainNav: true });
    items.forEach((item, position) => {
      expect(item.getAttribute("aria-current")).toBe(position === index ? "page" : null);
    });
  });

  it("show neither as current while Settings is open", () => {
    const { items } = render({ section: "settings", showMainNav: true });
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, null]);
  });

  it("open their page when clicked", () => {
    const { items, handlers } = render({ section: "settings", showMainNav: true });
    click(items[0]);
    expect(handlers.onOpenActivity).toHaveBeenCalledTimes(1);
    click(items[1]);
    expect(handlers.onOpenAccounts).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenSettings).not.toHaveBeenCalled();
  });

  it("leave the group rows selected only on the Accounts page", () => {
    render({ section: "accounts", showMainNav: true });
    expect(mounted!.container.querySelector(".provider-summary-row.selected")).not.toBeNull();
    mounted!.unmount();
    render({ section: "activity", showMainNav: true });
    expect(mounted!.container.querySelector(".provider-summary-row.selected")).toBeNull();
  });
});
