// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../test-utils/react";
import { BottomNav } from "./BottomNav";
import { setBottomNavLabels } from "../shared/lib/bottom-nav-labels";
import type { Section } from "./useSidebarNavigation";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setBottomNavLabels("on");
});

function render(section: Section, props: { inert?: boolean } = {}) {
  const onSelect = vi.fn();
  mounted = mount(<BottomNav section={section} onSelect={onSelect} {...props} />);
  const nav = mounted.container.querySelector("nav")!;
  return { onSelect, nav, items: [...nav.querySelectorAll<HTMLButtonElement>("button")] };
}

describe("BottomNav", () => {
  it("is the Main navigation, with Dashboard, Usage and Settings in that order", () => {
    const { nav, items } = render("accounts");
    expect(nav.getAttribute("aria-label")).toBe("Main");
    expect(items.map((item) => item.textContent)).toEqual(["Dashboard", "Usage", "Settings"]);
    expect(items.every((item) => item.type === "button" && item.querySelector("svg") !== null)).toBe(true);
  });

  it.each([
    ["accounts", 0],
    ["activity", 1],
    ["settings", 2],
  ] as const)("marks only the %s item as the current page", (section, index) => {
    const { items } = render(section);
    items.forEach((item, position) => {
      expect(item.getAttribute("aria-current")).toBe(position === index ? "page" : null);
      expect(item.classList.contains("is-active")).toBe(position === index);
    });
  });

  it("selects the page of the item tapped, including the one already shown", () => {
    const { items, onSelect } = render("accounts");
    click(items[0]);
    click(items[1]);
    click(items[2]);
    expect(onSelect.mock.calls.map(([section]) => section)).toEqual(["accounts", "activity", "settings"]);
  });

  it("drops the page names when they are turned off, and names each button for screen readers", () => {
    setBottomNavLabels("off");
    const { nav, items } = render("activity");
    expect(nav.classList.contains("is-icon-only")).toBe(true);
    expect(items.map((item) => item.textContent)).toEqual(["", "", ""]);
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Dashboard", "Usage", "Settings"]);
    expect(items[1].getAttribute("aria-current")).toBe("page");
  });

  it("shows the page names by default, with no separate accessible name", () => {
    const { nav, items } = render("accounts");
    expect(nav.classList.contains("is-icon-only")).toBe(false);
    expect(items.every((item) => !item.hasAttribute("aria-label"))).toBe(true);
  });

  it("takes nothing behind an open sidebar", () => {
    expect(render("activity").nav.hasAttribute("inert")).toBe(false);
    mounted!.unmount();
    expect(render("activity", { inert: true }).nav.hasAttribute("inert")).toBe(true);
  });
});
