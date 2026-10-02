// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import type { ShortcutAction } from "./shortcuts";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

function Probe({ enabled, handlers }: { enabled: boolean; handlers: Record<ShortcutAction, () => void> }) {
  useKeyboardShortcuts(enabled, handlers);
  return null;
}

const makeHandlers = () => ({ refreshAll: vi.fn(), openSettings: vi.fn(), addAccount: vi.fn(), addGroup: vi.fn() });

function press(key: string, init: KeyboardEventInit = { ctrlKey: true }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe("useKeyboardShortcuts", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("runs the action and stops the browser default (reload)", () => {
    const handlers = makeHandlers();
    mounted = mount(<Probe enabled handlers={handlers} />);
    const event = press("r");
    expect(handlers.refreshAll).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    press(",");
    press("n");
    press("g");
    expect(handlers.addGroup).toHaveBeenCalledTimes(1);
    expect(handlers.openSettings).toHaveBeenCalledTimes(1);
    expect(handlers.addAccount).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled", () => {
    const handlers = makeHandlers();
    mounted = mount(<Probe enabled={false} handlers={handlers} />);
    const event = press("r");
    expect(handlers.refreshAll).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing while a dialog is open", () => {
    const handlers = makeHandlers();
    mounted = mount(<Probe enabled handlers={handlers} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    press("r");
    press("n");
    expect(handlers.refreshAll).not.toHaveBeenCalled();
    expect(handlers.addAccount).not.toHaveBeenCalled();
    dialog.remove();
    press("r");
    expect(handlers.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("always calls the latest handlers", () => {
    const first = makeHandlers();
    const second = makeHandlers();
    mounted = mount(<Probe enabled handlers={first} />);
    mounted.rerender(<Probe enabled handlers={second} />);
    press("r");
    expect(first.refreshAll).not.toHaveBeenCalled();
    expect(second.refreshAll).toHaveBeenCalledTimes(1);
  });

  it("ignores keys without the modifier", () => {
    const handlers = makeHandlers();
    mounted = mount(<Probe enabled handlers={handlers} />);
    press("r", {});
    expect(handlers.refreshAll).not.toHaveBeenCalled();
  });
});
