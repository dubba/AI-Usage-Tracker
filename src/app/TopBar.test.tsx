// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../test-utils/react";
import { TopBar } from "./TopBar";
import type { Section } from "./useSidebarNavigation";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function render(section: Section) {
  const handlers = { onSelect: vi.fn(), onAddAccount: vi.fn(), onAddGroup: vi.fn() };
  mounted = mount(<TopBar section={section} {...handlers} />);
  const pages = [...mounted.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button')];
  return { handlers, pages };
}

describe("TopBar", () => {
  it("lists Dashboard, Usage and Settings and marks the current page", () => {
    const { pages } = render("activity");
    expect(pages.map((page) => page.textContent)).toEqual(["Dashboard", "Usage", "Settings"]);
    expect(pages.map((page) => page.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("describes each page in a tooltip", () => {
    const { pages } = render("accounts");
    expect(pages.map((page) => page.getAttribute("data-tooltip"))).toEqual([
      "View all your AI accounts, their limits, and reset times",
      "Shows daily usage across your AI accounts",
      "Customize app preferences and sync devices",
    ]);
  });

  it("opens a page when clicked", () => {
    const { pages, handlers } = render("accounts");
    click(pages[2]);
    expect(handlers.onSelect).toHaveBeenCalledWith("settings");
  });

  it("offers Add account and New group, and leaves the sync status, Refresh all and the Left / Used switch to others", () => {
    const { handlers } = render("accounts");
    const container = mounted!.container;
    // The sync status and Refresh all sit at the foot of the sidebar, as on a phone.
    expect(container.textContent).not.toContain("synced");
    expect(container.querySelector('[aria-label="Refresh all accounts"]')).toBeNull();
    expect(container.querySelector('[aria-label="Usage display"]')).toBeNull();
    // Named like the phone sidebar's add buttons: an icon, then one word.
    expect(container.querySelector(".top-bar-add-group")?.textContent).toBe("Group");
    expect(container.querySelector(".top-bar-add-account")?.textContent).toBe("Account");
    expect(container.querySelector(".top-bar-add-account")?.getAttribute("aria-label")).toBe("Add new account");
    click(container.querySelector<HTMLButtonElement>(".top-bar-add-account")!);
    click(container.querySelector<HTMLButtonElement>('[aria-label="Add new group"]')!);
    expect(handlers.onAddAccount).toHaveBeenCalledTimes(1);
    expect(handlers.onAddGroup).toHaveBeenCalledTimes(1);
  });
});
