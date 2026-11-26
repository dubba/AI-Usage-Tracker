// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { useModalA11y } from "./useModalA11y";

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Edit Group
      </button>
      {open ? <InlineDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function InlineDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModalA11y(ref, true, onClose);
  return (
    <div className="modal-backdrop">
      <section ref={ref} role="dialog" aria-modal="true">
        <button type="button">First action</button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </section>
    </div>
  );
}

const pressKey = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("useModalA11y", () => {
  it("moves focus into the dialog on open and back to the opener on close", () => {
    mounted = mount(<Opener />);
    const opener = Array.from(document.querySelectorAll("button")).find((el) => el.textContent === "Edit Group")!;
    opener.focus();
    act(() => opener.click());
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => {
      Array.from(document.querySelectorAll("button")).find((el) => el.textContent === "Close")!.click();
    });
    expect(document.activeElement).toBe(opener);
  });

  it("starts on the × without showing its focus ring", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    function CloseFirst() {
      const ref = useRef<HTMLElement>(null);
      useModalA11y(ref, true, () => {});
      return (
        <section ref={ref} role="dialog" aria-modal="true">
          <button type="button" className="ui-modal-close">
            ×
          </button>
          <button type="button">First action</button>
        </section>
      );
    }
    mounted = mount(<CloseFirst />);
    const close = document.querySelector<HTMLElement>(".ui-modal-close")!;
    expect(document.activeElement).toBe(close);
    const call = focus.mock.calls.find((_, index) => focus.mock.contexts[index] === close);
    expect(call?.[0]).toMatchObject({ focusVisible: false });
    focus.mockRestore();
  });

  it("closes on Escape", () => {
    mounted = mount(<Opener />);
    act(() => document.querySelector("button")!.click());
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    pressKey("Escape");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
