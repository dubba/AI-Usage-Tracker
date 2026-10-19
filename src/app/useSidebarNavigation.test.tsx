// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../test-utils/react";
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
});

describe("useSidebarNavigation", () => {
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

  it("the settings shortcut toggles Settings and closes the sidebar", () => {
    mounted = mount(<Probe />);
    act(() => nav.toggleSidebar());
    act(() => nav.toggleSettings());
    expect(nav.section).toBe("settings");
    expect(nav.sidebarOpen).toBe(false);
    act(() => nav.toggleSettings());
    expect(nav.section).toBe("accounts");
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

  it("keeps the same functions between renders", () => {
    mounted = mount(<Probe />);
    const { selectGroup, showSettings, toggleSidebar } = nav;
    act(() => nav.toggleSidebar());
    expect(nav.selectGroup).toBe(selectGroup);
    expect(nav.showSettings).toBe(showSettings);
    expect(nav.toggleSidebar).toBe(toggleSidebar);
  });
});
