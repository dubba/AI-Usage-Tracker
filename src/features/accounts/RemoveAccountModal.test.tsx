// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { Account } from "../../types";
import { RemoveAccountModal } from "./RemoveAccountModal";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const account = { id: "a1", label: "Work" } as Account;

function render(props: Partial<Parameters<typeof RemoveAccountModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  mounted = mount(
    <RemoveAccountModal account={account} busy={false} onClose={onClose} onConfirm={onConfirm} {...props} />,
  );
  return { onConfirm, onClose };
}

describe("RemoveAccountModal (L-113)", () => {
  it("says removal is local and that other synced devices are not affected", () => {
    render();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Remove Work?");
    expect(dialog.textContent).toContain("from this device only");
    expect(dialog.textContent).toContain("will not be canceled");
    const note = dialog.querySelector(".confirm-dialog-note")!;
    expect(note.textContent).toBe("This only removes the account from this device. Other synced devices, if any, remain unchanged.");
    expect(note.classList.contains("is-caution")).toBe(true);
    // The note is part of the dialog's accessible description.
    const describedBy = dialog.getAttribute("aria-describedby")!.split(" ");
    expect(describedBy).toContain(note.id);
  });

  it("still removes only when confirmed, and Cancel does nothing else", () => {
    const { onConfirm, onClose } = render();
    click(document.querySelector(".button.ghost")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    click(document.querySelector(".remove-confirm-button")!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when no account is being removed", () => {
    render({ account: null });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
