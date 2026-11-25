// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { useDialogError } from "./useDialogError";

function Probe({ resetKey = "a" }: { resetKey?: unknown }) {
  const { error, setError, clearError } = useDialogError(resetKey);
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

describe("useDialogError", () => {
  it("keeps the message open over time until cleared", () => {
    mounted = mount(<Probe />);
    click(document.querySelector("button")!);
    expect(shown()).toBe("boom");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shown()).toBe("boom");
    click(document.querySelectorAll("button")[2]!);
    expect(shown()).toBe("");
  });

  it("updates when a different message is set", () => {
    mounted = mount(<Probe />);
    click(document.querySelector("button")!);
    expect(shown()).toBe("boom");
    click(document.querySelectorAll("button")[1]!);
    expect(shown()).toBe("other");
  });

  it("clears immediately when resetKey changes", () => {
    mounted = mount(<Probe resetKey="one" />);
    click(document.querySelector("button")!);
    expect(shown()).toBe("boom");
    mounted.rerender(<Probe resetKey="two" />);
    expect(shown()).toBe("");
  });
});
