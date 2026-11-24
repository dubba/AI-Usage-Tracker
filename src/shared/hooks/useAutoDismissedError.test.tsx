// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { ERROR_AUTO_DISMISS_MS, useAutoDismissedError } from "./useAutoDismissedError";

function Probe({ resetKey = "a", keepOpen = false }: { resetKey?: unknown; keepOpen?: boolean }) {
  const { error, setError, clearError } = useAutoDismissedError(resetKey, keepOpen);
  return (
    <div>
      <span data-testid="error">{error ?? ""}</span>
      <button type="button" onClick={() => setError("boom")}>
        set
      </button>
      <button type="button" onClick={() => setError("other")}>
        other
      </button>
      <button type="button" onClick={clearError}>
        clear
      </button>
    </div>
  );
}

function shown(): string {
  return document.querySelector('[data-testid="error"]')?.textContent ?? "";
}

let mounted: Mounted | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("useAutoDismissedError", () => {
  it("hides the message after 10 seconds", () => {
    mounted = mount(<Probe />);
    click(document.querySelector("button")!);
    expect(shown()).toBe("boom");
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
    });
    expect(shown()).toBe("boom");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe("");
  });

  it("does not restart the timer when the same message is set again", () => {
    mounted = mount(<Probe />);
    const setBtn = document.querySelector("button")!;
    click(setBtn);
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
    });
    click(setBtn);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe("");
  });

  it("restarts the timer when a different message is set", () => {
    mounted = mount(<Probe />);
    click(document.querySelector("button")!);
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
    });
    click(document.querySelectorAll("button")[1]!);
    expect(shown()).toBe("other");
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
    });
    expect(shown()).toBe("other");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe("");
  });

  it("clears immediately when resetKey changes", () => {
    mounted = mount(<Probe resetKey="one" />);
    click(document.querySelector("button")!);
    expect(shown()).toBe("boom");
    mounted.rerender(<Probe resetKey="two" />);
    expect(shown()).toBe("");
  });

  it("clears immediately from clearError", () => {
    mounted = mount(<Probe />);
    click(document.querySelector("button")!);
    click(document.querySelectorAll("button")[2]!);
    expect(shown()).toBe("");
  });

  it("keeps the message while keepOpen is on, and still clears from clearError", () => {
    mounted = mount(<Probe keepOpen />);
    click(document.querySelector("button")!);
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS * 3);
    });
    expect(shown()).toBe("boom");
    click(document.querySelectorAll("button")[2]!);
    expect(shown()).toBe("");
  });

  it("stops the timer when keepOpen turns on, and starts a fresh one when it turns off", () => {
    mounted = mount(<Probe />);
    click(document.querySelector("button")!);
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
    });
    mounted.rerender(<Probe keepOpen />);
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS * 2);
    });
    expect(shown()).toBe("boom");
    mounted.rerender(<Probe />);
    act(() => {
      vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
    });
    expect(shown()).toBe("boom");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe("");
  });
});
