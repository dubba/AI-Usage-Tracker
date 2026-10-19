// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { MobileSidebarToggle } from "./MobileSidebarToggle";
import { ToggleSwitch } from "./ToggleSwitch";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("ToggleSwitch", () => {
  it("renders the markup the styles select, reflecting its state", () => {
    mounted = mount(
      <>
        <span id="label">Label</span>
        <ToggleSwitch checked labelledBy="label" onChange={() => {}} />
      </>,
    );
    const toggle = document.querySelector("button")!;
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-labelledby")).toBe("label");
    expect(toggle.classList.contains("toggle")).toBe(true);
    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.children).toHaveLength(1);
    expect(toggle.firstElementChild!.tagName).toBe("SPAN");
  });

  it("is off without the on class, and asks for the opposite state when clicked", () => {
    const onChange = vi.fn();
    mounted = mount(<ToggleSwitch checked={false} labelledBy="l" onChange={onChange} />);
    const toggle = document.querySelector("button")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.classList.contains("on")).toBe(false);
    click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    mounted.rerender(<ToggleSwitch checked labelledBy="l" onChange={onChange} />);
    click(document.querySelector("button")!);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("does nothing while disabled", () => {
    const onChange = vi.fn();
    mounted = mount(<ToggleSwitch checked={false} labelledBy="l" onChange={onChange} disabled />);
    const toggle = document.querySelector("button")!;
    expect(toggle.disabled).toBe(true);
    click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MobileSidebarToggle", () => {
  it("is the labelled menu button that controls the sidebar", () => {
    const onToggle = vi.fn();
    mounted = mount(<MobileSidebarToggle onToggle={onToggle} open />);
    const button = document.querySelector("button")!;
    expect(button.className).toBe("mobile-sidebar-toggle-btn");
    expect(button.getAttribute("aria-label")).toBe("Toggle navigation menu");
    expect(button.getAttribute("aria-controls")).toBe("app-sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("data-tooltip")).toBe("Toggle navigation menu");
    click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reports collapsed when the sidebar is closed or unknown", () => {
    mounted = mount(<MobileSidebarToggle onToggle={() => {}} />);
    expect(document.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  });
});
