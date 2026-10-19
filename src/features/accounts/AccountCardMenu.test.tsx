// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { Account } from "../../types";
import { AccountCardMenu } from "./AccountCardMenu";

const account = { id: "acct-1", label: "Work", provider: "openai" } as unknown as Account;

type Handlers = {
  onMove: Mock<(delta: -1 | 1) => void>;
  onRefresh: Mock<() => void>;
  onNotifications: Mock<() => void>;
  onRemove: Mock<() => void>;
};

function Harness({ handlers, ...props }: { handlers: Handlers } & Partial<Parameters<typeof AccountCardMenu>[0]>) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" id="outside">outside</button>
      <AccountCardMenu
        account={account}
        open={open}
        onOpenChange={setOpen}
        hasMove
        canMoveUp
        canMoveDown
        cardBusy={false}
        refreshDisabled={false}
        {...handlers}
        {...props}
      />
    </div>
  );
}

let mounted: Mounted | null = null;
const handlers = (): Handlers => ({ onMove: vi.fn<(delta: -1 | 1) => void>(), onRefresh: vi.fn<() => void>(), onNotifications: vi.fn<() => void>(), onRemove: vi.fn<() => void>() });
const toggle = () => document.querySelector<HTMLButtonElement>(".mobile-dropdown-toggle")!;
const menu = () => document.querySelector<HTMLElement>(".mobile-dropdown-menu");
const items = () => [...document.querySelectorAll<HTMLButtonElement>(".mobile-dropdown-item")];
const key = (name: string) => act(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("AccountCardMenu", () => {
  it("is closed until the toggle is pressed, and describes itself", () => {
    mounted = mount(<Harness handlers={handlers()} />);
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBeNull();
    click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-controls")).toBe("account-actions-acct-1");
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(menu()!.getAttribute("aria-label")).toBe("Actions for Work");
    expect(menu()!.id).toBe("account-actions-acct-1");
  });

  it("lists Move only when the page allows moving", () => {
    mounted = mount(<Harness handlers={handlers()} />);
    click(toggle());
    expect(items().map((item) => item.textContent?.trim())).toEqual(["Move up", "Move down", "Refresh", "Notifications", "Remove"]);
    mounted.rerender(<Harness handlers={handlers()} hasMove={false} />);
    expect(items().map((item) => item.textContent?.trim())).toEqual(["Refresh", "Notifications", "Remove"]);
    expect(document.querySelector(".mobile-actions-dropdown")!.classList.contains("has-move-menu")).toBe(false);
  });

  it("focuses the first enabled item and moves between enabled items with the arrow keys", () => {
    mounted = mount(<Harness handlers={handlers()} canMoveUp={false} />);
    click(toggle());
    // "Move up" is disabled, so the first enabled item is "Move down".
    expect(document.activeElement).toBe(items()[1]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items()[2]);
    key("ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
    key("ArrowUp"); // wraps past the disabled first item to the last
    expect(document.activeElement).toBe(items()[4]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    key("End");
    expect(document.activeElement).toBe(items()[4]);
    key("Home");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("runs an action and closes, giving focus back to the toggle", () => {
    vi.useFakeTimers();
    const h = handlers();
    mounted = mount(<Harness handlers={h} />);
    click(toggle());
    click(items()[2]);
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(toggle());
  });

  it("moves with a direction", () => {
    const h = handlers();
    mounted = mount(<Harness handlers={h} />);
    click(toggle());
    click(items()[0]);
    expect(h.onMove).toHaveBeenLastCalledWith(-1);
    click(toggle());
    click(items()[1]);
    expect(h.onMove).toHaveBeenLastCalledWith(1);
  });

  it("disables what the card cannot do right now", () => {
    mounted = mount(<Harness handlers={handlers()} canMoveDown={false} refreshDisabled />);
    click(toggle());
    expect(items().map((item) => item.disabled)).toEqual([false, true, true, false, false]);
    mounted.rerender(<Harness handlers={handlers()} cardBusy />);
    expect(items().every((item) => item.disabled)).toBe(true);
  });

  it("closes on Escape and returns focus to the toggle", () => {
    vi.useFakeTimers();
    mounted = mount(<Harness handlers={handlers()} />);
    click(toggle());
    key("Escape");
    expect(menu()).toBeNull();
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(toggle());
  });

  it("closes on a press outside, without taking focus", () => {
    mounted = mount(<Harness handlers={handlers()} />);
    click(toggle());
    act(() => {
      document.getElementById("outside")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    // A press inside does not close it.
    click(toggle());
    act(() => {
      toggle().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
  });

  it("closes on a touch outside too, and from the toggle itself", () => {
    mounted = mount(<Harness handlers={handlers()} />);
    click(toggle());
    act(() => {
      document.getElementById("outside")!.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    click(toggle());
    click(toggle());
    expect(menu()).toBeNull();
  });

  it("opens upward when there is no room below the toggle", () => {
    mounted = mount(<Harness handlers={handlers()} />);
    toggle().getBoundingClientRect = () => ({ top: 730, bottom: 762, left: 0, right: 32, width: 32, height: 32, x: 0, y: 730, toJSON: () => ({}) });
    click(toggle());
    expect(menu()!.classList.contains("upward")).toBe(true);
  });
});
