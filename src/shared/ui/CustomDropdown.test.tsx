// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mount, type Mounted } from "../../test-utils/react";
import { CustomDropdown } from "./CustomDropdown";

const OPTIONS = [
  { value: "claude", label: "Anthropic Claude" },
  { value: "antigravity", label: "Google Antigravity" },
  { value: "openai", label: "OpenAI ChatGPT" },
];

function mockAnchorRect(container: HTMLElement, rect: { top: number; left: number; width: number; height: number }) {
  const anchor = container.querySelector<HTMLElement>(".custom-dropdown-container")!;
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON() {
      return {};
    },
  });
}

describe("CustomDropdown", () => {
  let app: Mounted | null = null;
  const onChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("innerHeight", 800);
    onChange.mockReset();
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pins the open menu with position fixed so it does not grow a scroll parent", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    mockAnchorRect(app.container, { top: 120, left: 40, width: 360, height: 44 });

    click(document.getElementById("provider")!);

    const menu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.left).toBe("40px");
    expect(menu.style.width).toBe("360px");
    expect(menu.style.top).toBe("169px");
    expect(menu.classList.contains("upward")).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("opens upward when there is not enough room below the trigger", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    mockAnchorRect(app.container, { top: 620, left: 40, width: 360, height: 44 });

    click(document.getElementById("provider")!);

    const menu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    expect(menu.classList.contains("upward")).toBe(true);
    expect(menu.style.top).toBe("auto");
    expect(menu.style.bottom).toBe("185px");
  });

  it("selects an option and closes", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    click(document.getElementById("provider")!);
    const option = Array.from(document.querySelectorAll<HTMLElement>(".custom-dropdown-item")).find((item) =>
      item.textContent?.includes("OpenAI ChatGPT"),
    )!;
    click(option);
    expect(onChange).toHaveBeenCalledWith("openai");
    expect(document.querySelector(".custom-dropdown-menu")).toBeNull();
  });

  it("closes on pointer down outside the menu", () => {
    app = mount(
      <div>
        <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />
        <button type="button" id="outside">outside</button>
      </div>,
    );
    click(document.getElementById("provider")!);
    expect(document.querySelector(".custom-dropdown-menu")).not.toBeNull();

    act(() => {
      document.getElementById("outside")!.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector(".custom-dropdown-menu")).toBeNull();
  });
});
