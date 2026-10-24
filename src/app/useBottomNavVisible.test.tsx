// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../test-utils/react";
import { useBottomNavVisible } from "./useBottomNavVisible";

const keyboard = vi.hoisted(() => ({
  listeners: [] as Array<(open: boolean) => void>,
  dispose: vi.fn(),
}));
vi.mock("../shared/lib/virtual-keyboard", () => ({
  watchVirtualKeyboard: (onChange: (open: boolean) => void) => {
    keyboard.listeners.push(onChange);
    onChange(false);
    return { check: vi.fn(), dispose: keyboard.dispose };
  },
}));

let visible: boolean;

function capture(value: boolean) {
  visible = value;
}

function Probe({ overlay }: { overlay: boolean }) {
  capture(useBottomNavVisible(overlay));
  return null;
}

let mounted: Mounted | null = null;
beforeEach(() => {
  keyboard.listeners.length = 0;
  keyboard.dispose.mockClear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const setKeyboard = (open: boolean) => act(() => keyboard.listeners.forEach((listener) => listener(open)));

describe("useBottomNavVisible", () => {
  it("is shown only while the sidebar is an overlay", () => {
    mounted = mount(<Probe overlay={false} />);
    expect(visible).toBe(false);
    // On a wide window nothing watches the keyboard either.
    expect(keyboard.listeners).toHaveLength(0);

    mounted.rerender(<Probe overlay />);
    expect(visible).toBe(true);
    mounted.rerender(<Probe overlay={false} />);
    expect(visible).toBe(false);
  });

  it("hides while the on-screen keyboard is open and comes back when it closes", () => {
    mounted = mount(<Probe overlay />);
    expect(visible).toBe(true);
    setKeyboard(true);
    expect(visible).toBe(false);
    setKeyboard(false);
    expect(visible).toBe(true);
  });

  it("stops watching the keyboard when the overlay layout ends", () => {
    mounted = mount(<Probe overlay />);
    mounted.rerender(<Probe overlay={false} />);
    expect(keyboard.dispose).toHaveBeenCalled();
  });

  it("does not stay hidden for a keyboard that was open when the layout changed", () => {
    mounted = mount(<Probe overlay />);
    setKeyboard(true);
    mounted.rerender(<Probe overlay={false} />);
    mounted.rerender(<Probe overlay />);
    expect(visible).toBe(true);
  });
});
