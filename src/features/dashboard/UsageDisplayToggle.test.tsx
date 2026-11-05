// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { UsageDisplayToggle } from "./UsageDisplayToggle";
import { getUsageDisplayMode, setUsageDisplayMode } from "../../shared/lib/usage-display";

describe("UsageDisplayToggle", () => {
  let app: Mounted | null = null;

  beforeEach(() => {
    setUsageDisplayMode("left");
  });

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("renders L and U toggle buttons with correct initial active state", () => {
    app = mount(<UsageDisplayToggle />);

    const buttons = document.querySelectorAll<HTMLButtonElement>(".provider-window-toggle button");
    expect(buttons.length).toBe(2);

    const [leftBtn, usedBtn] = Array.from(buttons);
    expect(leftBtn.textContent?.trim()).toBe("L");
    expect(usedBtn.textContent?.trim()).toBe("U");

    expect(leftBtn.classList.contains("active")).toBe(true);
    expect(leftBtn.getAttribute("aria-pressed")).toBe("true");
    expect(usedBtn.classList.contains("active")).toBe(false);
    expect(usedBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to U when clicked and updates active class", () => {
    app = mount(<UsageDisplayToggle />);

    const buttons = document.querySelectorAll<HTMLButtonElement>(".provider-window-toggle button");
    const [leftBtn, usedBtn] = Array.from(buttons);

    click(usedBtn);
    expect(getUsageDisplayMode()).toBe("used");
    expect(usedBtn.classList.contains("active")).toBe(true);
    expect(usedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(leftBtn.classList.contains("active")).toBe(false);
    expect(leftBtn.getAttribute("aria-pressed")).toBe("false");

    click(leftBtn);
    expect(getUsageDisplayMode()).toBe("left");
    expect(leftBtn.classList.contains("active")).toBe(true);
    expect(leftBtn.getAttribute("aria-pressed")).toBe("true");
    expect(usedBtn.classList.contains("active")).toBe(false);
    expect(usedBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders % Left and % Used when labels is 'words'", () => {
    app = mount(<UsageDisplayToggle labels="words" />);

    const buttons = document.querySelectorAll<HTMLButtonElement>("button");
    expect(Array.from(buttons).map((b) => b.textContent?.trim())).toEqual(["% Left", "% Used"]);
  });
});
