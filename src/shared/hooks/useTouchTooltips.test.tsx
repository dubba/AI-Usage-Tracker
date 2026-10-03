// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { useTouchTooltips } from "./useTouchTooltips";

function TestComponent() {
  useTouchTooltips();
  return (
    <div>
      <button type="button" className="generic-btn" data-tooltip="Generic tooltip">
        Generic
      </button>
      <button type="button" className="sidebar-settings-btn" data-tooltip="Settings">
        Settings
      </button>
      <button type="button" className="mobile-sidebar-toggle-btn" data-tooltip="Toggle menu">
        Toggle
      </button>
      <button type="button" className="mobile-sidebar-close-btn" data-tooltip="Close menu">
        Close
      </button>
      <div className="outside-area">Outside</div>
    </div>
  );
}

describe("useTouchTooltips", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("activates data-tooltip-active on touch for generic elements with data-tooltip", () => {
    app = mount(<TestComponent />);

    const genericBtn = document.querySelector<HTMLButtonElement>(".generic-btn")!;
    expect(genericBtn).not.toBeNull();

    const touchEvent = new Event("touchstart", { bubbles: true });
    genericBtn.dispatchEvent(touchEvent);

    expect(genericBtn.getAttribute("data-tooltip-active")).toBe("true");
  });

  it("does not activate data-tooltip-active on touch for .sidebar-settings-btn", () => {
    app = mount(<TestComponent />);

    const settingsBtn = document.querySelector<HTMLButtonElement>(".sidebar-settings-btn")!;
    expect(settingsBtn).not.toBeNull();

    const touchEvent = new Event("touchstart", { bubbles: true });
    settingsBtn.dispatchEvent(touchEvent);

    expect(settingsBtn.getAttribute("data-tooltip-active")).toBeNull();
  });

  it("does not activate data-tooltip-active on touch for mobile sidebar toggle or close buttons", () => {
    app = mount(<TestComponent />);

    const toggleBtn = document.querySelector<HTMLButtonElement>(".mobile-sidebar-toggle-btn")!;
    const closeBtn = document.querySelector<HTMLButtonElement>(".mobile-sidebar-close-btn")!;

    toggleBtn.dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(toggleBtn.getAttribute("data-tooltip-active")).toBeNull();

    closeBtn.dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(closeBtn.getAttribute("data-tooltip-active")).toBeNull();
  });
});
