// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { useOnAppResume } from "./useOnAppResume";

function Probe({ onResume }: { onResume: () => void }) {
  useOnAppResume(onResume);
  return null;
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setVisibility("visible");
});

describe("useOnAppResume", () => {
  it("fires on window focus and when the page becomes visible, not when it hides", () => {
    const onResume = vi.fn();
    mounted = mount(<Probe onResume={onResume} />);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(onResume).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    expect(onResume).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it("calls the newest handler without subscribing again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const add = vi.spyOn(window, "addEventListener");
    mounted = mount(<Probe onResume={first} />);
    const subscribed = add.mock.calls.filter(([name]) => name === "focus").length;
    mounted.rerender(<Probe onResume={second} />);
    expect(add.mock.calls.filter(([name]) => name === "focus").length).toBe(subscribed);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    add.mockRestore();
  });

  it("stops listening after unmount", () => {
    const onResume = vi.fn();
    mounted = mount(<Probe onResume={onResume} />);
    mounted.unmount();
    mounted = null;
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    expect(onResume).not.toHaveBeenCalled();
  });
});
