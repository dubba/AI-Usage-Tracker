// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { ERROR_AUTO_DISMISS_MS, useAutoDismissedError } from "./useAutoDismissedError";

function Probe({ resetKey = "a" }: { resetKey?: unknown }) {
  const { error, setError, clearError } = useAutoDismissedError(resetKey);
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
  it("hides the message after 6 seconds", () => {
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
});
