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

  it("flips upward when measured menu height exceeds space below", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    // Anchor leaves 200px below (800 - (551 + 44) - 5 = 200px)
    mockAnchorRect(app.container, { top: 551, left: 40, width: 360, height: 44 });

    click(document.getElementById("provider")!);

    // If menu height is measured as 220px (e.g. customized items), it must flip upward!
    const menu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    Object.defineProperty(menu, "scrollHeight", { value: 220, configurable: true });

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const updatedMenu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    expect(updatedMenu.classList.contains("upward")).toBe(true);
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

  it("applies aria-label to the trigger button", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" aria-label="Provider" />,
    );
    const trigger = document.getElementById("provider")!;
    expect(trigger.getAttribute("aria-label")).toBe("Provider");
  });

  it("navigates to first and last options with Home and End keys", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    const trigger = document.getElementById("provider")!;
    click(trigger);

    // Press End -> last option highlighted
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    const items = document.querySelectorAll<HTMLElement>(".custom-dropdown-item");
    expect(items[2].classList.contains("highlighted")).toBe(true);

    // Press Home -> first option highlighted
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(items[0].classList.contains("highlighted")).toBe(true);
  });

  it("restores focus to trigger when closed with Escape", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    const trigger = document.getElementById("provider")!;
    trigger.focus();
    click(trigger);
    expect(document.querySelector(".custom-dropdown-menu")).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".custom-dropdown-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("positions the menu relative to a backdrop-filter containing block", () => {
    app = mount(
      <div id="backdrop">
        <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />
      </div>,
    );
    const backdrop = document.getElementById("backdrop")!;
    backdrop.getBoundingClientRect = () =>
      ({
        x: 20,
        y: 50,
        top: 50,
        left: 20,
        right: 420,
        bottom: 750,
        width: 400,
        height: 700,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    mockAnchorRect(app.container, { top: 200, left: 100, width: 300, height: 60 });
    // A reserved 6px scrollbar gutter on the left: the padding box, which
    // fixed descendants are placed from, starts at x = 20 + 6.
    Object.defineProperty(backdrop, "clientLeft", { value: 6, configurable: true });

    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) => {
      if (el === backdrop) {
        return {
          transform: "none",
          filter: "none",
          backdropFilter: "blur(3px)",
          perspective: "none",
          willChange: "auto",
          contain: "none",
        } as unknown as CSSStyleDeclaration;
      }
      return real.call(window, el);
    }) as typeof window.getComputedStyle);

    click(document.getElementById("provider")!);

    const menu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    // Viewport-space coordinates translated into the backdrop's padding box,
    // so the menu's left edge lands exactly on the trigger's (100 - 26).
    expect(menu.style.left).toBe("74px");
    expect(menu.style.width).toBe("300px");
    expect(menu.style.top).toBe("215px");
  });

  it("restores focus to trigger when an option is selected", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    const trigger = document.getElementById("provider")!;
    trigger.focus();
    click(trigger);

    const option = Array.from(document.querySelectorAll<HTMLElement>(".custom-dropdown-item")).find((item) =>
      item.textContent?.includes("OpenAI ChatGPT"),
    )!;
    click(option);
    expect(onChange).toHaveBeenCalledWith("openai");
    expect(document.querySelector(".custom-dropdown-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not reserve scrollbar space on a short menu", () => {
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    mockAnchorRect(app.container, { top: 120, left: 40, width: 360, height: 44 });
    click(document.getElementById("provider")!);
    const menu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    expect(menu.classList.contains("has-overflow")).toBe(false);
  });

  it("reserves scrollbar space when the menu content overflows", () => {
    vi.spyOn(HTMLUListElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLUListElement.prototype, "clientHeight", "get").mockReturnValue(200);
    app = mount(
      <CustomDropdown value="claude" options={OPTIONS} onChange={onChange} id="provider" />,
    );
    mockAnchorRect(app.container, { top: 120, left: 40, width: 360, height: 44 });
    click(document.getElementById("provider")!);
    const menu = document.querySelector<HTMLElement>(".custom-dropdown-menu")!;
    expect(menu.classList.contains("has-overflow")).toBe(true);
  });
});
