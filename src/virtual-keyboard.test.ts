// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchVirtualKeyboard } from "./virtual-keyboard";

const VAR = "--visual-keyboard-height";

function setViewport(innerHeight: number, vvHeight: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: Object.assign(new EventTarget(), { height: vvHeight }),
  });
}

function setMobile(mobile: boolean) {
  vi.stubGlobal("navigator", { userAgent: mobile ? "Mozilla/5.0 (Linux; Android 14)" : "Mozilla/5.0 (Macintosh)" });
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});
afterEach(() => vi.unstubAllGlobals());

describe("watchVirtualKeyboard", () => {
  it("reports the keyboard and sets the CSS variable when the viewport shrinks a lot", () => {
    setMobile(true);
    setViewport(800, 500);
    const onChange = vi.fn();
    const watcher = watchVirtualKeyboard(onChange);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe("300px");
    watcher.dispose();
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe("");
  });

  it("ignores small shrinkage such as a collapsing address bar", () => {
    setMobile(true);
    setViewport(800, 740);
    const onChange = vi.fn();
    watchVirtualKeyboard(onChange).dispose();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("falls back to the native keyboard-active class", () => {
    setMobile(true);
    setViewport(800, 800);
    document.documentElement.classList.add("keyboard-active");
    const onChange = vi.fn();
    watchVirtualKeyboard(onChange).dispose();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("never reports a keyboard on desktop", () => {
    setMobile(false);
    setViewport(800, 400);
    const onChange = vi.fn();
    watchVirtualKeyboard(onChange).dispose();
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(document.documentElement.style.getPropertyValue(VAR)).toBe("");
  });

  it("re-evaluates when the viewport resizes", () => {
    setMobile(true);
    setViewport(800, 800);
    const onChange = vi.fn();
    const watcher = watchVirtualKeyboard(onChange);
    expect(onChange).toHaveBeenLastCalledWith(false);
    (window.visualViewport as unknown as { height: number }).height = 450;
    window.visualViewport!.dispatchEvent(new Event("resize"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    watcher.dispose();
  });
});
