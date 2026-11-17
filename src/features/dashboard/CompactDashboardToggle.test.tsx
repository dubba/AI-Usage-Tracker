// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNarrowWindow } from "../../test-utils/media";
import { click, mount, type Mounted } from "../../test-utils/react";
import { getCompactDashboardMode, setCompactDashboardMode } from "../../shared/lib/compact-dashboard";
import { isCardCollapsedOnPage, setCardCollapsedOnPage } from "../layout/dashboard-page-state";
import { CompactDashboardToggle } from "./CompactDashboardToggle";

describe("CompactDashboardToggle", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    setCompactDashboardMode("off");
    setCardCollapsedOnPage("all", "a1", true);
    setCardCollapsedOnPage("provider:openai", "a2", true);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    setCardCollapsedOnPage("all", "a1", false);
    setCardCollapsedOnPage("provider:openai", "a2", false);
    setCompactDashboardMode("off");
    vi.restoreAllMocks();
  });

  const press = () => click(document.querySelector<HTMLButtonElement>(".compact-dashboard-toggle")!);

  it("on a wide window, puts every card back in the layout it picks", () => {
    setNarrowWindow(false);
    app = mount(<CompactDashboardToggle />);
    press();
    expect(getCompactDashboardMode()).toBe("on");
    // A card's own toggle swaps it to the other layout; the button resets that on every page.
    expect(isCardCollapsedOnPage("all", "a1")).toBe(false);
    expect(isCardCollapsedOnPage("provider:openai", "a2")).toBe(false);
  });

  it("on a phone, puts every card back in the layout it picks", () => {
    setNarrowWindow(true);
    app = mount(<CompactDashboardToggle />);
    press();
    expect(getCompactDashboardMode()).toBe("on");
    expect(isCardCollapsedOnPage("all", "a1")).toBe(false);
    expect(isCardCollapsedOnPage("provider:openai", "a2")).toBe(false);
  });

  it("labels the button Compact View", () => {
    setNarrowWindow(false);
    app = mount(<CompactDashboardToggle />);
    const button = document.querySelector<HTMLButtonElement>(".compact-dashboard-toggle")!;
    expect(button.getAttribute("aria-label")).toBe("Compact view");
    expect(button.textContent).toBe("Compact View");
    expect(button.querySelector("svg")).not.toBeNull();
  });
});
