// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { backdropMouseDown, useModalClosePolicy } from "./useModalClosePolicy";

function Dialog({ closable, onClose }: { closable: boolean; onClose: () => void }) {
  const requestClose = useModalClosePolicy(closable, onClose);
  return (
    <div className="modal-backdrop" onMouseDown={backdropMouseDown(requestClose)}>
      <section role="dialog" aria-modal="true">
        <button type="button" onClick={requestClose}>
          Close
        </button>
      </section>
    </div>
  );
}

function pressBackdrop() {
  act(() => {
    document.querySelector(".modal-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("useModalClosePolicy", () => {
  it("closes through the policy when allowed", () => {
    const onClose = vi.fn();
    mounted = mount(<Dialog closable onClose={onClose} />);
    pressBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blocks every dismissal path while closing is not allowed", () => {
    const onClose = vi.fn();
    mounted = mount(<Dialog closable={false} onClose={onClose} />);
    pressBackdrop();
    act(() => {
      document.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("respects the latest guard value, not a stale closure", () => {
    const onClose = vi.fn();
    mounted = mount(<Dialog closable={false} onClose={onClose} />);
    pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    mounted.rerender(<Dialog closable onClose={onClose} />);
    pressBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the press starts inside the dialog", () => {
    const onClose = vi.fn();
    mounted = mount(<Dialog closable onClose={onClose} />);
    act(() => {
      document.querySelector("[role=dialog]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useModalClosePolicy in a component with changing state", () => {
  it("follows a guard that flips after mount", () => {
    const onClose = vi.fn();
    function TogglingDialog() {
      const [busy, setBusy] = useState(true);
      const requestClose = useModalClosePolicy(!busy, onClose);
      return (
        <div className="modal-backdrop" onMouseDown={backdropMouseDown(requestClose)}>
          <button type="button" onClick={() => setBusy(false)}>
            Finish
          </button>
        </div>
      );
    }
    mounted = mount(<TogglingDialog />);
    pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      document.querySelector<HTMLButtonElement>("button")!.click();
    });
    pressBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
