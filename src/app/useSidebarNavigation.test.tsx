// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../test-utils/react";
import { STORAGE_KEYS, storageRemove } from "../shared/lib/storage";
import { restorePageScroll } from "./page-scroll";
import { useSidebarNavigation } from "./useSidebarNavigation";

let nav: ReturnType<typeof useSidebarNavigation>;

function capture(value: ReturnType<typeof useSidebarNavigation>) {
  nav = value;
}

function Probe() {
  capture(useSidebarNavigation());
  return null;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  storageRemove(STORAGE_KEYS.openSection);
});

describe("useSidebarNavigation", () => {
  it("opens again on the page that was open last time", () => {
    mounted = mount(<Probe />);
    act(() => nav.showSettings());
    mounted.unmount();
    mounted = mount(<Probe />);
    expect(nav.section).toBe("settings");

    act(() => nav.showActivity());
    mounted.unmount();
    mounted = mount(<Probe />);
    expect(nav.section).toBe("activity");
    expect(nav.sidebarOpen).toBe(false);
  });

  it("starts on All accounts with the sidebar closed", () => {
    mounted = mount(<Probe />);
    expect(nav.selectedGroupId).toBe("all");
    expect(nav.section).toBe("accounts");
    expect(nav.sidebarOpen).toBe(false);
  });

  it("selecting a group shows the accounts page, and closes the sidebar only when asked", () => {
    mounted = mount(<Probe />);
    act(() => nav.toggleSidebar());
    act(() => nav.showSettings());
    expect(nav.section).toBe("settings");
    expect(nav.sidebarOpen).toBe(false);

    act(() => nav.toggleSidebar());
    act(() => nav.selectGroup("provider:openai"));
    expect(nav.selectedGroupId).toBe("provider:openai");
    expect(nav.section).toBe("accounts");
    expect(nav.sidebarOpen).toBe(true);

    act(() => nav.selectGroup("bucket:b1", { closeSidebar: true }));
    expect(nav.selectedGroupId).toBe("bucket:b1");
    expect(nav.sidebarOpen).toBe(false);
  });

  it("showSettings opens Settings and closes the sidebar", () => {
    mounted = mount(<Probe />);
    act(() => nav.toggleSidebar());
    act(() => nav.showSettings());
    expect(nav.section).toBe("settings");
    expect(nav.sidebarOpen).toBe(false);
    act(() => nav.showSettings());
    expect(nav.section).toBe("settings");
  });

  it("cyclePages carries on from the page that was just chosen, also back to back", () => {
    mounted = mount(<Probe />);
    act(() => {
      nav.showSettings();
      nav.cyclePages();
      nav.cyclePages();
    });
    expect(nav.section).toBe("activity");
  });

  it("resetGroup returns to All accounts without changing the page", () => {
    mounted = mount(<Probe />);
    act(() => nav.selectGroup("bucket:b1"));
    act(() => nav.showSettings());
    act(() => nav.resetGroup());
    expect(nav.selectedGroupId).toBe("all");
    expect(nav.section).toBe("settings");
  });

  it("closeSidebar closes it", () => {
    mounted = mount(<Probe />);
    act(() => nav.toggleSidebar());
    expect(nav.sidebarOpen).toBe(true);
    act(() => nav.closeSidebar());
    expect(nav.sidebarOpen).toBe(false);
  });

  it("records the open page's scroll position before leaving it", () => {
    document.body.insertAdjacentHTML("beforeend", `
      <main class="main-stage">
        <div class="kept-page" data-page="activity">
          <div class="dashboard-scroll" id="usage-scroll"></div>
        </div>
      </main>`);
    const usage = document.getElementById("usage-scroll")!;
    Object.defineProperty(usage, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(usage, "clientHeight", { configurable: true, get: () => 100 });
    usage.scrollTop = 510;
    mounted = mount(<Probe />);
    act(() => nav.showAccounts());
    usage.scrollTop = 0;
    expect(restorePageScroll("activity")).toBe(true);
    expect(usage.scrollTop).toBe(510);
    document.querySelector(".main-stage")?.remove();
  });

  it("shows the Usage and Accounts pages and closes the sidebar", () => {
    mounted = mount(<Probe />);
    act(() => nav.toggleSidebar());
    act(() => nav.showActivity());
    expect(nav.section).toBe("activity");
    expect(nav.sidebarOpen).toBe(false);

    act(() => nav.toggleSidebar());
    act(() => nav.showAccounts());
    expect(nav.section).toBe("accounts");
    expect(nav.sidebarOpen).toBe(false);
  });

  it("shows Accounts on the group that was last chosen", () => {
    mounted = mount(<Probe />);
    act(() => nav.selectGroup("bucket:b1"));
    act(() => nav.showActivity());
    expect(nav.selectedGroupId).toBe("bucket:b1");
    act(() => nav.showAccounts());
    expect(nav.section).toBe("accounts");
    expect(nav.selectedGroupId).toBe("bucket:b1");
  });

  it("choosing a group from Usage shows the accounts", () => {
    mounted = mount(<Probe />);
    act(() => nav.showActivity());
    act(() => nav.selectGroup("provider:openai", { closeSidebar: true }));
    expect(nav.section).toBe("accounts");
    expect(nav.selectedGroupId).toBe("provider:openai");
  });

  it("the cycle shortcut steps Dashboard, Usage, Settings and round again", () => {
    mounted = mount(<Probe />);
    expect(nav.section).toBe("accounts");
    act(() => nav.cyclePages());
    expect(nav.section).toBe("activity");
    act(() => nav.cyclePages());
    expect(nav.section).toBe("settings");
    act(() => nav.cyclePages());
    expect(nav.section).toBe("accounts");
  });

  it("keeps the same functions between renders", () => {
    mounted = mount(<Probe />);
    const { selectGroup, showSettings, showActivity, showAccounts, cyclePages, toggleSidebar } = nav;
    act(() => nav.toggleSidebar());
    expect(nav.selectGroup).toBe(selectGroup);
    expect(nav.showSettings).toBe(showSettings);
    expect(nav.showActivity).toBe(showActivity);
    expect(nav.showAccounts).toBe(showAccounts);
    expect(nav.cyclePages).toBe(cyclePages);
    expect(nav.toggleSidebar).toBe(toggleSidebar);
  });
});
